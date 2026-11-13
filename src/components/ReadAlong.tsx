import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatSettings } from "@/hooks/useChatSettings";
import { useAuth } from "@/hooks/useAuth";
import { useReadAlongStats } from "@/hooks/useReadAlongStats";
import { fetchInworldVoices, type InworldVoice } from "@/lib/inworldTts";
import {
  comboMultiplier,
  creditWords,
  DAILY_WORD_GOAL,
  levelInfo,
  liveStreak,
  localDay,
  nextSentenceStart,
  prevSentenceStart,
  sentenceStartOf,
  tokenizeWords,
  wordAtOffset,
  type SourceWord,
} from "@/lib/readAlong";
import { buildTextMap, caretFromPoint, HighlightPill, paintSentence, paintWordText, type TextMap } from "@/lib/readAlongDom";
import { ReadAlongPlayer, type ReadAlongEnd, type ReadAlongStatus, type ReadAlongVoice } from "@/lib/readAlongPlayer";

/**
 * Read-along for the Read tab: reads the page aloud with the same TTS Counsel
 * uses (Inworld voice when enabled, else the device voice), highlights each
 * word with a theme-coloured pill as it is spoken, auto-scrolls and turns
 * pages, and rewards listening with XP, levels, combos and a daily streak.
 *
 * It draws two things: the "Listen" button in the reader's bar, and — while
 * a session is on — the player, which takes the bar over (it is portalled
 * into `playerHost`). The rewards stay out of the way of the controls: a ring
 * round the Listen icon, and the numbers in the player's More menu.
 */

export interface ReadAlongProps {
  mode: "pdf" | "html";
  bookId: string;
  bookTitle: string;
  /** PDF: position:relative wrapper around the rendered page (holds the text layer). */
  pageHostRef: React.RefObject<HTMLDivElement>;
  /** PDF: the scrolling container around the page. */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** HTML: the book iframe, and its position:relative wrapper. */
  iframeRef: React.RefObject<HTMLIFrameElement>;
  htmlHostRef: React.RefObject<HTMLDivElement>;
  /** Bumps whenever the text layer (PDF) or iframe document (HTML) re-renders. */
  textVersion: number;
  page: number;
  hasNextPage: boolean;
  onNextPage: () => void;
  onStatusChange?: (status: ReadAlongStatus) => void;
  /** Where the player goes while a session is on: the reader bar's own row. */
  playerHost: HTMLElement | null;
  /** Narrow bar: icon over label, tighter player. */
  compact: boolean;
  /** The bar is at the bottom of the screen (phones): pop-ups open upward. */
  barAtBottom: boolean;
  /** Classes of a bar slot and its label, so Listen matches its neighbours. */
  slotClass: string;
  slotLabelClass: string;
  /** Any touch on the controls (keeps a phone's controls from hiding mid-use). */
  onInteract?: () => void;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const PAGE_BONUS_XP = 25;
const USER_SCROLL_GRACE_MS = 2500;
/** Sleep timer choices in minutes; "page" stops at the end of the current page. */
const SLEEP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "off", label: "Off" },
  { value: "page", label: "End of this page" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
];
type SleepTimer = { kind: "page" } | { kind: "time"; minutes: string; endsAt: number } | null;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type Celebration = { id: number; title: string; detail?: string; burst: boolean };

const ReadAlong: React.FC<ReadAlongProps> = (props) => {
  const { mode, bookId, bookTitle, textVersion, page, onStatusChange, playerHost, compact, barAtBottom, slotClass, slotLabelClass, onInteract } = props;
  const { user } = useAuth();
  const settings = useChatSettings();
  const { stats, latest: statsRef, update: updateStats, flush: flushStats } = useReadAlongStats(user?.id ?? null);

  // ── Voice & speed: default to exactly what Counsel uses ─────────────────
  const counselVoice: ReadAlongVoice = settings.inworldEnabled && settings.inworldVoiceId
    ? { engine: "inworld", inworldVoiceId: settings.inworldVoiceId }
    : { engine: "browser" };
  const [voiceOverride, setVoiceOverride] = useState<ReadAlongVoice | null>(null);
  const voice = voiceOverride ?? counselVoice;
  const [rateOverride, setRateOverride] = useState<number | null>(null);
  const rate = rateOverride ?? settings.ttsRate ?? 1;
  const [voices, setVoices] = useState<InworldVoice[] | null>(null);
  const loadVoices = useCallback(() => {
    if (voices || !settings.inworldEnabled) return;
    fetchInworldVoices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, [voices, settings.inworldEnabled]);

  // ── Session state ────────────────────────────────────────────────────────
  const [status, setStatus] = useState<ReadAlongStatus>("idle");
  const [wordPos, setWordPos] = useState({ index: 0, total: 0 });
  const [combo, setCombo] = useState(0);
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const active = status !== "idle";

  const playerRef = useRef<ReadAlongPlayer | null>(null);
  const sourceRef = useRef<{ map: TextMap; words: SourceWord[] } | null>(null);
  const pillRef = useRef<HighlightPill | null>(null);
  const lastCreditedRef = useRef(-1);
  const comboRef = useRef(0);
  const currentWordRef = useRef(-1);
  /** Set before we turn the page ourselves (or the user turns it mid-read). */
  const continueOnNextTextRef = useRef(false);
  /** Ignore the onEnd from stops we trigger internally (page flips, rebuilds). */
  const silentStopRef = useRef(false);
  const userScrolledAtRef = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  const celebrationTimer = useRef<number | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => onStatusChange?.(status), [status, onStatusChange]);

  // ── Sleep timer ──────────────────────────────────────────────────────────
  const [sleep, setSleep] = useState<SleepTimer>(null);
  const sleepRef = useRef<SleepTimer>(null);
  sleepRef.current = sleep;
  const [, setClock] = useState(0);

  const celebrate = useCallback((c: Omit<Celebration, "id">) => {
    if (celebrationTimer.current) window.clearTimeout(celebrationTimer.current);
    setCelebration({ ...c, id: Date.now() });
    celebrationTimer.current = window.setTimeout(() => setCelebration(null), 2400);
  }, []);

  // ── Placing the highlight ────────────────────────────────────────────────
  const placeWord = useCallback((index: number, follow: boolean) => {
    const src = sourceRef.current;
    const pill = pillRef.current;
    const w = src?.words[index];
    if (!src || !pill || !w) return;
    const range = src.map.rangeFor(w.start, w.end);
    const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
    const s0 = sentenceStartOf(src.words, index);
    const s1 = nextSentenceStart(src.words, index);
    const sentence = src.map.rangeFor(src.words[s0].start, src.words[s1 < 0 ? src.words.length - 1 : s1 - 1].end);
    const tint = primary ? `hsl(${primary} / 0.14)` : "rgba(128,128,128,0.16)";
    if (propsRef.current.mode === "html") {
      const iframe = propsRef.current.iframeRef.current;
      if (!iframe) return;
      const f = iframe.getBoundingClientRect();
      const rect = pill.place(range, { x: f.left, y: f.top });
      if (iframe.contentDocument) {
        // Theme's primary, read live so a theme switch recolours mid-read.
        paintWordText(iframe.contentDocument, range, primary ? `hsl(${primary})` : "Highlight");
        paintSentence(iframe.contentDocument, sentence, tint);
      }
      const win = iframe.contentWindow;
      if (follow && rect && win && Date.now() - userScrolledAtRef.current > USER_SCROLL_GRACE_MS) {
        const topInFrame = rect.top - f.top;
        if (topInFrame < f.height * 0.15 || rect.bottom - f.top > f.height * 0.7) {
          win.scrollBy({ top: topInFrame - f.height * 0.35, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        }
      }
      return;
    }
    const rect = pill.place(range);
    paintSentence(document, sentence, tint);
    const scroller = propsRef.current.scrollRef.current;
    if (follow && rect && scroller && Date.now() - userScrolledAtRef.current > USER_SCROLL_GRACE_MS) {
      const c = scroller.getBoundingClientRect();
      const dy = rect.top < c.top + c.height * 0.15 || rect.bottom > c.bottom - c.height * 0.3
        ? rect.top - (c.top + c.height * 0.35)
        : 0;
      const dx = rect.left < c.left + 16 || rect.right > c.right - 16 ? rect.left - (c.left + c.width * 0.3) : 0;
      if (dy || dx) scroller.scrollBy({ top: dy, left: dx, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }, []);

  // ── Credit (XP / combo / streak) ─────────────────────────────────────────
  const credit = useCallback((index: number) => {
    const last = lastCreditedRef.current;
    lastCreditedRef.current = index;
    const n = index - last;
    // Only sequential listening earns: a jump (tap, skip) re-anchors silently.
    if (last < -1 || n <= 0 || n > 3) return;
    comboRef.current += n;
    const r = creditWords(statsRef.current, n, comboRef.current, localDay(new Date()));
    updateStats(r.stats);
    setCombo(comboRef.current);
    if (r.leveledUp) celebrate({ title: `Level ${r.leveledUp}!`, detail: "Your listening levelled up", burst: true });
    else if (r.goalMet) celebrate({ title: `${r.stats.streak}-day streak`, detail: `Daily goal of ${DAILY_WORD_GOAL} words reached`, burst: true });
  }, [statsRef, updateStats, celebrate]);

  const clearHighlights = useCallback(() => {
    pillRef.current?.hide();
    paintSentence(document, null, "");
    const frameDoc = propsRef.current.iframeRef.current?.contentDocument;
    if (frameDoc) {
      paintWordText(frameDoc, null, "");
      paintSentence(frameDoc, null, "");
    }
  }, []);

  // ── Player ───────────────────────────────────────────────────────────────
  const handleEnd = useCallback((reason: ReadAlongEnd) => {
    flushStats();
    detachRef.current?.();
    detachRef.current = null;
    if (silentStopRef.current) {
      silentStopRef.current = false;
      return;
    }
    const p = propsRef.current;
    if (reason === "ended") {
      const s = statsRef.current;
      const before = levelInfo(s.xp).level;
      const next = { ...s, xp: s.xp + PAGE_BONUS_XP, pagesFinished: s.pagesFinished + 1 };
      updateStats(next);
      const after = levelInfo(next.xp).level;
      if (p.mode === "pdf" && p.hasNextPage && sleepRef.current?.kind !== "page") {
        celebrate(after > before
          ? { title: `Level ${after}!`, detail: `Page finished · +${PAGE_BONUS_XP} XP`, burst: true }
          : { title: `+${PAGE_BONUS_XP} XP`, detail: "Page finished — turning the page", burst: false });
        continueOnNextTextRef.current = true;
        // Keep the dock up across the page turn.
        setStatus("loading");
        p.onNextPage();
        return;
      }
      celebrate({ title: after > before ? `Level ${after}!` : "Finished!", detail: `+${PAGE_BONUS_XP} XP`, burst: true });
    }
    if (reason === "ended" && sleepRef.current?.kind === "page") {
      setSleep(null);
      toast.info("Sleep timer: stopped at the end of the page.");
    }
    clearHighlights();
    comboRef.current = 0;
    setCombo(0);
  }, [flushStats, statsRef, updateStats, celebrate, clearHighlights]);

  // The player is created once; it reaches the latest callbacks through refs
  // (the stats key changes when the signed-in user resolves).
  const handleEndRef = useRef(handleEnd);
  handleEndRef.current = handleEnd;
  const creditRef = useRef(credit);
  creditRef.current = credit;
  if (!playerRef.current) {
    playerRef.current = new ReadAlongPlayer({
      onWord: (i) => {
        currentWordRef.current = i;
        placeWord(i, true);
        creditRef.current(i);
        setWordPos((w) => ({ index: i, total: w.total }));
      },
      onStatus: (s) => {
        // An internal stop between pages must not collapse the dock.
        if (s === "idle" && continueOnNextTextRef.current) return;
        setStatus(s);
      },
      onEnd: (r) => handleEndRef.current(r),
      onNotice: (m) => toast.info(m),
    });
  }

  useEffect(() => () => {
    playerRef.current?.destroy();
    pillRef.current?.destroy();
    detachRef.current?.();
  }, []);

  // ── Building the text source from what's rendered ─────────────────────────
  const buildSource = useCallback((): { map: TextMap; words: SourceWord[]; host: HTMLElement; doc: Document } | null => {
    const p = propsRef.current;
    if (p.mode === "pdf") {
      const host = p.pageHostRef.current;
      const layer = host?.querySelector(".textLayer, .react-pdf__Page__textContent");
      if (!host || !layer) return null;
      const map = buildTextMap(layer);
      return { map, words: tokenizeWords(map.text), host, doc: document };
    }
    const iframe = p.iframeRef.current;
    const host = p.htmlHostRef.current;
    const body = iframe?.contentDocument?.body;
    if (!host || !body) return null;
    const map = buildTextMap(body);
    return { map, words: tokenizeWords(map.text), host, doc: iframe!.contentDocument! };
  }, []);

  const ensurePill = useCallback((host: HTMLElement) => {
    const p = propsRef.current;
    if (pillRef.current && host.contains(host.querySelector(".read-along-pill"))) return;
    pillRef.current?.destroy();
    pillRef.current = new HighlightPill(host, p.mode);
  }, []);

  /** Tap a word to jump there; manual scrolling pauses auto-follow briefly. */
  const attachInteractions = useCallback((doc: Document, host: HTMLElement) => {
    detachRef.current?.();
    const p = propsRef.current;
    const tapTarget: EventTarget = p.mode === "html" ? doc : host;
    const onTap = (e: Event) => {
      const me = e as MouseEvent;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const src = sourceRef.current;
      const caret = caretFromPoint(doc, me.clientX, me.clientY);
      if (!src || !caret) return;
      const off = src.map.offsetOf(caret.node, caret.offset);
      if (off < 0) return;
      const idx = wordAtOffset(src.words, off);
      lastCreditedRef.current = idx - 1;
      comboRef.current = 0;
      setCombo(0);
      userScrolledAtRef.current = 0;
      playerRef.current?.seek(idx);
    };
    const onUserScroll = () => { userScrolledAtRef.current = Date.now(); };
    const scrollTarget: EventTarget | null = p.mode === "html" ? doc : p.scrollRef.current;
    // In HTML books the iframe scrolls under a pill that lives outside it.
    let raf = 0;
    const onFrameScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (currentWordRef.current >= 0) placeWord(currentWordRef.current, false);
      });
    };
    tapTarget.addEventListener("click", onTap);
    scrollTarget?.addEventListener("wheel", onUserScroll, { passive: true });
    scrollTarget?.addEventListener("touchmove", onUserScroll, { passive: true });
    if (p.mode === "html") doc.addEventListener("scroll", onFrameScroll, { passive: true });
    const onResize = () => onFrameScroll();
    window.addEventListener("resize", onResize);
    detachRef.current = () => {
      tapTarget.removeEventListener("click", onTap);
      scrollTarget?.removeEventListener("wheel", onUserScroll);
      scrollTarget?.removeEventListener("touchmove", onUserScroll);
      doc.removeEventListener("scroll", onFrameScroll);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [placeWord]);

  const startReading = useCallback((fromStartOfPage: boolean) => {
    const src = buildSource();
    const p = propsRef.current;
    if (!src) {
      toast.error("The page text isn't ready yet — try again in a moment.");
      return;
    }
    if (!src.words.length) {
      if (p.mode === "pdf" && p.hasNextPage && continueOnNextTextRef.current) {
        // A blank or image-only page mid-session: keep going.
        p.onNextPage();
        return;
      }
      continueOnNextTextRef.current = false;
      setStatus("idle");
      toast.error("No readable text on this page (it may be a scanned image).");
      return;
    }
    continueOnNextTextRef.current = false;
    sourceRef.current = { map: src.map, words: src.words };
    ensurePill(src.host);
    attachInteractions(src.doc, src.host);
    let from = 0;
    if (!fromStartOfPage && p.mode === "html") {
      // Start at the first word visible in the iframe.
      const caret = caretFromPoint(src.doc, 24, 24);
      const off = caret ? src.map.offsetOf(caret.node, caret.offset) : -1;
      if (off >= 0) from = wordAtOffset(src.words, off);
    }
    lastCreditedRef.current = from - 1;
    userScrolledAtRef.current = 0;
    setWordPos({ index: from, total: src.words.length });
    playerRef.current!.start(src.map.text, src.words, from, voiceRef.current, rateRef.current);
  }, [buildSource, ensurePill, attachInteractions]);

  const stopReading = useCallback(() => {
    continueOnNextTextRef.current = false;
    playerRef.current?.stop("stopped");
    setStatus("idle");
    clearHighlights();
  }, [clearHighlights]);

  // New text rendered: continue a page turn, or re-map after a zoom re-render.
  useEffect(() => {
    if (continueOnNextTextRef.current) {
      startReading(true);
      return;
    }
    const player = playerRef.current;
    if (!player || player.state.status === "idle") return;
    const src = buildSource();
    if (!src || !src.words.length) return;
    sourceRef.current = { map: src.map, words: src.words };
    ensurePill(src.host);
    attachInteractions(src.doc, src.host);
    if (currentWordRef.current >= 0) placeWord(currentWordRef.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textVersion]);

  // The user turned the page mid-read: follow them to the new page.
  const lastPageRef = useRef(page);
  useEffect(() => {
    if (lastPageRef.current === page) return;
    lastPageRef.current = page;
    const player = playerRef.current;
    if (!player || continueOnNextTextRef.current) return;
    const s = player.state.status;
    if (s === "idle") return;
    const keepGoing = s === "playing" || s === "loading";
    silentStopRef.current = true;
    continueOnNextTextRef.current = keepGoing;
    player.stop("stopped");
    clearHighlights();
    lastCreditedRef.current = -2;
    if (!keepGoing) setStatus("idle");
  }, [page, clearHighlights]);

  // A different book: end the session.
  useEffect(() => {
    stopReading();
    pillRef.current?.destroy();
    pillRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Lock-screen / headset controls while reading (Chrome Android, desktop).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (!active) {
      for (const a of ["play", "pause", "stop"] as MediaSessionAction[]) {
        try { ms.setActionHandler(a, null); } catch { /* unsupported action */ }
      }
      return;
    }
    try {
      ms.metadata = new MediaMetadata({ title: bookTitle, artist: "Read-along" });
      ms.setActionHandler("play", () => playerRef.current?.resume());
      ms.setActionHandler("pause", () => playerRef.current?.pause());
      ms.setActionHandler("stop", () => stopReading());
    } catch {
      // Media Session partially supported: controls simply don't appear.
    }
  }, [active, bookTitle, stopReading]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current!;
    const s = player.state.status;
    if (s === "idle") startReading(false);
    else if (s === "paused") player.resume();
    else player.pause();
  }, [startReading]);

  /** Sentence skip: back restarts the sentence (or the previous one if just begun). */
  const skipSentence = useCallback((dir: -1 | 1) => {
    const src = sourceRef.current;
    const player = playerRef.current;
    if (!src || !player || player.state.status === "idle") return;
    const at = Math.max(0, currentWordRef.current);
    const to = dir < 0 ? prevSentenceStart(src.words, at) : nextSentenceStart(src.words, at);
    if (to < 0) return;
    lastCreditedRef.current = to - 1;
    comboRef.current = 0;
    setCombo(0);
    userScrolledAtRef.current = 0;
    player.seek(to);
  }, []);

  const changeVoice = (next: ReadAlongVoice) => {
    setVoiceOverride(next.engine === counselVoice.engine && next.inworldVoiceId === counselVoice.inworldVoiceId ? null : next);
    voiceRef.current = next;
    const player = playerRef.current!;
    if (player.state.status !== "idle" && sourceRef.current) {
      const at = Math.max(0, currentWordRef.current);
      lastCreditedRef.current = at - 1;
      player.start(sourceRef.current.map.text, sourceRef.current.words, at, next, rateRef.current);
    }
  };

  const cycleSpeed = () => {
    const i = SPEEDS.findIndex((s) => s >= rate - 0.01);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    setRateOverride(next);
    rateRef.current = next;
    playerRef.current?.setRate(next);
  };

  const chooseSleep = (value: string) => {
    if (value === "off") setSleep(null);
    else if (value === "page") setSleep({ kind: "page" });
    else setSleep({ kind: "time", minutes: value, endsAt: Date.now() + Number(value) * 60_000 });
  };

  // Timed sleep: pause when it runs out; tick the remaining-minutes label.
  useEffect(() => {
    if (sleep?.kind !== "time") return;
    const tick = window.setInterval(() => {
      if (Date.now() < sleep.endsAt) {
        setClock((n) => n + 1);
        return;
      }
      setSleep(null);
      if (playerRef.current && playerRef.current.state.status !== "idle") {
        playerRef.current.pause();
        toast.info("Sleep timer: reading paused.");
      }
    }, 5000);
    return () => window.clearInterval(tick);
  }, [sleep]);

  // While listening: Space play/pause, [ and ] skip a sentence.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "[") {
        skipSentence(-1);
      } else if (e.key === "]") {
        skipSentence(1);
      } else {
        return;
      }
      onInteract?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, togglePlay, skipSentence, onInteract]);

  // ── Derived display ───────────────────────────────────────────────────────
  const lvl = levelInfo(stats.xp);
  const today = localDay(new Date());
  const streak = liveStreak(stats, today);
  const todayWords = stats.day === today ? stats.todayWords : 0;
  const mult = comboMultiplier(combo);
  const pagePct = wordPos.total ? Math.min(100, Math.round(((wordPos.index + 1) / wordPos.total) * 100)) : 0;
  const voiceLabel = voice.engine === "inworld"
    ? (voices?.find((v) => v.voice_id === voice.inworldVoiceId)?.name ?? voice.inworldVoiceId ?? "Inworld")
    : "Device voice";
  const sleepValue = !sleep ? "off" : sleep.kind === "page" ? "page" : sleep.minutes;
  const sleepLabel = !sleep
    ? null
    : sleep.kind === "page"
      ? "End of page"
      : `${Math.max(1, Math.ceil((sleep.endsAt - Date.now()) / 60_000))}m`;
  const particles = useMemo(
    () => Array.from({ length: 14 }, (_, i) => ({ a: `${(360 / 14) * i}deg`, d: `${(i % 3) * 40}ms`, c: i % 2 ? "hsl(var(--primary))" : "hsl(var(--primary-container))" })),
    [],
  );
  /** The level as a ring: how far into the current level, no numbers. */
  const levelRing = (size: number, children: React.ReactNode) => (
    <span
      className="relative shrink-0 rounded-full grid place-items-center"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(hsl(var(--primary)) ${lvl.into / lvl.span}turn, hsl(var(--surface-container-highest)) 0)`,
      }}
    >
      <span className="absolute inset-[2px] rounded-full bg-surface-container-high grid place-items-center">{children}</span>
      {celebration?.burst && (
        <span key={celebration.id} aria-hidden>
          {particles.map((pt, i) => (
            <span key={i} className="ra-particle" style={{ "--a": pt.a, "--d": pt.d, "--c": pt.c } as React.CSSProperties} />
          ))}
        </span>
      )}
    </span>
  );

  const celebrationPop = celebration && (
    <div
      key={celebration.id}
      className={`ra-pop absolute left-1/2 -translate-x-1/2 whitespace-nowrap px-4 py-2 rounded-full bg-primary-container text-on-primary-container shadow-xl text-center z-10 ${barAtBottom ? "-top-14" : "top-full mt-3"}`}
      role="status"
    >
      <span className="font-headline font-bold text-sm">{celebration.title}</span>
      {celebration.detail && <span className="text-xs opacity-80 ml-2">{celebration.detail}</span>}
    </div>
  );

  const transportBtn =
    "shrink-0 grid place-items-center w-12 h-12 rounded-full text-foreground hover:bg-surface-container-highest active:scale-90 transition disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

  const skipButton = (dir: -1 | 1) => (
    <button
      type="button"
      onClick={() => skipSentence(dir)}
      aria-label={dir < 0 ? "Back one sentence" : "Forward one sentence"}
      title={dir < 0 ? "Back one sentence ([)" : "Forward one sentence (])"}
      className={transportBtn}
    >
      <span className="material-symbols-outlined text-2xl" aria-hidden>{dir < 0 ? "fast_rewind" : "fast_forward"}</span>
    </button>
  );

  const player = active && playerHost && createPortal(
    <div
      className="relative flex items-center w-full gap-1"
      role="region"
      aria-label="Listening controls"
      onPointerDown={() => onInteract?.()}
    >
      {celebrationPop}
      {/* How far through the page the voice is. */}
      <div
        className={`absolute inset-x-1 h-0.5 rounded-full bg-surface-container-highest overflow-hidden ${barAtBottom ? "-top-1" : "-bottom-0.5"}`}
        role="progressbar"
        aria-label={mode === "pdf" ? "Page progress" : "Progress"}
        aria-valuenow={pagePct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${pagePct}%` }} />
      </div>

      <span className="flex-1 flex items-center justify-start min-w-0">
        <button
          type="button"
          onClick={() => { cycleSpeed(); onInteract?.(); }}
          className="shrink-0 h-12 min-w-12 px-2 rounded-full hover:bg-surface-container-highest text-foreground font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label={`Speed ${rate}x. Tap to change.`}
          title="Reading speed"
        >
          {rate}×
        </button>
        {!compact && (
          <span className="ml-2 truncate text-xs text-on-surface-variant">
            {mode === "pdf" ? `Listening · page ${page}` : "Listening"}
          </span>
        )}
      </span>

      <span className="flex items-center gap-1">
        {skipButton(-1)}
        <button
          type="button"
          onClick={togglePlay}
          aria-label={status === "playing" || status === "loading" ? "Pause" : "Resume"}
          title="Play or pause (Space)"
          className={`shrink-0 rounded-full bg-primary-container text-on-primary-container grid place-items-center shadow-lg ${barAtBottom ? "w-12 h-12" : "w-11 h-11"} active:scale-90 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}
        >
          {status === "loading" ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>
              {status === "playing" ? "pause" : "play_arrow"}
            </span>
          )}
        </button>
        {skipButton(1)}
      </span>

      <span className="flex-1 flex items-center justify-end gap-1 min-w-0">
        <DropdownMenu onOpenChange={(o) => { if (o) loadVoices(); onInteract?.(); }}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={sleepLabel ? `Voice, sleep timer and progress. Sleep timer: ${sleepLabel}` : "Voice, sleep timer and progress"}
              title="Voice, sleep timer, progress"
              className={`${transportBtn} relative`}
            >
              <span className="material-symbols-outlined text-2xl" aria-hidden>more_horiz</span>
              {sleep && <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-primary" aria-hidden />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="font-normal">
              <span className="block font-semibold">Level {lvl.level} · {Math.floor(stats.xp).toLocaleString()} XP</span>
              <span className="block text-xs text-muted-foreground">
                {lvl.into}/{lvl.span} XP to the next level
                <br />
                {Math.min(todayWords, DAILY_WORD_GOAL)}/{DAILY_WORD_GOAL} words today
                {streak > 0 && <> · <span className="ra-flame" aria-hidden>🔥</span>{streak}-day streak</>}
                {mult > 1 && <> · ×{mult} combo</>}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">Voice</span>
                <span className="max-w-[7rem] truncate text-xs text-muted-foreground">{voiceLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[50dvh] overflow-y-auto">
                <DropdownMenuRadioGroup
                  value={voice.engine === "inworld" ? `inworld:${voice.inworldVoiceId}` : "browser"}
                  onValueChange={(v) => changeVoice(v === "browser" ? { engine: "browser" } : { engine: "inworld", inworldVoiceId: v.slice("inworld:".length) })}
                >
                  {counselVoice.engine === "inworld" && (
                    <DropdownMenuRadioItem value={`inworld:${counselVoice.inworldVoiceId}`}>
                      {voices?.find((v) => v.voice_id === counselVoice.inworldVoiceId)?.name ?? counselVoice.inworldVoiceId} (Counsel voice)
                    </DropdownMenuRadioItem>
                  )}
                  <DropdownMenuRadioItem value="browser">Device voice{counselVoice.engine === "browser" ? " (Counsel voice)" : ""}</DropdownMenuRadioItem>
                  {settings.inworldEnabled && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">Inworld voices</DropdownMenuLabel>
                      {voices === null && <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>}
                      {voices?.filter((v) => v.voice_id !== counselVoice.inworldVoiceId).map((v) => (
                        <DropdownMenuRadioItem key={v.voice_id} value={`inworld:${v.voice_id}`}>{v.name}</DropdownMenuRadioItem>
                      ))}
                    </>
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">Sleep timer</span>
                <span className="text-xs text-muted-foreground">{sleepLabel ?? "Off"}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={sleepValue} onValueChange={chooseSleep}>
                  {SLEEP_OPTIONS.map((o) => (
                    <DropdownMenuRadioItem key={o.value} value={o.value}>{o.label}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={stopReading}
          aria-label="Stop listening"
          title="Stop listening"
          className={`shrink-0 flex items-center justify-center gap-1 h-12 rounded-full text-foreground hover:bg-surface-container-highest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${compact ? "w-12" : "px-3"}`}
        >
          <span className="material-symbols-outlined text-2xl" aria-hidden>close</span>
          {!compact && <span className="font-label text-sm font-semibold">Stop</span>}
        </button>
      </span>
    </div>,
    playerHost,
  );

  return (
    <>
      <button
        type="button"
        onClick={() => { startReading(false); onInteract?.(); }}
        className={slotClass}
        title={`Read this page aloud · Level ${lvl.level}${streak > 0 ? ` · ${streak}-day streak` : ""}`}
        aria-label="Listen: read this page aloud"
      >
        {levelRing(26, <span className="material-symbols-outlined text-base text-primary" aria-hidden>graphic_eq</span>)}
        <span className={slotLabelClass}>Listen</span>
      </button>
      {player}
    </>
  );
};

export default ReadAlong;
