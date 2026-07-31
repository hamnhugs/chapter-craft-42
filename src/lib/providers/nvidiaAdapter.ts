// NVIDIA adapter — speaks to integrate.api.nvidia.com through the
// nvidia-chat Supabase edge function (NVIDIA's CORS allowlist bars browsers,
// so there is no direct path). The browser sends only the user's Supabase
// JWT; the relay reads their NVIDIA key server-side under RLS.
//
// NVIDIA quirks handled here, invisible above this file:
//   - reasoning arrives as `delta.reasoning_content` (DeepSeek convention),
//     or inlined into content as <think>/<|channel>thought tags — both are
//     normalized into `reasoning` events (DiffusionGemma emits an empty tag
//     pair even with thinking off, so tags are stripped unconditionally);
//   - streamed tool calls may arrive whole, without `index` (ToolCallIndexer);
//   - a 200 SSE stream can carry an error object in its first payload;
//   - models that refuse stream:true fall back transparently: a JSON
//     response body is rendered as one burst of events (this is how
//     DiffusionGemma stays usable if its hosted endpoint turns out to be
//     non-streaming — nobody has published a streamed example);
//   - error statuses are NVIDIA's own dialect (403 bad key, 402 credits
//     exhausted, 404 per-account entitlement gaps) normalized by the relay
//     to { error: { message, code } } with the status passed through.

import { supabase } from "@/integrations/supabase/client";
import {
  ChatCompleteRequest,
  ChatProviderAdapter,
  ChatStreamEvent,
  ChatStreamRequest,
  ProviderError,
  ProviderErrorCode,
} from "./types";
import { mapFinishReason, sseJson, ThoughtRouter, ToolCallIndexer } from "./sse";

// Mirrors src/integrations/supabase/client.ts (auto-generated, so the
// constants aren't exported from there).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "https://ktzaysdkdkocqhewwtnn.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0emF5c2RrZGtvY3FoZXd3dG5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3MDc5NTMsImV4cCI6MjA4NzI4Mzk1M30.Kql1cXJFJ1Me2XKQj0Jkf1G-iKHiUbc0GB_24NOfsP0";

export const NVIDIA_RELAY_URL = `${SUPABASE_URL}/functions/v1/nvidia-chat`;

const FRIENDLY: Partial<Record<ProviderErrorCode, string>> = {
  no_key: "Add your NVIDIA API key in Settings → AI Models & Keys (free at build.nvidia.com — no balance required).",
  auth: "NVIDIA rejected your API key — check it in Settings (keys start with nvapi-).",
  not_provisioned:
    "NVIDIA hasn't enabled this model for your account yet — a known provisioning issue on their side. " +
    "Try another NVIDIA model (google/gemma-4-31b-it is a good fallback), or email help@build.nvidia.com with the error.",
  // NVIDIA retired its credit system in 2025; free usage is governed by rate
  // limits that vary by model and current traffic, with no self-serve
  // increase. This is now the PRIMARY exhaustion signal, not a secondary one.
  rate_limit:
    "NVIDIA's free-tier rate limit kicked in — it varies by model and how busy they are. " +
    "Wait a minute and retry, or pick a different NVIDIA model.",
  credits:
    "NVIDIA refused this request for quota reasons. Their free tier is rate-limited rather than credit-based, " +
    "so waiting usually clears it; if it persists, try another NVIDIA model.",
};

export async function relayFetch(body: unknown, signal?: AbortSignal, accept?: string): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ProviderError("nvidia", "auth", null, "Sign in to use NVIDIA models.");
  return fetch(NVIDIA_RELAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
      ...(accept ? { Accept: accept } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function throwRelayError(res: Response): Promise<never> {
  const raw = await res.text().catch(() => "");
  let message = raw.slice(0, 500);
  let code: ProviderErrorCode = "upstream";
  try {
    const b = JSON.parse(raw);
    message = String(b?.error?.message ?? message);
    const c = String(b?.error?.code ?? "");
    if (["auth", "no_key", "credits", "rate_limit", "not_provisioned", "bad_request", "server", "network", "upstream"].includes(c)) {
      code = c as ProviderErrorCode;
    }
  } catch { /* non-JSON (e.g. platform 404 before deploy) */ }
  if (res.status === 404 && code === "upstream") {
    // The relay function itself isn't deployed yet.
    message = "The NVIDIA relay isn't deployed yet — ask Lovable to deploy the nvidia-chat function (see Settings → AI Models & Keys).";
    code = "server";
  }
  throw new ProviderError("nvidia", code, res.status, FRIENDLY[code] ?? message);
}

/** Emit events for one non-streaming completion payload. */
function* completionEvents(data: any): Generator<ChatStreamEvent> {
  const msg = data?.choices?.[0]?.message;
  if (typeof msg?.reasoning_content === "string" && msg.reasoning_content) {
    yield { type: "reasoning", delta: msg.reasoning_content };
  }
  if (typeof msg?.content === "string" && msg.content) {
    const router = new ThoughtRouter();
    const routed = router.push(msg.content);
    const rest = router.flush();
    const reasoning = routed.reasoning + rest.reasoning;
    const text = routed.text + rest.text;
    if (reasoning) yield { type: "reasoning", delta: reasoning };
    if (text) yield { type: "text", delta: text };
  }
  if (Array.isArray(msg?.tool_calls)) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      yield {
        type: "tool_call_delta",
        index: i,
        id: tc?.id || undefined,
        name: tc?.function?.name || undefined,
        argsDelta: tc?.function?.arguments || undefined,
      };
    }
  }
  const native = data?.choices?.[0]?.finish_reason;
  yield { type: "finish", reason: mapFinishReason(native), native: native ? String(native) : undefined };
}

/** Prove a saved NVIDIA key actually works. NVIDIA publishes no auth-check
 *  or balance endpoint, so the relay does a 1-token completion — the only
 *  oracle that exists. Resolves with a human-readable result. */
export async function validateNvidiaKey(model?: string): Promise<string | null> {
  try {
    const res = await relayFetch({ action: "validate", ...(model ? { model } : {}) });
    if (res.ok) return null;
    try {
      await throwRelayError(res);
    } catch (e) {
      return (e as Error).message;
    }
    return "NVIDIA request failed.";
  } catch (e) {
    return (e as Error)?.message || "Could not reach the NVIDIA relay.";
  }
}

export const nvidiaAdapter: ChatProviderAdapter = {
  id: "nvidia",

  async *streamChat(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const res = await relayFetch(
      {
        model: req.model,
        messages: req.messages,
        ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
        stream: true,
        ...(req.extraBody || {}),
      },
      req.signal,
      "text/event-stream",
    );
    if (!res.ok) await throwRelayError(res);

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      // Model (or backend) refused streaming — render the JSON completion
      // as one burst. DiffusionGemma's block generation makes this feel
      // similar to its streamed output anyway.
      const data = await res.json().catch(() => null);
      if (!data) throw new ProviderError("nvidia", "upstream", 200, "NVIDIA returned an unreadable response.");
      if (data.error) {
        throw new ProviderError("nvidia", "upstream", 200, String(data.error?.message ?? data.error));
      }
      yield* completionEvents(data);
      return;
    }

    const indexer = new ToolCallIndexer();
    const router = new ThoughtRouter();
    for await (const parsed of sseJson(res)) {
        if (parsed?.error) {
          // Error smuggled inside a 200 stream — a measured NIM behavior.
          const m = String(parsed.error?.message ?? parsed.error);
          throw new ProviderError("nvidia", /rate/i.test(m) ? "rate_limit" : "upstream", 200, m);
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
          yield { type: "reasoning", delta: delta.reasoning_content };
        }
        if (typeof delta?.content === "string" && delta.content) {
          const routed = router.push(delta.content);
          if (routed.reasoning) yield { type: "reasoning", delta: routed.reasoning };
          if (routed.text) yield { type: "text", delta: routed.text };
        }
        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            yield {
              type: "tool_call_delta",
              index: indexer.resolve(tc),
              id: tc.id || undefined,
              name: tc.function?.name || undefined,
              argsDelta: tc.function?.arguments || undefined,
            };
          }
        }
        if (choice?.finish_reason) {
          const rest = router.flush();
          if (rest.reasoning) yield { type: "reasoning", delta: rest.reasoning };
          if (rest.text) yield { type: "text", delta: rest.text };
          yield { type: "finish", reason: mapFinishReason(choice.finish_reason), native: String(choice.finish_reason) };
        }
    }
    // Stream ended (naturally or without a finish_reason) — don't swallow
    // held-back text. flush() resets, so a second flush after the
    // finish-path flush is a harmless no-op. NOTE: this must NOT live in a
    // `finally` — yielding there would suspend the generator during a
    // consumer's early return() and leak the underlying reader.
    const rest = router.flush();
    if (rest.reasoning) yield { type: "reasoning", delta: rest.reasoning };
    if (rest.text) yield { type: "text", delta: rest.text };
  },

  async completeChat(req: ChatCompleteRequest): Promise<string> {
    const res = await relayFetch(
      {
        model: req.model,
        stream: false,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        messages: req.messages,
        ...(req.extraBody || {}),
      },
      req.signal,
    );
    if (!res.ok) await throwRelayError(res);
    const data = await res.json();
    // NIM can return an error object inside a 200 — same check the streaming
    // paths make. Without it this returns "" and the caller retries forever.
    if (data?.error) {
      const m = String(data.error?.message ?? data.error);
      throw new ProviderError("nvidia", /rate/i.test(m) ? "rate_limit" : "upstream", 200, m);
    }
    const msg = data?.choices?.[0]?.message;
    const router = new ThoughtRouter();
    const routed = router.push(String(msg?.content || ""));
    const rest = router.flush();
    return (routed.text + rest.text).trim();
  },
};
