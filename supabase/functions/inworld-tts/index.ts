// Proxy for Inworld AI TTS so the user's API key stays server-side.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const INWORLD_BASE = "https://api.inworld.ai";

function basicAuth(rawKey: string): string {
  let key = rawKey.trim();
  // Tolerate users pasting "Basic xxxx" or "Authorization: Basic xxxx".
  key = key.replace(/^authorization:\s*/i, "");
  if (/^basic\s+/i.test(key)) key = key.replace(/^basic\s+/i, "").trim();
  // If the key contains a colon it's a raw "id:secret" pair → encode it.
  if (key.includes(":")) return `Basic ${btoa(key)}`;
  // Otherwise treat it as the pre-encoded Base64 credential the Inworld
  // portal gives you (padded or unpadded — don't re-encode it).
  return `Basic ${key}`;
}

const MODELS = ["inworld-tts-2", "inworld-tts-2-flash"];
const DELIVERIES = ["STABLE", "BALANCED", "CREATIVE"];

/** Markdown and line breaks out; brackets too, so nothing in the text itself
 *  can be taken for a steering tag. */
function cleanText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[#*_`~[\]()>|]/g, "")
    .replace(/\n+/g, ". ")
    .trim();
}

const tokenKey = (s: unknown) =>
  String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * If the word timing opens with the steering direction's own words, drop
 * them: read-along maps timed words onto the page, and a dozen words that
 * are not on the page would throw its alignment off.
 */
function dropDirectionWords(info: any, direction: string) {
  const wa = info?.wordAlignment;
  const want = tokenKey(direction);
  if (!want || !Array.isArray(wa?.words)) return info;
  let acc = "";
  let n = 0;
  while (n < wa.words.length && acc.length < want.length) {
    acc += tokenKey(wa.words[n]);
    n++;
    if (!want.startsWith(acc)) return info;
  }
  if (acc !== want) return info;
  return {
    ...info,
    wordAlignment: {
      ...wa,
      words: wa.words.slice(n),
      wordStartTimeSeconds: (wa.wordStartTimeSeconds ?? []).slice(n),
      wordEndTimeSeconds: (wa.wordEndTimeSeconds ?? []).slice(n),
    },
  };
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonError("Unauthorized", 401);
    }
    const jwt = authHeader.replace("Bearer ", "");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return jsonError("Unauthorized", 401);
    const userId = userData.user.id;

    const { data: settings } = await admin
      .from("user_settings")
      .select("inworld_api_key")
      .eq("user_id", userId)
      .maybeSingle();

    const inworldKey = (settings?.inworld_api_key || "").trim();
    if (!inworldKey) {
      return jsonError("No Inworld API key saved in settings", 400);
    }

    const url = new URL(req.url);
    const isVoices = url.pathname.endsWith("/voices");

    if (req.method === "GET" && isVoices) {
      const resp = await fetch(`${INWORLD_BASE}/tts/v1/voices`, {
        headers: { Authorization: basicAuth(inworldKey) },
      });
      const body = await resp.text();
      if (!resp.ok) return jsonError(`Inworld voices error: ${body}`, resp.status);
      return new Response(body, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const payload = await req.json().catch(() => null) as
        | {
          text?: string; voice_id?: string; voiceId?: string; model?: string;
          sample_rate?: number; timestamp_type?: string;
          delivery?: string; direction?: string;
          reasoning?: boolean; reasoning_context?: string; previous?: unknown;
        }
        | null;
      let voiceId = String(payload?.voice_id ?? payload?.voiceId ?? "").trim();
      if (!payload?.text) {
        return jsonError("text is required");
      }
      if (!voiceId || voiceId === "undefined") {
        console.warn("inworld-tts: empty voiceId, falling back to 'Ashley'");
        voiceId = "Ashley";
      }
      const clean = cleanText(payload.text);

      const sampleRate = Number(payload.sample_rate) > 0 ? Number(payload.sample_rate) : 24000;
      // Read-along (the Read tab's word highlighting) asks for WORD timing.
      // Callers that don't ask keep getting raw audio/mpeg bytes.
      const timestampType = payload.timestamp_type === "WORD" || payload.timestamp_type === "CHARACTER"
        ? payload.timestamp_type
        : null;

      // The 1.x models are discontinued or deprecated; anything unknown gets
      // the flagship.
      const modelId = MODELS.includes(String(payload.model)) ? String(payload.model) : "inworld-tts-2";
      // Steering, delivery modes and Reasoning are TTS-2 only — Flash ignores
      // or rejects them.
      const flagship = modelId === "inworld-tts-2";
      const delivery = DELIVERIES.includes(String(payload.delivery)) ? String(payload.delivery) : "BALANCED";
      // A written direction rides in front of the text as one bracket tag and
      // holds for the whole request.
      const direction = flagship ? cleanText(payload.direction).slice(0, 300) : "";
      // What was said just before this chunk (not billed): the voice carries
      // its pace and tone across sentence boundaries instead of starting cold.
      // Inworld caps this at 5 entries / 2,000 characters; we stay well inside.
      const previous = (Array.isArray(payload.previous) ? payload.previous : [])
        .map(cleanText)
        .filter(Boolean)
        .slice(-3)
        .map((t) => ({ text: t.slice(0, 400) }));
      // Reasoning: the model reads the line and writes its own direction
      // first. A written direction wins, so the two are never sent together.
      const reasoning = flagship && payload.reasoning === true && !direction;
      const synthesisContext = {
        ...(previous.length ? { previousRequests: previous } : {}),
        ...(reasoning
          ? {
            reasoning: "REASONING_ON",
            ...(payload.reasoning_context
              ? { reasoningContext: cleanText(payload.reasoning_context).slice(0, 600) }
              : {}),
          }
          : {}),
      };
      const hasContext = Object.keys(synthesisContext).length > 0;

      const synth = (withContext: boolean) =>
        fetch(`${INWORLD_BASE}/tts/v1/voice`, {
          method: "POST",
          headers: {
            Authorization: basicAuth(inworldKey),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: direction ? `[${direction}] ${clean}` : clean,
            voiceId,
            modelId,
            audioConfig: {
              audioEncoding: "MP3",
              sampleRateHertz: sampleRate,
            },
            ...(flagship ? { deliveryMode: delivery } : {}),
            applyTextNormalization: "ON",
            ...(timestampType ? { timestampType } : {}),
            ...(withContext && hasContext ? { synthesisContext } : {}),
          }),
        });

      let resp = await synth(true);
      // The context is a nicety. If Inworld refuses the request with it, speak
      // the line plainly rather than fail the whole read.
      if (!resp.ok && hasContext && resp.status >= 400 && resp.status < 500 && resp.status !== 401 && resp.status !== 429) {
        const why = await resp.text().catch(() => resp.statusText);
        console.warn(`inworld-tts: retrying without synthesisContext (${resp.status}): ${why}`);
        resp = await synth(false);
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => resp.statusText);
        return jsonError(`Inworld synth error (voiceId=${voiceId}): ${body}`, resp.status);
      }

      const result = await resp.json();
      const base64 = result?.audioContent || result?.audio_content;
      if (!base64) return jsonError("Inworld returned no audio", 502);
      if (timestampType) {
        // JSON so the timing rides with the audio in one round trip; the
        // client decodes the base64 itself.
        return new Response(
          JSON.stringify({
            audioContent: base64,
            timestampInfo: dropDirectionWords(result?.timestampInfo ?? null, direction),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      return new Response(bin, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "audio/mpeg" },
      });
    }

    return jsonError("Not found", 404);
  } catch (e) {
    console.error("inworld-tts error:", e);
    return jsonError((e as Error).message || "Internal error", 500);
  }
});
