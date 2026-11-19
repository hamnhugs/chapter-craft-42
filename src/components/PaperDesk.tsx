import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { useChatSettings } from "@/hooks/useChatSettings";
import { useWakeLock } from "@/hooks/useWakeLock";
import { usePaperScan, type ScanEvent, type Shot } from "@/hooks/usePaperScan";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  deskText, isPlaceholderPaperTitle, isUnfinishedPaper, missingRuns, pageLabel, paperMeta, paperProgressLabel,
  speechFor, type PaperPage,
} from "@/lib/paperBook";
import { PROBLEM_COPY } from "@/lib/pagePhoto";
import { cameraTrip, paperSession } from "@/lib/paperSession";
import PaperCamera, { inPageCameraUsable } from "@/components/PaperCamera";
import { tokenizeWords, wordAtOffset, type SourceWord } from "@/lib/readAlong";
import { ReadAlongPlayer, type ReadAlongStatus, type ReadAlongVoice } from "@/lib/readAlongPlayer";
import type { VoiceStyle } from "@/lib/inworldTts";

/**
 * The scanning desk — the Read tab while a paper book is unfinished.
 *
 * The reader is holding a book in one hand and the phone in the other, so
 * the whole screen is three things under the thumb:
 *
 *        Listen        ( Snap page )        Ask
 *
 * Snap adds the page they are on. Listen reads the pages aloud and keeps
 * going as new ones arrive, carrying a sentence across the page turn. Ask
 * takes the book so far to Counsel. Everything else (rename, the cover, book
 * length, removing a page, finishing) is one tap down in the menu.
 *
 * The page's words are shown — not its photo. The photo is gone by the time
 * the words appear (usePaperScan, PHOTO LIFETIME).
 */

const TIPS = ["Whole page in the shot", "As flat as you can", "Light from the side, no glare"];

/** A page as blocks of tappable words. `data-o` is the word's offset in
 *  deskText(page) — the same offsets speech uses, so a spoken word finds its
 *  place on screen without any second mapping. */
const PageText: React.FC<{ page: PaperPage }> = React.memo(({ page }) => {
  const blocks = useMemo(() => {
    const text = deskText(page);
    const words = tokenizeWords(text);
    const out: Array<{ heading: boolean; from: number; to: number; words: SourceWord[] }> = [];
    let at = 0;
    text.split("\n\n").forEach((para, i) => {
      const from = at, to = at + para.length;
      out.push({ heading: i === 0 && !!page.heading, from, to, words: words.filter((w) => w.start >= from && w.start < to) });
      at = to + 2;
    });
    return { text, out };
  }, [page]);
  return (
    <>
      {blocks.out.map((b, i) => {
        const Tag = b.heading ? "h2" : "p";
        const parts: React.ReactNode[] = [];
        let cursor = b.from;
        for (const w of b.words) {
          if (w.start > cursor) parts.push(blocks.text.slice(cursor, w.start));
          const raw = blocks.text.slice(w.start, w.end);
          parts.push(
            /\[unclear\]/i.test(raw)
              ? <mark key={w.start} className="cc-paper-unclear" title="Could not be read from the photo">{raw}</mark>
              : <span key={w.start} data-o={w.start}>{raw}</span>,
          );
          cursor = w.end;
        }
        if (cursor < b.to) parts.push(blocks.text.slice(cursor, b.to));
        return <Tag key={i} className={b.heading ? "cc-paper-heading" : undefined}>{parts}</Tag>;
      })}
    </>
  );
});
PageText.displayName = "PageText";

const ShotRow: React.FC<{
  shot: Shot;
  onUse: () => void; onRetry: () => void; onDiscard: () => void; onRetake: () => void;
}> = ({ shot, onUse, onRetry, onDiscard, onRetake }) => {
  if (shot.status === "checking" || shot.status === "reading") {
    return (
      <div className="cc-paper-shot" role="status">
        <span className="material-symbols-outlined animate-spin text-accent" aria-hidden>progress_activity</span>
        <span className="flex-1 min-w-0 truncate">{shot.status === "checking" ? "Checking the photo…" : "Reading the page…"}</span>
        <button type="button" className="cc-paper-link" onClick={onDiscard}>Cancel</button>
      </div>
    );
  }
  const warn = shot.status === "warn" && shot.problem ? PROBLEM_COPY[shot.problem] : null;
  return (
    <div className="cc-paper-shot" data-tone="warn" role="alert">
      <span className="material-symbols-outlined" aria-hidden>{warn ? "blur_on" : "error"}</span>
      <span className="flex-1 min-w-0">
        <span className="block font-bold">{warn ? warn.title : shot.message}</span>
        {warn && <span className="block text-xs opacity-80">{warn.tip}</span>}
      </span>
      {warn ? (
        <>
          <button type="button" className="cc-paper-link" onClick={onUse}>Use anyway</button>
          <button type="button" className="cc-btn3d !py-1.5 !px-3 text-sm" data-tone="accent" onClick={onRetake}>Retake</button>
        </>
      ) : (
        <>
          <button type="button" className="cc-paper-link" onClick={onDiscard}>Dismiss</button>
          {shot.retryable
            ? <button type="button" className="cc-btn3d !py-1.5 !px-3 text-sm" data-tone="accent" onClick={onRetry}>Try again</button>
            : <button type="button" className="cc-btn3d !py-1.5 !px-3 text-sm" data-tone="accent" onClick={onRetake}>Retake</button>}
        </>
      )}
    </div>
  );
};

const PaperDesk: React.FC<{ bookId: string | null }> = ({ bookId }) => {
  const { books, setActiveBookSilent, setActiveBook, setActiveTab, loadFocus } = useApp();
  const settings = useChatSettings();

  // ── Scanning ────────────────────────────────────────────────────────────
  /** Index of pages that just arrived, for the effect that reacts to them. */
  const arrived = useRef<number | null>(null);
  const nudged = useRef(false);
  // Short messages go in a strip ABOVE the bar, not in a toast: the app's
  // toasts rise from the bottom of the screen, which here is the shutter.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef(0);
  const say = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  /** A line shown over the live camera for a moment ("p. 47 added"). */
  const [camNote, setCamNote] = useState<string | null>(null);
  const camTimer = useRef(0);
  const flashCam = useCallback((m: string) => {
    setCamNote(m);
    window.clearTimeout(camTimer.current);
    camTimer.current = window.setTimeout(() => setCamNote(null), 2500);
  }, []);
  useEffect(() => () => window.clearTimeout(camTimer.current), []);
  const onEvent = useCallback((e: ScanEvent) => {
    if (e.type === "cover") {
      say(e.title ? `Cover added: ${e.title}` : "Cover added");
      return;
    }
    arrived.current = arrived.current === null ? e.firstIndex : Math.min(arrived.current, e.firstIndex);
    flashCam(`${e.labels.join(" and ")} added`.replace(/^a page/, "Page").replace(/^p\./, "p."));
    if (e.replaced > 0) say(`Replaced ${e.labels.join(" and ")} with the new photo`);
    try { navigator.vibrate?.(15); } catch { /* not supported */ }
  }, [say, flashCam]);
  const onCreated = useCallback((id: string) => {
    paperSession.adopt(id);
    setActiveBookSilent(id);
  }, [setActiveBookSilent]);
  const scan = usePaperScan({ bookId, onCreated, onEvent });
  const { pages } = scan;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // With a mouse there is no camera to open: the same button picks a file,
  // and says so.
  const [touch] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const takeFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    e.target.value = "";
    cameraTrip.end();
    if (files.length > 0) scan.addPhotos(files);
  };
  /** The phone's own camera app. The browser goes to the background for it,
   *  so the trip is marked in case the phone reloads the app meanwhile. */
  const snapNative = () => {
    if (touch) cameraTrip.begin(!scan.bookId);
    cameraInput.current?.click();
  };
  const [camOpen, setCamOpen] = useState(false);
  /** Snap: the camera inside the app on a phone, a file picker with a mouse. */
  const snap = () => {
    setNudge(false);
    setLost(false);
    if (touch && inPageCameraUsable()) setCamOpen(true);
    else snapNative();
  };
  // Back in the app with the page intact: the trip ended normally.
  useEffect(() => {
    const back = () => { if (!document.hidden) window.setTimeout(() => cameraTrip.end(), 1500); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  /** The app was reloaded while the phone's camera was open. */
  const [lost, setLost] = useState(() => cameraTrip.takeLostShot());

  // ── Which page is on screen ─────────────────────────────────────────────
  const [view, setView] = useState(0);
  const viewRef = useRef(0);
  viewRef.current = view;
  const opened = useRef(false);
  // Open an existing book where it was left: on its last page.
  useEffect(() => {
    if (scan.loadState !== "ready" || opened.current) return;
    opened.current = true;
    setView(Math.max(0, pages.length - 1));
  }, [scan.loadState, pages.length]);
  useEffect(() => { opened.current = false; }, [bookId]);
  useEffect(() => { if (view > pages.length - 1) setView(Math.max(0, pages.length - 1)); }, [pages.length, view]);
  const page = pages[view] ?? null;

  // ── Listening ───────────────────────────────────────────────────────────
  const voiceStyle: VoiceStyle = {
    model: settings.inworldModel,
    delivery: settings.inworldDelivery,
    direction: settings.inworldDirection,
    scene: "An audiobook narrator is reading a book aloud to one listener. This is the next passage.",
  };
  const voice: ReadAlongVoice = settings.inworldEnabled && settings.inworldVoiceId
    ? { engine: "inworld", inworldVoiceId: settings.inworldVoiceId, style: voiceStyle }
    : { engine: "browser" };
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const rateRef = useRef(settings.ttsRate ?? 1);
  rateRef.current = settings.ttsRate ?? 1;

  const [status, setStatus] = useState<ReadAlongStatus>("idle");
  /** Listening is ON for this sitting: pages are read as they arrive. */
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  /** Read to the end of what is scanned; the next page will pick it up. */
  const [waitingAt, setWaitingAt] = useState<number | null>(null);
  const waitingRef = useRef<number | null>(null);
  waitingRef.current = waitingAt;
  /** The page being spoken and how its speech maps onto its text. */
  const spoken = useRef<{ index: number; lead: number; words: SourceWord[]; held: string } | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const litWord = useRef<HTMLElement | null>(null);
  useWakeLock(status === "playing" || status === "loading");

  /** Shown once, when the first page of a sitting lands: the two things to do with it. */
  const [nudge, setNudge] = useState(false);

  const unlight = () => { litWord.current?.classList.remove("cc-paper-word-on"); litWord.current = null; };

  const light = useCallback((k: number) => {
    const cur = spoken.current;
    const host = textHost.current;
    if (!cur || !host || cur.index !== viewRef.current) { unlight(); return; }
    const offset = (cur.words[k]?.start ?? -1) - cur.lead;
    if (offset < 0) { unlight(); return; }
    // The last word that starts at or before the spoken offset.
    let hit: HTMLElement | null = null;
    for (const el of host.querySelectorAll<HTMLElement>("[data-o]")) {
      if (Number(el.dataset.o) > offset) break;
      hit = el;
    }
    if (hit === litWord.current) return;
    unlight();
    if (!hit) return;
    hit.classList.add("cc-paper-word-on");
    litWord.current = hit;
    const box = host.getBoundingClientRect(), r = hit.getBoundingClientRect();
    if (r.bottom > box.bottom - 48 || r.top < box.top + 24) hit.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const playerRef = useRef<ReadAlongPlayer | null>(null);
  const playPageRef = useRef<(index: number, fromOffset?: number, carry?: string) => void>(() => undefined);

  const playPage = useCallback((index: number, fromOffset?: number, carry = "") => {
    const list = pagesRef.current;
    const target = list[index];
    if (!target) return;
    const sp = speechFor(target, { carry, nextReady: index < list.length - 1 });
    const words = tokenizeWords(sp.text);
    setWaitingAt(null);
    spoken.current = { index, lead: sp.lead, words, held: sp.held };
    setSpeakingIndex(index);
    setView(index);
    if (words.length === 0) {
      // A page of pictures only: nothing to say, move on.
      queueMicrotask(() => onEndRef.current("ended"));
      return;
    }
    const from = fromOffset === undefined ? 0 : Math.max(0, wordAtOffset(words, fromOffset + sp.lead));
    playerRef.current?.start(sp.text, words, from, voiceRef.current, rateRef.current);
  }, []);
  playPageRef.current = playPage;

  const sayRef = useRef(say);
  sayRef.current = say;
  const onEnd = useCallback((reason: "ended" | "stopped" | "error") => {
    unlight();
    const cur = spoken.current;
    if (reason !== "ended" || !cur) {
      if (reason === "error") { setListening(false); sayRef.current("The voice stopped. Tap Listen to start again."); }
      setSpeakingIndex(null);
      return;
    }
    const next = cur.index + 1;
    if (next < pagesRef.current.length) { playPageRef.current(next, undefined, cur.held); return; }
    // Out of pages: hold the unfinished sentence for the page still to come.
    setSpeakingIndex(null);
    setWaitingAt(cur.index);
    try { navigator.vibrate?.([20, 60, 20]); } catch { /* not supported */ }
  }, []);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  if (!playerRef.current) {
    playerRef.current = new ReadAlongPlayer({
      onWord: (i) => light(i),
      onStatus: (s) => setStatus(s),
      onEnd: (r) => onEndRef.current(r),
      onNotice: (m) => sayRef.current(m),
    });
  }
  useEffect(() => () => { playerRef.current?.destroy(); }, []);

  const stopListening = useCallback(() => {
    setListening(false);
    setWaitingAt(null);
    spoken.current = null;
    playerRef.current?.stop();
    setSpeakingIndex(null);
    unlight();
  }, []);

  const toggleListen = () => {
    const player = playerRef.current!;
    if (status === "playing" || status === "loading") { player.pause(); return; }
    if (status === "paused") { player.resume(); return; }
    setListening(true);
    setNudge(false);
    if (pages.length > 0) playPage(view);
  };

  // New pages: show them, and if listening has run out of pages, read on.
  useEffect(() => {
    const first = arrived.current;
    if (first === null) return;
    arrived.current = null;
    const waiting = waitingRef.current;
    const idle = spoken.current === null || waiting !== null;
    if (!idle) return; // mid-page: the queue picks the new page up by itself
    if (listeningRef.current) {
      if (waiting !== null && waiting + 1 < pages.length) playPage(waiting + 1, undefined, spoken.current?.held ?? "");
      else playPage(first);
    } else {
      setView(first);
      if (!nudged.current) { nudged.current = true; setNudge(true); }
    }
  }, [pages, playPage]);

  // ── Leaving, asking, finishing ──────────────────────────────────────────
  const others = useMemo(
    () => books.filter((b) => isUnfinishedPaper(b) && b.id !== scan.bookId)
      .sort((a, b) => (paperMeta(b)?.updated_at ?? b.addedAt) - (paperMeta(a)?.updated_at ?? a.addedAt)),
    [books, scan.bookId],
  );

  const askCounsel = () => {
    if (!scan.bookId || !page) return;
    setNudge(false);
    playerRef.current?.pause();
    let hasDraft = false;
    try { hasDraft = !!(sessionStorage.getItem("counsel_draft") || "").trim(); } catch { /* no storage */ }
    if (!hasDraft) {
      const text = `About ${pageLabel(page, view)} of “${scan.title}”: `;
      try { sessionStorage.setItem("counsel_draft", text); } catch { /* the event still lands */ }
      window.dispatchEvent(new CustomEvent("chat-composer-insert", { detail: { text } }));
    }
    void loadFocus({ kind: "books", bookIds: [scan.bookId], neurons: { kind: "keep" } });
  };

  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const finish = async () => {
    setFinishing(true);
    stopListening();
    try {
      await scan.setStatus("done");
      setConfirmFinish(false);
      toast.success("Finished. It reads like any other book now.");
    } catch {
      toast.error("Could not finish the book. Check your connection and try again.");
    } finally {
      setFinishing(false);
    }
  };

  // A finished book reopened for more pages is unfinished again.
  useEffect(() => {
    if (scan.loadState === "ready" && scan.bookId && scan.meta.status === "done" && paperSession.resumeId() === scan.bookId) {
      void scan.setStatus("open").catch(() => undefined).finally(() => paperSession.clearResume());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.loadState, scan.bookId, scan.meta.status]);

  const [details, setDetails] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const openDetails = () => {
    setDraftTitle(isPlaceholderPaperTitle(scan.title) ? "" : scan.title);
    setDraftTotal(scan.meta.total_pages ? String(scan.meta.total_pages) : "");
    setDetails(true);
  };
  const saveDetails = (e: React.FormEvent) => {
    e.preventDefault();
    if (draftTitle.trim()) scan.rename(draftTitle);
    const n = Number(draftTotal);
    scan.setTotalPages(draftTotal.trim() && Number.isFinite(n) && n > 0 ? n : null);
    setDetails(false);
  };

  const removeCurrent = () => {
    if (!page) return;
    if (speakingIndex !== null) stopListening();
    scan.removePage(page.id);
    say(`Removed ${pageLabel(page, view)}`);
  };

  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) scan.addPhotos(files);
  };

  // ── Render ──────────────────────────────────────────────────────────────
  const empty = pages.length === 0;
  const playing = status === "playing" || status === "loading";
  const gaps = useMemo(() => missingRuns(pages), [pages]);
  const subtitle = scan.loadState === "loading" ? "Opening…" : paperProgressLabel(scan.meta);
  const saveNote = scan.saveState === "saving" ? "Saving…" : scan.saveState === "error" ? "Not saved" : empty ? "" : "Saved";

  const inputs = (
    <>
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" multiple={!touch} className="hidden" onChange={takeFiles} data-paper-camera />
      <input ref={galleryInput} type="file" accept="image/*" multiple className="hidden" onChange={takeFiles} data-paper-gallery />
    </>
  );

  const shotRows = (scan.shots.length > 0 || lost) && (
    <div className="cc-paper-shots" aria-live="polite">
      {lost && (
        <div className="cc-paper-shot" data-tone="warn" role="alert">
          <span className="material-symbols-outlined" aria-hidden>refresh</span>
          <span className="flex-1 min-w-0">
            <span className="block font-bold">Your phone reloaded the app while its camera was open</span>
            <span className="block text-xs opacity-80">That photo was lost. Your book and every page already added are safe.</span>
          </span>
          <button type="button" className="cc-paper-link" onClick={() => setLost(false)}>Dismiss</button>
          <button type="button" className="cc-btn3d !py-1.5 !px-3 text-sm" data-tone="accent" onClick={snap}>Snap it again</button>
        </div>
      )}
      {scan.shots.map((s) => (
        <ShotRow
          key={s.id}
          shot={s}
          onUse={() => scan.useAnyway(s.id)}
          onRetry={() => scan.retryShot(s.id)}
          onDiscard={() => scan.discardShot(s.id)}
          onRetake={() => { scan.discardShot(s.id); snap(); }}
        />
      ))}
    </div>
  );

  return (
    <div
      className="cc-paper h-full flex flex-col bg-background"
      data-drag={dragOver || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {inputs}

      <header className="cc-paper-head">
        <span className="cc-paper-badge" aria-hidden><span className="material-symbols-outlined">menu_book</span></span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={openDetails} title="Rename, or set how long the book is">
          <span className="block truncate font-headline font-bold text-foreground leading-tight">
            {empty && !scan.bookId ? "Paper book" : scan.title}
          </span>
          <span className="block truncate text-xs text-on-surface-variant">
            {empty && !scan.bookId ? "Read a real book with Counsel" : subtitle}
            {saveNote && <span data-save={scan.saveState} className="cc-paper-save"> · {saveNote}</span>}
          </span>
        </button>
        {scan.saveState === "error" && (
          <button type="button" className="cc-btn3d !py-1.5 !px-3 text-sm" data-tone="danger" onClick={scan.retrySave}>Save again</button>
        )}
        {!scan.bookId && empty ? (
          <button type="button" className="cc-paper-icon" onClick={() => paperSession.end()} aria-label="Close" title="Close">
            <span className="material-symbols-outlined" aria-hidden>close</span>
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="cc-paper-icon" aria-label="Book options" title="Book options">
                <span className="material-symbols-outlined" aria-hidden>more_horiz</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuItem onSelect={openDetails}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>edit</span> Name and length
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTimeout(snap, 0)}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>photo_camera</span>
                <span className="flex flex-col"><span>Snap the cover</span><span className="text-[11px] text-on-surface-variant">Names the book and gives its card a face.</span></span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTimeout(() => galleryInput.current?.click(), 0)}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>photo_library</span> Add photos you already took
              </DropdownMenuItem>
              {page && (
                <DropdownMenuItem onSelect={removeCurrent}>
                  <span className="material-symbols-outlined text-base mr-2" aria-hidden>delete</span> Remove {pageLabel(page, view)}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={empty} onSelect={() => setConfirmFinish(true)}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>task_alt</span>
                <span className="flex flex-col"><span>Finish this book</span><span className="text-[11px] text-on-surface-variant">Moves it out of Unfinished. You can add pages later.</span></span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { stopListening(); paperSession.start(); setActiveBookSilent(null); }}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>add</span> Start a different paper book
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { stopListening(); paperSession.end(); setActiveBookSilent(null); }}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>close</span>
                <span className="flex flex-col"><span>Close this book</span><span className="text-[11px] text-on-surface-variant">It stays in Unfinished, with every page you added.</span></span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {scan.loadState === "error" ? (
        <div className="flex-1 grid place-items-center p-6 text-center">
          <div>
            <p className="font-headline text-lg text-foreground">This book's pages did not load</p>
            <p className="text-sm text-on-surface-variant mt-1">Nothing is lost. Check your connection and try again.</p>
            <button type="button" className="cc-btn3d mt-4" onClick={scan.reload}>Try again</button>
          </div>
        </div>
      ) : scan.loadState === "loading" ? (
        <div className="flex-1 grid place-items-center text-on-surface-variant animate-pulse">Opening your pages…</div>
      ) : empty ? (
        // ── First page ──────────────────────────────────────────────────
        <div className="flex-1 overflow-y-auto">
          <div className="cc-paper-start">
            <div className="cc-paper-hero" aria-hidden>
              <span className="material-symbols-outlined">auto_stories</span>
              <span className="material-symbols-outlined cc-paper-hero-cam">photo_camera</span>
            </div>
            <h1 className="font-headline text-2xl font-bold text-foreground text-balance">
              {scan.bookId ? "Snap the page you are on" : "Reading a paper book?"}
            </h1>
            <p className="text-sm text-on-surface-variant max-w-sm text-pretty">
              Snap the page you are on. Have it read to you, or talk it over with Counsel. Every page you add builds the book in your Library, and you can pick it up again any time.
            </p>
            {shotRows}
            <button type="button" className="cc-btn3d cc-paper-snap-wide" data-tone="accent" onClick={snap} disabled={scan.busy > 0}>
              <span className="material-symbols-outlined" aria-hidden>{touch ? "photo_camera" : "add_photo_alternate"}</span> {touch ? "Snap a page" : "Add a page photo"}
            </button>
            {touch
              ? <button type="button" className="cc-paper-link" onClick={() => galleryInput.current?.click()}>or choose photos you already took</button>
              : <p className="text-xs text-on-surface-variant">or drop photos anywhere here. On your phone this button opens the camera.</p>}
            <ul className="cc-paper-tips">
              {TIPS.map((t) => <li key={t}><span className="material-symbols-outlined" aria-hidden>check</span>{t}</li>)}
            </ul>
            {others.length > 0 && (
              <section className="w-full max-w-sm text-left" aria-label="Unfinished paper books">
                <h2 className="text-xs font-bold uppercase tracking-wide text-on-surface-variant mb-2">Pick up where you left off</h2>
                <div className="flex flex-col gap-2">
                  {others.slice(0, 4).map((b) => (
                    <button key={b.id} type="button" className="cc-paper-resume" onClick={() => { paperSession.end(); setActiveBook(b.id); }}>
                      <span className="material-symbols-outlined text-accent" aria-hidden>bookmark</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold text-foreground">{b.title}</span>
                        <span className="block truncate text-xs text-on-surface-variant">{paperProgressLabel(paperMeta(b)!)}</span>
                      </span>
                      <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>chevron_right</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <p className="text-[11px] text-on-surface-variant max-w-sm text-pretty">
              For your own use, with books you own. Each photo is read once and then thrown away: only the words are kept, private to your account.
            </p>
          </div>
        </div>
      ) : (
        // ── The page ────────────────────────────────────────────────────
        <>
          <div className="cc-paper-pager">
            <button type="button" className="cc-paper-icon" disabled={view === 0} onClick={() => setView(view - 1)} aria-label="Previous page">
              <span className="material-symbols-outlined" aria-hidden>chevron_left</span>
            </button>
            <span className="text-sm font-bold text-foreground tabular-nums" aria-live="polite">
              {page ? pageLabel(page, view) : ""}
              <span className="font-normal text-on-surface-variant"> · {view + 1} of {pages.length}</span>
            </span>
            <button type="button" className="cc-paper-icon" disabled={view >= pages.length - 1} onClick={() => setView(view + 1)} aria-label="Next page">
              <span className="material-symbols-outlined" aria-hidden>chevron_right</span>
            </button>
          </div>

          <div
            ref={textHost}
            className="cc-paper-page flex-1 overflow-y-auto"
            onClick={(e) => {
              // While listening, a tap on a word reads from there.
              if (status === "idle" && waitingAt === null) return;
              const el = (e.target as HTMLElement).closest<HTMLElement>("[data-o]");
              if (el) { setListening(true); playPage(view, Number(el.dataset.o)); }
            }}
          >
            {page && (
              <article className="cc-paper-sheet" key={page.id}>
                {page.startsMid && view === 0 && <p className="cc-paper-note">This page starts mid-sentence. The page before it is not scanned.</p>}
                <PageText page={page} />
                {page.figures.map((f, i) => <aside key={`f${i}`} className="cc-paper-aside"><span className="material-symbols-outlined" aria-hidden>image</span>{f}</aside>)}
                {page.footnotes.map((f, i) => <aside key={`n${i}`} className="cc-paper-aside"><span className="material-symbols-outlined" aria-hidden>notes</span>{f}</aside>)}
                {page.unclear > 0 && (
                  <p className="cc-paper-note" data-tone="warn">
                    {page.unclear} spot{page.unclear === 1 ? "" : "s"} could not be read. Snap this page again to replace it.
                  </p>
                )}
                {view === pages.length - 1 && gaps.length > 0 && (
                  <p className="cc-paper-note">
                    Not scanned: {gaps.map(([a, b]) => (a === b ? `p. ${a}` : `p. ${a}–${b}`)).join(", ")}. Snap them any time and they go in the right place.
                  </p>
                )}
              </article>
            )}
          </div>

          {shotRows}

          {waitingAt !== null && scan.busy === 0 && (
            <div className="cc-paper-turn" role="status">
              <span className="material-symbols-outlined" aria-hidden>auto_stories</span>
              End of {pages[waitingAt] ? pageLabel(pages[waitingAt], waitingAt) : "the page"}. Turn the page and snap the next one.
            </div>
          )}

          {notice ? (
            <div className="cc-paper-turn" data-quiet role="status">{notice}</div>
          ) : nudge && waitingAt === null && scan.busy === 0 && (
            <div className="cc-paper-turn" role="status">
              <span className="material-symbols-outlined" aria-hidden>check_circle</span>
              {page ? `${pageLabel(page, view)} is in.` : "Page added."} Listen to it, or ask Counsel about it.
            </div>
          )}

          <nav className="cc-paper-bar" aria-label="Paper book">
            <button type="button" className="cc-paper-side" onClick={toggleListen} aria-pressed={listening}>
              <span className="material-symbols-outlined" aria-hidden>{playing ? "pause" : status === "paused" ? "play_arrow" : "headphones"}</span>
              <span>{playing ? "Pause" : status === "paused" ? "Resume" : "Listen"}</span>
            </button>
            <button type="button" className="cc-paper-snap" data-pulse={waitingAt !== null || undefined} onClick={snap} aria-label="Snap the next page">
              <span className="material-symbols-outlined" aria-hidden>photo_camera</span>
              <span>{!touch ? "Add page" : scan.busy > 0 ? "Snap another" : "Snap page"}</span>
            </button>
            <button type="button" className="cc-paper-side" onClick={askCounsel} disabled={!scan.bookId}>
              <span className="material-symbols-outlined" aria-hidden>psychology</span>
              <span>Ask</span>
            </button>
          </nav>
          {listening && (
            <button type="button" className="cc-paper-stop" onClick={stopListening}>
              <span className="material-symbols-outlined" aria-hidden>stop_circle</span> Stop listening
            </button>
          )}
        </>
      )}

      <PaperCamera
        open={camOpen}
        onClose={() => setCamOpen(false)}
        onPhoto={(file) => scan.addPhotos([file])}
        onUseNative={snapNative}
        busy={scan.busy}
        pages={pages.length}
        note={scan.shots.some((s) => s.status === "warn" || s.status === "failed") ? "A photo needs a look. Tap Done to see it." : camNote}
      />

      {dragOver && <div className="cc-paper-drop" aria-hidden>Drop page photos here</div>}

      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Name and length</DialogTitle>
          <DialogDescription>Both are optional. Snapping the cover fills in the name for you.</DialogDescription>
          <form onSubmit={saveDetails} className="flex flex-col gap-3">
            <label className="text-sm font-bold text-foreground">
              Title
              <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder={scan.title} autoFocus
                className="mt-1 w-full h-11 rounded-xl bg-surface-container-high border border-outline-variant/40 px-3 text-foreground font-normal" />
            </label>
            <label className="text-sm font-bold text-foreground">
              Pages in the whole book
              <input value={draftTotal} onChange={(e) => setDraftTotal(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" placeholder="e.g. 320"
                className="mt-1 w-full h-11 rounded-xl bg-surface-container-high border border-outline-variant/40 px-3 text-foreground font-normal" />
              <span className="block mt-1 text-xs font-normal text-on-surface-variant">Lets the card show how far through you are.</span>
            </label>
            <button type="submit" className="cc-btn3d" data-tone="accent">Save</button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmFinish} onOpenChange={setConfirmFinish}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Finish “{scan.title}”?</DialogTitle>
          <DialogDescription>
            It leaves Unfinished and opens in the reader like any other book, with its {pages.length} page{pages.length === 1 ? "" : "s"}. Nothing is deleted, and you can add more pages later from the reader's More menu.
          </DialogDescription>
          <div className="flex gap-2 justify-end">
            <button type="button" className="cc-btn3d" data-tone="quiet" onClick={() => setConfirmFinish(false)}>Keep scanning</button>
            <button type="button" className="cc-btn3d" data-tone="accent" disabled={finishing} onClick={() => void finish()}>{finishing ? "Finishing…" : "Finish"}</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PaperDesk;
