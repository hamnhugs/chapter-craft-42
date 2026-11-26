import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { useWakeLock } from "@/hooks/useWakeLock";
import { useReadAlongStats } from "@/hooks/useReadAlongStats";
import { fetchInworldVoices, type InworldVoice, type VoiceStyle } from "@/lib/inworldTts";
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
import { CastDirector, castBookStore, type CastBook, type CastState } from "@/lib/castVoices/director";
import CastVoicePrompt from "@/components/CastVoicePrompt";
import type { CastMember } from "@/lib/castVoices/attribute";
import { resolveUtilityModel } from "@/lib/chatHistory";
import { providerConfigured, providerKey, resolveModel } from "@/lib/providers/registry";
import { nvidiaNoThinkingBody } from "@/lib/nvidiaCatalog";
import { erasePageRecording, formatBytes, pageRecorder, pageRecordingInfo, pageScope, type PageRecordingInfo } from "@/lib/readRecordings";

/**
 * Read-along for the Read tab: reads the page aloud with the same TTS Chat
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

/**
 * Hands-free highlight colours, one per character in the order the book
 * introduced them. The Okabe–Ito set: told apart with any colour vision, and
 * all bright enough to read on a dimmed page. The narrator keeps the theme's.
 */
const SPEAKER_COLOURS = ["#56B4E9", "#E69F00", "#CC79A7", "#009E73", "#F0E442", "#D55E00"];

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type Celebration = { id: number; title: string; detail?: string; burst: boolean };

const ReadAlong: React.FC<ReadAlongProps> = (props) => {
  const { mode, bookId, bookTitle, textVersion, page, onStatusChange, playerHost, compact, barAtBottom, slotClass, slotLabelClass, onInteract } = props;
  const { user } = useAuth();
  const settings = useChatSettings();
  const { stats, latest: statsRef, update: updateStats, flush: flushStats } = useReadAlongStats(user?.id ?? null);

  // ── Voice & speed: default to exactly what Chat uses ─────────────────
  const voiceStyle: VoiceStyle = {
    model: settings.inworldModel,
    delivery: settings.inworldDelivery,
    direction: settings.inworldDirection,
    scene: "An audiobook narrator is reading a book aloud to one listener. This is the next passage.",
  };
  const counselVoice: ReadAlongVoice = settings.inworldEnabled && settings.inworldVoiceId
    ? { engine: "inworld", inworldVoiceId: settings.inworldVoiceId, style: voiceStyle }
    : { engine: "browser" };
  const [voiceOverride, setVoiceOverride] = useState<ReadAlongVoice | null>(null);
  const voice = voiceOverride ?? counselVoice;
  const [rateOverride, setRateOverride] = useState<number | null>(null);
  const rate = rateOverride ?? settings.ttsRate ?? 1;
  const [voices, setVoices] = useState<InworldVoice[] | null>(null);
  // One fetch of the catalog, shared by the Voice menu and the casting.
  const voicesPromiseRef = useRef<Promise<InworldVoice[]> | null>(null);
  const voiceCatalog = useCallback((): Promise<InworldVoice[]> => {
    if (!voicesPromiseRef.current) {
      voicesPromiseRef.current = fetchInworldVoices().then(
        (v) => { setVoices(v); return v; },
        () => { setVoices([]); voicesPromiseRef.current = null; return [] as InworldVoice[]; },
      );
    }
    return voicesPromiseRef.current;
  }, []);
  const loadVoices = useCallback(() => {
    if (voices || !settings.inworldEnabled) return;
    void voiceCatalog();
  }, [voices, settings.inworldEnabled, voiceCatalog]);

  // ── Character voices ─────────────────────────────────────────────────────
  // Each character speaks in their own voice; the narrator keeps everything
  // else, "she said" included. Worked out a page ahead of the voice by the
  // background model (castVoices/director.ts). On unless switched off; the
  // first time a character speaks, the listener is asked to pick their voice.
  const castPrefKey = `bw_cast_on_${user?.id ?? "anon"}`;
  const askPrefKey = `bw_cast_ask_${user?.id ?? "anon"}`;
  const [castOn, setCastOn] = useState(true);
  const [askOn, setAskOn] = useState(true);
  useEffect(() => {
    try {
      setCastOn(localStorage.getItem(castPrefKey) !== "0");
      setAskOn(localStorage.getItem(askPrefKey) !== "0");
    } catch { /* private mode */ }
  }, [castPrefKey, askPrefKey]);
  const castOnRef = useRef(castOn);
  castOnRef.current = castOn;
  const askOnRef = useRef(askOn);
  askOnRef.current = askOn;
  const [castState, setCastState] = useState<CastState | null>(null);
  /** The character whose voice the listener is being asked to pick. */
  const [voicePrompt, setVoicePrompt] = useState<{ member: CastMember; line: string; done: (v: string | null | undefined) => void } | null>(null);
  const voicePromptRef = useRef(voicePrompt);
  voicePromptRef.current = voicePrompt;
  const castFailNoticeRef = useRef(false);
  const [cast, setCast] = useState<CastMember[]>([]);
  const castBookRef = useRef<{ bookId: string; uid: string | null; book: CastBook } | null>(null);
  const directorRef = useRef<CastDirector | null>(null);
  /** What the page before said, when pages are read in order. */
  const carryRef = useRef<{ bookId: string; page: number; carry: ReturnType<CastDirector["carryOut"]> } | null>(null);
  const castNoticeRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const castBook = useCallback((): CastBook => {
    const uid = user?.id ?? null;
    const cur = castBookRef.current;
    if (cur && cur.bookId === bookId && cur.uid === uid) return cur.book;
    const book = castBookStore.load(uid, bookId);
    castBookRef.current = { bookId, uid, book };
    return book;
  }, [bookId, user?.id]);
  useEffect(() => { setCast(castBook().cast); }, [castBook]);

  /** One call to the background model: who says each numbered quote. */
  const castComplete = useCallback(async (messages: Array<{ role: "system" | "user"; content: string }>, signal?: AbortSignal) => {
    const s = settingsRef.current;
    const keys = { apiKey: s.apiKey, geminiApiKey: s.geminiApiKey, nvidiaKeyLast4: s.nvidiaKeyLast4 };
    const model = resolveUtilityModel(s.utilityModel, s.selectedModel);
    const { adapter, provider, localId } = resolveModel(model);
    if (!model || !providerConfigured(provider, keys)) {
      if (!castNoticeRef.current) {
        castNoticeRef.current = true;
        toast.info("Character voices need a chat model — add a model key in Settings. Reading in one voice for now.");
      }
      throw new Error("No model configured for character voices");
    }
    return adapter.completeChat({
      model: localId,
      // A page of dialogue is ~40 quotes ≈ 900 tokens of answer; the rest is
      // room for a model that thinks first.
      maxTokens: 3000,
      apiKey: providerKey(provider, keys),
      extraBody: provider === "nvidia" ? nvidiaNoThinkingBody(localId) : undefined,
      signal,
      messages,
    });
  }, []);

  /** `v` with a casting director for `text`, when character voices apply. */
  const withCast = useCallback((v: ReadAlongVoice, text: string): ReadAlongVoice => {
    const prev = directorRef.current;
    const p = propsRef.current;
    if (prev) {
      // Reading on in order: the next page hears who was just talking.
      carryRef.current = { bookId: p.bookId, page: lastCastPageRef.current, carry: prev.carryOut() };
      prev.dispose();
      directorRef.current = null;
    }
    if (!castOnRef.current || v.engine !== "inworld" || !v.inworldVoiceId) return { ...v, cast: null };
    const uid = user?.id ?? null;
    const book = castBook();
    const c = carryRef.current;
    const director = new CastDirector(text, {
      complete: castComplete,
      voices: voiceCatalog,
      narratorVoiceId: v.inworldVoiceId,
      bookTitle: p.bookTitle,
      book,
      save: (b) => castBookStore.save(uid, p.bookId, b),
      onCast: (members) => setCast(members),
      onState: (st) => {
        setCastState(st);
        if ((st.phase === "failed" || st.phase === "novoices") && !castFailNoticeRef.current) {
          castFailNoticeRef.current = true;
          toast.info(st.phase === "failed"
            ? `Character voices: couldn't work out who is speaking (${st.error.slice(0, 120)}). Reading in one voice for now.`
            : "Character voices: no other voices are available for the cast.");
        }
      },
      ask: () => askOnRef.current,
      choose: (member, line) => {
        void voiceCatalog();
        return new Promise((done) => {
          voicePromptRef.current?.done(undefined);
          setVoicePrompt({ member, line, done });
        });
      },
      carry: c && c.bookId === p.bookId && (p.mode === "html" || c.page === p.page - 1 || c.page === p.page) ? c.carry : undefined,
    });
    lastCastPageRef.current = p.page;
    directorRef.current = director;
    return { ...v, cast: director };
  }, [castBook, castComplete, voiceCatalog, user?.id]);
  const lastCastPageRef = useRef(page);

  // ── Recording ────────────────────────────────────────────────────────────
  // What an Inworld voice says is kept on this device, a page at a time, so
  // the next listen plays it back instead of paying for it again
  // (lib/readRecordings.ts). The device voice cannot be recorded.
  const scope = pageScope(user?.id ?? null, bookId, mode === "pdf" ? `p${page}` : "all");
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [recInfo, setRecInfo] = useState<PageRecordingInfo>({ clips: 0, bytes: 0 });
  const refreshRecInfo = useCallback(() => {
    const asked = scopeRef.current;
    void pageRecordingInfo(asked).then((info) => { if (scopeRef.current === asked) setRecInfo(info); });
  }, []);
  useEffect(() => { setRecInfo({ clips: 0, bytes: 0 }); refreshRecInfo(); }, [scope, refreshRecInfo]);
  const recTimer = useRef<number | null>(null);
  /** `v` with this page's recording to play from and add to. */
  const withRecording = useCallback((v: ReadAlongVoice): ReadAlongVoice => {
    if (v.engine !== "inworld" || !v.inworldVoiceId) return v;
    const at = pageScope(user?.id ?? null, propsRef.current.bookId, propsRef.current.mode === "pdf" ? `p${propsRef.current.page}` : "all");
    return {
      ...v,
      recordings: pageRecorder(at, () => {
        // A page is a dozen clips arriving one after another: count once.
        if (recTimer.current) window.clearTimeout(recTimer.current);
        recTimer.current = window.setTimeout(refreshRecInfo, 800);
      }),
    };
  }, [user?.id, refreshRecInfo]);
  /** Is the voice now heard from the recording, or being recorded? */
  const [source, setSource] = useState<"recorded" | "fresh" | null>(null);

  // ── Hands-free ───────────────────────────────────────────────────────────
  // The page dims, the screen stays awake, and the word being spoken is lit
  // in a colour of its speaker's own.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;
  const [speaker, setSpeaker] = useState<string | null>(null);
  const speakerRef = useRef<string | null>(null);
  const castRef = useRef<CastMember[]>([]);
  const speakerColour = useCallback((name: string | null): string | null => {
    if (!name) return null;
    const i = castRef.current.findIndex((m) => m.name === name);
    return SPEAKER_COLOURS[(i < 0 ? name.length : i) % SPEAKER_COLOURS.length];
  }, []);

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
    // Hands-free: the highlight is the speaker's colour, the narrator's the theme's.
    const lit = handsFreeRef.current ? speakerColour(speakerRef.current) : null;
    pill.tint(lit);
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
        paintWordText(iframe.contentDocument, range, lit ?? (primary ? `hsl(${primary})` : "Highlight"));
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
  }, [speakerColour]);

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
      onSpeaker: (name) => { speakerRef.current = name; setSpeaker(name); },
      onSource: (src) => setSource(src),
    });
  }

  useEffect(() => () => {
    playerRef.current?.destroy();
    pillRef.current?.destroy();
    detachRef.current?.();
    directorRef.current?.dispose();
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
    playerRef.current!.start(src.map.text, src.words, from, withRecording(withCast(voiceRef.current, src.map.text)), rateRef.current);
  }, [buildSource, ensurePill, attachInteractions, withCast, withRecording]);

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
    directorRef.current?.dispose();
    directorRef.current = null;
    carryRef.current = null;
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

  /** Carry on from the current word with the voices as they now stand. */
  const restartHere = useCallback(() => {
    const player = playerRef.current!;
    if (player.state.status === "idle" || !sourceRef.current) return;
    const at = Math.max(0, currentWordRef.current);
    lastCreditedRef.current = at - 1;
    player.start(sourceRef.current.map.text, sourceRef.current.words, at, withRecording(withCast(voiceRef.current, sourceRef.current.map.text)), rateRef.current);
  }, [withCast, withRecording]);

  /** Throw this page's recording away; if reading, read it again from the top. */
  const recordOver = useCallback(async () => {
    try {
      await erasePageRecording(scopeRef.current);
    } catch {
      toast.error("Couldn't clear this page's recording.");
      return;
    }
    refreshRecInfo();
    const player = playerRef.current;
    const src = sourceRef.current;
    if (player && src && player.state.status !== "idle") {
      lastCreditedRef.current = -2;
      comboRef.current = 0;
      setCombo(0);
      player.start(src.map.text, src.words, 0, withRecording(withCast(voiceRef.current, src.map.text)), rateRef.current);
      toast.success("Recording this page again from the top.");
    } else {
      toast.success("Recording cleared. The next listen records this page again.");
    }
  }, [refreshRecInfo, withCast, withRecording]);

  // Hands-free ends with the session; while it is on, the page is dimmed and
  // the screen is kept awake (the lock is dropped by the browser whenever the
  // tab is hidden, so it is asked for again on the way back).
  useEffect(() => {
    if (status === "idle") { setHandsFree(false); setSource(null); speakerRef.current = null; setSpeaker(null); }
  }, [status]);
  const dimmed = handsFree && active;
  useWakeLock(dimmed);
  useEffect(() => {
    if (!dimmed) return;
    const root = document.documentElement;
    const p = propsRef.current;
    const hosts = [p.pageHostRef.current, p.htmlHostRef.current].filter((h): h is HTMLDivElement => !!h);
    root.setAttribute("data-ra-handsfree", "");
    for (const h of hosts) h.setAttribute("data-ra-dim", "");
    p.scrollRef.current?.setAttribute("data-ra-dark", "");
    if (currentWordRef.current >= 0) placeWord(currentWordRef.current, false);
    return () => {
      root.removeAttribute("data-ra-handsfree");
      for (const h of hosts) h.removeAttribute("data-ra-dim");
      p.scrollRef.current?.removeAttribute("data-ra-dark");
      pillRef.current?.tint(null);
    };
    // textVersion: a re-rendered page is a new host to dim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimmed, textVersion, mode]);
  // The speaker changed: recolour the word already lit.
  useEffect(() => {
    if (dimmed && currentWordRef.current >= 0) placeWord(currentWordRef.current, false);
  }, [dimmed, speaker, placeWord]);

  const changeVoice = (next: ReadAlongVoice) => {
    setVoiceOverride(next.engine === counselVoice.engine && next.inworldVoiceId === counselVoice.inworldVoiceId ? null : next);
    voiceRef.current = next;
    restartHere();
  };

  // Reading stopped while the question was up: put it away unanswered.
  useEffect(() => {
    if (status === "idle" && voicePromptRef.current) {
      const p = voicePromptRef.current;
      setVoicePrompt(null);
      p.done(undefined);
    }
  }, [status]);

  const answerVoicePrompt = (v: string | null | undefined) => {
    const p = voicePromptRef.current;
    if (!p) return;
    setVoicePrompt(null);
    p.done(v);
  };
  const toggleAsk = (on: boolean) => {
    setAskOn(on);
    askOnRef.current = on;
    try { localStorage.setItem(askPrefKey, on ? "1" : "0"); } catch { /* private mode */ }
  };

  const toggleCast = (on: boolean) => {
    setCastOn(on);
    castOnRef.current = on;
    try { localStorage.setItem(castPrefKey, on ? "1" : "0"); } catch { /* private mode */ }
    if (on) void voiceCatalog();
    else setCastState(null);
    restartHere();
  };

  /** The listener picks a character's voice: it sticks, on every page. */
  const recast = (memberId: string, voiceId: string) => {
    const book = castBook();
    book.cast = book.cast.map((m) => (m.id === memberId ? { ...m, voiceId, locked: true, asked: true } : m));
    castBookStore.save(user?.id ?? null, bookId, book);
    setCast(book.cast);
    restartHere();
  };

  const forgetCast = () => {
    castBookStore.clear(user?.id ?? null, bookId);
    castBookRef.current = null;
    carryRef.current = null;
    setCast([]);
    restartHere();
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
  /** Who has spoken, leads first — the Cast menu. */
  const speakers = useMemo(() => [...cast].sort((a, b) => b.lines - a.lines).slice(0, 40), [cast]);
  castRef.current = cast;
  const canRecord = voice.engine === "inworld";
  const recorded = recInfo.clips > 0;
  const recLine = !canRecord
    ? "The device voice can't be recorded."
    : recorded
      ? `This page is recorded (${formatBytes(recInfo.bytes)}). It plays back without paying for the voice again.`
      : "Recorded as it is read, so the next listen is free.";
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
                  onValueChange={(v) => changeVoice(v === "browser" ? { engine: "browser" } : { engine: "inworld", inworldVoiceId: v.slice("inworld:".length), style: voiceStyle })}
                >
                  {counselVoice.engine === "inworld" && (
                    <DropdownMenuRadioItem value={`inworld:${counselVoice.inworldVoiceId}`}>
                      {voices?.find((v) => v.voice_id === counselVoice.inworldVoiceId)?.name ?? counselVoice.inworldVoiceId} (Chat voice)
                    </DropdownMenuRadioItem>
                  )}
                  <DropdownMenuRadioItem value="browser">Device voice{counselVoice.engine === "browser" ? " (Chat voice)" : ""}</DropdownMenuRadioItem>
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
            {voice.engine === "inworld" && (
              <>
                <DropdownMenuCheckboxItem
                  checked={castOn}
                  onCheckedChange={(v) => toggleCast(v === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="flex-1">Character voices</span>
                </DropdownMenuCheckboxItem>
                {castOn && (
                  <DropdownMenuCheckboxItem
                    checked={askOn}
                    onCheckedChange={(v) => toggleAsk(v === true)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="flex-1">Ask me for each voice</span>
                  </DropdownMenuCheckboxItem>
                )}
                {castOn && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <span className="flex-1">Cast</span>
                      <span className="text-xs text-muted-foreground">{speakers.length || "None yet"}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-[50dvh] w-60 overflow-y-auto">
                      {castState?.phase === "working" && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">Working out who is speaking…</div>
                      )}
                      {castState?.phase === "failed" && (
                        <div className="px-2 py-1.5 text-xs text-destructive">Couldn't work out the speakers: {castState.error.slice(0, 140)}</div>
                      )}
                      {speakers.length === 0 && castState?.phase !== "working" && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          Characters appear here as they speak. The narrator reads everything else.
                        </div>
                      )}
                      {speakers.map((m) => (
                        <DropdownMenuSub key={m.id}>
                          <DropdownMenuSubTrigger>
                            <span className="flex-1 truncate">{m.name}</span>
                            <span className="max-w-[6rem] truncate text-xs text-muted-foreground">
                              {voices?.find((v) => v.voice_id === m.voiceId)?.name ?? m.voiceId ?? "Narrator"}
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="max-h-[50dvh] overflow-y-auto">
                            <DropdownMenuRadioGroup value={m.voiceId ?? ""} onValueChange={(v) => recast(m.id, v)}>
                              {voices === null && <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>}
                              {voices?.map((v) => (
                                <DropdownMenuRadioItem key={v.voice_id} value={v.voice_id}>{v.name}</DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      ))}
                      {speakers.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={forgetCast}>Start the cast over</DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
              </>
            )}
            <DropdownMenuCheckboxItem
              checked={handsFree}
              onCheckedChange={(v) => setHandsFree(v === true)}
            >
              <span className="flex-1">Hands-free</span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">{recLine}</DropdownMenuLabel>
            {canRecord && (
              <DropdownMenuItem disabled={!recorded} onSelect={() => void recordOver()}>
                <span className="material-symbols-outlined text-base mr-2" aria-hidden>fiber_manual_record</span>
                Record over this page
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
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
      <DropdownMenu onOpenChange={() => onInteract?.()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={slotClass}
            title={`Read this page aloud · Level ${lvl.level}${streak > 0 ? ` · ${streak}-day streak` : ""}`}
            aria-label="Listen: read this page aloud"
          >
            {levelRing(26, <span className="material-symbols-outlined text-base text-primary" aria-hidden>graphic_eq</span>)}
            <span className={slotLabelClass}>Listen</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side={barAtBottom ? "top" : "bottom"} className="w-72">
          <DropdownMenuItem onSelect={() => { setHandsFree(false); startReading(false); }}>
            <span className="material-symbols-outlined text-xl mr-3" aria-hidden>graphic_eq</span>
            <span className="flex flex-col">
              <span className="font-semibold">Listen</span>
              <span className="text-xs text-muted-foreground">Read this page aloud and follow the words.</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setHandsFree(true); startReading(false); }}>
            <span className="material-symbols-outlined text-xl mr-3" aria-hidden>bedtime</span>
            <span className="flex flex-col">
              <span className="font-semibold">Hands-free</span>
              <span className="text-xs text-muted-foreground">The screen stays on and dims. Each character's words light up in their own colour.</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">{recLine}</DropdownMenuLabel>
          {canRecord && recorded && (
            <DropdownMenuItem onSelect={() => void recordOver()}>
              <span className="material-symbols-outlined text-xl mr-3" aria-hidden>fiber_manual_record</span>
              Record over this page
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {player}
      {dimmed && createPortal(
        <div className="ra-handsfree-caption" role="status" aria-live="off">
          <span className="ra-handsfree-dot" style={{ background: speakerColour(speaker) ?? "var(--ra-narrator)" }} aria-hidden />
          <span className="truncate">{speaker ?? "Narrator"}</span>
          {source && canRecord && (
            <span className="material-symbols-outlined text-sm opacity-70" title={source === "recorded" ? "Playing your recording" : "Recording"} aria-label={source === "recorded" ? "Playing your recording" : "Recording"}>
              {source === "recorded" ? "download_done" : "fiber_manual_record"}
            </span>
          )}
          <button type="button" className="ra-handsfree-exit" onClick={() => setHandsFree(false)} aria-label="Leave hands-free: bring the lights back up" title="Lights up">
            <span className="material-symbols-outlined text-base" aria-hidden>light_mode</span>
          </button>
        </div>,
        document.body,
      )}
      {voicePrompt && (
        <CastVoicePrompt
          key={voicePrompt.member.id}
          member={voicePrompt.member}
          line={voicePrompt.line}
          voices={voices}
          narratorVoiceId={voice.inworldVoiceId || ""}
          style={voice.style}
          onDone={answerVoicePrompt}
          onStopAsking={() => { toggleAsk(false); answerVoicePrompt(null); }}
        />
      )}
    </>
  );
};

export default ReadAlong;
