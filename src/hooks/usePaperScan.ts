import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  isPlaceholderPaperTitle, paperMeta, placePages, untitledPaperTitle,
  type PaperMeta, type PaperPage,
} from "@/lib/paperBook";
import { coverFromPhoto, orderPhotos, preparePagePhoto, type PhotoProblem } from "@/lib/pagePhoto";
import { makeTranscriber, SHOT_PROBLEM_COPY, TranscribeError, type Transcription } from "@/lib/pageTranscribe";
import { metaFor, PaperIOContext, supabasePaperIO, type PaperIO } from "@/lib/paperStore";

/**
 * The scanning engine: photo in, page in the book.
 *
 * One instance per place that can scan (the desk in the Read tab, the chip in
 * Chat). It owns three queues, each serial for its own reason:
 *
 *   - READING runs in parallel (a model call per photo) but pages are
 *     COMMITTED in the order the photos were taken, so a slow first page can
 *     never land after a fast second one;
 *   - SAVING is serial, so two saves can never interleave their file write
 *     and their chapter writes — but it TRAILS: a page shows as soon as it is
 *     read, and saves that pile up collapse into the newest one;
 *   - the book itself is created by the first page that commits — a blurry
 *     first shot leaves nothing behind in the library.
 *
 * PHOTO LIFETIME. A photo is one data URL in `photos`, keyed by its shot. It
 * is deleted the moment its words are committed, its cover thumbnail is made,
 * the model reports it unreadable, or the reader discards it — and all of
 * them on unmount. The only time one outlives its first read is a failure the
 * reader can retry (no connection, a busy provider), because then it still
 * has a use. Nothing is ever written to storage. Photos still waiting in line
 * are not decoded at all: only the reader's own file handles are held.
 */

export type ShotStatus = "queued" | "checking" | "warn" | "reading" | "failed";

export interface Shot {
  id: string;
  status: ShotStatus;
  /** What the on-device check found (status "warn"). */
  problem?: PhotoProblem;
  /** Why it failed, in the reader's words (status "failed"). */
  message?: string;
  /** The photo is still held and "Try again" will re-read it. */
  retryable?: boolean;
  /** The page's words so far, while it is still being read. */
  preview?: string;
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
  /** Photos waiting, being checked or being read. */
  busy: number;
  /** The current run of photos: how many were handed over, how many are dealt with. */
  batch: { total: number; done: number };
  /** Drop everything not yet read. */
  cancelQueue: () => void;
  saveState: SaveState;
  addPhotos: (files: File[]) => void;
  useAnyway: (shotId: string) => void;
  retryShot: (shotId: string) => void;
  discardShot: (shotId: string) => void;
  removePages: (pageIds: string[]) => Array<{ page: PaperPage; index: number }>;
  restorePages: (removed: Array<{ page: PaperPage; index: number }>) => void;
  markChecked: (pageId: string) => void;
  /** The page the next photo will replace, if the reader asked for a retake. */
  retaking: string | null;
  retake: (pageId: string | null) => void;
  rename: (title: string) => void;
  setTotalPages: (n: number | null) => void;
  setStatus: (status: "open" | "done") => Promise<void>;
  retrySave: () => void;
  reload: () => void;
}

let shotSeq = 0;
/** Saves still on their way, from every engine. Saving trails behind the
 *  page, so an engine opening a book (the chip in Chat, a second after the
 *  desk took a page) waits for these first — or it would load the book
 *  without its newest pages and later save it back that way. */
const savesInFlight = new Set<Promise<unknown>>();
/** Photos decoded and being read at the same time. */
const READ_AT_ONCE = 3;
/** Waits before asking a busy provider again. */
const RATE_WAITS = [4000, 10_000, 20_000];

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
  const [retaking, setRetaking] = useState<string | null>(null);
  const retakeRef = useRef<string | null>(null);

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
      waiting.current = [];
      files.current.clear();
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
    const store = ioRef.current;
    Promise.allSettled([...savesInFlight]).then(() => store.load(id)).then(
      (loaded) => { if (!cancelled && alive.current) { setPages(loaded); setLoadState("ready"); } },
      () => { if (!cancelled && alive.current) setLoadState("error"); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.bookId, loadTick, io]);

  // ── Saving ──────────────────────────────────────────────────────────────
  // A save writes whatever the book is WHEN IT STARTS, so a save that is still
  // waiting its turn already covers every change made since it was asked for:
  // ten pages landing in a burst are one or two saves, not ten.
  const queuedSave = useRef<Promise<void> | null>(null);
  const savesOpen = useRef(0);
  const persist = useCallback((metaPatch: Partial<PaperMeta> = {}) => {
    const nextMeta = metaFor(pagesRef.current, metaRef.current, metaPatch);
    setMeta(nextMeta);
    setSaveState("saving");
    if (queuedSave.current) return queuedSave.current;
    const run = async () => {
      queuedSave.current = null;
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
    savesOpen.current++;
    const done = saveChain.current.then(run).then(
      () => { savesOpen.current--; if (alive.current && savesOpen.current === 0) setSaveState("saved"); },
      (e) => { savesOpen.current--; console.error("Paper book save failed:", e); if (alive.current) setSaveState("error"); throw e; },
    );
    queuedSave.current = done;
    const settled = done.catch(() => undefined).finally(() => savesInFlight.delete(settled));
    savesInFlight.add(settled);
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
      // Saving trails behind: the next photo does not wait for this one's save.
      void persist({ author })
        .then(() => (thumb && bookIdRef.current ? ioRef.current?.setCover(bookIdRef.current, thumb) : undefined))
        .catch(() => undefined);
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
    // A retake asked for by name: the new reading takes that page's place,
    // whether or not the two carry the same printed number.
    const target = retakeRef.current;
    retakeRef.current = null;
    if (alive.current) setRetaking(null);
    const at = target ? pagesRef.current.findIndex((p) => p.id === target) : -1;
    let placed;
    if (at !== -1) {
      const next = pagesRef.current.slice();
      next.splice(at, 1, ...t.pages);
      placed = { pages: next, replaced: [target!], firstIndex: at };
    } else {
      placed = placePages(pagesRef.current, t.pages);
    }
    setPages(placed.pages);
    dropShot(shotId);
    cb.current.onEvent?.({
      type: "pages", firstIndex: placed.firstIndex, count: t.pages.length, replaced: placed.replaced.length,
      labels: t.pages.map((p) => (p.printed ? `p. ${p.printed}` : "a page")),
    });
    // The page is on screen now; its save trails behind and never holds up
    // the next page (a failed save shows "Not saved" with a way to retry).
    void persist(t.author && !metaRef.current.author ? { author: t.author } : {}).catch(() => undefined);
  }, [persist]);

  // ── The queue ───────────────────────────────────────────────────────────
  // Any number of photos can be handed over at once. They wait in line as
  // FILE HANDLES (nothing decoded), are worked READ_AT_ONCE at a time — a
  // decoded photo is ~0.5 MB and every read is a model call, so fifty at once
  // would be fifty megabytes and a rate limit — and are COMMITTED in the
  // order given, whichever read happens to finish first.
  type Job = { id: string; skipCheck: boolean };
  type Outcome = { t: Transcription } | { error: unknown } | "parked";
  const waiting = useRef<Job[]>([]);
  const files = useRef(new Map<string, File>());
  const running = useRef(0);
  const settle = useRef(new Map<string, (o: Outcome) => void>());
  /** Shots the reader took back; work already under way for them stops at its next step. */
  const discarded = useRef(new Set<string>());
  const [batch, setBatch] = useState({ total: 0, done: 0 });
  const finishOne = () => setBatch((b) => ({ ...b, done: Math.min(b.total, b.done + 1) }));

  /** Reserve this shot's place in the commit order. */
  const reserve = useCallback((id: string) => {
    const outcome = new Promise<Outcome>((resolve) => settle.current.set(id, resolve));
    commitChain.current = commitChain.current.then(async () => {
      const o = await outcome;
      settle.current.delete(id);
      if (o === "parked" || !alive.current) return;
      try {
        if ("error" in o) throw o.error;
        await apply(id, o.t);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        const err = e instanceof TranscribeError ? e : null;
        // Worth another go with the same photo only when the photo was never
        // the problem.
        const retryable = !err || err.code === "network" || err.code === "rate" || err.code === "no_key" || err.code === "auth" || err.code === "credits";
        if (!retryable) dispose(id);
        patchShot(id, { status: "failed", retryable, message: err?.message ?? "That page could not be read. Try again." });
      } finally {
        finishOne();
      }
    });
  }, [apply]);

  const work = useCallback(async (job: Job): Promise<Outcome> => {
    if (!job.skipCheck) {
      const file = files.current.get(job.id);
      files.current.delete(job.id);
      if (!file) return "parked"; // discarded while it waited
      patchShot(job.id, { status: "checking" });
      try {
        const photo = await preparePagePhoto(file);
        if (!alive.current || discarded.current.has(job.id)) return "parked";
        photos.current.set(job.id, photo.dataUrl);
        if (photo.problem) {
          // Waits for the reader; the line moves on without it.
          patchShot(job.id, { status: "warn", problem: photo.problem });
          finishOne();
          return "parked";
        }
      } catch (e) {
        patchShot(job.id, { status: "failed", retryable: false, message: (e as Error)?.message || "That photo could not be opened." });
        finishOne();
        return "parked";
      }
    }
    const photo = photos.current.get(job.id);
    if (!photo || discarded.current.has(job.id)) { dispose(job.id); return "parked"; }
    patchShot(job.id, { status: "reading", problem: undefined, message: undefined, preview: undefined });
    // Words arrive many times a second; the screen is told a few times.
    let told = 0;
    const onText = (body: string) => {
      const now = Date.now();
      if (now - told < 200 || !alive.current) return;
      told = now;
      patchShot(job.id, { preview: body });
    };
    const abort = new AbortController();
    aborts.current.set(job.id, abort);
    const known = isPlaceholderPaperTitle(titleRef.current) ? null : titleRef.current;
    try {
      // A busy provider is a reason to wait, not to bother the reader: a big
      // batch on a free key will hit the per-minute limit as a matter of course.
      for (let attempt = 0; ; attempt++) {
        try {
          return { t: await transcribeRef.current(photo, { signal: abort.signal, bookTitle: known, onText }) };
        } catch (e) {
          const rate = e instanceof TranscribeError && e.code === "rate";
          if (!rate || attempt >= RATE_WAITS.length || abort.signal.aborted) throw e;
          await new Promise((r) => setTimeout(r, RATE_WAITS[attempt]));
          if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
        }
      }
    } catch (error) {
      return { error };
    } finally {
      aborts.current.delete(job.id);
    }
  }, []);

  const pump = useCallback(() => {
    while (running.current < READ_AT_ONCE && waiting.current.length > 0) {
      const job = waiting.current.shift()!;
      running.current++;
      void work(job).then((o) => {
        running.current--;
        settle.current.get(job.id)?.(o);
        if (alive.current) pump();
      });
    }
  }, [work]);

  const startBatch = (n: number) =>
    setBatch((b) => (b.done >= b.total ? { total: n, done: 0 } : { total: b.total + n, done: b.done }));

  const addPhotos = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    const ordered = incoming.length > 1 ? orderPhotos(incoming) : incoming;
    const jobs = ordered.map((file) => {
      const id = `shot-${++shotSeq}`;
      files.current.set(id, file);
      return { id, skipCheck: false };
    });
    setShots((prev) => [...prev, ...jobs.map((j) => ({ id: j.id, status: "queued" as const }))]);
    startBatch(jobs.length);
    jobs.forEach((j) => reserve(j.id));
    waiting.current.push(...jobs);
    pump();
  }, [pump, reserve]);

  /** Read a photo that is already checked (Use anyway / Try again). It goes
   *  to the FRONT of the line: the reader just asked for it. */
  const read = useCallback((shotId: string) => {
    if (!photos.current.has(shotId)) { dropShot(shotId); return; }
    patchShot(shotId, { status: "queued", problem: undefined, message: undefined });
    startBatch(1);
    reserve(shotId);
    waiting.current.unshift({ id: shotId, skipCheck: true });
    pump();
  }, [pump, reserve]);

  const discardShot = useCallback((shotId: string) => {
    discarded.current.add(shotId);
    aborts.current.get(shotId)?.abort();
    aborts.current.delete(shotId);
    const wasWaiting = waiting.current.some((j) => j.id === shotId);
    waiting.current = waiting.current.filter((j) => j.id !== shotId);
    files.current.delete(shotId);
    dispose(shotId);
    dropShot(shotId);
    // Still in line: nothing will ever settle it, so settle it here.
    if (wasWaiting) { settle.current.get(shotId)?.("parked"); finishOne(); }
  }, []);

  /** Drop everything that has not been read yet. Pages already in stay in. */
  const cancelQueue = useCallback(() => {
    const ids = waiting.current.map((j) => j.id);
    waiting.current = [];
    for (const id of ids) {
      discarded.current.add(id);
      files.current.delete(id);
      dispose(id);
      settle.current.get(id)?.("parked");
    }
    aborts.current.forEach((a) => a.abort());
    setShots((prev) => prev.filter((s) => s.status === "warn" || s.status === "failed"));
    setBatch({ total: 0, done: 0 });
  }, []);

  /** Take pages out. Resolves to what was removed and where, for an Undo. */
  const removePages = useCallback((pageIds: string[]): Array<{ page: PaperPage; index: number }> => {
    const gone = new Set(pageIds);
    const removed = pagesRef.current.map((page, index) => ({ page, index })).filter((x) => gone.has(x.page.id));
    if (removed.length === 0) return [];
    setPages(pagesRef.current.filter((p) => !gone.has(p.id)));
    if (retakeRef.current && gone.has(retakeRef.current)) { retakeRef.current = null; setRetaking(null); }
    void persist().catch(() => undefined);
    return removed;
  }, [persist]);

  /** Put removed pages back where they were (Undo). */
  const restorePages = useCallback((removed: Array<{ page: PaperPage; index: number }>) => {
    const next = pagesRef.current.slice();
    for (const { page, index } of removed.slice().sort((a, b) => a.index - b.index)) {
      if (!next.some((p) => p.id === page.id)) next.splice(Math.min(index, next.length), 0, page);
    }
    setPages(next);
    void persist().catch(() => undefined);
  }, [persist]);

  /** The reader looked at a doubted page and it is fine. */
  const markChecked = useCallback((pageId: string) => {
    setPages(pagesRef.current.map((p) => (p.id === pageId ? { ...p, checked: true } : p)));
    void persist().catch(() => undefined);
  }, [persist]);

  /** The next photo read replaces this page (null = never mind). */
  const retake = useCallback((pageId: string | null) => {
    retakeRef.current = pageId;
    setRetaking(pageId);
  }, []);

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
    busy: shots.filter((s) => s.status === "queued" || s.status === "checking" || s.status === "reading").length,
    batch,
    cancelQueue,
    saveState,
    addPhotos,
    useAnyway: read,
    retryShot: read,
    discardShot,
    removePages,
    restorePages,
    markChecked,
    retaking,
    retake,
    rename,
    setTotalPages,
    setStatus,
    retrySave: () => { void persist().catch(() => undefined); },
    reload: () => setLoadTick((n) => n + 1),
  };
}
