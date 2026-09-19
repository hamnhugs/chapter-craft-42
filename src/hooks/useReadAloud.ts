import { useCallback, useEffect, useRef, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { synthesizeSpeech } from "@/lib/inworldTts";
import { computeBackTarget, computeForwardTarget, type SeekPos } from "@/lib/ttsSeek";
import {
  addTtsChunkAt,
  beginTtsCapture,
  completeTtsCapture,
  discardTtsCapture,
} from "@/lib/ttsAudioCache";

// Unified read-aloud for the merged Chat ("Talk") surface.
//
// Plays a message using the Inworld character voice when the user has it
// enabled, and transparently falls back to the browser SpeechSynthesis voice
// otherwise (or if an Inworld synthesis fails). Tracks a single "speaking id"
// so per-message read-aloud buttons can toggle play/stop and reflect state.
//
// LATENCY: the message is split into sentence-sized chunks and the FIRST chunk
// starts playing while the rest are still being prepared. The browser engine
// otherwise synthesizes the whole message before emitting a single word (its
// latency scales with text length), and Inworld would otherwise round-trip the
// entire reply before any audio — so chunking is what makes time-to-first-audio
// short enough to feel hands-free. For Inworld we pipeline: chunk N+1 is
// requested while chunk N is still playing, so playback stays gap-free.
//
// SEEKING: the same sentence chunks double as the seek timeline. The Inworld
// path plays real audio files whose durations become known as they play, so
// ±10s is walked exactly across chunk boundaries (snapping to a sentence
// start where a duration is unknown), and backward jumps replay the cached
// MP3 buffers — never a second billed synthesis. The browser engine has no
// time axis at all (no seek API, and estimating time from text is forbidden
// here), so its skip unit is the sentence chunk: cancel and re-enqueue from
// the target chunk. `progress` exposes the chunk being spoken for the
// mini-player UI, and `mode` tells it which skip semantics to label.
//
// COMPLETION CONTRACT: every speak() session settles its onDone callback
// EXACTLY ONCE with a reason — hands-free drives its whole state machine off
// this, so "did the audio really finish?" must never be guessed from timers:
//   • "ended"      — playback finished naturally (onEnd fires too)
//   • "stopped"    — stop() was called (toggle off, clear chat, unmount)
//   • "superseded" — a newer speak() replaced this session
//   • "error"      — playback could not proceed (autoplay-blocked, stalled)
// Seeking happens strictly INSIDE a session: a skip never settles onDone and
// always bumps the progress heartbeat, so the watchdog and the hands-free FSM
// are blind to it. Real playout events are the completion signals (final
// chunk `ended` / utterance onend); a heartbeat watchdog reaps genuinely
// stalled sessions (Chrome drops speechSynthesis onend for network voices —
// Chromium 41346274 — and a rejected play() would otherwise hang a session
// forever). The watchdog measures PROGRESS, never total duration: audio that
// is audibly playing can run for any length of time without being reaped.

export type SpeakEndReason = "ended" | "stopped" | "superseded" | "error";

export type ReadAloudMode = "inworld" | "browser";

export interface ReadAloudProgress {
  /** The speaking id of the session (matches speakingId). */
  id: string;
  /** Index of the sentence chunk currently being spoken. */
  index: number;
  /** Total sentence chunks in the message. */
  total: number;
  /** The chunk's text — the mini-player's place-keeping snippet. */
  text: string;
  /** Which engine is speaking — decides skip semantics (±10s vs sentence). */
  mode: ReadAloudMode;
}

/** No audible/synth progress for this long = the session is stuck. */
const STALL_MS = 12000;
/** Skip step for the time-seekable (Inworld) path. */
const SKIP_SECONDS = 10;
/** Resuming after a pause longer than this rewinds to the sentence start
 *  (context reinstatement — the Pocket Casts / Audible pattern). */
const SMART_RESUME_MS = 60_000;

const stripMarkdownForTts = (s: string) =>
  (s || "")
    .replace(/[#*_`~\[\]()>|]/g, "")
    .replace(/\n+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();

// Sentence chunking. We keep the first chunk short so audio starts fast, then
// pack the rest up to ~MAX_CHUNK so we don't fire dozens of tiny requests.
const MAX_CHUNK = 240;
const MIN_CHUNK = 16;

function splitIntoChunks(text: string): string[] {
  const rough = text.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  let pending = "";
  const flush = () => {
    const t = pending.trim();
    if (t) out.push(t);
    pending = "";
  };
  for (const part of rough) {
    if (!part) continue;
    // A single very long "sentence" (no terminal punctuation, run-on, or a
    // list flattened into one line): break it on clause boundaries so the
    // engine still gets bite-sized work and we keep prosodic pauses.
    if (part.length > MAX_CHUNK) {
      flush();
      let buf = "";
      for (const clause of part.split(/(?<=[,;:])\s+/)) {
        if (buf && (buf.length + clause.length + 1) > MAX_CHUNK) {
          out.push(buf.trim());
          buf = clause;
        } else {
          buf = buf ? `${buf} ${clause}` : clause;
        }
      }
      if (buf.trim()) out.push(buf.trim());
      continue;
    }
    pending = pending ? `${pending} ${part}` : part;
    // Don't emit micro-fragments ("Sure.", "Yes!") on their own — merge them
    // forward so the first spoken chunk is a real clause.
    if (pending.length >= MIN_CHUNK) flush();
  }
  flush();
  if (out.length) return out;
  const t = text.trim();
  return t ? [t] : [];
}

// Some browsers populate getVoices() asynchronously; speaking before voices
// load can drop or silence the first utterance. Resolve once voices exist (or
// after a short cap so we never hang).
function ensureVoices(synth: SpeechSynthesis): Promise<void> {
  if (synth.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      try { synth.removeEventListener("voiceschanged", finish); } catch { /* no-op */ }
      resolve();
    };
    try { synth.addEventListener("voiceschanged", finish); } catch { /* no-op */ }
    const poll = setInterval(() => { if (synth.getVoices().length) finish(); }, 250);
    setTimeout(finish, 2000);
  });
}

const clampRate = (r: number | undefined, fallback: number) => {
  const v = typeof r === "number" && Number.isFinite(r) && r > 0 ? r : fallback;
  return Math.min(2, Math.max(0.5, v));
};

export interface SpeakOptions {
  /** Stable id driving the per-message toggle/stop UI. */
  id?: string;
  /** Fired only on natural completion (legacy shorthand for reason "ended"). */
  onEnd?: () => void;
  /** Fired exactly once, on EVERY terminal path, with the reason. */
  onDone?: (r: { reason: SpeakEndReason }) => void;
  /** Per-call playback rate override (else the ttsRate setting). */
  rate?: number;
}

export interface ReadAloudController {
  /** Id of the message currently being spoken, or null. */
  speakingId: string | null;
  isSpeaking: boolean;
  /** The sentence chunk being spoken right now — drives the mini-player. */
  progress: ReadAloudProgress | null;
  /** True while playback is paused in place (the session stays live). */
  isPaused: boolean;
  speak: (text: string, opts?: SpeakOptions) => void;
  /** Stop any in-flight synthesis/playback (settles the session "stopped"). */
  stop: () => void;
  /** Pause playback in place (barge-in verification) — session stays live. */
  pause: () => void;
  /** Resume playback paused by pause(). */
  resume: () => void;
  /** User-facing pause/resume toggle (smart-rewinds after a long pause). */
  togglePause: () => void;
  /** Seek ~10s back (Inworld) / previous sentence (browser voice). */
  skipBack: () => void;
  /** Seek ~10s forward (Inworld) / next sentence (browser voice). */
  skipForward: () => void;
  /** True while ANY app audio could be audible: a live speak session (even
   *  mid-fetch), a busy speechSynthesis engine (incl. other components like
   *  the PDF reader), or an unpaused audio element. The hands-free mic gate. */
  isAudioActive: () => boolean;
}

interface SessionCallbacks {
  session: number;
  onEnd?: () => void;
  onDone?: (r: { reason: SpeakEndReason }) => void;
  settled: boolean;
}

/** Per-session seek state: the chunk timeline and where we are on it. */
interface SeekSession {
  session: number;
  id: string;
  chunks: string[];
  rate: number;
  mode: ReadAloudMode;
  /** Chunk currently being spoken (or about to be). */
  index: number;
  /** Measured audio duration per chunk (Inworld; null until played). */
  durations: (number | null)[];
  /** Fetched MP3 per chunk (Inworld) — backward seeks replay these free. */
  buffers: (ArrayBuffer | null)[];
  /** Pending cross-chunk jump for the Inworld loop to consume. */
  seekTo: SeekPos | null;
  /** Browser path: bumped on every (re-)enqueue so utterance events from a
   *  cancelled batch are inert (cancel fires their onend/onerror async). */
  enqueueGen: number;
}

export function useReadAloud(): ReadAloudController {
  const { ttsRate, inworldEnabled, inworldApiKey, inworldVoiceId } = useChatSettings();
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReadAloudProgress | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const synthRef = useRef<SpeechSynthesis | null>(
    typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null,
  );
  // Monotonic token: bumped on every terminate/new speak() so stale async
  // chunk work (in-flight Inworld fetches, queued utterances) can detect it's
  // been superseded and bail instead of stomping the current playback.
  const sessionRef = useRef(0);
  const cbRef = useRef<SessionCallbacks | null>(null);
  const activeSessionRef = useRef(false);
  const pausedRef = useRef(false);
  const pausedAtRef = useRef(0);
  const seekStateRef = useRef<SeekSession | null>(null);
  // Browser path re-enqueue entry point, bound to the live session's chunk
  // list by browserSpeakChunks — how browserSkipTo restarts from a chunk.
  const enqueueRef = useRef<((from: number) => void) | null>(null);
  // The in-flight MP3 chunk's blob URL + playBuffer resolver. terminate()
  // releases both — otherwise every mid-chunk stop/supersede leaks the blob
  // (URL registry entries survive GC) and strands the chunk loop's await.
  const currentUrlRef = useRef<string | null>(null);
  const playResolveRef = useRef<((s: "ok" | "blocked") => void) | null>(null);
  // Watchdog state: heartbeat bumped by real progress events; the interval
  // reaps stalled sessions and detects dropped final-utterance events.
  const watchdogRef = useRef<number | null>(null);
  const heartbeatRef = useRef(0);
  const lastEnqueuedRef = useRef(false); // browser path: final chunk queued
  const browserIdleTicksRef = useRef(0);

  const defaultRate = ttsRate || 1.05;

  const clearId = useCallback((id: string) => {
    setSpeakingId((cur) => (cur === id ? null : cur));
  }, []);

  const bumpHeartbeat = useCallback(() => { heartbeatRef.current = Date.now(); }, []);

  const stopWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      window.clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  /** Settle the given session's callbacks exactly once. Returns whether this
   *  call was the one that settled it. */
  const settleSession = useCallback((session: number, reason: SpeakEndReason): boolean => {
    const cur = cbRef.current;
    if (!cur || cur.session !== session || cur.settled) return false;
    cur.settled = true;
    activeSessionRef.current = false;
    lastEnqueuedRef.current = false;
    // Disarm the seek machinery WITH the settle: settling doesn't bump
    // sessionRef, so a skip/pause click racing the mini-player's unmount
    // would otherwise pass the session guard and re-enqueue audible speech
    // on a session whose onDone already fired (the FSM believes audio is
    // over and may open the mic on top of it).
    if (seekStateRef.current?.session === session) {
      seekStateRef.current = null;
      enqueueRef.current = null;
    }
    stopWatchdog();
    if (reason === "ended") { try { cur.onEnd?.(); } catch { /* listener error */ } }
    try { cur.onDone?.({ reason }); } catch { /* listener error */ }
    return true;
  }, [stopWatchdog]);

  /** Tear down the current session (if any): settle callbacks with `reason`,
   *  silence everything, invalidate stale async work. */
  const terminate = useCallback((reason: SpeakEndReason) => {
    settleSession(sessionRef.current, reason);
    sessionRef.current += 1;
    pausedRef.current = false;
    // Unconditional (settleSession early-returns on an already-settled
    // session): a stale true here would let the next session's watchdog
    // idle-tick declare "ended" before its first chunk even fetched.
    lastEnqueuedRef.current = false;
    setIsPaused(false);
    seekStateRef.current = null;
    enqueueRef.current = null;
    setProgress(null);
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* no-op */ }
      abortRef.current = null;
    }
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* no-op */ }
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onloadedmetadata = null;
      try { audioRef.current.src = ""; } catch { /* no-op */ }
    }
    // Release the in-flight chunk: revoke its blob URL and resolve the
    // suspended playBuffer so the (now stale-sessioned) chunk loop exits.
    if (currentUrlRef.current) {
      try { URL.revokeObjectURL(currentUrlRef.current); } catch { /* no-op */ }
      currentUrlRef.current = null;
    }
    const pendingResolve = playResolveRef.current;
    playResolveRef.current = null;
    pendingResolve?.("ok");
    try { synthRef.current?.cancel(); } catch { /* no-op */ }
    // cancel() empties the queue but does NOT clear a paused engine (Chrome):
    // without this, a barge-in commit while paused would leave EVERY future
    // browser-voice utterance silently queued behind a paused engine.
    try { if (synthRef.current?.paused) synthRef.current.resume(); } catch { /* no-op */ }
    setSpeakingId(null);
  }, [settleSession]);

  const stop = useCallback(() => terminate("stopped"), [terminate]);

  // Pause/resume in place — used by the mini-player and by hands-free
  // barge-in verification, so a false alarm (cough, background noise) can
  // RESUME instead of restarting the reply. The session stays live; the
  // watchdog idles while paused.
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    pausedAtRef.current = Date.now();
    setIsPaused(true);
    try { audioRef.current?.pause(); } catch { /* no-op */ }
    try { if (synthRef.current?.speaking) synthRef.current.pause(); } catch { /* no-op */ }
  }, []);

  /** Cancel-and-re-enqueue from a chunk — the browser engine's only "seek".
   *  Skipping while paused resumes playback: Chrome leaves new utterances
   *  silently queued behind a paused engine, so staying paused across a
   *  re-enqueue is not implementable honestly. */
  const browserSkipTo = useCallback((target: number) => {
    const st = seekStateRef.current;
    const synth = synthRef.current;
    if (!st || st.session !== sessionRef.current || !synth) return;
    bumpHeartbeat();
    pausedRef.current = false;
    setIsPaused(false);
    st.enqueueGen += 1; // deaden the cancelled batch's async onend/onerror
    if (target >= st.chunks.length) {
      // Forward past the last sentence = finish the read (a real terminal).
      lastEnqueuedRef.current = false;
      try { synth.cancel(); } catch { /* no-op */ }
      try { if (synth.paused) synth.resume(); } catch { /* no-op */ }
      clearId(st.id);
      setProgress(null);
      settleSession(st.session, "ended");
      return;
    }
    if (!enqueueRef.current) return;
    lastEnqueuedRef.current = false;
    browserIdleTicksRef.current = 0;
    try { synth.cancel(); } catch { /* no-op */ }
    try { if (synth.paused) synth.resume(); } catch { /* no-op */ }
    st.index = target;
    setProgress({ id: st.id, index: target, total: st.chunks.length, text: st.chunks[target], mode: "browser" });
    // Chrome can silently drop an utterance spoken in the same task as
    // cancel() — and a dropped batch here would trip the watchdog's
    // idle-tick into a premature "ended". One macrotask of air plus the
    // voices gate; the gen check makes rapid presses last-writer-wins.
    const genAtSkip = st.enqueueGen;
    window.setTimeout(() => {
      if (st.session !== sessionRef.current || st.enqueueGen !== genAtSkip) return;
      void ensureVoices(synth).then(() => {
        if (st.session !== sessionRef.current || st.enqueueGen !== genAtSkip) return;
        bumpHeartbeat();
        enqueueRef.current?.(target);
      });
    }, 60);
  }, [bumpHeartbeat, clearId, settleSession]);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    const longPause = Date.now() - pausedAtRef.current > SMART_RESUME_MS;
    pausedRef.current = false;
    setIsPaused(false);
    heartbeatRef.current = Date.now();
    const st = seekStateRef.current;
    if (longPause && st && st.session === sessionRef.current) {
      // Context reinstatement: after a long pause, restart the current
      // sentence instead of dropping the listener mid-thought. The threshold
      // keeps barge-in's verify-and-resume (seconds) untouched.
      if (st.mode === "browser") { browserSkipTo(st.index); return; }
      const a0 = audioRef.current;
      if (a0 && a0.src && !a0.ended) { try { a0.currentTime = 0; } catch { /* no-op */ } }
    }
    const a = audioRef.current;
    if (a && a.src && a.paused && !a.ended) {
      a.play().catch(() => { /* watchdog reaps the session if this sticks */ });
    }
    try { synthRef.current?.resume(); } catch { /* no-op */ }
  }, [browserSkipTo]);

  const togglePause = useCallback(() => {
    if (pausedRef.current) resume(); else pause();
  }, [pause, resume]);

  const isAudioActive = useCallback(() => {
    if (activeSessionRef.current) return true;
    const synth = synthRef.current;
    if (synth && (synth.speaking || synth.pending)) return true;
    const a = audioRef.current;
    return !!(a && a.src && !a.paused && !a.ended);
  }, []);

  const startWatchdog = useCallback((session: number, id: string) => {
    stopWatchdog();
    heartbeatRef.current = Date.now();
    browserIdleTicksRef.current = 0;
    watchdogRef.current = window.setInterval(() => {
      if (session !== sessionRef.current) { stopWatchdog(); return; }
      if (pausedRef.current) { heartbeatRef.current = Date.now(); return; }
      const synth = synthRef.current;
      // Dropped-event completion: once the final browser chunk is queued, an
      // engine that is idle AND empty on two consecutive ticks has finished —
      // even if Chrome never fired the last onend (Chromium 41346274).
      if (lastEnqueuedRef.current && synth && !synth.speaking && !synth.pending) {
        if (++browserIdleTicksRef.current >= 2) {
          clearId(id);
          setProgress(null);
          settleSession(session, "ended");
          return;
        }
      } else {
        browserIdleTicksRef.current = 0;
      }
      // Stall reaper: no progress event for STALL_MS while unpaused. Audible
      // audio bumps the heartbeat continuously (timeupdate / onboundary), so
      // only a genuinely wedged session can trip this. Silence first, then
      // report — the FSM must never flip while sound could be playing.
      if (Date.now() - heartbeatRef.current > STALL_MS) {
        terminate("error");
      }
    }, 500);
  }, [stopWatchdog, clearId, settleSession, terminate]);

  // Browser voice: queue one utterance per chunk. The engine plays them in
  // order, but only has to synthesize the (short) first chunk before audio
  // starts — and short utterances also sidestep Chrome's ~15s long-utterance
  // cutoff. Used directly when Inworld is off, and as the fallback for it
  // (startIndex = where the Inworld read left off, against the FULL chunk
  // list so seek indexes stay message-relative).
  const browserSpeakChunks = useCallback(
    (chunks: string[], id: string, session: number, rate: number, startIndex = 0) => {
      const synth = synthRef.current;
      if (!synth) { clearId(id); setProgress(null); settleSession(session, "error"); return; }
      if (chunks.length === 0 || startIndex >= chunks.length) {
        clearId(id); setProgress(null); settleSession(session, "ended"); return;
      }
      const st = seekStateRef.current;
      if (st && st.session === session) st.mode = "browser"; // Inworld fallback lands here mid-session
      const enqueueFrom = (from: number) => {
        if (session !== sessionRef.current) return;
        const gen = st ? ++st.enqueueGen : 0;
        const live = () => session === sessionRef.current && (!st || st.enqueueGen === gen);
        for (let idx = from; idx < chunks.length; idx++) {
          const u = new SpeechSynthesisUtterance(chunks[idx]);
          u.rate = rate;
          // Every utterance feeds the watchdog heartbeat; word-boundary
          // events (local voices) make it beat continuously during audio.
          u.onstart = () => {
            bumpHeartbeat();
            if (!live()) return;
            if (st) st.index = idx;
            setSpeakingId(id);
            setProgress({ id, index: idx, total: chunks.length, text: chunks[idx], mode: "browser" });
          };
          u.onboundary = bumpHeartbeat;
          if (idx === chunks.length - 1) {
            const fin = () => {
              if (!live()) return;
              clearId(id);
              setProgress(null);
              settleSession(session, "ended");
            };
            u.onend = fin;
            u.onerror = fin;
          } else {
            u.onend = bumpHeartbeat;
          }
          synth.speak(u);
        }
        lastEnqueuedRef.current = true;
      };
      enqueueRef.current = enqueueFrom;
      try { synth.cancel(); } catch { /* no-op */ }
      const genBefore = st ? st.enqueueGen : 0;
      ensureVoices(synth).then(() => {
        if (session !== sessionRef.current) return;
        // A skip that raced voice loading already enqueued — don't double up.
        if (st && st.enqueueGen !== genBefore) return;
        bumpHeartbeat();
        enqueueFrom(startIndex);
      });
    },
    [clearId, settleSession, bumpHeartbeat],
  );

  /** Land an Inworld seek: nudge the playing element for a same-chunk jump,
   *  otherwise post a cross-chunk target and release the current playback so
   *  the chunk loop consumes it. Never settles the session. */
  const applyInworldSeek = useCallback((st: SeekSession, target: SeekPos | "end") => {
    bumpHeartbeat();
    const a = audioRef.current;
    // Direct nudge only once metadata is in: before that, the loadedmetadata
    // startAt-correction would fire AFTER this set and silently undo it.
    // Pre-metadata same-chunk seeks fall through to the replay path instead.
    const playingNow = playResolveRef.current !== null && a && a.src && !a.ended
      && a.readyState >= HTMLMediaElement.HAVE_METADATA;
    if (target !== "end" && target.index === st.index && playingNow) {
      try { a.currentTime = Math.max(0, target.t); } catch { /* no-op */ }
      return;
    }
    st.seekTo = target === "end" ? { index: st.chunks.length, t: 0 } : target;
    if (target !== "end") {
      // Reflect the jump immediately — the loop repeats it, but the button
      // press should move the mini-player snippet without waiting on audio.
      setProgress({ id: st.id, index: target.index, total: st.chunks.length, text: st.chunks[target.index], mode: "inworld" });
    }
    const r = playResolveRef.current;
    if (r) {
      if (a) { try { a.pause(); } catch { /* no-op */ } }
      r("ok"); // resolves playBuffer; the loop's post-play check consumes seekTo
    }
  }, [bumpHeartbeat]);

  const skipBack = useCallback(() => {
    const st = seekStateRef.current;
    if (!st || st.session !== sessionRef.current) return;
    if (st.mode === "browser") { browserSkipTo(Math.max(0, st.index - 1)); return; }
    const a = audioRef.current;
    const playingNow = playResolveRef.current !== null && a && a.src && !a.ended;
    // Rapid presses accumulate: base each jump on the not-yet-consumed target.
    const pending = st.seekTo;
    const pos: SeekPos = pending && pending.index < st.chunks.length
      ? pending
      : { index: st.index, t: playingNow ? a.currentTime : 0 };
    applyInworldSeek(st, computeBackTarget(pos, st.durations, SKIP_SECONDS));
  }, [browserSkipTo, applyInworldSeek]);

  const skipForward = useCallback(() => {
    const st = seekStateRef.current;
    if (!st || st.session !== sessionRef.current) return;
    if (st.mode === "browser") { browserSkipTo(st.index + 1); return; }
    const a = audioRef.current;
    const playingNow = playResolveRef.current !== null && a && a.src && !a.ended;
    const pending = st.seekTo;
    const pos: SeekPos = pending && pending.index < st.chunks.length
      ? pending
      : { index: st.index, t: playingNow ? a.currentTime : 0 };
    applyInworldSeek(st, computeForwardTarget(pos, st.durations, st.chunks.length, SKIP_SECONDS));
  }, [browserSkipTo, applyInworldSeek]);

  // Inworld voice: synthesize chunk-by-chunk with a one-ahead prefetch so the
  // first sentence's audio is ready after a single short request, and each
  // subsequent chunk is already in flight while the current one plays. The
  // loop is index-driven so seeks can move it: fetched chunks are memoized on
  // the session (backward jumps replay them free — Inworld bills per
  // character), and a pending seekTo is consumed at the two points playback
  // can be interrupted (before play, after play).
  const inworldSpeakChunks = useCallback(
    async (chunks: string[], id: string, session: number, rate: number) => {
      if (chunks.length === 0) { clearId(id); setProgress(null); settleSession(session, "ended"); return; }
      const st = seekStateRef.current;
      if (!st || st.session !== session) return;
      // Retain the fetched MP3 chunks so the message can be downloaded later
      // without re-synthesizing (Inworld bills per character).
      beginTtsCapture(id, chunks.length);

      const inflight = new Map<number, Promise<ArrayBuffer>>();
      const getChunk = (idx: number): Promise<ArrayBuffer> => {
        const cached = st.buffers[idx];
        if (cached) return Promise.resolve(cached);
        let p = inflight.get(idx);
        if (!p) {
          const controller = new AbortController();
          abortRef.current = controller; // latest wins; terminate() aborts it
          p = synthesizeSpeech(chunks[idx], inworldApiKey, inworldVoiceId, "inworld-tts-2", {
            signal: controller.signal,
          })
            .then((buf) => {
              st.buffers[idx] = buf;
              // Session-gated: with seeks, TWO fetches can be in flight and
              // abortRef only covers the latest — a survivor from a dead
              // session must not write into a NEW capture that reuses the
              // same bubble id (re-speak after a voice change would bake one
              // wrong-voice sentence into the downloadable MP3).
              if (session === sessionRef.current) addTtsChunkAt(id, idx, buf);
              return buf;
            })
            .finally(() => { inflight.delete(idx); });
          inflight.set(idx, p);
        }
        return p;
      };

      const playBuffer = (buf: ArrayBuffer, chunkIdx: number, startAt: number): Promise<"ok" | "blocked"> =>
        new Promise((resolve) => {
          const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
          let audio = audioRef.current;
          if (!audio) {
            audio = new Audio();
            // Persistent progress listeners: audible playback continuously
            // feeds the watchdog heartbeat.
            audio.addEventListener("timeupdate", bumpHeartbeat);
            audio.addEventListener("playing", bumpHeartbeat);
            audioRef.current = audio;
          }
          audio.src = url;
          audio.playbackRate = rate;
          if (startAt > 0) {
            // Pre-metadata this sets the default playback start position;
            // loadedmetadata below corrects it against the real duration.
            try { audio.currentTime = startAt; } catch { /* no-op */ }
          }
          let settled = false;
          const done = (status: "ok" | "blocked" = "ok") => {
            if (settled) return;
            settled = true;
            if (currentUrlRef.current === url) currentUrlRef.current = null;
            // Only release the resolver slot if it's still OURS — a stale
            // late event must not clobber a newer chunk's registration.
            if (playResolveRef.current === myResolver) playResolveRef.current = null;
            try { URL.revokeObjectURL(url); } catch { /* no-op */ }
            if (audio) { audio.onended = null; audio.onerror = null; audio.onloadedmetadata = null; }
            resolve(status);
          };
          const myResolver = (s: "ok" | "blocked") => done(s);
          currentUrlRef.current = url;
          playResolveRef.current = myResolver;
          audio.onloadedmetadata = () => {
            const d = audio!.duration;
            if (Number.isFinite(d) && d > 0) {
              st.durations[chunkIdx] = d; // the seek timeline learns real lengths
              if (startAt > 0 && Math.abs(audio!.currentTime - startAt) > 0.25) {
                try { audio!.currentTime = Math.min(startAt, Math.max(0, d - 0.05)); } catch { /* no-op */ }
              }
            }
          };
          audio.onended = () => { bumpHeartbeat(); done(); };
          audio.onerror = () => done();
          audio.play().catch((e: any) => {
            // Autoplay-blocked: no sound will ever come from this session —
            // fail it honestly instead of pretending the chunk played.
            done(e?.name === "NotAllowedError" ? "blocked" : "ok");
          });
        });

      let i = 0;
      let startAt = 0;
      while (i < chunks.length) {
        let buf: ArrayBuffer;
        try {
          buf = await getChunk(i);
        } catch {
          discardTtsCapture(id); // partial audio would download truncated
          if (session !== sessionRef.current) return;
          // Honor a seek posted while this fetch was in flight — the user's
          // navigation must survive the engine handover (an end-seek settles
          // instead of restarting speech the user tried to finish).
          const pending = st.seekTo;
          st.seekTo = null;
          const startIdx = pending ? pending.index : i;
          if (startIdx >= chunks.length) {
            clearId(id);
            setProgress(null);
            settleSession(session, "ended");
            return;
          }
          // Inworld failed for this chunk — read the rest with the browser
          // voice so the user still hears the whole reply (same session).
          browserSpeakChunks(chunks, id, session, rate, startIdx);
          return;
        }
        if (session !== sessionRef.current) return;
        bumpHeartbeat();
        // Kick off the next request before playing the current chunk. A
        // prefetch failure is retried when the loop actually reaches it.
        if (i + 1 < chunks.length) { getChunk(i + 1).catch(() => { /* awaited later */ }); }
        setSpeakingId(id);
        st.index = i;
        setProgress({ id, index: i, total: chunks.length, text: chunks[i], mode: "inworld" });
        // Hold between chunks while barge-in verification has us paused —
        // play() on the next chunk would silently un-pause.
        while (pausedRef.current && session === sessionRef.current) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (session !== sessionRef.current) return;
        // A seek may have landed while fetching or paused. Commit the index
        // immediately: a skip pressed while the target chunk is still
        // fetching anchors on st.index, and a stale one would re-anchor the
        // jump at the pre-seek position.
        const pre = st.seekTo;
        if (pre) { st.seekTo = null; st.index = Math.min(pre.index, chunks.length - 1); i = pre.index; startAt = pre.t; continue; }
        const status = await playBuffer(buf, i, startAt);
        if (session !== sessionRef.current) return;
        if (status === "blocked") {
          discardTtsCapture(id);
          terminate("error");
          return;
        }
        // A mid-play seek released playBuffer early and posted its target.
        const seek = st.seekTo;
        if (seek) { st.seekTo = null; st.index = Math.min(seek.index, chunks.length - 1); i = seek.index; startAt = seek.t; continue; }
        startAt = 0;
        i++;
      }
      if (session === sessionRef.current) {
        completeTtsCapture(id);
        clearId(id);
        setProgress(null);
        settleSession(session, "ended");
      }
    },
    [inworldApiKey, inworldVoiceId, clearId, settleSession, terminate, bumpHeartbeat, browserSpeakChunks],
  );

  const speak = useCallback(
    (text: string, opts?: SpeakOptions) => {
      const clean = stripMarkdownForTts(text);
      if (!clean) {
        try { opts?.onEnd?.(); } catch { /* no-op */ }
        try { opts?.onDone?.({ reason: "ended" }); } catch { /* no-op */ }
        return;
      }
      terminate("superseded"); // settles any prior session, bumps sessionRef
      const session = sessionRef.current;
      cbRef.current = { session, onEnd: opts?.onEnd, onDone: opts?.onDone, settled: false };
      activeSessionRef.current = true;
      const id = opts?.id || `speak-${Date.now()}`;
      setSpeakingId(id);
      const chunks = splitIntoChunks(clean);
      const rate = clampRate(opts?.rate, defaultRate);
      const mode: ReadAloudMode = inworldEnabled && inworldVoiceId ? "inworld" : "browser";
      seekStateRef.current = {
        session,
        id,
        chunks,
        rate,
        mode,
        index: 0,
        durations: new Array(chunks.length).fill(null),
        buffers: new Array(chunks.length).fill(null),
        seekTo: null,
        enqueueGen: 0,
      };
      startWatchdog(session, id);

      // Inworld path (premium voice). `inworldApiKey` is passed for API
      // compatibility but the edge function authenticates via the Supabase
      // session, so an enabled toggle + a chosen voice are what matter.
      if (mode === "inworld") {
        void inworldSpeakChunks(chunks, id, session, rate);
        return;
      }
      browserSpeakChunks(chunks, id, session, rate);
    },
    [inworldEnabled, inworldVoiceId, defaultRate, terminate, startWatchdog, inworldSpeakChunks, browserSpeakChunks],
  );

  useEffect(() => () => { stop(); stopWatchdog(); }, [stop, stopWatchdog]);

  return {
    speakingId,
    isSpeaking: speakingId !== null,
    progress,
    isPaused,
    speak,
    stop,
    pause,
    resume,
    togglePause,
    skipBack,
    skipForward,
    isAudioActive,
  };
}
