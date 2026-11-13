// Bookworm AI — the built-in models, paid for with coins.
//
// The browser holds no key for this provider. Every request goes to the
// coin-chat edge function, which relays it to the app's AI gateway and debits
// the signed-in user's coin wallet for the tokens used (see that function for
// the metering rules). The wire is the same OpenAI SSE dialect the NVIDIA
// relay speaks, plus one extra frame the relay appends before [DONE]:
//
//   data: {"coins":{"charged":3,"balance":412}}
//
// which is how the wallet in the top bar moves the moment a reply is billed.

import { supabase } from "@/integrations/supabase/client";
import { noteBalance } from "@/lib/coins";
import {
  ChatCompleteRequest,
  ChatProviderAdapter,
  ChatStreamEvent,
  ChatStreamRequest,
  ProviderError,
  ProviderErrorCode,
} from "./types";
import { mapFinishReason, normalizeUsage, sseJson, ThoughtRouter, ToolCallIndexer } from "./sse";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "https://ktzaysdkdkocqhewwtnn.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export const COIN_RELAY_URL = `${SUPABASE_URL}/functions/v1/coin-chat`;

const CODES: ProviderErrorCode[] = ["auth", "no_key", "credits", "rate_limit", "not_provisioned", "bad_request", "server", "network", "upstream"];

async function relayFetch(body: unknown, signal?: AbortSignal, accept?: string): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ProviderError("bookworm", "auth", null, "Sign in to use Bookworm AI.");
  return fetch(COIN_RELAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
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
    const c = String(b?.error?.code ?? "") as ProviderErrorCode;
    if (CODES.includes(c)) code = c;
  } catch { /* non-JSON: the platform's own 404 before the function is deployed */ }
  if (res.status === 404 && code === "upstream") {
    message = "Bookworm AI isn't switched on for this app yet (the coin-chat function hasn't been deployed). Add your own API key in Settings to chat in the meantime.";
    code = "server";
  }
  throw new ProviderError("bookworm", code, res.status, message);
}

const noteCoins = (frame: any) => {
  const b = Number(frame?.coins?.balance);
  if (Number.isFinite(b)) noteBalance(b);
};

export const coinsAdapter: ChatProviderAdapter = {
  id: "bookworm",

  async *streamChat(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const res = await relayFetch(
      {
        model: req.model,
        messages: req.messages,
        ...(req.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
        stream: true,
      },
      req.signal,
      "text/event-stream",
    );
    if (!res.ok) await throwRelayError(res);

    const indexer = new ToolCallIndexer();
    const router = new ThoughtRouter();
    for await (const parsed of sseJson(res)) {
      if (parsed?.coins) { noteCoins(parsed); continue; }
      if (parsed?.error) {
        const m = String(parsed.error?.message ?? parsed.error);
        throw new ProviderError("bookworm", /rate/i.test(m) ? "rate_limit" : "upstream", 200, m);
      }
      if (parsed?.usage) {
        const usage = normalizeUsage(parsed.usage);
        if (usage) yield { type: "usage", usage };
      }
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        yield { type: "reasoning", delta: delta.reasoning_content };
      }
      if (typeof delta?.content === "string" && delta.content) {
        const routed = router.push(delta.content);
        if (routed.reasoning) yield { type: "reasoning", delta: routed.reasoning };
        if (routed.text) yield { type: "text", delta: routed.text };
      }
      if (Array.isArray(delta?.tool_calls)) {
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
    // Not in a `finally`: yielding there would suspend the generator during a
    // consumer's early return() and leak the reader (see nvidiaAdapter).
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
      },
      req.signal,
    );
    if (!res.ok) await throwRelayError(res);
    const data = await res.json();
    if (data?.error) {
      throw new ProviderError("bookworm", "upstream", 200, String(data.error?.message ?? data.error));
    }
    noteCoins(data);
    req.onMeta?.({
      finish: data?.choices?.[0]?.finish_reason ? mapFinishReason(data.choices[0].finish_reason) : undefined,
      usage: normalizeUsage(data?.usage) ?? undefined,
    });
    const router = new ThoughtRouter();
    const routed = router.push(String(data?.choices?.[0]?.message?.content || ""));
    const rest = router.flush();
    return (routed.text + rest.text).trim();
  },
};
