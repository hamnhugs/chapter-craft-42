// Provider adapter seam. The adapter owns the wire protocol (endpoints,
// headers, SSE dialect, error shapes, reasoning-field names); the chat
// pipeline in ChatContext owns the conversation (tool loop, sentence cap,
// persistence) and only ever sees the normalized vocabulary below.

export type ProviderId = "openrouter" | "nvidia" | "gemini";

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other";

export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool_call_delta";
      /** Resolved by the adapter — always safe to key accumulation on, even
       *  for providers that omit `index` on the wire (NVIDIA NIM does). */
      index: number;
      id?: string;
      name?: string;
      argsDelta?: string;
    }
  | { type: "finish"; reason: FinishReason; native?: string }
  /** What the provider billed for this request, when it says. Arrives once,
   *  usually on the final chunk. */
  | { type: "usage"; usage: TokenUsage };

/** Normalized token accounting for ONE provider request. Every field is
 *  optional because providers report different subsets (and some, like the
 *  NVIDIA relay, often nothing at all) — absent means "not reported", never 0. */
export interface TokenUsage {
  /** All input tokens, cached ones included. */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from the provider's prompt cache (billed at a discount). */
  cachedTokens?: number;
  /** Input tokens written to the prompt cache this request (Anthropic bills a premium). */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Provider-reported cost in USD (OpenRouter's `usage.cost`). */
  costUsd?: number;
}

/** One place in the request where a provider-side prompt cache may be told
 *  "everything up to here is reusable". */
export interface CacheBreakpoint {
  /** Index into `messages`. */
  index: number;
  /** When > 0, only the part of the message BEFORE its last `tailChars`
   *  characters is stable (string content), or — for part-array content —
   *  the final part is volatile. Used for the latest user message, whose
   *  app-added per-turn context rides at its end. */
  tailChars?: number;
}

export type ProviderErrorCode =
  | "auth"
  | "no_key"
  | "credits"
  | "rate_limit"
  | "not_provisioned"
  | "bad_request"
  | "upstream"
  | "server"
  | "network";

export class ProviderError extends Error {
  constructor(
    public provider: ProviderId,
    /** Machine-readable failure class. Read by the UI to decide whether a
     *  one-tap escape to the other provider is worth offering. */
    public code: ProviderErrorCode,
    public status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ChatStreamRequest {
  /** Provider-LOCAL model id — the "nvidia:" namespace is already stripped. */
  model: string;
  /** OpenAI ChatML messages, passed through untouched. */
  messages: unknown[];
  /** OpenAI tool definitions. Omit (undefined) to send no tools at all —
   *  NVIDIA 400s when tools reach a model without function-calling. */
  tools?: unknown[];
  /** "none" = tools stay DECLARED on the wire (so no prompt sentence names a
   *  tool the request doesn't carry) but the model must answer in prose this
   *  round. Used for the forced answer round after the tool-iteration budget
   *  is spent; default "auto". Ignored when `tools` is omitted. */
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
  /** Provider-specific request extras (e.g. NVIDIA's chat_template_kwargs). */
  extraBody?: Record<string, unknown>;
  /** OpenRouter only: the user's API key. */
  apiKey?: string;
  /** How many LEADING messages form a byte-stable prefix across turns (today:
   *  the book-context block, so 0 or 1). An adapter MAY mark the last of them
   *  as an explicit cache breakpoint for providers that price cached prefix
   *  reads (Anthropic bills them at 0.1x but only below a cache_control
   *  marker); adapters without such a wire feature ignore this. Never count a
   *  message that changes per turn — a breakpoint on churning bytes buys
   *  cache WRITES (1.25x) with no reads, strictly worse than nothing. */
  cacheStablePrefixCount?: number;
  /** Explicit breakpoints (supersedes cacheStablePrefixCount when present).
   *  Adapters for providers without explicit cache markers ignore it — their
   *  caches key on byte-stable prefixes alone. At most 4 are honored. */
  cacheBreakpoints?: CacheBreakpoint[];
  /** A stable id for the conversation. OpenRouter uses it to keep routing the
   *  conversation to the same upstream provider, so its prompt cache stays warm. */
  sessionId?: string;
}

export interface ChatCompleteRequest {
  model: string;
  messages: unknown[];
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  /** Provider-specific request extras (e.g. NVIDIA's chat_template_kwargs —
   *  background summaries pin thinking OFF so a reasoning model can't spend
   *  the whole budget before writing a word). */
  extraBody?: Record<string, unknown>;
  /** Called once with how the completion ended and what it cost — lets a
   *  caller tell a length-truncated result from a finished one. */
  onMeta?: (meta: { finish?: FinishReason; usage?: TokenUsage }) => void;
}

export interface ChatProviderAdapter {
  readonly id: ProviderId;
  /** Stream one completion as normalized events. Throws ProviderError.
   *  Calling .return() on the generator cancels the underlying request body. */
  streamChat(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown>;
  /** One-shot non-streaming completion; returns the assistant text ("" when
   *  the model returned none). Used by the background rolling summary. */
  completeChat(req: ChatCompleteRequest): Promise<string>;
}
