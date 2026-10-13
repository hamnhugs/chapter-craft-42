// Ollama adapter — a model running on THIS machine, called browser-direct.
//
// Native /api/chat, not the OpenAI-compatible /v1 surface. Measured on the
// reference machine (docs/local-ai/results/2026-10-12-speed.txt): /v1
// ignores options.num_ctx, so every request ran at Ollama's VRAM-derived
// default of 4096 tokens and the front of the system prompt was silently cut.
// The native API also honours `think` and `keep_alive`, which /v1 does not.
//
// Wire facts this file depends on (probed against Ollama 0.33.3, qwen3.5:4b):
//   - the body is NDJSON, one object per line, not SSE;
//   - tool calls arrive WHOLE, one per chunk, as
//     {id, function:{index, name, arguments:<object>}} — arguments are an
//     object, not a JSON string, so they are re-serialized for the pipeline;
//   - `done_reason` is "stop" even when the turn ended in tool calls, so the
//     adapter reports "tool_calls" itself whenever it emitted any;
//   - thinking arrives in message.thinking when think:true;
//   - an error can arrive as a 200 line {"error": "..."}.
//
// Messages are converted from the app's OpenAI ChatML shape: image_url parts
// become the native `images` array (raw base64), assistant tool_call
// arguments are parsed back to objects, and role:"tool" replies carry the
// tool's name, which Ollama's chat templates key on.

import {
  ChatCompleteRequest,
  ChatProviderAdapter,
  ChatStreamEvent,
  ChatStreamRequest,
  FinishReason,
  ProviderError,
  ProviderErrorCode,
  TokenUsage,
} from "./types";
import { ThoughtRouter } from "./sse";
import { OLLAMA_KEEP_ALIVE, ollamaBaseUrl, ollamaNumCtx } from "./ollamaConfig";

const FRIENDLY: Partial<Record<ProviderErrorCode, string>> = {
  network:
    "Can't reach Ollama on this computer. Start it with `systemctl start ollama` (or run scripts/local-up.sh), then try again.",
  not_provisioned: "That model isn't downloaded yet. Run `ollama pull <model>` in a terminal, then try again.",
  server: "Ollama hit an error running the model. If it ran out of memory, pick a smaller model or lower the context size in Settings.",
};

function classify(status: number, body: string): { code: ProviderErrorCode; message: string } {
  let message = body.slice(0, 500);
  try {
    const b = JSON.parse(body);
    if (b?.error) message = String(b.error);
  } catch { /* plain text */ }
  if (status === 404 || /model .* not found|try pulling it/i.test(message)) return { code: "not_provisioned", message };
  if (/out of memory|unable to allocate|cudaMalloc|vk::|ErrorOutOfDeviceMemory/i.test(message)) return { code: "server", message };
  if (status >= 400 && status < 500) return { code: "bad_request", message };
  return { code: "server", message };
}

function fail(code: ProviderErrorCode, status: number | null, message: string): never {
  const friendly = FRIENDLY[code];
  throw new ProviderError("ollama", code, status, friendly ? `${friendly} (${message})` : message);
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${ollamaBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    fail("network", null, (e as Error)?.message || "fetch failed");
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    const { code, message } = classify(res.status, raw);
    fail(code, res.status, message);
  }
  return res;
}

/** Parse an NDJSON body. Cancels the reader if the consumer stops early. */
export async function* ndjson(res: Response): AsyncGenerator<any, void, unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response stream");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* garbled line */ }
      }
    }
    const tail = buffer.trim();
    if (tail) { try { yield JSON.parse(tail); } catch { /* ignore */ } }
  } finally {
    try { void reader.cancel(); } catch { /* closed */ }
  }
}

// ---------------------------------------------------------------------------
// ChatML -> Ollama native messages
// ---------------------------------------------------------------------------

async function imageToBase64(url: string): Promise<string | null> {
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  if (m) return m[1];
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return null;
  }
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (a && typeof a === "object") return a as Record<string, unknown>;
  if (typeof a !== "string" || !a.trim()) return {};
  try {
    const v = JSON.parse(a);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function toOllamaMessages(messages: any[]): Promise<any[]> {
  const toolNames = new Map<string, string>();
  const out: any[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg: any = { role: m.role };
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      const images: string[] = [];
      for (const p of m.content) {
        if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
        else if (p?.type === "image_url") {
          const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          const b64 = url ? await imageToBase64(url) : null;
          if (b64) images.push(b64);
        }
      }
      msg.content = texts.join("\n\n");
      if (images.length) msg.images = images;
    } else {
      msg.content = typeof m.content === "string" ? m.content : m.content == null ? "" : String(m.content);
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      msg.tool_calls = m.tool_calls.map((tc: any) => {
        if (tc?.id && tc?.function?.name) toolNames.set(tc.id, tc.function.name);
        return { function: { name: tc?.function?.name, arguments: parseArgs(tc?.function?.arguments) } };
      });
    }
    if (m.role === "tool") {
      const name = m.name || (m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined);
      if (name) msg.tool_name = name;
    }
    out.push(msg);
  }
  return out;
}

function usageOf(d: any): TokenUsage | null {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const u: TokenUsage = {
    inputTokens: num(d?.prompt_eval_count),
    outputTokens: num(d?.eval_count),
    cachedTokens: num(d?.prompt_eval_cached_count),
    costUsd: 0,
  };
  return u.inputTokens !== undefined || u.outputTokens !== undefined ? u : null;
}

function finishOf(native: unknown, sawTools: boolean): FinishReason {
  if (sawTools) return "tool_calls";
  if (native === "stop") return "stop";
  if (native === "length") return "length";
  return native ? "other" : "stop";
}

/** Request body shared by both paths. `think` defaults OFF: on a 4B model a
 *  thinking turn measured 20-50 s against ~10 s without, and the app's own
 *  prompt already asks for the reasoning it needs. Callers turn it on
 *  through extraBody ({ think: true }) — Deep Research does. */
function baseBody(model: string, messages: any[], extraBody?: Record<string, unknown>) {
  const { think, options, ...rest } = (extraBody || {}) as any;
  return {
    model,
    messages,
    think: think === undefined ? false : think,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: { num_ctx: ollamaNumCtx(), ...(options || {}) },
    ...rest,
  };
}

/** A model-runner crash that is worth one silent retry. On the reference
 *  laptop the discrete GPU occasionally hangs on the first heavy request after
 *  waking from runtime suspend ("ErrorDeviceLost"); the kernel resets the ring
 *  and Ollama respawns its runner, so the same request then succeeds
 *  (docs/local-ai/results/2026-10-12-gpu-profile.txt). Out-of-memory is not
 *  retried: it would fail the same way. */
function retryable(e: unknown): boolean {
  if (!(e instanceof ProviderError) || e.code !== "server") return false;
  const detail = e.message.replace(FRIENDLY.server ?? "", ""); // our hint itself mentions memory
  return !/out of memory|unable to allocate|cudaMalloc|ErrorOutOfDeviceMemory/i.test(detail);
}

async function* streamOnce(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const messages = await toOllamaMessages(req.messages as any[]);
  // Ollama has no tool_choice. "none" (the forced answer round) is honoured
  // by not sending tools at all: the model then cannot call one. Ollama's
  // templates render a transcript containing earlier tool calls fine
  // without the declarations.
  const sendTools = req.tools && req.toolChoice !== "none";
  const res = await post(
    "/api/chat",
    { ...baseBody(req.model, messages, req.extraBody), stream: true, ...(sendTools ? { tools: req.tools } : {}) },
    req.signal,
  );

  const router = new ThoughtRouter();
  let sawTools = false;
  let produced = false;
  let nextIndex = 0;
  for await (const d of ndjson(res)) {
    if (d?.error) {
      const { code, message } = classify(200, JSON.stringify(d));
      fail(code, 200, message);
    }
    const m = d?.message;
    if (typeof m?.thinking === "string" && m.thinking) yield { type: "reasoning", delta: m.thinking };
    if (typeof m?.content === "string" && m.content) {
      const r = router.push(m.content);
      if (r.reasoning) yield { type: "reasoning", delta: r.reasoning };
      if (r.text) yield { type: "text", delta: r.text };
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function || {};
        sawTools = true;
        // Each chunk is a complete call. Ollama numbers them, but the
        // number is per-message; a fresh counter keeps slots distinct even
        // if a build ever repeats one.
        yield {
          type: "tool_call_delta",
          index: nextIndex++,
          id: tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: fn.name || undefined,
          argsDelta: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        };
      }
    }
    if (d?.done) {
      const rest = router.flush();
      if (rest.reasoning) yield { type: "reasoning", delta: rest.reasoning };
      if (rest.text) yield { type: "text", delta: rest.text };
      const usage = usageOf(d);
      if (usage) yield { type: "usage", usage };
      yield { type: "finish", reason: finishOf(d.done_reason, sawTools), native: String(d.done_reason ?? "") };
      return;
    }
    if (m?.content || m?.thinking || m?.tool_calls) produced = true;
  }
  // The runner died mid-request: Ollama closes the stream without a done line.
  if (!produced) fail("server", 200, "the model stopped before answering");
  const rest = router.flush();
  if (rest.reasoning) yield { type: "reasoning", delta: rest.reasoning };
  if (rest.text) yield { type: "text", delta: rest.text };
}

async function completeOnce(req: ChatCompleteRequest): Promise<string> {
  const messages = await toOllamaMessages(req.messages as any[]);
  const body: any = { ...baseBody(req.model, messages, req.extraBody), stream: false };
  if (req.maxTokens) body.options = { ...body.options, num_predict: req.maxTokens };
  const res = await post("/api/chat", body, req.signal);
  const data = await res.json();
  if (data?.error) {
    const { code, message } = classify(200, JSON.stringify(data));
    fail(code, 200, message);
  }
  // A runner that died mid-request leaves an empty, unfinished reply.
  if (data?.done === false && !data?.message?.content) fail("server", 200, "the model stopped before answering");
  req.onMeta?.({ finish: finishOf(data?.done_reason, false), usage: usageOf(data) ?? undefined });
  const router = new ThoughtRouter();
  const a = router.push(String(data?.message?.content || ""));
  const b = router.flush();
  return (a.text + b.text).trim();
}

export const ollamaAdapter: ChatProviderAdapter = {
  id: "ollama",

  async *streamChat(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        for await (const ev of streamOnce(req)) {
          started = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (started || attempt > 0 || req.signal?.aborted || !retryable(e)) throw e;
      }
    }
  },

  async completeChat(req: ChatCompleteRequest): Promise<string> {
    try {
      return await completeOnce(req);
    } catch (e) {
      if (req.signal?.aborted || !retryable(e)) throw e;
      return completeOnce(req);
    }
  },
};

// ---------------------------------------------------------------------------
// Discovery — what is installed and what each model can do
// ---------------------------------------------------------------------------

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  capabilities: string[];
  contextLength?: number;
}

/** Capabilities seen by the last listOllamaModels(), keyed by model name.
 *  Read synchronously by modelCapabilities.ts; unknown means fail open. */
const capabilityCache = new Map<string, string[]>();

export function cachedOllamaToolSupport(name: string): boolean | null {
  const caps = capabilityCache.get(name);
  if (!caps || caps.length === 0) return null;
  return caps.includes("tools");
}

/** Is the server up? Never throws. */
export async function pingOllama(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/version`, { signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, version: String(j?.version || "") };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "unreachable" };
  }
}

/** Installed models with their capabilities (tools / vision / thinking /
 *  embedding / completion) from /api/show. Never throws; [] when down. */
export async function listOllamaModels(signal?: AbortSignal): Promise<OllamaModelInfo[]> {
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal });
    if (!res.ok) return [];
    const tags = (await res.json())?.models || [];
    return await Promise.all(tags.map(async (t: any): Promise<OllamaModelInfo> => {
      const info: OllamaModelInfo = {
        name: String(t.name || t.model),
        sizeBytes: Number(t.size) || 0,
        family: t.details?.family,
        parameterSize: t.details?.parameter_size,
        quantization: t.details?.quantization_level,
        capabilities: [],
      };
      try {
        const s = await fetch(`${ollamaBaseUrl()}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: info.name }),
          signal,
        });
        if (s.ok) {
          const j = await s.json();
          info.capabilities = Array.isArray(j?.capabilities) ? j.capabilities.map(String) : [];
          const mi = j?.model_info || {};
          const ctxKey = Object.keys(mi).find((k) => k.endsWith(".context_length"));
          if (ctxKey) info.contextLength = Number(mi[ctxKey]) || undefined;
        }
      } catch { /* capabilities unknown */ }
      if (info.capabilities.length) capabilityCache.set(info.name, info.capabilities);
      return info;
    }));
  } catch {
    return [];
  }
}
