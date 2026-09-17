// Proxy for Inworld AI TTS so the user's API key stays server-side.
// Read Along clips are also cached per book on the VPS (see _shared/ttsCache).
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  clipKey,
  deleteBookClips,
  getCachedClip,
  inBackground,
  isValidBookId,
  putCachedClip,
  ttsCacheConfig,
} from "../_shared/ttsCache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-TTS-Cache",
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

    const loadInworldKey = async () => {
      const { data: settings } = await admin
        .from("user_settings")
        .select("inworld_api_key")
        .eq("user_id", userId)
        .maybeSingle();
      return (settings?.inworld_api_key || "").trim();
    };
    /** Owner of a book, or null when the book no longer exists. */
    const bookOwner = async (bookId: string): Promise<string | null> => {
      const { data } = await admin.from("books").select("user_id").eq("id", bookId).maybeSingle();
      return (data?.user_id as string | undefined) ?? null;
    };

    const url = new URL(req.url);
    const isVoices = url.pathname.endsWith("/voices");

    if (req.method === "GET" && isVoices) {
      const inworldKey = await loadInworldKey();
      if (!inworldKey) return jsonError("No Inworld API key saved in settings", 400);
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
          text?: string; voice_id?: string; voiceId?: string; model?: string; sample_rate?: number; timestamp_type?: string;
          /** Read Along: cache this clip under the book (must be the caller's). */
          cache_book_id?: string;
          action?: string; book_id?: string;
        }
        | null;
      const cache = ttsCacheConfig();

      // A book is being permanently deleted: drop its saved audio too.
      if (payload?.action === "purge_cache") {
        if (!isValidBookId(payload.book_id)) return jsonError("book_id is required");
        if (!cache) return new Response(JSON.stringify({ purged: false, reason: "cache not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const owner = await bookOwner(payload.book_id);
        // A book that still exists must be yours; a deleted one leaves only orphaned audio.
        if (owner && owner !== userId) return jsonError("Forbidden", 403);
        const result = await deleteBookClips(cache, payload.book_id);
        return new Response(JSON.stringify({ purged: !!result, ...(result ?? {}) }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let voiceId = String(payload?.voice_id ?? payload?.voiceId ?? "").trim();
      if (!payload?.text) {
        return jsonError("text is required");
      }
      if (!voiceId || voiceId === "undefined") {
        console.warn("inworld-tts: empty voiceId, falling back to 'Ashley'");
        voiceId = "Ashley";
      }
      const clean = String(payload.text)
        .replace(/[#*_`~[\]()>|]/g, "")
        .replace(/\n+/g, ". ")
        .trim();

      const sampleRate = Number(payload.sample_rate) > 0 ? Number(payload.sample_rate) : 24000;
      // Read-along (the Read tab's word highlighting) asks for WORD timing.
      // Callers that don't ask keep getting raw audio/mpeg bytes.
      const timestampType = payload.timestamp_type === "WORD" || payload.timestamp_type === "CHARACTER"
        ? payload.timestamp_type
        : null;
      const modelId = payload.model || "inworld-tts-2";

      // Saved audio first: only JSON (timestamped) clips for a book the caller owns.
      let cacheSlot: { bookId: string; key: string } | null = null;
      if (cache && timestampType && isValidBookId(payload.cache_book_id)) {
        const [owner, key] = await Promise.all([
          bookOwner(payload.cache_book_id),
          clipKey({ model: modelId, voiceId, sampleRate, timestampType, text: clean }),
        ]);
        if (owner === userId) {
          cacheSlot = { bookId: payload.cache_book_id, key };
          const hit = await getCachedClip(cache, cacheSlot.bookId, key);
          if (hit) {
            return new Response(
              JSON.stringify({ audioContent: hit.audioContent, timestampInfo: hit.timestampInfo ?? null }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json", "X-TTS-Cache": "hit" } },
            );
          }
        }
      }

      const inworldKey = await loadInworldKey();
      if (!inworldKey) return jsonError("No Inworld API key saved in settings", 400);

      const resp = await fetch(`${INWORLD_BASE}/tts/v1/voice`, {
        method: "POST",
        headers: {
          Authorization: basicAuth(inworldKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: clean,
          voiceId,
          modelId,
          audioConfig: {
            audioEncoding: "MP3",
            sampleRateHertz: sampleRate,
          },
          deliveryMode: "BALANCED",
          applyTextNormalization: "ON",
          ...(timestampType ? { timestampType } : {}),
        }),
      });

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
        const timestampInfo = result?.timestampInfo ?? null;
        if (cache && cacheSlot) {
          // Saved after the response goes out; a failed save only costs a future re-synthesis.
          inBackground(putCachedClip(cache, cacheSlot.bookId, cacheSlot.key, {
            audioContent: base64, timestampInfo, voiceId, model: modelId, chars: clean.length,
          }));
        }
        return new Response(
          JSON.stringify({ audioContent: base64, timestampInfo }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json", ...(cacheSlot ? { "X-TTS-Cache": "miss" } : {}) },
          },
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
