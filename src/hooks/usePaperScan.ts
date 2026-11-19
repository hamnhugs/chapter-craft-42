import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  isPlaceholderPaperTitle, paperMeta, placePages, untitledPaperTitle,
  type PaperMeta, type PaperPage,
} from "@/lib/paperBook";
import { coverFromPhoto, preparePagePhoto, type PhotoProblem } from "@/lib/pagePhoto";
import { makeTranscriber, SHOT_PROBLEM_COPY, TranscribeError, type Transcription } from "@/lib/pageTranscribe";
import { metaFor, PaperIOContext, supabasePaperIO, type PaperIO } from "@/lib/paperStore";

/**
 * The scanning engine: photo in, page in the book.
 *
 * One instance per place that can scan (the desk in the Read tab, the chip in
 * Counsel). It owns three queues, each serial for its own reason:
 *
 *   - READING runs in parallel (a model call per photo) but pages are
 *     COMMITTED in the order the photos were taken, so a slow first page can
 *     never land after a fast second one;
 *   - SAVING is serial, so two saves can never interleave their file write
 *     and their chapter writes;
 *   - the book itself is created by the first page that commits — a blurry
 *     first shot leaves nothing behind in the library.
 *
 * PHOTO LIFETIME. A photo is one data URL in `photos`, keyed by its shot. It
 * is deleted the moment its words are committed, its cover thumbnail is made,
 * the model reports it unreadable, or the reader discards it — and all of
 * them on unmount. The only time one outlives its first read is a failure the
 * reader can retry (no connection, a busy provider), because then it still
 * has a use. Nothing is ever written to storage.
 */

export type ShotStatus = "checking" | "warn" | "reading" | "failed";

export interface Shot {
  id: string;
  status: ShotStatus;
  /** What the on-device check found (status "warn"). */
  problem?: PhotoProblem;
  /** Why it failed, in the reader's words (status "failed"). */
  message?: string;
  /** The photo is still held and "Try again" will re-read it. */
  retryable?: boolean;
}

export type ScanEvent =
  | { type: "pages"; firstIndex: number; count: number; replaced: number; labels: string[] }
  | { type: "cover"; title: string | null };

export type SaveState = "saved" | "saving" | "error";

export interface PaperScan {
  bookId: string | null;
  title: string;
  meta: PaperMeta;
  pages: PaperPage[];
  loadState: "idle" | "loading" | "ready" | "error";
  shots: Shot[];
  /** Photos being checked or read right now. */
  busy: number;
  saveState: SaveState;
  addPhotos: (files: File[]) => void;
  useAnyway: (shotId: string) => void;
  retryShot: (shotId: string) => void;
  discardShot: (shotId: string) => void;
  removePage: (pageId: string) => void;
  rename: (title: string) => void;
  setTotalPages: (n: number | null) => void;
  setStatus: (status: "open" | "done") => Promise<void>;
  retrySave: () => void;
  reload: () => void;
}

let shotSeq = 0;

export function usePaperScan(opts: {
  bookId: string | null;
  /** The engine made the book (first page committed). */
  onCreated?: (bookId: string) => void;
  onEvent?: (e: ScanEvent) => void;
}): PaperScan {
  const app = useApp();
  const { user } = useAuth();
  const settings = useChatSettings();
  const override = useContext(PaperIOContext);

  const booksRef = useRef(app.books);
  booksRef.current = app.books;
  const appRef = useRef(app);
  appRef.current = app;

  const io: PaperIO | null = useMemo(() => {
    if (override?.io) return override.io;
    if (!user) return null;
    return supabasePaperIO({
      userId: user.id,
      addBook: (b, f, o) => appRef.current.addBook(b, f, o),
      loadBookFile: (id) => appRef.current.loadBookFile(id),
      patchBookLocal: (id, p) => appRef.current.patchBookLocal(id, p),
      setBookCover: (id, img) => appRef.current.setBookCover(id, img),
      getBook: (id) => booksRef.current.find((b) => b.id === id),
    });
  }, [override?.io, user]);
  const ioRef = useRef(io);
  ioRef.current = io;

  const transcribe = useMemo(
    () => override?.transcribe ?? makeTranscriber({
      visionModel: settings.visionModel,
      selectedModel: settings.selectedModel,
      keys: { apiKey: settings.apiKey, geminiApiKey: settings.geminiApiKey, nvidiaKeyLast4: settings.nvidiaKeyLast4 },
    }),
    [override?.transcribe, settings.visionModel, settings.selectedModel, settings.apiKey, settings.geminiApiKey, settings.nvidiaKeyLast4],
  );
  const transcribeRef = useRef(transcribe);
  transcribeRef.current = transcribe;

  const book = opts.bookId ? app.books.find((b) => b.id === opts.bookId) : undefined;

  const [bookId, setBookId] = useState<string | null>(opts.bookId);
  const [pages, setPagesState] = useState<PaperPage[]>([]);
  const [title, setTitleState] = useState(() => book?.title ?? untitledPaperTitle());
  const [meta, setMetaState] = useState<PaperMeta>(() => paperMeta(book) ?? metaFor([], null));
  const [loadState, setLoadState] = useState<PaperScan["loadState"]>(opts.bookId ? "loading" : "ready");
  const [shots, setShots] = useState<Shot[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loadTick, setLoadTick] = useState(0);

  const bookIdRef = useRef<string | null>(opts.bookId);
  const pagesRef = useRef<PaperPage[]>([]);
  const titleRef = useRef(title);
  const metaRef = useRef(meta);
  const setPages = (p: PaperPage[]) => { pagesRef.current = p; setPagesState(p); };
  const setTitle = (t: string) => { titleRef.current = t; setTitleState(t); };
  const setMeta = (m: PaperMeta) => { metaRef.current = m; setMetaState(m); };

  /** The only copies of the photos. See PHOTO LIFETIME above. */
  const photos = useRef(new Map<string, string>());
  const dispose = (shotId: string) => { photos.current.delete(shotId); };
  const aborts = useRef(new Map<string, AbortController>());
  const commitChain = useRef<Promise<void>>(Promise.resolve());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  /** A book this engine created: its pages are already here, do not reload. */
  const createdHere = useRef<string | null>(null);
  const alive = useRef(true);
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    alive.current = true;
    const held = photos.current;
    const running = aborts.current;
    return () => {
      alive.current = false;
      running.forEach((a) => a.abort());
      running.clear();
      held.clear();
    };
  }, []);

  // ── Opening an existing book ────────────────────────────────────────────
  useEffect(() => {
    const id = opts.bookId;
    if (id === bookIdRef.current && id === createdHere.current) return;
    bookIdRef.current = id;
    setBookId(id);
    createdHere.current = null;
    if (!id) {
      setPages([]); setTitle(untitledPaperTitle()); setMeta(metaFor([], null)); setLoadState("ready");
      return;
    }
    const b = booksRef.current.find((x) => x.id === id);
    if (b) { setTitle(b.title); setMeta(paperMeta(b) ?? metaFor([], null)); }
    if (!ioRef.current) { setLoadState("error"); return; }
    let cancelled = false;
    setLoadState("loading");
    ioRef.current.load(id).then(
      (loaded) => { if (!cancelled && alive.current) { setPages(loaded); setLoadState("ready"); } },
      () => { if (!cancelled && alive.current) setLoadState("error"); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.bookId, loadTick, io]);

  // ── Saving ──────────────────────────────────────────────────────────────
  const persist = useCallback((metaPatch: Partial<PaperMeta> = {}) => {
    const nextMeta = metaFor(pagesRef.current, metaRef.current, metaPatch);
    setMeta(nextMeta);
    setSaveState("saving");
    const run = async () => {
      const store = ioRef.current;
      if (!store) throw new Error("Sign in to save pages.");
      if (!bookIdRef.current) {
        const id = await store.create(titleRef.current, metaRef.current);
        bookIdRef.current = id;
        createdHere.current = id;
        if (alive.current) setBookId(id);
        cb.current.onCreated?.(id);
      }
      await store.save(bookIdRef.current, { title: titleRef.current, pages: pagesRef.current, meta: metaRef.current });
    };
    const done = saveChain.current.then(run).then(
      () => { if (alive.current) setSaveState("saved"); },
      (e) => { console.error("Paper book save failed:", e); if (alive.current) setSaveState("error"); throw e; },
    );
    saveChain.current = done.catch(() => undefined);
    return done;
  }, []);

  // ── Shots ───────────────────────────────────────────────────────────────
  const patchShot = (id: string, patch: Partial<Shot>) =>
    setShots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const dropShot = (id: string) => setShots((prev) => prev.filter((s) => s.id !== id));

  const apply = useCallback(async (shotId: string, t: Transcription) => {
    if (t.kind === "cover") {
      const photo = photos.current.get(shotId);
      const named = t.bookTitle && isPlaceholderPaperTitle(titleRef.current);
      if (named) setTitle(t.bookTitle!);
      const author = t.author ?? metaRef.current.author ?? null;
      const thumb = photo ? await coverFromPhoto(photo) : null;
      dispose(shotId);
      dropShot(shotId);
      await persist({ author });
      if (thumb && bookIdRef.current) await ioRef.current?.setCover(bookIdRef.current, thumb).catch(() => undefined);
      cb.current.onEvent?.({ type: "cover", title: t.bookTitle });
      return;
    }
    // Read or unreadable, the photo has no further use.
    dispose(shotId);
    if (t.pages.length === 0) {
      patchShot(shotId, { status: "failed", retryable: false, message: SHOT_PROBLEM_COPY[t.problem ?? "no_text"] });
      return;
    }
    if (t.bookTitle && isPlaceholderPaperTitle(titleRef.current)) setTitle(t.bookTitle);
    const placed = placePages(pagesRef.current, t.pages);
    setPages(placed.pages);
    dropShot(shotId);
    cb.current.onEvent?.({
      type: "pages", firstIndex: placed.firstIndex, count: t.pages.length, replaced: placed.replaced.length,
      labels: t.pages.map((p) => (p.printed ? `p. ${p.printed}` : "a page")),
    });
    await persist(t.author && !metaRef.current.author ? { author: t.author } : {}).catch(() => undefined);
  }, [persist]);

  const read = useCallback((shotId: string) => {
    const photo = photos.current.get(shotId);
    if (!photo) { dropShot(shotId); return; }
    patchShot(shotId, { status: "reading", problem: undefined, message: undefined });
    const abort = new AbortController();
    aborts.current.set(shotId, abort);
    const known = isPlaceholderPaperTitle(titleRef.current) ? null : titleRef.current;
    const reading = transcribeRef.current(photo, { signal: abort.signal, bookTitle: known });
    reading.catch(() => undefined); // handled in order, below
    commitChain.current = commitChain.current.then(async () => {
      try {
        const t = await reading;
        if (!alive.current || abort.signal.aborted) return;
        await apply(shotId, t);
      } catch (e) {
        if (!alive.current || abort.signal.aborted) return;
        const err = e instanceof TranscribeError ? e : null;
        // Worth another go with the same photo only when the photo was never
        // the problem.
        const retryable = !err || err.code === "network" || err.code === "rate" || err.code === "no_key" || err.code === "auth" || err.code === "credits";
        if (!retryable) dispose(shotId);
        patchShot(shotId, { status: "failed", retryable, message: err?.message ?? "That page could not be read. Try again." });
      } finally {
        aborts.current.delete(shotId);
      }
    });
  }, [apply]);

  const addPhotos = useCallback((files: File[]) => {
    for (const file of files) {
      const id = `shot-${++shotSeq}`;
      setShots((prev) => [...prev, { id, status: "checking" }]);
      // Checked one after another, in the order taken: reading order follows.
      commitChain.current = commitChain.current.then(async () => {
        try {
          const photo = await preparePagePhoto(file);
          if (!alive.current) return;
          photos.current.set(id, photo.dataUrl);
          if (photo.problem) patchShot(id, { status: "warn", problem: photo.problem });
          else read(id);
        } catch (e) {
          patchShot(id, { status: "failed", retryable: false, message: (e as Error)?.message || "That photo could not be opened." });
        }
      });
    }
  }, [read]);

  const discardShot = useCallback((shotId: string) => {
    aborts.current.get(shotId)?.abort();
    aborts.current.delete(shotId);
    dispose(shotId);
    dropShot(shotId);
  }, []);

  const removePage = useCallback((pageId: string) => {
    const next = pagesRef.current.filter((p) => p.id !== pageId);
    if (next.length === pagesRef.current.length) return;
    setPages(next);
    void persist().catch(() => undefined);
  }, [persist]);

  const rename = useCallback((next: string) => {
    const t = next.trim().slice(0, 160);
    if (!t || t === titleRef.current) return;
    setTitle(t);
    if (bookIdRef.current) void persist().catch(() => undefined);
  }, [persist]);

  const setTotalPages = useCallback((n: number | null) => {
    const total = n && n > 0 ? Math.round(n) : null;
    if (bookIdRef.current) void persist({ total_pages: total }).catch(() => undefined);
    else setMeta({ ...metaRef.current, total_pages: total });
  }, [persist]);

  const setStatus = useCallback(async (status: "open" | "done") => {
    if (!bookIdRef.current) return;
    await persist({ status });
  }, [persist]);

  return {
    bookId, title, meta, pages, loadState, shots,
    busy: shots.filter((s) => s.status === "checking" || s.status === "reading").length,
    saveState,
    addPhotos,
    useAnyway: read,
    retryShot: read,
    discardShot,
    removePage,
    rename,
    setTotalPages,
    setStatus,
    retrySave: () => { void persist().catch(() => undefined); },
    reload: () => setLoadTick((n) => n + 1),
  };
}
