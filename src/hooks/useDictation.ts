import React, { useEffect, useRef, useState } from "react";

/**
 * Lightweight push-to-talk dictation hook for the Chat tab.
 * Returns interim transcript while listening and a final string when stopped.
 * Does NOT auto-submit — the caller decides what to do.
 *
 * Anti-duplication design (the reason words like "please please do" used to
 * appear): the Web Speech API in `continuous` mode re-emits and re-finalizes
 * results. Rebuilding the transcript from index 0 each event, or blindly
 * appending every indexed result, double-counts those re-emissions. Instead we:
 *   1. Key finalized segments by their SpeechRecognitionResult index, so a
 *      re-emitted/re-finalized result OVERWRITES rather than appends.
 *   2. Iterate only from `event.resultIndex` (the first changed result).
 *   3. Flush each session's finals into a persistent accumulator before the
 *      auto-restart that `continuous` mode triggers on silence, since a new
 *      session resets the result indices back to 0.
 * Mirrors the approach used by the widely-trusted `react-speech-recognition`.
 */
export interface UseDictationOpts {
  onFinal?: (text: string) => void;
  onInterim?: (text: string) => void;
}

export interface UseDictationApi {
  supported: boolean;
  isListening: boolean;
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

const SpeechRecognitionImpl: any =
  typeof window !== "undefined" ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isAndroid = /android/i.test(ua);
// iOS Safari's `continuous` support is unreliable — treat it as one-shot
// (no auto-restart) to avoid the engine throwing / looping.
const isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && (navigator as any).maxTouchPoints > 1);

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export function useDictation(opts: UseDictationOpts = {}): UseDictationApi {
  const supported = !!SpeechRecognitionImpl;
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<any>(null);
  const cbRef = useRef(opts);
  useEffect(() => { cbRef.current = opts; }, [opts]);

  // Finals committed in PREVIOUS sessions (survive continuous-mode restarts).
  const committedRef = useRef("");
  // Finals in the CURRENT session, keyed by result index so re-emissions of the
  // same index overwrite instead of duplicating. Cleared on (re)start.
  const finalSegmentsRef = useRef<string[]>([]);
  // True while the user wants to keep dictating — drives auto-restart on onend.
  const wantListeningRef = useRef(false);

  const sessionFinal = () => finalSegmentsRef.current.filter(Boolean).join(" ");
  const fullFinal = () => collapse(committedRef.current + " " + sessionFinal());

  const cleanup = () => {
    const r = recRef.current;
    if (!r) return;
    // Detach handlers first so the forced stop() can't trigger an auto-restart.
    try { r.onstart = null; r.onresult = null; r.onerror = null; r.onend = null; } catch {}
    try { r.stop(); } catch {}
    recRef.current = null;
  };

  useEffect(() => () => { wantListeningRef.current = false; cleanup(); }, []);

  const start = () => {
    if (!supported || wantListeningRef.current) return; // guard double-start (re-render / StrictMode)
    cleanup();
    committedRef.current = "";
    finalSegmentsRef.current = [];
    setInterim("");
    wantListeningRef.current = true;

    const rec = new SpeechRecognitionImpl();
    rec.continuous = !isIOS;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => setIsListening(true);

    rec.onresult = (e: any) => {
      let interimStr = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = String(res[0]?.transcript || "").trim();
        if (!t) continue;
        if (res.isFinal) {
          // Android re-emits duplicate finals with confidence 0 — skip those.
          if (isAndroid && typeof res[0].confidence === "number" && res[0].confidence === 0) continue;
          finalSegmentsRef.current[i] = t; // key by index → idempotent
        } else {
          interimStr += (interimStr ? " " : "") + t;
        }
      }
      const combined = collapse(fullFinal() + " " + interimStr);
      setInterim(combined);
      cbRef.current.onInterim?.(combined);
    };

    rec.onerror = (e: any) => {
      // Permission errors are terminal — stop trying. no-speech / aborted /
      // network are transient: let onend decide whether to restart.
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        wantListeningRef.current = false;
      }
    };

    rec.onend = () => {
      // Flush this session's finals so the restart (which resets result indices
      // to 0) doesn't reuse stale slots, then clear the per-session buffer.
      committedRef.current = fullFinal();
      finalSegmentsRef.current = [];

      if (wantListeningRef.current && !isIOS) {
        try { rec.start(); return; } catch { /* fall through to finalize */ }
      }

      setIsListening(false);
      wantListeningRef.current = false;
      setInterim("");
      const finalStr = collapse(committedRef.current);
      if (finalStr) cbRef.current.onFinal?.(finalStr);
    };

    recRef.current = rec;
    try { rec.start(); } catch { /* InvalidStateError if already running */ }
  };

  const stop = () => {
    wantListeningRef.current = false; // prevents onend auto-restart
    const r = recRef.current;
    if (!r) { setIsListening(false); return; }
    try { r.stop(); } catch {}
  };

  const toggle = () => { isListening ? stop() : start(); };

  return { supported, isListening, interim, start, stop, toggle };
}
