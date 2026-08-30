// OpenRouter adapter — the app's original chat transport, extracted verbatim
// from ChatContext so both providers speak through one seam. Behavior
// (endpoint, headers, body fields, error copy) is intentionally identical to
// the pre-adapter code; the only addition is surfacing `delta.reasoning`,
// which the old parser silently dropped.

import {
  ChatCompleteRequest,
  ChatProviderAdapter,
  ChatStreamEvent,
  ChatStreamRequest,
  ProviderError,
} from "./types";
import { mapFinishReason, sseJson, ToolCallIndexer } from "./sse";

const OR_CHAT = "https://openrouter.ai/api/v1/chat/completions";
/** Generous enough that no real reply is truncated (the app's own sentence
 *  cap bounds replies long before this), small enough that OpenRouter's
 *  pre-flight reservation doesn't refuse a funded key. */
const OR_MAX_TOKENS = 8000;

function orHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": window.location.origin,
    "X-Title": "Chapter Craft",
  };
}

/** OpenRouter's own explanation, which is far more specific than any summary
 *  we could write — a 402 can mean "balance empty" OR "this request reserves
 *  more than your balance covers", and only the body says which. */
function upstreamText(raw: string): string {
  try {
    const b = JSON.parse(raw);
    return String(b?.error?.message ?? b?.message ?? raw).trim().slice(0, 400);
  } catch {
    return raw.trim().slice(0, 400);
  }
}

/** Anthropic models bill cached prefix reads at 0.1x, but ONLY below an
 *  explicit cache_control breakpoint, which OpenRouter passes through inside
 *  content-part arrays. The pipeline says how many LEADING messages are
 *  byte-stable across turns (today: the book block); the LAST of them gets
 *  the marker, which caches everything up to it — tools included, since
 *  Anthropic's cache hierarchy is tools→system→messages.
 *
 *  Anthropic-only on purpose: other OpenRouter providers either cache
 *  implicitly off byte-stability alone (OpenAI, DeepSeek, Gemini) or ignore
 *  the field, and none of them need the string→array content rewrite — so
 *  nobody else's wire shape changes at all. Non-string content (an image
 *  turn's part array) is left untouched: it is never the stable book block. */
export function withCacheBreakpoint(req: ChatStreamRequest): unknown[] {
  const n = req.cacheStablePrefixCount || 0;
  if (n <= 0 || !req.model.startsWith("anthropic/")) return req.messages;
  const i = n - 1;
  const m = req.messages[i] as any;
  if (!m || typeof m.content !== "string" || !m.content) return req.messages;
  const out = req.messages.slice();
  out[i] = { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
  return out;
}

async function throwOrError(res: Response): Promise<never> {
  const raw = await res.text().catch(() => "");
  const detail = upstreamText(raw);
  if (res.status === 401) {
    throw new ProviderError("openrouter", "auth", 401,
      `OpenRouter rejected your API key${detail ? ` — ${detail}` : "."}`);
  }
  if (res.status === 402) {
    // Two very different situations, one status code. The reservation case
    // hits users who HAVE credit; the advice for it is not "add money".
    if (/max_tokens|can only afford|requires more credits/i.test(detail)) {
      throw new ProviderError("openrouter", "credits", 402,
        `OpenRouter reserved more credit than your balance covers for this reply. ${detail}`);
    }
    throw new ProviderError("openrouter", "credits", 402,
      `OpenRouter has no credit available on your key${detail ? ` — ${detail}` : "."} ` +
      "Note that OpenRouter also requires a lifetime top-up before its free models work. NVIDIA models need no balance.");
  }
  if (res.status === 429) {
    throw new ProviderError("openrouter", "rate_limit", 429,
      `OpenRouter rate limit reached${detail ? ` — ${detail}` : "."} Wait a moment, or switch to an NVIDIA model.`);
  }
  throw new ProviderError("openrouter", "upstream", res.status, `OpenRouter error (${res.status}): ${detail}`);
}

export const openrouterAdapter: ChatProviderAdapter = {
  id: "openrouter",

  async *streamChat(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (!req.apiKey) throw new ProviderError("openrouter", "no_key", null, "Set your OpenRouter API key first");
    const res = await fetch(OR_CHAT, {
      method: "POST",
      headers: orHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        messages: withCacheBreakpoint(req),
        ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
        stream: true,
        // OpenRouter reserves the MAXIMUM possible reply against the balance
        // before running. Omitting this made it reserve its ~65k default, so
        // a user with real (but modest) credit got 402 on every single turn
        // for replies that cost a fraction of a cent.
        max_tokens: OR_MAX_TOKENS,
        ...(req.extraBody || {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) await throwOrError(res);

    const indexer = new ToolCallIndexer();
    for await (const parsed of sseJson(res)) {
      // An error can arrive INSIDE a 200 stream (it fires after headers are
      // sent, e.g. a mid-stream rate limit) — without this the reply just
      // stops and the user sees an empty bubble.
      if (parsed?.error) {
        const m = upstreamText(JSON.stringify(parsed));
        throw new ProviderError("openrouter", /rate/i.test(m) ? "rate_limit" : "upstream", 200, m);
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning === "string" && delta.reasoning) {
        yield { type: "reasoning", delta: delta.reasoning };
      }
      if (delta?.content) {
        yield { type: "text", delta: delta.content };
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
        yield { type: "finish", reason: mapFinishReason(choice.finish_reason), native: String(choice.finish_reason) };
      }
    }
  },

  async completeChat(req: ChatCompleteRequest): Promise<string> {
    if (!req.apiKey) throw new ProviderError("openrouter", "no_key", null, "Set your OpenRouter API key first");
    const res = await fetch(OR_CHAT, {
      method: "POST",
      headers: orHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        stream: false,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        messages: req.messages,
      }),
      signal: req.signal,
    });
    if (!res.ok) await throwOrError(res);
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  },
};
