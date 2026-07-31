// nvidia-chat: BYOK streaming relay to NVIDIA's hosted inference API.
//
// integrate.api.nvidia.com enforces a CORS origin allowlist (only NVIDIA's
// own frontend gets Access-Control-Allow-Origin), so the browser can never
// call it directly — every NVIDIA request transits this function instead.
//
// Not an open relay, by construction:
//   1. The upstream host is hardcoded — no caller-supplied URL, no SSRF.
//   2. A valid user JWT is required (in-code getUser, same as describe-figures).
//   3. The only key ever used is the CALLER's own row's key (RLS-scoped
//      read), so the worst any abuser can do is spend their own quota.
//
// Error envelope: every non-2xx response body is normalized to
// { error: { message, code } } with the UPSTREAM status passed through, so
// the client can map provider-specific statuses (NVIDIA uses 403 for bad
// keys, 402 for exhausted trial credits, 404 for per-account entitlement
// gaps). "No key saved" uses 428 — a status NVIDIA never sends, so the
// client can't confuse it with a billing error.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UPSTREAM_CHAT = "https://integrate.api.nvidia.com/v1/chat/completions";
const UPSTREAM_MODELS = "https://integrate.api.nvidia.com/v1/models";

const err = (message: string, code: string, status: number) =>
  new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** NVIDIA speaks two error dialects: gateway problem-details
 *  ({status,title,detail}) and OpenAI-style ({error:{message}}). 401s are
 *  even plain text. Read whichever field exists. */
function upstreamMessage(raw: string): string {
  try {
    const b = JSON.parse(raw);
    return String(b?.detail ?? b?.title ?? b?.error?.message ?? raw).slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

function classify(status: number, message: string): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credits";
  if (status === 429) return "rate_limit";
  if (status === 404 && /not found for account/i.test(message)) return "not_provisioned";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  return "upstream";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err("POST only", "bad_request", 405);
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return err("Missing authorization", "auth", 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return err("Unauthorized", "auth", 401);

    const body = await req.json().catch(() => null);

    // Model catalog branch — upstream GET /v1/models needs no auth, but the
    // browser can't read it cross-origin, so it rides through here too.
    if (body?.action === "models") {
      const upstream = await fetch(UPSTREAM_MODELS, { signal: req.signal });
      const text = await upstream.text();
      if (!upstream.ok) {
        return err(upstreamMessage(text), classify(upstream.status, text), upstream.status);
      }
      return new Response(text, {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof body?.model !== "string" || !Array.isArray(body?.messages)) {
      return err("model and messages are required", "bad_request", 400);
    }

    // BYOK: RLS-scoped read — this query can only ever see the caller's row.
    const { data: row, error: keyErr } = await supabase
      .from("user_settings")
      .select("nvidia_api_key")
      .eq("user_id", user.id)
      .maybeSingle();
    if (keyErr) {
      // Most likely: the nvidia_api_key migration hasn't been applied yet.
      return err(`Could not read your NVIDIA key: ${keyErr.message}`, "server", 500);
    }
    const key = (row?.nvidia_api_key || "").trim();
    if (!key) return err("No NVIDIA API key saved — add one in Settings.", "no_key", 428);

    const upstream = await fetch(UPSTREAM_CHAT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: body.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      // Propagate browser aborts upstream so a stopped chat doesn't keep
      // burning the user's NVIDIA credits.
      signal: req.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      const message = upstreamMessage(text);
      return err(message, classify(upstream.status, message), upstream.status);
    }

    // Pass-through with FRESH headers: Deno's fetch has already decompressed
    // the body, so forwarding upstream Content-Encoding/Content-Length would
    // corrupt the response.
    const ct = upstream.headers.get("content-type") || "application/json";
    const sse = ct.includes("text/event-stream");
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": sse ? "text/event-stream" : "application/json",
        ...(sse ? { "Cache-Control": "no-store" } : {}),
      },
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      return err("Request aborted", "network", 499);
    }
    return err((e as Error)?.message || "nvidia-chat failed", "server", 500);
  }
});
