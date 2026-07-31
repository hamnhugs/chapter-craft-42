// Provider adapter seam. The adapter owns the wire protocol (endpoints,
// headers, SSE dialect, error shapes, reasoning-field names); the chat
// pipeline in ChatContext owns the conversation (tool loop, sentence cap,
// persistence) and only ever sees the normalized vocabulary below.

export type ProviderId = "openrouter" | "nvidia";

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
  | { type: "finish"; reason: FinishReason; native?: string };

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
  signal?: AbortSignal;
  /** Provider-specific request extras (e.g. NVIDIA's chat_template_kwargs). */
  extraBody?: Record<string, unknown>;
  /** OpenRouter only: the user's API key. */
  apiKey?: string;
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
