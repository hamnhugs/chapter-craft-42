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
  model = "inworld-tts-2",
  opts?: { signal?: AbortSignal; sampleRate?: number },
): Promise<ArrayBuffer> {
  let cleanVoiceId = String(voiceId ?? "").trim();
  if (!cleanVoiceId || cleanVoiceId === "undefined") {
    cleanVoiceId = "Ashley"; // Inworld built-in default
  }
  const cleanModel = (model && model.trim()) || "inworld-tts-2";
  const headers = await authHeaders();
  const resp = await fetch(FUNCTIONS_BASE, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: cleanVoiceId,
      model: cleanModel,
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
  /** Served from the book's saved audio on the VPS (no Inworld charge). */
  cached?: boolean;
}

/**
 * `synthesizeSpeech` plus Inworld WORD timestamps, for read-along highlighting.
 * Tolerates an edge function that predates timestamp support: it answers with
 * raw audio/mpeg, which comes back with `words: null` (caller estimates).
 */
export async function synthesizeSpeechWithTimestamps(
  text: string,
  voiceId: string,
  model = "inworld-tts-2",
  opts?: { signal?: AbortSignal; sampleRate?: number; bookId?: string },
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
      model: (model && model.trim()) || "inworld-tts-2",
      sample_rate: opts?.sampleRate ?? 24000,
      timestamp_type: "WORD",
      // Read Along: the server keeps this clip under the book on the VPS and
      // serves repeats from there instead of paying Inworld again.
      ...(opts?.bookId ? { cache_book_id: opts.bookId } : {}),
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
  return {
    audio: bin.buffer,
    words: parseWordAlignment(data?.timestampInfo),
    cached: resp.headers.get("X-TTS-Cache") === "hit",
  };
}

/** Best-effort: delete a book's saved read-along audio (after the book is purged). */
export async function purgeBookAudio(bookId: string): Promise<void> {
  try {
    const headers = await authHeaders();
    await fetch(FUNCTIONS_BASE, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "purge_cache", book_id: bookId }),
    });
  } catch {
    /* orphaned audio is evicted from the VPS as space is needed */
  }
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
