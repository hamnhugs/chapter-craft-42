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

function orHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": window.location.origin,
    "X-Title": "Chapter Craft",
  };
}

async function throwOrError(res: Response): Promise<never> {
  const errText = await res.text().catch(() => "");
  if (res.status === 401) throw new ProviderError("openrouter", "auth", 401, "Invalid API key.");
  if (res.status === 402) throw new ProviderError("openrouter", "credits", 402, "Insufficient credits.");
  if (res.status === 429) throw new ProviderError("openrouter", "rate_limit", 429, "Rate limited. Try again.");
  throw new ProviderError("openrouter", "upstream", res.status, `OpenRouter error (${res.status}): ${errText}`);
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
        messages: req.messages,
        ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
        stream: true,
        ...(req.extraBody || {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) await throwOrError(res);

    const indexer = new ToolCallIndexer();
    for await (const parsed of sseJson(res)) {
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
