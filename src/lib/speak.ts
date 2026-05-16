// Shared TTS helper using the browser SpeechSynthesis API.
// Tracks the active utterance so callers can detect when the same text
// is being spoken (toggle off) versus a new one (replace).

let currentId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

function setCurrent(id: string | null) {
  currentId = id;
  listeners.forEach((l) => l(id));
}

export function getSpeakingId(): string | null {
  return currentId;
}

export function subscribeSpeaking(cb: (id: string | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function stopSpeaking() {
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* no-op */
  }
  setCurrent(null);
}

export interface SpeakOptions {
  id?: string;
  rate?: number;
  onEnd?: () => void;
  onError?: () => void;
}

export function speak(text: string, opts: SpeakOptions = {}) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  try {
    synth.cancel();
  } catch {
    /* no-op */
  }
  const clean = (text || "")
    .replace(/[#*_`~\[\]()>|]/g, "")
    .replace(/\n+/g, ". ")
    .trim();
  if (!clean) {
    setCurrent(null);
    return;
  }
  const utter = new SpeechSynthesisUtterance(clean);
  const rate = Number.isFinite(opts.rate) ? Math.min(2, Math.max(0.5, opts.rate as number)) : 1.05;
  utter.rate = rate;
  const id = opts.id || `${Date.now()}-${Math.random()}`;
  utter.onstart = () => setCurrent(id);
  utter.onend = () => {
    if (currentId === id) setCurrent(null);
    opts.onEnd?.();
  };
  utter.onerror = () => {
    if (currentId === id) setCurrent(null);
    opts.onError?.();
  };
  setCurrent(id);
  synth.speak(utter);
}
