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
