import { useCallback, useEffect, useRef, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { synthesizeSpeech } from "@/lib/inworldTts";
import {
  addTtsChunk,
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
// COMPLETION CONTRACT: every speak() session settles its onDone callback
// EXACTLY ONCE with a reason — hands-free drives its whole state machine off
// this, so "did the audio really finish?" must never be guessed from timers:
//   • "ended"      — playback finished naturally (onEnd fires too)
//   • "stopped"    — stop() was called (toggle off, clear chat, unmount)
//   • "superseded" — a newer speak() replaced this session
//   • "error"      — playback could not proceed (autoplay-blocked, stalled)
// Real playout events are the completion signals (final chunk `ended` /
// utterance onend); a heartbeat watchdog reaps genuinely stalled sessions
// (Chrome drops speechSynthesis onend for network voices — Chromium
// 41346274 — and a rejected play() would otherwise hang a session forever).
// The watchdog measures PROGRESS, never total duration: audio that is
// audibly playing can run for any length of time without being reaped.

export type SpeakEndReason = "ended" | "stopped" | "superseded" | "error";

/** No audible/synth progress for this long = the session is stuck. */
const STALL_MS = 12000;

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
  speak: (text: string, opts?: SpeakOptions) => void;
  /** Stop any in-flight synthesis/playback (settles the session "stopped"). */
  stop: () => void;
  /** Pause playback in place (barge-in verification) — session stays live. */
  pause: () => void;
  /** Resume playback paused by pause(). */
  resume: () => void;
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

export function useReadAloud(): ReadAloudController {
  const { ttsRate, inworldEnabled, inworldApiKey, inworldVoiceId } = useChatSettings();
  const [speakingId, setSpeakingId] = useState<string | null>(null);

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
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* no-op */ }
      abortRef.current = null;
    }
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* no-op */ }
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
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

  // Pause/resume in place — used by hands-free barge-in verification so a
  // false alarm (cough, background noise) can RESUME instead of restarting
  // the reply. The session stays live; the watchdog idles while paused.
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    try { audioRef.current?.pause(); } catch { /* no-op */ }
    try { if (synthRef.current?.speaking) synthRef.current.pause(); } catch { /* no-op */ }
  }, []);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    heartbeatRef.current = Date.now();
    const a = audioRef.current;
    if (a && a.src && a.paused && !a.ended) {
      a.play().catch(() => { /* watchdog reaps the session if this sticks */ });
    }
    try { synthRef.current?.resume(); } catch { /* no-op */ }
  }, []);

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
  // cutoff. Used directly when Inworld is off, and as the fallback for it.
  const browserSpeakChunks = useCallback(
    (chunks: string[], id: string, session: number, rate: number) => {
      const synth = synthRef.current;
      if (!synth) { clearId(id); settleSession(session, "error"); return; }
      if (chunks.length === 0) { clearId(id); settleSession(session, "ended"); return; }
      try { synth.cancel(); } catch { /* no-op */ }
      ensureVoices(synth).then(() => {
        if (session !== sessionRef.current) return;
        bumpHeartbeat();
        chunks.forEach((chunk, i) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.rate = rate;
          // Every utterance feeds the watchdog heartbeat; word-boundary
          // events (local voices) make it beat continuously during audio.
          u.onstart = () => {
            bumpHeartbeat();
            if (i === 0 && session === sessionRef.current) setSpeakingId(id);
          };
          u.onboundary = bumpHeartbeat;
          if (i === chunks.length - 1) {
            const fin = () => {
              if (session === sessionRef.current) { clearId(id); settleSession(session, "ended"); }
            };
            u.onend = fin;
            u.onerror = fin;
          } else {
            u.onend = bumpHeartbeat;
          }
          synth.speak(u);
        });
        lastEnqueuedRef.current = true;
      });
    },
    [clearId, settleSession, bumpHeartbeat],
  );

  // Inworld voice: synthesize chunk-by-chunk with a one-ahead prefetch so the
  // first sentence's audio is ready after a single short request, and each
  // subsequent chunk is already in flight while the current one plays.
  const inworldSpeakChunks = useCallback(
    async (chunks: string[], id: string, session: number, rate: number) => {
      if (chunks.length === 0) { clearId(id); settleSession(session, "ended"); return; }
      // Retain the fetched MP3 chunks so the message can be downloaded later
      // without re-synthesizing (Inworld bills per character).
      beginTtsCapture(id);

      const playBuffer = (buf: ArrayBuffer): Promise<"ok" | "blocked"> =>
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
          let settled = false;
          const done = (status: "ok" | "blocked" = "ok") => {
            if (settled) return;
            settled = true;
            if (currentUrlRef.current === url) currentUrlRef.current = null;
            // Only release the resolver slot if it's still OURS — a stale
            // late event must not clobber a newer chunk's registration.
            if (playResolveRef.current === myResolver) playResolveRef.current = null;
            try { URL.revokeObjectURL(url); } catch { /* no-op */ }
            if (audio) { audio.onended = null; audio.onerror = null; }
            resolve(status);
          };
          const myResolver = (s: "ok" | "blocked") => done(s);
          currentUrlRef.current = url;
          playResolveRef.current = myResolver;
          audio.onended = () => { bumpHeartbeat(); done(); };
          audio.onerror = () => done();
          audio.play().catch((e: any) => {
            // Autoplay-blocked: no sound will ever come from this session —
            // fail it honestly instead of pretending the chunk played.
            done(e?.name === "NotAllowedError" ? "blocked" : "ok");
          });
        });

      const synthChunk = (t: string) => {
        const controller = new AbortController();
        abortRef.current = controller; // latest wins; terminate() aborts it
        return synthesizeSpeech(t, inworldApiKey, inworldVoiceId, "inworld-tts-2", {
          signal: controller.signal,
        });
      };

      let next = synthChunk(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        let buf: ArrayBuffer;
        try {
          buf = await next;
        } catch {
          discardTtsCapture(id); // partial audio would download truncated
          if (session !== sessionRef.current) return;
          // Inworld failed for this chunk — read the rest with the browser
          // voice so the user still hears the whole reply (same session).
          browserSpeakChunks(chunks.slice(i), id, session, rate);
          return;
        }
        if (session !== sessionRef.current) return;
        bumpHeartbeat();
        addTtsChunk(id, buf);
        // Kick off the next request before playing the current chunk.
        next = i + 1 < chunks.length ? synthChunk(chunks[i + 1]) : Promise.resolve(new ArrayBuffer(0));
        if (i === 0 && session === sessionRef.current) setSpeakingId(id);
        // Hold between chunks while barge-in verification has us paused —
        // play() on the next chunk would silently un-pause.
        while (pausedRef.current && session === sessionRef.current) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (session !== sessionRef.current) return;
        const status = await playBuffer(buf);
        if (session !== sessionRef.current) return;
        if (status === "blocked") {
          discardTtsCapture(id);
          terminate("error");
          return;
        }
      }
      if (session === sessionRef.current) {
        completeTtsCapture(id);
        clearId(id);
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
      startWatchdog(session, id);

      // Inworld path (premium voice). `inworldApiKey` is passed for API
      // compatibility but the edge function authenticates via the Supabase
      // session, so an enabled toggle + a chosen voice are what matter.
      if (inworldEnabled && inworldVoiceId) {
        void inworldSpeakChunks(chunks, id, session, rate);
        return;
      }
      browserSpeakChunks(chunks, id, session, rate);
    },
    [inworldEnabled, inworldVoiceId, defaultRate, terminate, startWatchdog, inworldSpeakChunks, browserSpeakChunks],
  );

  useEffect(() => () => { stop(); stopWatchdog(); }, [stop, stopWatchdog]);

  return { speakingId, isSpeaking: speakingId !== null, speak, stop, pause, resume, isAudioActive };
}
