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

// ---------------------------------------------------------------------------
// Local voices (Piper on this machine, reached through the dev server's
// same-origin /local/tts proxy — see vite.config.ts). A voice id of the form
// "piper:<voice>" is synthesized locally; every other id goes to Inworld
// exactly as before. Piper measured ~0.3 s for 5 s of speech on this
// machine's CPU (docs/local-ai/results).
// ---------------------------------------------------------------------------

export const PIPER_PREFIX = "piper:";
const LOCAL_TTS = "/local/tts";

export function isPiperVoice(voiceId: string | undefined): boolean {
  return String(voiceId || "").startsWith(PIPER_PREFIX);
}

/** MIME type from the bytes: Piper returns WAV, Inworld MP3. */
export function audioMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 4));
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 ? "audio/wav" : "audio/mpeg";
}

export async function fetchPiperVoices(): Promise<InworldVoice[]> {
  try {
    const r = await fetch(`${LOCAL_TTS}/voices`);
    if (!r.ok) return [];
    const data = await r.json();
    return Object.entries(data || {}).map(([id, cfg]: [string, any]) => ({
      voice_id: PIPER_PREFIX + id,
      name: `Local · ${String(cfg?.dataset || id).replace(/^./, (c) => c.toUpperCase())} (${cfg?.language?.code || ""})`,
      language_code: cfg?.language?.code,
      tags: ["local", cfg?.audio?.quality].filter(Boolean),
    }));
  } catch {
    return [];
  }
}

async function synthesizePiper(text: string, voiceId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const resp = await fetch(`${LOCAL_TTS}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: voiceId.slice(PIPER_PREFIX.length) }),
    signal,
  });
  if (!resp.ok) throw new Error(`Local voice ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
  return resp.arrayBuffer();
}

// `_apiKey` accepted for backwards compatibility with existing callers; ignored.
// Local Piper voices come first; Inworld's list follows when it is reachable.
export async function fetchInworldVoices(_apiKey?: string): Promise<InworldVoice[]> {
  const local = await fetchPiperVoices();
  try {
    return [...local, ...(await fetchCloudVoices())];
  } catch (e) {
    if (local.length) return local;
    throw e;
  }
}

async function fetchCloudVoices(): Promise<InworldVoice[]> {
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
  if (isPiperVoice(voiceId)) return synthesizePiper(text, voiceId, opts?.signal);
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
  opts?: { signal?: AbortSignal; sampleRate?: number },
): Promise<TimedSpeech> {
  // Piper has no word timestamps; null makes the player estimate them.
  if (isPiperVoice(voiceId)) return { audio: await synthesizePiper(text, voiceId, opts?.signal), words: null };
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
