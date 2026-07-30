import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { SpeakEndReason } from "@/hooks/useReadAloud";

// Hands-free voice conversation, modeled as an explicit finite-state machine.
//
//   idle → listening → thinking → speaking → (cooldown) → listening …
//
// Design rules (each one exists because its absence was a shipped bug):
//   • EVENT-DRIVEN, NEVER ESTIMATED: the speaking→listening transition fires
//     only when the TTS layer settles its onDone callback — real playout
//     events, backed by useReadAloud's stall watchdog. There is no duration
//     timer: the old min(90s, 4s + len×90ms) guess expired before long
//     replies finished, opening the mic over live audio (the assistant then
//     transcribed itself — Chrome's echo cancellation does NOT cover the
//     page's own playback, and Web Speech recognition has none we control).
//   • HARD MIC GATING: the recognizer refuses to open while ANY app audio is
//     audible (isAudioActive covers live TTS sessions, a busy speechSynthesis
//     engine — incl. the PDF reader — and unpaused audio elements), deferring
//     in 300ms steps with a 20s safety valve. Transcripts arriving outside
//     the listening state are discarded as a backstop.
//   • Per-utterance recognition (continuous = false) lets the browser's own
//     endpointing close each turn — no fragile silence timers.
//   • Toggling hands-free OFF closes the MIC, not the voice (the
//     Gemini/ChatGPT convention) — an in-flight reply keeps playing and is
//     never replayed; the speaker button / Read Aloud toggle silence it.
//
// OPTIONAL BARGE-IN (toggle): a Silero VAD (lazy-loaded from CDN) listens
// during playback. On suspected speech it PAUSES the TTS in place and opens
// the mic to VERIFY: a real utterance commits the interruption and becomes
// the next turn; silence or a cough RESUMES playback from the pause point
// (detect → verify → recover, per the barge-in literature — never restart).
// The VAD mic stream requests Chrome 141's echoCancellationMode "all" so the
// assistant's own speaker output stops self-triggering it.

const SR: any =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

export type HandsFreeState = "idle" | "listening" | "thinking" | "speaking";

interface UseHandsFreeOpts {
  /** Send a user utterance to the model; resolves with the assistant reply. */
  onUtterance: (text: string) => Promise<string>;
  /** Speak the reply; onDone settles exactly once on every terminal path. */
  speak: (text: string, opts?: { onDone?: (r: { reason: SpeakEndReason }) => void }) => void;
  /** Stop any in-flight speech (settles its session "stopped"). */
  stopSpeaking: () => void;
  /** Pause playback in place — enables verify-and-resume barge-in. */
  pauseSpeaking?: () => void;
  /** Resume playback paused by pauseSpeaking. */
  resumeSpeaking?: () => void;
  /** True while any app audio could be audible — gates the mic. */
  isAudioActive?: () => boolean;
  /** Enable interrupting the assistant mid-sentence (needs VAD). */
  bargeIn?: boolean;
}

const POST_TTS_COOLDOWN_MS = 700; // speaker-tail guard after REAL audio end (industry band 0.4–1s)
const BARGE_GRACE_MS = 900;       // ignore the assistant's opening words so they don't self-trigger
const LISTEN_RETRY_MS = 300;      // re-check interval while audio is still audible
const LISTEN_DEFER_MAX_MS = 20000; // safety valve: never defer the mic forever
const SILENCE_STOP_MS = 5 * 60_000; // hands-free ends itself after this much total quiet

// Lazy-loaded VAD (only when barge-in is enabled) — kept off the main bundle.
const VAD_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/";
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
let vadLoadPromise: Promise<any> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadVad(): Promise<any> {
  if ((window as any).vad) return (window as any).vad;
  if (!vadLoadPromise) {
    vadLoadPromise = (async () => {
      await loadScript(`${ORT_BASE}ort.js`);
      await loadScript(`${VAD_BASE}bundle.min.js`);
      return (window as any).vad;
    })().catch((e) => { vadLoadPromise = null; throw e; });
  }
  return vadLoadPromise;
}

// Chrome 139+ on-device recognition: lower latency, no server socket to drop
// when the tab backgrounds. Probed once; used only when the language pack is
// already available (we never trigger a download).
let localAsrAvailable = false;
let localAsrProbed = false;
async function probeLocalAsr(): Promise<void> {
  if (localAsrProbed) return;
  localAsrProbed = true;
  try {
    if (SR && typeof SR.available === "function") {
      const status = await SR.available({ langs: ["en-US"], processLocally: true });
      localAsrAvailable = status === "available";
    }
  } catch {
    localAsrAvailable = false;
  }
}

export interface HandsFreeController {
  supported: boolean;
  active: boolean;
  state: HandsFreeState;
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useHandsFree(opts: UseHandsFreeOpts): HandsFreeController {
  const { bargeIn = false } = opts;
  const supported = !!SR;
  const [active, setActive] = useState(false);
  const [state, setState] = useState<HandsFreeState>("idle");
  const [interim, setInterim] = useState("");

  const recRef = useRef<any>(null);
  const activeRef = useRef(false);
  const busyRef = useRef(false); // true while thinking or speaking (recognizer must stay closed)
  // Session generation: bumped by stopAll. A turn captured under an older
  // generation must never speak, reschedule, or touch shared state — without
  // this, toggling hands-free off during "thinking" and back on would let the
  // stale turn's reply speak over the new session's open mic.
  const generationRef = useRef(0);
  const stateRef = useRef<HandsFreeState>("idle");
  const finalRef = useRef("");
  const wakeLockRef = useRef<any>(null);
  const cooldownRef = useRef<number | null>(null);
  const deferralStartRef = useRef(0);
  const verifyingRef = useRef(false);
  // Silence watchdog: with the wake lock holding the screen on, a forgotten
  // session in a pocket would burn battery for hours. After SILENCE_STOP_MS
  // with no speech in either direction the session ends itself — with a
  // spoken notice, since the user may not be looking.
  const lastActivityRef = useRef(0);
  const silenceTimerRef = useRef<number | null>(null);

  // Latest caller-provided functions — recognizer/VAD callbacks always call
  // the current ones without threading dependency arrays everywhere.
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });

  // Barge-in (VAD) state.
  const bargeInRef = useRef(bargeIn);
  const vadRef = useRef<any>(null);
  const vadInitingRef = useRef(false);
  const bargeCallbackRef = useRef<(() => void) | null>(null);

  // Latest-value refs so recognizer callbacks always call the current fns.
  const startListeningRef = useRef<() => void>(() => {});
  const scheduleListenRef = useRef<(delayMs: number) => void>(() => {});
  const handleUtteranceRef = useRef<(t: string) => void>(() => {});
  const stopAllRef = useRef<() => void>(() => {});
  const openRecognizerRef = useRef<(onText: (text: string) => void) => boolean>(() => false);

  const setFsm = useCallback((s: HandsFreeState) => {
    stateRef.current = s;
    if (s !== "listening" && s !== "idle") lastActivityRef.current = Date.now();
    setState(s);
  }, []);

  const teardownRecognition = useCallback(() => {
    const rec = recRef.current;
    if (rec) {
      rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
      try { rec.stop(); } catch { /* no-op */ }
      try { rec.abort?.(); } catch { /* no-op */ }
      recRef.current = null;
    }
  }, []);

  // ---- Barge-in VAD lifecycle -------------------------------------------
  const destroyVad = useCallback(() => {
    bargeCallbackRef.current = null;
    const inst = vadRef.current;
    vadRef.current = null;
    if (inst) {
      try { inst.pause(); } catch { /* no-op */ }
      try { inst.destroy?.(); } catch { /* no-op */ }
    }
  }, []);

  const initVad = useCallback(async () => {
    if (vadRef.current || vadInitingRef.current) return;
    vadInitingRef.current = true;
    try {
      const vad = await loadVad();
      if (!vad?.MicVAD) throw new Error("VAD library unavailable");
      if (!activeRef.current || !bargeInRef.current) return;
      const inst = await vad.MicVAD.new({
        baseAssetPath: VAD_BASE,
        onnxWASMBasePath: ORT_BASE,
        // Tuned high to bias toward the user's direct (louder/clearer) voice
        // over the echo-cancelled residual of the assistant's own playback.
        // Headphones remain the most reliable option on open speakers.
        positiveSpeechThreshold: 0.92,
        negativeSpeechThreshold: 0.7,
        minSpeechFrames: 10,
        redemptionFrames: 10,
        additionalAudioConstraints: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Chrome 141+: also cancel the page's OWN playback from the mic
          // signal (default Chrome AEC only covers remote WebRTC audio).
          // Unknown constraint members are ignored by older browsers.
          echoCancellationMode: "all",
        } as any,
        onSpeechStart: () => { bargeCallbackRef.current?.(); },
      });
      if (!activeRef.current || !bargeInRef.current) { try { inst.destroy?.(); } catch { /* no-op */ } return; }
      vadRef.current = inst;
      inst.start();
    } catch (e) {
      console.warn("Barge-in VAD failed to initialize:", e);
      toast.error("Barge-in is unavailable — continuing turn-based.");
    } finally {
      vadInitingRef.current = false;
    }
  }, []);

  // ---- Recognition ------------------------------------------------------
  /** Open a one-shot recognizer; `onText` receives the final transcript
   *  ("" for silence) when the browser endpoints the utterance. Used for
   *  normal listening AND barge-in verification. */
  const openRecognizer = useCallback((onText: (text: string) => void): boolean => {
    if (!SR || recRef.current) return false;
    finalRef.current = "";
    setInterim("");

    const rec = new SR();
    rec.continuous = false;      // one utterance per session → browser endpoints the turn
    rec.interimResults = true;
    rec.lang = "en-US";
    if (localAsrAvailable) {
      try { rec.processLocally = true; } catch { /* pre-139 Chrome */ }
    }

    rec.onstart = () => setFsm("listening");
    rec.onresult = (e: any) => {
      // Backstop: a transcript arriving while the assistant is audibly
      // speaking or thinking can only be echo/stale — discard it. (The
      // recognizer shouldn't even exist in those states.)
      if (stateRef.current === "speaking" || stateRef.current === "thinking") return;
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = String(e.results[i][0]?.transcript || "");
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) finalRef.current = `${finalRef.current} ${finalText}`.trim();
      if (finalText || interimText) lastActivityRef.current = Date.now();
      setInterim(interimText);
    };
    rec.onerror = (e: any) => {
      const benign = e.error === "no-speech" || e.error === "aborted" || e.error === "audio-capture";
      if (!benign) {
        toast.error(`Mic error: ${e.error}`);
        if (e.error === "not-allowed" || e.error === "service-not-allowed") stopAllRef.current();
      }
    };
    rec.onend = () => {
      recRef.current = null;
      const text = finalRef.current.trim();
      finalRef.current = "";
      setInterim("");
      onText(text);
    };

    recRef.current = rec;
    try { rec.start(); } catch { /* start can throw if called too soon; onend retries */ }
    return true;
  }, [setFsm]);

  // ---- Listening --------------------------------------------------------
  // NOTE: the audio-audible hard gate lives in scheduleListen's attempt loop —
  // the ONLY caller of this function — so its 20s valve can actually open the
  // mic. (A duplicate gate here would re-enter scheduleListen, which resets
  // the valve clock, and the two would recurse forever — permanently muting
  // the session whenever a foreign speechSynthesis engine wedges.)
  const startListening = useCallback(() => {
    if (!activeRef.current || busyRef.current || !SR) return;
    if (recRef.current) return; // already listening (or a verifier is closing)
    openRecognizer((text) => {
      if (!activeRef.current) { setFsm("idle"); return; }
      if (text) handleUtteranceRef.current(text);
      else if (!busyRef.current) scheduleListenRef.current(0); // no speech — keep listening
    });
  }, [openRecognizer, setFsm]);

  /** Open the mic after `delayMs`, deferring in LISTEN_RETRY_MS steps while
   *  audio is still audible (20s valve so a wedged foreign engine can't mute
   *  the session forever) or while a recognizer is still closing. */
  const scheduleListen = useCallback((delayMs: number) => {
    if (cooldownRef.current) window.clearTimeout(cooldownRef.current);
    deferralStartRef.current = 0;
    const attempt = () => {
      cooldownRef.current = null;
      if (!activeRef.current || busyRef.current) return;
      if (recRef.current) {
        cooldownRef.current = window.setTimeout(attempt, LISTEN_RETRY_MS);
        return;
      }
      const now = Date.now();
      if (optsRef.current.isAudioActive?.()) {
        if (!deferralStartRef.current) deferralStartRef.current = now;
        if (now - deferralStartRef.current < LISTEN_DEFER_MAX_MS) {
          cooldownRef.current = window.setTimeout(attempt, LISTEN_RETRY_MS);
          return;
        }
        // Valve open: something claims to be audible for 20s+ (wedged
        // foreign speechSynthesis?) — listen anyway rather than go mute.
      }
      deferralStartRef.current = 0;
      startListeningRef.current();
    };
    cooldownRef.current = window.setTimeout(attempt, Math.max(0, delayMs));
  }, []);

  // ---- One full turn: send → speak (interruptible) → resume -------------
  const handleUtterance = useCallback(async (text: string) => {
    const gen = generationRef.current;
    busyRef.current = true;
    teardownRecognition();
    setFsm("thinking");
    let pendingBargeText: string | null = null;
    try {
      const reply = await optsRef.current.onUtterance(text);
      // activeRef alone is not enough: hands-free may have been toggled OFF
      // and ON again while the model was thinking — activeRef is true again,
      // but this turn belongs to the dead session and must not speak its
      // stale reply over the new session's open mic.
      if (!activeRef.current || gen !== generationRef.current) return;
      if (reply && reply.trim()) {
        setFsm("speaking");
        await new Promise<void>((resolve) => {
          let settled = false;
          let armTimer: number | null = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (armTimer) window.clearTimeout(armTimer);
            bargeCallbackRef.current = null;
            resolve();
          };
          // Barge-in: detect (VAD) → verify (pause + listen) → recover
          // (resume on false alarm) or commit (stop + treat as next turn).
          const armBarge = () => {
            if (settled) return;
            bargeCallbackRef.current = () => {
              if (settled || verifyingRef.current) return;
              bargeCallbackRef.current = null; // one verification at a time
              const o = optsRef.current;
              if (!o.pauseSpeaking || !o.resumeSpeaking) {
                // No pause support — legacy hard interrupt.
                o.stopSpeaking(); // settles the session → finish()
                return;
              }
              verifyingRef.current = true;
              o.pauseSpeaking();
              setFsm("listening");
              const opened = openRecognizerRef.current((verifiedText) => {
                verifyingRef.current = false;
                if (settled) {
                  // The paused session ended externally mid-verification
                  // (another speaker button, Read Aloud off). Don't discard
                  // what the user dictated — commit it as the next turn.
                  if (verifiedText && activeRef.current) {
                    void Promise.resolve().then(() => { if (activeRef.current) handleUtteranceRef.current(verifiedText); });
                  }
                  return;
                }
                if (!activeRef.current) return; // stopAll already resumed audio
                if (verifiedText) {
                  pendingBargeText = verifiedText;
                  optsRef.current.stopSpeaking(); // settles → finish()
                } else {
                  // False alarm (cough / noise) — resume from the pause
                  // point, never restart, and re-arm for real interruptions.
                  setFsm("speaking");
                  optsRef.current.resumeSpeaking?.();
                  armTimer = window.setTimeout(armBarge, 400);
                }
              });
              if (!opened) {
                verifyingRef.current = false;
                setFsm("speaking");
                o.resumeSpeaking();
                armTimer = window.setTimeout(armBarge, 400);
              }
            };
          };
          if (bargeInRef.current && vadRef.current) {
            // Grace period so the assistant's opening words can't self-trigger.
            armTimer = window.setTimeout(armBarge, BARGE_GRACE_MS);
          }
          // The ONLY exit from "speaking": the TTS session settles. Real
          // playout events + useReadAloud's stall watchdog guarantee this
          // fires exactly once — ended, stopped, superseded, or error.
          optsRef.current.speak(reply, { onDone: () => finish() });
        });
      }
    } catch {
      /* error already surfaced via toast in sendMessage */
    } finally {
      // A stale generation owns nothing anymore — a newer session may be
      // live, so leave busyRef, the FSM, and scheduling entirely to it.
      if (gen === generationRef.current) {
        busyRef.current = false;
        if (!activeRef.current) {
          setFsm("idle");
        } else if (pendingBargeText) {
          // Verified interruption — the user already spoke; treat it as the
          // next turn immediately (no cooldown: they're mid-thought).
          const t = pendingBargeText;
          void Promise.resolve().then(() => { if (activeRef.current) handleUtteranceRef.current(t); });
        } else {
          // Cooldown starts from the REAL end of audio (onDone), and
          // scheduleListen additionally refuses to open over audible sound
          // (covers "superseded": the user played some other message — wait
          // for it to finish before reopening the mic).
          scheduleListenRef.current(POST_TTS_COOLDOWN_MS);
        }
      }
    }
  }, [teardownRecognition, setFsm]);

  const stopAll = useCallback(() => {
    generationRef.current += 1; // orphan any in-flight turn (see handleUtterance)
    activeRef.current = false;
    busyRef.current = false;
    verifyingRef.current = false;
    if (cooldownRef.current) { window.clearTimeout(cooldownRef.current); cooldownRef.current = null; }
    teardownRecognition();
    destroyVad();
    // Hands-free OFF closes the MIC, not the voice: an in-flight reply keeps
    // playing (and is never replayed) — the per-message speaker button and
    // the Read Aloud toggle still silence it on demand. If a barge-in
    // verification left playback paused, resume it so the reply isn't
    // stranded mid-sentence.
    optsRef.current.resumeSpeaking?.();
    setInterim("");
    setFsm("idle");
    setActive(false);
    if (silenceTimerRef.current) { window.clearInterval(silenceTimerRef.current); silenceTimerRef.current = null; }
    try { wakeLockRef.current?.release?.(); } catch { /* no-op */ }
    wakeLockRef.current = null;
  }, [teardownRecognition, destroyVad, setFsm]);

  // Keep callback refs current.
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);
  useEffect(() => { scheduleListenRef.current = scheduleListen; }, [scheduleListen]);
  useEffect(() => { handleUtteranceRef.current = handleUtterance; }, [handleUtterance]);
  useEffect(() => { stopAllRef.current = stopAll; }, [stopAll]);
  useEffect(() => { openRecognizerRef.current = openRecognizer; }, [openRecognizer]);

  // React to the barge-in toggle while a session is live.
  useEffect(() => {
    bargeInRef.current = bargeIn;
    if (!activeRef.current) return;
    if (bargeIn) void initVad();
    else destroyVad();
  }, [bargeIn, initVad, destroyVad]);

  const start = useCallback(async () => {
    if (!SR) { toast.error("Hands-free needs speech recognition — try Chrome or Edge."); return; }
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    // Dismiss any open soft keyboard: entering voice mode is a modality
    // switch — the composer must not keep focus (Gemini Live / ChatGPT voice
    // convention; also stops pocket keyboard clicks cold).
    try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* no-op */ }
    lastActivityRef.current = Date.now();
    if (silenceTimerRef.current) window.clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = window.setInterval(() => {
      if (!activeRef.current) return;
      if (busyRef.current) { lastActivityRef.current = Date.now(); return; } // thinking/speaking counts as activity
      if (Date.now() - lastActivityRef.current >= SILENCE_STOP_MS) {
        const speakFn = optsRef.current.speak;
        stopAllRef.current();
        try { speakFn?.("Hands-free is off after five minutes of quiet. Tap the mic when you need me."); } catch { /* no-op */ }
      }
    }, 30000);
    void probeLocalAsr();
    try { wakeLockRef.current = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ }
    if (bargeInRef.current) void initVad();
    // Respect the audio gate from the very first listen (e.g. hands-free
    // re-enabled while the previous reply is still being spoken).
    scheduleListen(0);
  }, [scheduleListen, initVad]);

  const toggle = useCallback(() => {
    if (activeRef.current) stopAll();
    else void start();
  }, [start, stopAll]);

  // Pause while the tab is hidden; resume on return (through the same gate —
  // returning to the tab mid-playback must not open the mic over audio).
  useEffect(() => {
    const onVis = () => {
      if (!activeRef.current) return;
      if (document.hidden) {
        const wasVerifying = verifyingRef.current;
        teardownRecognition();
        if (wasVerifying) {
          // The verify recognizer died with its onText callback — recover by
          // hand or the reply stays paused and busyRef never clears: audio
          // frozen mid-sentence, mic closed, session deadlocked. (Barge-in
          // stays disarmed for the rest of this reply; the next reply re-arms.)
          verifyingRef.current = false;
          setFsm("speaking");
          optsRef.current.resumeSpeaking?.();
        }
      } else {
        (async () => { try { wakeLockRef.current = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ } })();
        if (!busyRef.current) scheduleListenRef.current(LISTEN_RETRY_MS);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [teardownRecognition]);

  // Cleanup on unmount.
  useEffect(() => () => { stopAllRef.current(); }, []);

  return { supported, active, state, interim, start, stop: stopAll, toggle };
}
