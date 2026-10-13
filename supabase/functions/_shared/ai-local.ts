// aiFetch — the edge functions' one door to a language model.
//
// Hosted, it is plain fetch: every function keeps calling the Lovable gateway
// or OpenRouter exactly as before. With AI_PROVIDER=ollama (the local
// edition) it answers the SAME OpenAI-shaped request from the Ollama on this
// machine and hands back an OpenAI-shaped Response, so no caller's parsing
// changes. That is the whole design: ~15 call sites switch by swapping
// `fetch(` for `aiFetch(`, and nothing downstream can tell.
//
// Translation, OpenAI → Ollama native /api/chat (not /v1, which ignores
// num_ctx and would truncate chapter-length inputs to 4096 tokens):
//   - a FORCED tool call (tool_choice: {function:{name}}) — the functions use
//     it as structured output — becomes `format: <that tool's JSON schema>`.
//     Ollama constrains decoding to the schema, which is a stronger guarantee
//     than a forced call, and the reply is wrapped back as tool_calls;
//   - response_format json_schema → format: schema; json_object → "json";
//   - image_url parts → native base64 `images`;
//   - max_tokens → num_predict, temperature → options.temperature;
//   - `reasoning` is dropped and thinking is off: background jobs want the
//     answer, and a 4-8B model thinking first can spend the whole budget.
// The requested model id (google/gemini-…) is replaced by a local role model:
// LOCAL_VISION_MODEL when the request carries an image, else LOCAL_LLM_MODEL.
// /embeddings requests are answered from /api/embed with LOCAL_EMBED_MODEL.

const PROVIDER = (Deno.env.get("AI_PROVIDER") || "").toLowerCase();
export const AI_LOCAL = PROVIDER === "ollama";

const OLLAMA_URL = (Deno.env.get("OLLAMA_URL") || "http://host.docker.internal:11434").replace(/\/+$/, "");
// Same model as chat by default: one resident model on a 6 GiB card means no
// swapping when a background job lands mid-conversation. LOCAL_LLM_MODEL=qwen3:8b
// trades that for accuracy (14/14 vs 11/14 on the tool eval).
export const LOCAL_LLM_MODEL = Deno.env.get("LOCAL_LLM_MODEL") || "qwen3:4b-instruct-2507-q4_K_M";
export const LOCAL_VISION_MODEL = Deno.env.get("LOCAL_VISION_MODEL") || "qwen3.5:4b";
export const LOCAL_EMBED_MODEL = Deno.env.get("LOCAL_EMBED_MODEL") || "nomic-embed-text";
const LOCAL_NUM_CTX = Number(Deno.env.get("LOCAL_NUM_CTX")) || 16384;

type Json = Record<string, any>;

async function imageToBase64(url: string): Promise<string | null> {
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  if (m) return m[1];
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return null;
  }
}

function parseArgs(a: unknown): Json {
  if (a && typeof a === "object") return a as Json;
  try {
    const v = JSON.parse(String(a || "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export async function toOllamaMessages(messages: any[]): Promise<{ messages: any[]; hasImages: boolean }> {
  const names = new Map<string, string>();
  let hasImages = false;
  const out: any[] = [];
  for (const m of messages || []) {
    const msg: any = { role: m.role };
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      const images: string[] = [];
      for (const p of m.content) {
        if (p?.type === "text") texts.push(String(p.text ?? ""));
        else if (p?.type === "image_url") {
          const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          const b64 = url ? await imageToBase64(url) : null;
          if (b64) images.push(b64);
        }
      }
      msg.content = texts.join("\n\n");
      if (images.length) { msg.images = images; hasImages = true; }
    } else {
      msg.content = m.content == null ? "" : String(m.content);
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      msg.tool_calls = m.tool_calls.map((tc: any) => {
        if (tc?.id) names.set(tc.id, tc.function?.name);
        return { function: { name: tc.function?.name, arguments: parseArgs(tc.function?.arguments) } };
      });
    }
    if (m.role === "tool") {
      const n = m.name || names.get(m.tool_call_id);
      if (n) msg.tool_name = n;
    }
    out.push(msg);
  }
  return { messages: out, hasImages };
}

/** The OpenAI body → the Ollama body, plus how to wrap the answer. */
export async function translateChat(body: Json): Promise<{ req: Json; forcedTool: string | null }> {
  const { messages, hasImages } = await toOllamaMessages(body.messages);
  const forced = body.tool_choice && typeof body.tool_choice === "object" ? body.tool_choice.function?.name : null;
  const forcedDef = forced ? (body.tools || []).find((t: any) => t?.function?.name === forced) : null;

  let format: unknown;
  if (forcedDef) format = forcedDef.function.parameters || { type: "object" };
  else if (body.response_format?.type === "json_schema") format = body.response_format.json_schema?.schema ?? "json";
  else if (body.response_format?.type === "json_object") format = "json";

  // num_batch 512: larger GPU jobs outran the kernel's compute timeout right
  // after a model load (ErrorDeviceLost). Same value as the app's
  // OLLAMA_NUM_BATCH (src/lib/providers/ollamaConfig.ts) so the model isn't reloaded.
  const options: Json = { num_ctx: LOCAL_NUM_CTX, num_batch: 512 };
  if (typeof body.temperature === "number") options.temperature = body.temperature;
  const maxTok = body.max_tokens ?? body.max_completion_tokens;
  if (typeof maxTok === "number") options.num_predict = maxTok;

  const req: Json = {
    model: hasImages ? LOCAL_VISION_MODEL : LOCAL_LLM_MODEL,
    messages,
    stream: false,
    think: false,
    keep_alive: "30m",
    options,
  };
  if (format !== undefined) req.format = format;
  // Unforced tools pass through (Ollama accepts the OpenAI tool shape).
  if (!forcedDef && Array.isArray(body.tools) && body.tools.length && body.tool_choice !== "none") req.tools = body.tools;
  return { req, forcedTool: forcedDef ? forced : null };
}

/** Ollama's reply → an OpenAI chat.completion object. */
export function wrapChat(d: Json, forcedTool: string | null, requestedModel: string): Json {
  const content = String(d?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const calls = Array.isArray(d?.message?.tool_calls) ? d.message.tool_calls : [];
  const message: Json = { role: "assistant", content };
  let finish = d?.done_reason === "length" ? "length" : "stop";
  if (forcedTool) {
    message.content = null;
    message.tool_calls = [{ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: forcedTool, arguments: content || "{}" } }];
    finish = "tool_calls";
  } else if (calls.length) {
    message.tool_calls = calls.map((c: any, i: number) => ({
      id: c.id || `call_${i}`,
      type: "function",
      function: { name: c.function?.name, arguments: JSON.stringify(c.function?.arguments ?? {}) },
    }));
    finish = "tool_calls";
  }
  return {
    id: `local-${crypto.randomUUID()}`,
    object: "chat.completion",
    model: d?.model || requestedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: d?.prompt_eval_count ?? 0, completion_tokens: d?.eval_count ?? 0, total_tokens: (d?.prompt_eval_count ?? 0) + (d?.eval_count ?? 0), cost: 0 },
  };
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

/** Local embeddings in the OpenAI shape ({data:[{embedding}]}). Task prefixes
 *  are the caller's job (see embed.ts) — this stays a transport. */
export async function localEmbed(input: string | string[], dimensions?: number): Promise<number[][] | null> {
  const texts = Array.isArray(input) ? input : [input];
  try {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // num_gpu 0: the embedder runs on the CPU (~0.1 s/query). Loaded on the
      // 6 GiB card it pushed 2 of the chat model's 37 layers to the CPU and
      // generation fell 50 -> 17 tok/s (docs/local-ai/results/2026-10-12-gpu-profile.txt).
      // Must match src/lib/localRoster.ts, or Ollama reloads it on every switch.
      body: JSON.stringify({
        model: LOCAL_EMBED_MODEL, input: texts, keep_alive: "30m", options: { num_gpu: 0 },
        ...(dimensions ? { dimensions } : {}),
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.embeddings) ? d.embeddings : null;
  } catch {
    return null;
  }
}

/** Dimensions of the columns the hosted models used to fill. A local vector
 *  is fitted to the caller's expectation: Matryoshka-truncated when longer,
 *  ZERO-PADDED when shorter. Padding is exact, not an approximation, for
 *  everything these columns are used for: appending zeros changes neither a
 *  dot product nor a norm, so cosine, inner product and L2 between two padded
 *  vectors equal those between the originals. What it does NOT make valid is
 *  comparing against a vector from another model — that stays the
 *  one-model-per-column rule embed.ts enforces, and re-embedding after the
 *  switch (knowledge-embed {stale_model:true}) is required. */
const HOSTED_DIMS: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "google/text-embedding-004": 768,
};

export function fitDims(v: number[], dims: number | undefined): number[] {
  if (!dims || v.length === dims) return v;
  if (v.length > dims) return v.slice(0, dims);
  return v.concat(new Array(dims - v.length).fill(0));
}

/** Prefix the local retrieval model was trained with ("query" or "document"). */
export function embedPrefix(kind: "query" | "document"): string {
  const m = LOCAL_EMBED_MODEL.toLowerCase();
  if (m.includes("nomic-embed")) return kind === "query" ? "search_query: " : "search_document: ";
  if (m.includes("embeddinggemma")) return kind === "query" ? "task: search result | query: " : "title: none | text: ";
  return "";
}

/** Drop-in for fetch() at every AI call site. An embeddings body may carry a
 *  non-OpenAI hint `input_kind: "query"` (default "document"). */
export async function aiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!AI_LOCAL) return fetch(url, init);
  let body: Json = {};
  try { body = JSON.parse(String(init.body || "{}")); } catch { return json(400, { error: { message: "aiFetch: body is not JSON" } }); }

  if (/\/embeddings(\?|$)/.test(url)) {
    const dims = typeof body.dimensions === "number" ? body.dimensions : HOSTED_DIMS[String(body.model || "")];
    const prefix = embedPrefix(body.input_kind === "query" ? "query" : "document");
    const texts = (Array.isArray(body.input) ? body.input : [body.input]).map((t: unknown) => prefix + String(t ?? ""));
    const vecs = await localEmbed(texts);
    if (!vecs) return json(502, { error: { message: `local embedder ${LOCAL_EMBED_MODEL} unavailable at ${OLLAMA_URL}` } });
    return json(200, {
      object: "list",
      model: `ollama/${LOCAL_EMBED_MODEL}`,
      data: vecs.map((v, index) => ({ object: "embedding", index, embedding: fitDims(v, dims) })),
    });
  }

  const { req, forcedTool } = await translateChat(body);
  let r: Response;
  try {
    r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: init.signal ?? undefined,
    });
  } catch (e) {
    return json(502, { error: { message: `Ollama unreachable at ${OLLAMA_URL}: ${(e as Error).message}` } });
  }
  const text = await r.text();
  if (!r.ok) return json(r.status === 404 ? 404 : 502, { error: { message: `Ollama ${r.status}: ${text.slice(0, 300)}` } });
  let d: Json;
  try { d = JSON.parse(text); } catch { return json(502, { error: { message: "Ollama returned non-JSON" } }); }
  if (d?.error) return json(502, { error: { message: String(d.error) } });
  return json(200, wrapChat(d, forcedTool, String(body.model || "")));
}
