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
  type CacheBreakpoint,
} from "./types";
import { mapFinishReason, normalizeUsage, sseJson, ToolCallIndexer } from "./sse";

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
 *  content-part arrays. The pipeline names the breakpoints (the end of the
 *  stable system messages, the latest user message, the newest tool result);
 *  each marker caches everything up to it — tools included, since Anthropic's
 *  cache hierarchy is tools→system→messages. Anthropic honors at most four.
 *
 *  Legacy callers pass only cacheStablePrefixCount: the last of that many
 *  leading messages gets the one marker, exactly as before.
 *
 *  Anthropic-only on purpose: other OpenRouter providers either cache
 *  implicitly off byte-stability alone (OpenAI, DeepSeek, Gemini) or ignore
 *  the field, and none of them need the string→array content rewrite — so
 *  nobody else's wire shape changes at all. */
export function withCacheBreakpoint(req: ChatStreamRequest): unknown[] {
  if (!req.model.startsWith("anthropic/")) return req.messages;
  const n = req.cacheStablePrefixCount || 0;
  const bps: CacheBreakpoint[] = req.cacheBreakpoints ?? (n > 0 ? [{ index: n - 1 }] : []);
  if (bps.length === 0) return req.messages;
  const out = req.messages.slice();
  const seen = new Set<number>();
  for (const bp of bps) {
    if (seen.size >= 4 || seen.has(bp.index)) continue;
    const marked = markMessage(out[bp.index], bp.tailChars ?? 0);
    if (!marked) continue;
    out[bp.index] = marked;
    seen.add(bp.index);
  }
  return seen.size > 0 ? out : req.messages;
}

const EPHEMERAL = { type: "ephemeral" } as const;

function markMessage(m: any, tailChars: number): any | null {
  if (!m) return null;
  if (typeof m.content === "string") {
    if (!m.content) return null;
    if (tailChars > 0 && tailChars < m.content.length) {
      const cut = m.content.length - tailChars;
      return {
        ...m,
        content: [
          { type: "text", text: m.content.slice(0, cut), cache_control: EPHEMERAL },
          { type: "text", text: m.content.slice(cut) },
        ],
      };
    }
    return { ...m, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] };
  }
  if (Array.isArray(m.content) && m.content.length > 0) {
    // The marker goes on the last TEXT part at or before the stable end;
    // image parts are left exactly as they were.
    let i = m.content.length - 1 - (tailChars > 0 ? 1 : 0);
    while (i >= 0 && m.content[i]?.type !== "text") i--;
    if (i < 0) return null;
    const parts = m.content.slice();
    parts[i] = { ...parts[i], cache_control: EPHEMERAL };
    return { ...m, content: parts };
  }
  return null;
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
        // Sticky routing: later requests of this conversation go to the same
        // upstream provider, whose prompt cache is the warm one.
        ...(req.sessionId ? { session_id: req.sessionId.slice(0, 256) } : {}),
        ...(req.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
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
      // OpenRouter always reports usage (tokens, cached tokens, cost) on the
      // final chunk, whose `choices` is usually empty.
      if (parsed?.usage) {
        const usage = normalizeUsage(parsed.usage);
        if (usage) yield { type: "usage", usage };
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
        // streamChat forwards extraBody; completeChat silently dropped it,
        // which turned every caller-side pin (e.g. reasoning off for gist
        // generation) into a no-op on this provider.
        ...(req.extraBody || {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) await throwOrError(res);
    const data = await res.json();
    req.onMeta?.({
      finish: data?.choices?.[0]?.finish_reason ? mapFinishReason(data.choices[0].finish_reason) : undefined,
      usage: normalizeUsage(data?.usage) ?? undefined,
    });
    return (data?.choices?.[0]?.message?.content || "").trim();
  },
};
