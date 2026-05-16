import React, { useEffect, useRef, useState } from "react";

/**
 * Lightweight push-to-talk dictation hook for the Chat tab.
 * Returns interim transcript while listening and a final string when stopped.
 * Does NOT auto-submit — the caller decides what to do.
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

export function useDictation(opts: UseDictationOpts = {}): UseDictationApi {
  const supported = !!SpeechRecognitionImpl;
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<any>(null);
  const finalRef = useRef("");
  const cbRef = useRef(opts);
  useEffect(() => { cbRef.current = opts; }, [opts]);

  const cleanup = () => {
    const r = recRef.current;
    if (!r) return;
    try { r.onstart = null; r.onresult = null; r.onerror = null; r.onend = null; } catch {}
    try { r.stop(); } catch {}
    recRef.current = null;
  };

  useEffect(() => () => cleanup(), []);

  const start = () => {
    if (!supported || isListening) return;
    cleanup();
    finalRef.current = "";
    setInterim("");
    const rec = new SpeechRecognitionImpl();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onstart = () => setIsListening(true);
    rec.onresult = (e: any) => {
      let interimStr = "";
      let finalStr = finalRef.current;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = String(res[0]?.transcript || "");
        if (res.isFinal) finalStr += (finalStr ? " " : "") + t.trim();
        else interimStr += t;
      }
      finalRef.current = finalStr;
      const combined = (finalStr + " " + interimStr).replace(/\s+/g, " ").trim();
      setInterim(combined);
      cbRef.current.onInterim?.(combined);
    };
    rec.onerror = () => { /* swallow benign errors */ };
    rec.onend = () => {
      setIsListening(false);
      const finalStr = finalRef.current.trim();
      setInterim("");
      if (finalStr) cbRef.current.onFinal?.(finalStr);
    };
    recRef.current = rec;
    try { rec.start(); } catch {}
  };

  const stop = () => {
    const r = recRef.current;
    if (!r) { setIsListening(false); return; }
    try { r.stop(); } catch {}
  };

  const toggle = () => { isListening ? stop() : start(); };

  return { supported, isListening, interim, start, stop, toggle };
}
