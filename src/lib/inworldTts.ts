import { supabase } from "@/integrations/supabase/client";

export interface InworldVoice {
  voice_id: string;
  name: string;
  tags?: string[];
  language_code?: string;
  gender?: string;
}

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL ?? "https://ktzaysdkdkocqhewwtnn.supabase.co"}/functions/v1/inworld-tts`;
const ANON_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0emF5c2RrZGtvY3FoZXd3dG5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3MDc5NTMsImV4cCI6MjA4NzI4Mzk1M30.Kql1cXJFJ1Me2XKQj0Jkf1G-iKHiUbc0GB_24NOfsP0";

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error("Not signed in");
  return {
    Authorization: `Bearer ${jwt}`,
    apikey: ANON_KEY,
  };
}

/** Inworld's two current models. Flash is the fast/cheap one and ignores
 *  direction; everything older is deprecated or already discontinued. */
export const INWORLD_MODELS = [
  { id: "inworld-tts-2", label: "TTS-2 — most expressive" },
  { id: "inworld-tts-2-flash", label: "TTS-2 Flash — fastest, cheapest" },
] as const;
export const DEFAULT_INWORLD_MODEL = "inworld-tts-2";

/** STABLE keeps the voice even (long narration); CREATIVE lets it range. */
export type InworldDelivery = "STABLE" | "BALANCED" | "CREATIVE";
export const INWORLD_DELIVERIES: InworldDelivery[] = ["STABLE", "BALANCED", "CREATIVE"];

/** Direction value meaning "the voice reads the line and directs itself"
 *  (Inworld Reasoning) instead of following a written direction. */
export const AUTO_DIRECTION = "auto";

/** Written directions. TTS-2 follows prose, and a described scene steers it
 *  better than a one-word mood — so the stored value IS the sentence. */
export const DIRECTION_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Storyteller", value: "speak like a warm, unhurried storyteller reading aloud by the fire" },
  { label: "Calm", value: "speak softly and calmly, in a gentle, soothing voice at a relaxed pace" },
  { label: "Upbeat", value: "speak with bright, upbeat energy, like sharing good news with a friend" },
  { label: "Dramatic", value: "speak with dramatic intensity, like a stage actor playing to the back row" },
  { label: "Whisper", value: "whisper quietly and close, as if trying not to wake anyone" },
];

/** How a line should be performed — everything beyond "which voice". */
export interface VoiceStyle {
  /** "" / undefined = DEFAULT_INWORLD_MODEL. */
  model?: string;
  delivery?: InworldDelivery;
  /** "" = none · AUTO_DIRECTION = the voice decides · else a written direction. */
  direction?: string;
  /** What is going on, for AUTO_DIRECTION to act on. Never spoken. */
  scene?: string;
}

/** A chunk's text plus what was said just before it. */
export interface SpeechContext {
  /** The preceding chunks, oldest first — see `contextBefore`. */
  previous?: string[];
}

const CONTEXT_CHUNKS = 2;
const CONTEXT_CHARS = 600;

/**
 * The chunks spoken just before `index`, for Inworld's synthesis context.
 * Each sentence chunk is its own request, so without this every sentence is
 * performed cold — the voice resets its pace and pitch at each boundary. Kept
 * to the last couple (Inworld: long context starts to outweigh the line
 * itself). Context text is not billed.
 */
export function contextBefore(chunks: string[], index: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = index - 1; i >= 0 && out.length < CONTEXT_CHUNKS; i--) {
    const t = (chunks[i] || "").trim();
    if (!t) continue;
    if (used + t.length > CONTEXT_CHARS) break;
    used += t.length;
    out.unshift(t);
  }
  return out;
}

/** The style half of the edge-function request body. An edge function that
 *  predates these fields ignores them and speaks the line plainly. */
export function styleFields(style?: VoiceStyle, ctx?: SpeechContext): Record<string, unknown> {
  const model = (style?.model && style.model.trim()) || DEFAULT_INWORLD_MODEL;
  const out: Record<string, unknown> = { model };
  if (style?.delivery && INWORLD_DELIVERIES.includes(style.delivery)) out.delivery = style.delivery;
  const direction = (style?.direction || "").trim();
  // Flash ignores direction; sending it would only bill the extra characters.
  if (direction && model === DEFAULT_INWORLD_MODEL) {
    if (direction === AUTO_DIRECTION) {
      out.reasoning = true;
      if (style?.scene) out.reasoning_context = style.scene;
    } else {
      out.direction = direction;
    }
  }
  if (ctx?.previous?.length) out.previous = ctx.previous;
  return out;
}

// `_apiKey` accepted for backwards compatibility with existing callers; ignored.
export async function fetchInworldVoices(_apiKey?: string): Promise<InworldVoice[]> {
  const headers = await authHeaders();
  const resp = await fetch(`${FUNCTIONS_BASE}/voices`, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status}: ${body}`);
  }
  const data = await resp.json();
  const voices = Array.isArray(data) ? data : (data.voices ?? []);
  return voices
    .map((voice: any) => ({
      ...voice,
      voice_id: String(voice.voice_id ?? voice.voiceId ?? voice.id ?? "").trim(),
      name: String(voice.name ?? voice.displayName ?? voice.voiceId ?? voice.voice_id ?? "Unknown voice"),
    }))
    .filter((voice: InworldVoice) => voice.voice_id && voice.voice_id !== "undefined");
}

export async function synthesizeSpeech(
  text: string,
  _apiKey: string | undefined,
  voiceId: string,
  model?: string,
  opts?: { signal?: AbortSignal; sampleRate?: number; style?: VoiceStyle; context?: SpeechContext },
): Promise<ArrayBuffer> {
  let cleanVoiceId = String(voiceId ?? "").trim();
  if (!cleanVoiceId || cleanVoiceId === "undefined") {
    cleanVoiceId = "Ashley"; // Inworld built-in default
  }
  const headers = await authHeaders();
  const resp = await fetch(FUNCTIONS_BASE, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: cleanVoiceId,
      ...styleFields({ ...opts?.style, model: model || opts?.style?.model }, opts?.context),
      sample_rate: opts?.sampleRate ?? 24000,
    }),
    signal: opts?.signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status}: ${body}`);
  }
  return resp.arrayBuffer();
}

export interface TimedSpeech {
  audio: ArrayBuffer;
  /** Per-token timing (seconds from audio start), or null when unavailable. */
  words: Array<{ text: string; start: number; end: number }> | null;
}

/**
 * `synthesizeSpeech` plus Inworld WORD timestamps, for read-along highlighting.
 * Tolerates an edge function that predates timestamp support: it answers with
 * raw audio/mpeg, which comes back with `words: null` (caller estimates).
 */
export async function synthesizeSpeechWithTimestamps(
  text: string,
  voiceId: string,
  model?: string,
  opts?: { signal?: AbortSignal; sampleRate?: number; style?: VoiceStyle; context?: SpeechContext },
): Promise<TimedSpeech> {
  let cleanVoiceId = String(voiceId ?? "").trim();
  if (!cleanVoiceId || cleanVoiceId === "undefined") cleanVoiceId = "Ashley";
  const headers = await authHeaders();
  const resp = await fetch(FUNCTIONS_BASE, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: cleanVoiceId,
      ...styleFields({ ...opts?.style, model: model || opts?.style?.model }, opts?.context),
      sample_rate: opts?.sampleRate ?? 24000,
      timestamp_type: "WORD",
    }),
    signal: opts?.signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status}: ${body}`);
  }
  if (!(resp.headers.get("Content-Type") || "").includes("application/json")) {
    return { audio: await resp.arrayBuffer(), words: null };
  }
  const data = await resp.json();
  const bin = Uint8Array.from(atob(String(data?.audioContent ?? "")), (c) => c.charCodeAt(0));
  return { audio: bin.buffer, words: parseWordAlignment(data?.timestampInfo) };
}

/** Inworld `timestampInfo.wordAlignment` → flat timed tokens (null if absent/malformed). */
export function parseWordAlignment(info: unknown): TimedSpeech["words"] {
  const wa = (info as { wordAlignment?: Record<string, unknown> } | null)?.wordAlignment;
  const words = wa?.words;
  const starts = wa?.wordStartTimeSeconds;
  const ends = wa?.wordEndTimeSeconds;
  if (!Array.isArray(words) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  const out: NonNullable<TimedSpeech["words"]> = [];
  for (let i = 0; i < words.length; i++) {
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    if (!Number.isFinite(start)) continue;
    out.push({ text: String(words[i] ?? ""), start, end: Number.isFinite(end) ? end : start });
  }
  return out.length ? out : null;
}
