import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

// Hands-free voice conversation, rebuilt as an explicit finite-state machine.
//
// Design (Path A — keeps Inworld TTS + OpenRouter, no extra STT vendor):
//   idle → listening → thinking → speaking → (cooldown) → listening …
//
// Why this fixes the old bugs:
//   • Per-utterance recognition (continuous = false) lets the browser's own
//     endpointing close each turn — no fragile setTimeout silence timers.
//   • HARD echo-gating: the mic is only open in the `listening` state. During
//     thinking/speaking (and a short cooldown after TTS) recognition is fully
//     stopped, so the mic can never transcribe the assistant's own voice.
//   • One recognizer at a time, started explicitly on entering `listening` and
//     torn down in onend — no overlapping starts / restart races.
//
// Barge-in (interrupting TTS by speaking over it) requires always-on VAD with
// acoustic echo cancellation; that's the next increment and is intentionally
// out of scope here so this stays reliable without unverifiable audio-ML deps.

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
}

const POST_TTS_COOLDOWN_MS = 700; // let the speaker tail / AEC settle before re-opening the mic

export interface HandsFreeController {
  supported: boolean;
  active: boolean;
  state: HandsFreeState;
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useHandsFree({ onUtterance, speak, stopSpeaking }: UseHandsFreeOpts): HandsFreeController {
  const supported = !!SR;
  const [active, setActive] = useState(false);
  const [state, setState] = useState<HandsFreeState>("idle");
  const [interim, setInterim] = useState("");

  const recRef = useRef<any>(null);
  const activeRef = useRef(false);
  const busyRef = useRef(false); // true while thinking or speaking (mic must stay closed)
  const finalRef = useRef("");
  const wakeLockRef = useRef<any>(null);
  const cooldownRef = useRef<number | null>(null);

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
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          stopAllRef.current();
        }
      }
    };
    rec.onend = () => {
      recRef.current = null;
      if (!activeRef.current) { setState("idle"); return; }
      const text = finalRef.current.trim();
      finalRef.current = "";
      setInterim("");
      if (text) {
        handleUtteranceRef.current(text);
      } else if (!busyRef.current) {
        // No speech captured this window — keep listening.
        startListeningRef.current();
      }
    };

    recRef.current = rec;
    try { rec.start(); } catch { /* start can throw if called too soon; onend will retry */ }
  }, []);

  const handleUtterance = useCallback(async (text: string) => {
    busyRef.current = true;
    teardownRecognition();
    setState("thinking");
    try {
      const reply = await onUtterance(text);
      if (!activeRef.current) return;
      if (reply && reply.trim()) {
        setState("speaking");
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          // Safety net: never hang in "speaking" if onEnd never fires.
          const maxMs = Math.min(90000, 4000 + reply.length * 90);
          const timer = window.setTimeout(finish, maxMs);
          speak(reply, { onEnd: () => { window.clearTimeout(timer); finish(); } });
        });
      }
    } catch {
      /* error already surfaced via toast in sendMessage */
    } finally {
      busyRef.current = false;
      if (activeRef.current) {
        if (cooldownRef.current) window.clearTimeout(cooldownRef.current);
        cooldownRef.current = window.setTimeout(() => {
          if (activeRef.current && !busyRef.current) startListeningRef.current();
        }, POST_TTS_COOLDOWN_MS);
      } else {
        setState("idle");
      }
    }
  }, [onUtterance, speak, teardownRecognition]);

  const stopAll = useCallback(() => {
    activeRef.current = false;
    busyRef.current = false;
    if (cooldownRef.current) { window.clearTimeout(cooldownRef.current); cooldownRef.current = null; }
    teardownRecognition();
    stopSpeaking();
    setInterim("");
    setState("idle");
    setActive(false);
    try { wakeLockRef.current?.release?.(); } catch { /* no-op */ }
    wakeLockRef.current = null;
  }, [teardownRecognition, stopSpeaking]);

  // Keep callback refs current.
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);
  useEffect(() => { handleUtteranceRef.current = handleUtterance; }, [handleUtterance]);
  useEffect(() => { stopAllRef.current = stopAll; }, [stopAll]);

  const start = useCallback(async () => {
    if (!SR) { toast.error("Hands-free needs speech recognition — try Chrome or Edge."); return; }
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    try { wakeLockRef.current = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ }
    startListening();
  }, [startListening]);

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
        // Re-acquire wake lock (it's released when the tab is hidden) and resume.
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
