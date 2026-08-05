// Gemini adapter — Google's Generative Language API, called BROWSER-DIRECT.
//
// Unlike NVIDIA, Gemini's API is CORS-open to arbitrary origins (verified by
// probe: OPTIONS from a foreign Origin returns Access-Control-Allow-Origin
// echoing that origin on both the native and OpenAI-compatible surfaces), so
// no relay is needed. Its origin IS required in the app CSP — see the
// build-time assertion in vite.config.ts.
//
// We use the OPENAI-COMPATIBLE surface (/v1beta/openai/chat/completions):
// the app's whole pipeline — SSE parsing, tool-call accumulation, the
// ToolCallIndexer, message shape — is OpenAI-shaped already, so this reuses
// battle-tested code instead of a second parser. Streamed tool calls arrive
// as partial JSON argument strings that accumulate exactly like OpenAI's
// (an earlier report claimed they arrive pre-parsed; that was refuted).
//
// Google Search grounding is deliberately NOT used. Two verified reasons:
// it does not exist on this OpenAI-compatible surface at all (schema-probed —
// the field is rejected as unknown), and Google's API terms forbid extracting
// grounded results for another purpose or interspersing them with other
// content, which is exactly what "search on Gemini, answer on NVIDIA" would
// be. Free web search is Tavily instead — see src/lib/tavilySearch.ts.

import {
  ChatCompleteRequest,
  ChatProviderAdapter,
  ChatStreamEvent,
  ChatStreamRequest,
  ProviderError,
  ProviderErrorCode,
} from "./types";
import { mapFinishReason, sseJson, ThoughtRouter, ToolCallIndexer } from "./sse";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta";

const FRIENDLY: Partial<Record<ProviderErrorCode, string>> = {
  no_key: "Add your Google Gemini API key in Settings → AI Models & Keys (free at aistudio.google.com/apikey).",
  auth: "Google rejected your Gemini API key — check it in Settings.",
  rate_limit:
    "Gemini's free tier is rate-limited and you've hit it — wait a minute, or switch chat to another provider.",
  credits:
    "Gemini says this model needs billing enabled on your Google Cloud project. Free-tier keys can chat, but image generation and some models require billing.",
};

/** Google's errors are {"error":{"code","message","status"}}. Map status +
 *  the RESOURCE_EXHAUSTED / API_KEY_INVALID strings onto our vocabulary. */
function classify(status: number, body: string): { code: ProviderErrorCode; message: string } {
  let message = body.slice(0, 500);
  let googleStatus = "";
  try {
    const b = JSON.parse(body);
    const e = b?.error ?? b;
    message = String(e?.message ?? message);
    googleStatus = String(e?.status ?? "");
  } catch { /* non-JSON — keep raw text */ }

  if (status === 429 || googleStatus === "RESOURCE_EXHAUSTED") return { code: "rate_limit", message };
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return { code: "auth", message };
  }
  // Google reports "billing required" style failures as 400 with a telling
  // message rather than a distinct status.
  if (/billing|billed users|not available on the free/i.test(message)) return { code: "credits", message };
  if (status >= 400 && status < 500) return { code: "bad_request", message };
  return { code: "upstream", message };
}

async function throwGeminiError(res: Response): Promise<never> {
  const raw = await res.text().catch(() => "");
  const { code, message } = classify(res.status, raw);
  // Keep Google's own text alongside our copy: a daily-quota 429 says "retry
  // in 41283s", and a friendly "wait a minute" alone would be actively wrong.
  const friendly = FRIENDLY[code];
  throw new ProviderError("gemini", code, res.status, friendly ? `${friendly} (${message})` : message);
}

function headers(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // The compat surface takes a Bearer token; the native surface takes
    // x-goog-api-key. Both are in the CSP-allowed header list.
    Authorization: `Bearer ${apiKey}`,
  };
}

/** The app legitimately sends up to three system messages per turn (main
 *  prompt, rolling summary, pinned focus). OpenRouter and the NVIDIA relay
 *  pass them through verbatim, but Google's OpenAI-compat layer documents a
 *  single systemInstruction and its folding of extras is unverifiable — so
 *  this adapter merges all string-content system messages into one, in
 *  order, at the position of the first. Semantically identical payload,
 *  provably safe shape. Non-string system content (never produced today)
 *  passes through untouched. */
function mergeSystemMessages(messages: any[]): any[] {
  const systems = messages.filter((m: any) => m?.role === "system");
  if (systems.length <= 1) return messages;
  if (systems.some((m: any) => typeof m.content !== "string")) return messages;
  const first = messages.findIndex((m: any) => m?.role === "system");
  const out = messages.filter((m: any) => m?.role !== "system");
  out.splice(first, 0, { role: "system", content: systems.map((m: any) => m.content).join("\n\n") });
  return out;
}

export const geminiAdapter: ChatProviderAdapter = {
  id: "gemini",

  async *streamChat(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (!req.apiKey) throw new ProviderError("gemini", "no_key", null, FRIENDLY.no_key!);
    const res = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: headers(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        messages: mergeSystemMessages(req.messages),
        ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
        stream: true,
        ...(req.extraBody || {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) await throwGeminiError(res);

    const indexer = new ToolCallIndexer();
    // Gemini can inline reasoning as <think> tags on some thinking models;
    // the shared router strips them into reasoning events.
    const router = new ThoughtRouter();
    for await (const parsed of sseJson(res)) {
      if (parsed?.error) {
        const { code, message } = classify(200, JSON.stringify(parsed));
        throw new ProviderError("gemini", code, 200, message);
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      // Gemini's compat layer exposes thinking as reasoning_content when
      // a thinking budget is set.
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
            // Streamed args are partial JSON STRINGS here, same as OpenAI —
            // they accumulate and are parsed once at the end.
            argsDelta: typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : tc.function?.arguments != null
                ? JSON.stringify(tc.function.arguments)
                : undefined,
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
    const rest = router.flush();
    if (rest.reasoning) yield { type: "reasoning", delta: rest.reasoning };
    if (rest.text) yield { type: "text", delta: rest.text };
  },

  async completeChat(req: ChatCompleteRequest): Promise<string> {
    if (!req.apiKey) throw new ProviderError("gemini", "no_key", null, FRIENDLY.no_key!);
    const res = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: headers(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        stream: false,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        messages: mergeSystemMessages(req.messages),
        ...(req.extraBody || {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) await throwGeminiError(res);
    const data = await res.json();
    if (data?.error) {
      const { code, message } = classify(200, JSON.stringify(data));
      throw new ProviderError("gemini", code, 200, message);
    }
    const content = String(data?.choices?.[0]?.message?.content || "");
    const router = new ThoughtRouter();
    const routed = router.push(content);
    const rest = router.flush();
    return (routed.text + rest.text).trim();
  },
};

/** Validate a key cheaply, without spending a generation: the models list
 *  requires auth and is CORS-open. Used by the Test key button. */
export async function testGeminiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${GEMINI_NATIVE_BASE}/models?pageSize=1`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (res.ok) return { ok: true };
    const raw = await res.text().catch(() => "");
    return { ok: false, error: classify(res.status, raw).message };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "Could not reach Google" };
  }
}
