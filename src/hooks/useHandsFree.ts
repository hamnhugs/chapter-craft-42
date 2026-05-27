import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

// Hands-free voice conversation, modeled as an explicit finite-state machine.
//
//   idle → listening → thinking → speaking → (cooldown) → listening …
//
// Why this fixes the old bugs:
//   • Per-utterance recognition (continuous = false) lets the browser's own
//     endpointing close each turn — no fragile setTimeout silence timers.
//   • HARD echo-gating: the mic recognizer is only open in `listening`. During
//     thinking/speaking (and a short cooldown after TTS) it's fully stopped, so
//     the recognizer can never transcribe the assistant's own voice.
//   • One recognizer at a time, started explicitly and torn down in onend.
//
// OPTIONAL BARGE-IN (toggle): when enabled, a Silero VAD (lazy-loaded from CDN)
// listens *during* playback and, on detecting real user speech, stops the TTS
// and jumps back to listening — so you can interrupt the assistant. Acoustic
// echo cancellation + a high speech threshold keep the assistant's own audio
// from self-triggering. If the VAD can't load, we fall back to turn-based.

const SR: any =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

export type HandsFreeState = "idle" | "listening" | "thinking" | "speaking";

interface UseHandsFreeOpts {
  /** Send a user utterance to the model; resolves with the assistant reply. */
  onUtterance: (text: string) => Promise<string>;
  /** Speak the reply; onEnd fires when playback finishes naturally. */
  speak: (text: string, opts?: { onEnd?: () => void }) => void;
  /** Stop any in-flight speech. */
  stopSpeaking: () => void;
  /** Enable interrupting the assistant mid-sentence (needs VAD). */
  bargeIn?: boolean;
}

const POST_TTS_COOLDOWN_MS = 700; // let the speaker tail / AEC settle before re-opening the mic

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

export interface HandsFreeController {
  supported: boolean;
  active: boolean;
  state: HandsFreeState;
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useHandsFree({ onUtterance, speak, stopSpeaking, bargeIn = false }: UseHandsFreeOpts): HandsFreeController {
  const supported = !!SR;
  const [active, setActive] = useState(false);
  const [state, setState] = useState<HandsFreeState>("idle");
  const [interim, setInterim] = useState("");

  const recRef = useRef<any>(null);
  const activeRef = useRef(false);
  const busyRef = useRef(false); // true while thinking or speaking (recognizer must stay closed)
  const finalRef = useRef("");
  const wakeLockRef = useRef<any>(null);
  const cooldownRef = useRef<number | null>(null);

  // Barge-in (VAD) state.
  const bargeInRef = useRef(bargeIn);
  const vadRef = useRef<any>(null);
  const vadInitingRef = useRef(false);
  const bargeCallbackRef = useRef<(() => void) | null>(null);

  // Latest-value refs so recognizer callbacks always call the current fns.
  const startListeningRef = useRef<() => void>(() => {});
  const handleUtteranceRef = useRef<(t: string) => void>(() => {});
  const stopAllRef = useRef<() => void>(() => {});

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
        // High threshold + a few frames so the assistant's own (echo-cancelled)
        // audio doesn't self-trigger an interruption.
        positiveSpeechThreshold: 0.85,
        minSpeechFrames: 4,
        additionalAudioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

  // ---- Listening --------------------------------------------------------
  const startListening = useCallback(() => {
    if (!activeRef.current || busyRef.current || !SR) return;
    if (recRef.current) return; // already listening
    finalRef.current = "";
    setInterim("");

    const rec = new SR();
    rec.continuous = false;      // one utterance per session → browser endpoints the turn
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => setState("listening");
    rec.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = String(e.results[i][0]?.transcript || "");
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) finalRef.current = `${finalRef.current} ${finalText}`.trim();
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
      if (!activeRef.current) { setState("idle"); return; }
      const text = finalRef.current.trim();
      finalRef.current = "";
      setInterim("");
      if (text) handleUtteranceRef.current(text);
      else if (!busyRef.current) startListeningRef.current(); // no speech — keep listening
    };

    recRef.current = rec;
    try { rec.start(); } catch { /* start can throw if called too soon; onend retries */ }
  }, []);

  // ---- One full turn: send → speak (interruptible) → resume -------------
  const handleUtterance = useCallback(async (text: string) => {
    busyRef.current = true;
    teardownRecognition();
    setState("thinking");
    let bargedIn = false;
    try {
      const reply = await onUtterance(text);
      if (!activeRef.current) return;
      if (reply && reply.trim()) {
        setState("speaking");
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            bargeCallbackRef.current = null;
            resolve();
          };
          // Safety net: never hang in "speaking" if onEnd never fires.
          const maxMs = Math.min(90000, 4000 + reply.length * 90);
          const timer = window.setTimeout(finish, maxMs);
          // Arm barge-in: VAD's onSpeechStart will fire this while we speak.
          if (bargeInRef.current && vadRef.current) {
            bargeCallbackRef.current = () => {
              bargedIn = true;
              stopSpeaking();
              window.clearTimeout(timer);
              finish();
            };
          }
          speak(reply, { onEnd: () => { window.clearTimeout(timer); finish(); } });
        });
      }
    } catch {
      /* error already surfaced via toast in sendMessage */
    } finally {
      busyRef.current = false;
      if (activeRef.current) {
        // On a barge-in, the user is already talking — resume immediately.
        const delay = bargedIn ? 0 : POST_TTS_COOLDOWN_MS;
        if (cooldownRef.current) window.clearTimeout(cooldownRef.current);
        cooldownRef.current = window.setTimeout(() => {
          if (activeRef.current && !busyRef.current) startListeningRef.current();
        }, delay);
      } else {
        setState("idle");
      }
    }
  }, [onUtterance, speak, stopSpeaking, teardownRecognition]);

  const stopAll = useCallback(() => {
    activeRef.current = false;
    busyRef.current = false;
    if (cooldownRef.current) { window.clearTimeout(cooldownRef.current); cooldownRef.current = null; }
    teardownRecognition();
    destroyVad();
    stopSpeaking();
    setInterim("");
    setState("idle");
    setActive(false);
    try { wakeLockRef.current?.release?.(); } catch { /* no-op */ }
    wakeLockRef.current = null;
  }, [teardownRecognition, destroyVad, stopSpeaking]);

  // Keep callback refs current.
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);
  useEffect(() => { handleUtteranceRef.current = handleUtterance; }, [handleUtterance]);
  useEffect(() => { stopAllRef.current = stopAll; }, [stopAll]);

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
    try { wakeLockRef.current = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ }
    if (bargeInRef.current) void initVad();
    startListening();
  }, [startListening, initVad]);

  const toggle = useCallback(() => {
    if (activeRef.current) stopAll();
    else void start();
  }, [start, stopAll]);

  // Pause while the tab is hidden; resume on return.
  useEffect(() => {
    const onVis = () => {
      if (!activeRef.current) return;
      if (document.hidden) {
        teardownRecognition();
      } else if (!busyRef.current) {
        (async () => { try { wakeLockRef.current = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ } })();
        startListeningRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [teardownRecognition]);

  // Cleanup on unmount.
  useEffect(() => () => { stopAllRef.current(); }, []);

  return { supported, active, state, interim, start, stop: stopAll, toggle };
}
