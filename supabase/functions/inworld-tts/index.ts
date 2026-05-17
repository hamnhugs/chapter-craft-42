// Proxy for Inworld AI TTS so the user's API key stays server-side.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const INWORLD_BASE = "https://api.inworld.ai";

function basicAuth(key: string): string {
  const trimmed = key.trim();
  if (/^[A-Za-z0-9+/]+=+$/.test(trimmed)) return `Basic ${trimmed}`;
  return `Basic ${btoa(`${trimmed}:`)}`;
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
        | { text?: string; voice_id?: string; model?: string }
        | null;
      if (!payload?.text || !payload?.voice_id) {
        return jsonError("text and voice_id are required");
      }
      const clean = String(payload.text)
        .replace(/[#*_`~[\]()>|]/g, "")
        .replace(/\n+/g, ". ")
        .trim();

      const resp = await fetch(`${INWORLD_BASE}/tts/v1/voice`, {
        method: "POST",
        headers: {
          Authorization: basicAuth(inworldKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: clean,
          voiceId: payload.voice_id,
          modelId: payload.model || "inworld-tts-2",
          audio_config: {
            audio_encoding: "MP3",
            sample_rate_hertz: 48000,
          },
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => resp.statusText);
        return jsonError(`Inworld synth error: ${body}`, resp.status);
      }

      const result = await resp.json();
      const base64 = result?.audioContent || result?.audio_content;
      if (!base64) return jsonError("Inworld returned no audio", 502);
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
