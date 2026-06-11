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
// LATENCY: the message is split into sentence-sized chunks and the FIRST chunk
// starts playing while the rest are still being prepared. The browser engine
// otherwise synthesizes the whole message before emitting a single word (its
// latency scales with text length), and Inworld would otherwise round-trip the
// entire reply before any audio — so chunking is what makes time-to-first-audio
// short enough to feel hands-free. For Inworld we pipeline: chunk N+1 is
// requested while chunk N is still playing, so playback stays gap-free.

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
  // Monotonic token: bumped on every stop()/new speak() so stale async chunk
  // work (in-flight Inworld fetches, queued utterances) can detect it's been
  // superseded and bail instead of stomping the current playback.
  const sessionRef = useRef(0);
  const rate = ttsRate || 1.05;
  const clampedRate = Math.min(2, Math.max(0.5, rate));

  const clearId = useCallback((id: string) => {
    setSpeakingId((cur) => (cur === id ? null : cur));
  }, []);

  const stop = useCallback(() => {
    sessionRef.current += 1;
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
    try { synthRef.current?.cancel(); } catch { /* no-op */ }
    setSpeakingId(null);
  }, []);

  // Browser voice: queue one utterance per chunk. The engine plays them in
  // order, but only has to synthesize the (short) first chunk before audio
  // starts — and short utterances also sidestep Chrome's ~15s long-utterance
  // cutoff. Used directly when Inworld is off, and as the fallback for it.
  const browserSpeakChunks = useCallback(
    (chunks: string[], id: string, session: number, onEnd?: () => void) => {
      const synth = synthRef.current;
      if (!synth || chunks.length === 0) { clearId(id); onEnd?.(); return; }
      try { synth.cancel(); } catch { /* no-op */ }
      ensureVoices(synth).then(() => {
        if (session !== sessionRef.current) return;
        chunks.forEach((chunk, i) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.rate = clampedRate;
          if (i === 0) {
            u.onstart = () => { if (session === sessionRef.current) setSpeakingId(id); };
          }
          if (i === chunks.length - 1) {
            const fin = () => { if (session === sessionRef.current) { clearId(id); onEnd?.(); } };
            u.onend = fin;
            u.onerror = fin;
          }
          synth.speak(u);
        });
      });
    },
    [clampedRate, clearId],
  );

  // Inworld voice: synthesize chunk-by-chunk with a one-ahead prefetch so the
  // first sentence's audio is ready after a single short request, and each
  // subsequent chunk is already in flight while the current one plays.
  const inworldSpeakChunks = useCallback(
    async (chunks: string[], id: string, session: number, onEnd?: () => void) => {
      if (chunks.length === 0) { clearId(id); onEnd?.(); return; }

      const playBuffer = (buf: ArrayBuffer): Promise<void> =>
        new Promise((resolve) => {
          const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
          let audio = audioRef.current;
          if (!audio) { audio = new Audio(); audioRef.current = audio; }
          audio.src = url;
          audio.playbackRate = clampedRate;
          const done = () => {
            try { URL.revokeObjectURL(url); } catch { /* no-op */ }
            if (audio) { audio.onended = null; audio.onerror = null; }
            resolve();
          };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });

      const synthChunk = (t: string) => {
        const controller = new AbortController();
        abortRef.current = controller; // latest wins; stop() aborts it
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
          if (session !== sessionRef.current) return;
          // Inworld failed for this chunk — read the rest with the browser
          // voice so the user still hears the whole reply.
          browserSpeakChunks(chunks.slice(i), id, session, onEnd);
          return;
        }
        if (session !== sessionRef.current) return;
        // Kick off the next request before playing the current chunk.
        next = i + 1 < chunks.length ? synthChunk(chunks[i + 1]) : Promise.resolve(new ArrayBuffer(0));
        if (i === 0 && session === sessionRef.current) setSpeakingId(id);
        await playBuffer(buf);
        if (session !== sessionRef.current) return;
      }
      if (session === sessionRef.current) { clearId(id); onEnd?.(); }
    },
    [inworldApiKey, inworldVoiceId, clampedRate, clearId, browserSpeakChunks],
  );

  const speak = useCallback(
    (text: string, opts?: { id?: string; onEnd?: () => void }) => {
      const clean = stripMarkdownForTts(text);
      const onEnd = opts?.onEnd;
      if (!clean) { onEnd?.(); return; }
      stop(); // bumps sessionRef
      const session = sessionRef.current;
      const id = opts?.id || `speak-${Date.now()}`;
      setSpeakingId(id);
      const chunks = splitIntoChunks(clean);

      // Inworld path (premium voice). `inworldApiKey` is passed for API
      // compatibility but the edge function authenticates via the Supabase
      // session, so an enabled toggle + a chosen voice are what matter.
      if (inworldEnabled && inworldVoiceId) {
        void inworldSpeakChunks(chunks, id, session, onEnd);
        return;
      }
      browserSpeakChunks(chunks, id, session, onEnd);
    },
    [inworldEnabled, inworldVoiceId, stop, inworldSpeakChunks, browserSpeakChunks],
  );

  useEffect(() => () => stop(), [stop]);

  return { speakingId, isSpeaking: speakingId !== null, speak, stop };
}
