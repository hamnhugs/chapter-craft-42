const BASE_URL = "https://api.inworld.ai";

// The Inworld platform provides API keys pre-encoded as base64(key:secret).
// If the key looks like a raw non-encoded string, encode it as basic auth.
function authHeader(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (/^[A-Za-z0-9+/]+=+$/.test(trimmed)) {
    // Already base64-padded — use directly (platform-generated key format)
    return `Basic ${trimmed}`;
  }
  return `Basic ${btoa(`${trimmed}:`)}`;
}

export interface InworldVoice {
  voice_id: string;
  name: string;
  tags?: string[];
  language_code?: string;
  gender?: string;
}

export async function fetchInworldVoices(apiKey: string): Promise<InworldVoice[]> {
  const resp = await fetch(`${BASE_URL}/v1/tts/voices`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status}: ${body}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : (data.voices ?? []);
}

export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  voiceId: string,
  model = "inworld-tts-2"
): Promise<ArrayBuffer> {
  const clean = text.replace(/[#*_`~[\]()>|]/g, "").replace(/\n+/g, ". ").trim();
  const resp = await fetch(`${BASE_URL}/v1/tts/synthesize`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: clean,
      voice_id: voiceId,
      model,
      output_format: "mp3",
      delivery_mode: "BALANCED",
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => resp.statusText);
    throw new Error(`${resp.status}: ${body}`);
  }
  return resp.arrayBuffer();
}
