// coin-chat: the built-in AI ("Bookworm AI"), paid for with coins.
//
// A user with no API key of their own chats through this function. It relays
// an OpenAI-shaped chat completion to the Lovable AI gateway with the APP's
// key and debits the caller's coin wallet for the tokens used.
//
// Not an open relay, by construction:
//   1. The upstream host is hardcoded and the model must be in RATES — no
//      caller-supplied URL, no caller-chosen price.
//   2. A valid user JWT is required, and the wallet debited is always the
//      caller's own (the user id comes from the verified JWT, never the body).
//   3. A request is refused up front (402) when the wallet is empty.
//
// Metering: the charge is computed from the token usage the gateway reports
// (requested via stream_options.include_usage). When a stream ends without a
// usage frame — a client disconnect, an upstream fault — the charge falls
// back to an estimate from the characters that actually went each way, so an
// aborted reply is still paid for. Debits clamp at the balance: the work has
// already happened by the time the bill is known.
//
// Error envelope: { error: { message, code } }, the shape every provider
// adapter in the client already reads.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UPSTREAM = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Coins per 1,000 tokens. Keep in step with COIN_MODELS in src/lib/coins.ts
 *  (that copy is display-only; this one is the price). */
const RATES: Record<string, { in: number; out: number }> = {
  "google/gemini-2.5-flash": { in: 0.2, out: 1.5 },
  "google/gemini-3-flash-preview": { in: 0.3, out: 2 },
};
const MIN_CHARGE = 1;
/** Hard ceiling on one reply, so a runaway generation cannot drain a wallet. */
const MAX_OUTPUT_TOKENS = 8192;

const err = (message: string, code: string, status: number) =>
  new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function priceOf(model: string, tokensIn: number, tokensOut: number): number {
  const r = RATES[model];
  if (!r) return MIN_CHARGE;
  return Math.max(MIN_CHARGE, Math.ceil((tokensIn / 1000) * r.in + (tokensOut / 1000) * r.out));
}

/** ~4 characters a token: the fallback when no usage frame arrives. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function promptChars(messages: unknown[]): number {
  let n = 0;
  for (const m of messages as { content?: unknown }[]) {
    const c = m?.content;
    if (typeof c === "string") n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) n += typeof part?.text === "string" ? part.text.length : 1000; // an image part
    }
  }
  return n;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err("POST only", "bad_request", 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return err("Missing authorization", "auth", 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return err("Unauthorized", "auth", 401);

    const body = await req.json().catch(() => null);
    const model = typeof body?.model === "string" ? body.model : "";
    if (!RATES[model] || !Array.isArray(body?.messages)) {
      return err("Unknown Bookworm AI model, or no messages.", "bad_request", 400);
    }

    const GATEWAY_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!GATEWAY_KEY) return err("Bookworm AI isn't configured on the server yet.", "server", 500);

    const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Opens the wallet (and grants the welcome coins) if this is the first
    // thing the account has ever done with coins.
    const { data: wallet, error: walletErr } = await userClient.rpc("my_wallet");
    if (walletErr) {
      return err("Coins aren't set up on the server yet (the coins migration hasn't been applied).", "server", 500);
    }
    const balance = Number(wallet?.balance ?? 0);
    if (balance < MIN_CHARGE) {
      return err("You're out of coins — top up in the Store, or add your own API key in Settings.", "credits", 402);
    }

    const stream = body.stream !== false;
    const requestedMax = Number(body.max_tokens);
    const upstreamBody = {
      model,
      messages: body.messages,
      stream,
      max_tokens: Number.isFinite(requestedMax) && requestedMax > 0
        ? Math.min(requestedMax, MAX_OUTPUT_TOKENS)
        : MAX_OUTPUT_TOKENS,
      ...(Array.isArray(body.tools) && body.tools.length > 0
        ? { tools: body.tools, tool_choice: body.tool_choice ?? "auto" }
        : {}),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };

    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { Authorization: `Bearer ${GATEWAY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal: req.signal,
    });

    if (!upstream.ok) {
      const raw = await upstream.text().catch(() => "");
      console.error("coin-chat upstream error:", upstream.status, raw.slice(0, 500));
      if (upstream.status === 429) return err("Bookworm AI is busy right now — try again in a moment.", "rate_limit", 429);
      // 402 here is the APP's gateway balance, not the user's coins.
      if (upstream.status === 402) return err("Bookworm AI is temporarily unavailable. Your coins were not charged.", "server", 503);
      if (upstream.status === 400 || upstream.status === 422) return err("Bookworm AI couldn't accept that request.", "bad_request", 400);
      return err(`Bookworm AI request failed (${upstream.status}). Your coins were not charged.`, "upstream", 502);
    }

    const inputEstimate = estimateTokens(promptChars(body.messages));
    const charge = async (tokensIn: number, tokensOut: number, measured: boolean): Promise<{ charged: number; balance: number }> => {
      const cost = priceOf(model, tokensIn, tokensOut);
      const { data, error } = await service.rpc("coin_apply", {
        _user_id: user.id,
        _delta: -cost,
        _kind: "spend_ai",
        _ref: null,
        _note: `${model} · ${tokensIn} in / ${tokensOut} out${measured ? "" : " (estimated)"}`,
        _clamp: true,
      });
      if (error) {
        console.error("coin-chat debit failed:", error.message);
        return { charged: 0, balance };
      }
      const after = Number(data ?? 0);
      return { charged: Math.max(0, balance - after), balance: after };
    };

    if (!stream) {
      const data = await upstream.json();
      const u = data?.usage;
      const measured = Number.isFinite(u?.prompt_tokens) && Number.isFinite(u?.completion_tokens);
      const text = String(data?.choices?.[0]?.message?.content ?? "");
      const coins = await charge(
        measured ? u.prompt_tokens : inputEstimate,
        measured ? u.completion_tokens : estimateTokens(text.length),
        measured,
      );
      return new Response(JSON.stringify({ ...data, coins }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Streaming: pass frames through untouched, watching for the usage frame
    // and counting output characters as the fallback. The terminal [DONE] is
    // held back so the bill can be sent as one last frame ahead of it.
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let usageIn: number | null = null;
    let usageOut: number | null = null;
    let outChars = 0;
    let settled = false;

    const settle = async () => {
      if (settled) return null;
      settled = true;
      const measured = usageIn !== null && usageOut !== null;
      return charge(measured ? usageIn! : inputEstimate, measured ? usageOut! : estimateTokens(outChars), measured);
    };

    const inspect = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const j = JSON.parse(payload);
        if (j?.usage && Number.isFinite(j.usage.prompt_tokens)) {
          usageIn = j.usage.prompt_tokens;
          usageOut = Number(j.usage.completion_tokens) || 0;
        }
        const d = j?.choices?.[0]?.delta;
        if (typeof d?.content === "string") outChars += d.content.length;
        if (typeof d?.reasoning_content === "string") outChars += d.reasoning_content.length;
        if (Array.isArray(d?.tool_calls)) {
          for (const tc of d.tool_calls) outChars += String(tc?.function?.arguments ?? "").length;
        }
      } catch { /* a partial or non-JSON frame — forwarded as-is */ }
    };

    const reader = upstream.body!.getReader();
    const out = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (pending.trim() && pending.trim() !== "data: [DONE]") {
              inspect(pending.trim());
              controller.enqueue(encoder.encode(pending + "\n\n"));
            }
            const coins = await settle();
            if (coins) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ coins })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          let forward = "";
          for (const line of lines) {
            const t = line.trim();
            if (t === "data: [DONE]") continue; // re-emitted after the bill
            inspect(t);
            forward += line + "\n";
          }
          if (forward) controller.enqueue(encoder.encode(forward));
        } catch (e) {
          await settle();
          controller.error(e);
        }
      },
      async cancel() {
        // The reader went away mid-reply. What was generated is still owed.
        try { await reader.cancel(); } catch { /* already closed */ }
        await settle();
      },
    });

    return new Response(out, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    console.error("coin-chat error:", e);
    return err(e instanceof Error ? e.message : "Unknown error", "server", 500);
  }
});
