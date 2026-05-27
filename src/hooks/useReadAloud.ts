import { useCallback, useEffect, useRef, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { synthesizeSpeech } from "@/lib/inworldTts";

// Unified read-aloud for the merged Chat ("Talk") surface.
//
// Plays a message using the Inworld character voice when the user has it
// enabled, and transparently falls back to the browser SpeechSynthesis voice
// otherwise (or if an Inworld synthesis fails). Tracks a single "speaking id"
// so per-message read-aloud buttons can toggle play/stop and reflect state.
//
// NOTE: the sentence-by-sentence *streaming during generation* optimization
// (prefetch queue) that the old Voice tab used lives with the hands-free
// rebuild in Phase 3. This hook speaks a whole message in one shot, which is
// the behavior the Chat tab already had for auto-read — now upgraded to the
// Inworld voice when enabled.

const stripMarkdownForTts = (s: string) =>
  (s || "")
    .replace(/[#*_`~\[\]()>|]/g, "")
    .replace(/\n+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();

export interface ReadAloudController {
  /** Id of the message currently being spoken, or null. */
  speakingId: string | null;
  isSpeaking: boolean;
  /** Speak a block of text. Pass a stable id to drive toggle/stop UI, and an
   *  onEnd callback fired when playback finishes naturally (not on stop()). */
  speak: (text: string, opts?: { id?: string; onEnd?: () => void }) => void;
  /** Stop any in-flight synthesis/playback. */
  stop: () => void;
}

export function useReadAloud(): ReadAloudController {
  const { ttsRate, inworldEnabled, inworldApiKey, inworldVoiceId } = useChatSettings();
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const synthRef = useRef<SpeechSynthesis | null>(
    typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null,
  );
  const rate = ttsRate || 1.05;

  const clearId = useCallback((id: string) => {
    setSpeakingId((cur) => (cur === id ? null : cur));
  }, []);

  const stop = useCallback(() => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* no-op */ }
      abortRef.current = null;
    }
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* no-op */ }
      audioRef.current.src = "";
    }
    try { synthRef.current?.cancel(); } catch { /* no-op */ }
    setSpeakingId(null);
  }, []);

  const browserSpeak = useCallback((text: string, id: string, onEnd?: () => void) => {
    const synth = synthRef.current;
    if (!synth) { clearId(id); onEnd?.(); return; }
    try { synth.cancel(); } catch { /* no-op */ }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.min(2, Math.max(0.5, rate));
    const fin = () => { clearId(id); onEnd?.(); };
    u.onend = fin;
    u.onerror = fin;
    synth.speak(u);
  }, [rate, clearId]);

  const speak = useCallback((text: string, opts?: { id?: string; onEnd?: () => void }) => {
    const clean = stripMarkdownForTts(text);
    const onEnd = opts?.onEnd;
    if (!clean) { onEnd?.(); return; }
    stop();
    const id = opts?.id || `speak-${Date.now()}`;
    setSpeakingId(id);

    // Inworld path (premium voice). `inworldApiKey` is passed for API
    // compatibility but the edge function authenticates via the Supabase
    // session, so an enabled toggle + a chosen voice are what matter.
    if (inworldEnabled && inworldVoiceId) {
      const controller = new AbortController();
      abortRef.current = controller;
      synthesizeSpeech(clean, inworldApiKey, inworldVoiceId, "inworld-tts-2", { signal: controller.signal })
        .then((buf) => {
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
          let audio = audioRef.current;
          if (!audio) { audio = new Audio(); audioRef.current = audio; }
          audio.src = url;
          audio.playbackRate = Math.min(2, Math.max(0.5, rate));
          const done = () => {
            try { URL.revokeObjectURL(url); } catch { /* no-op */ }
            clearId(id);
            onEnd?.();
          };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        })
        .catch(() => {
          // Transparent fallback to the browser voice on any Inworld error.
          if (controller.signal.aborted) return;
          browserSpeak(clean, id, onEnd);
        });
      return;
    }

    browserSpeak(clean, id, onEnd);
  }, [inworldEnabled, inworldApiKey, inworldVoiceId, rate, stop, browserSpeak, clearId]);

  useEffect(() => () => stop(), [stop]);

  return { speakingId, isSpeaking: speakingId !== null, speak, stop };
}
