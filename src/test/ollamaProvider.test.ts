import { describe, it, expect, vi, afterEach } from "vitest";
import { ollamaAdapter, ollamaRetry, toOllamaMessages, ndjson } from "@/lib/providers/ollamaAdapter";

ollamaRetry.delaysMs = [0, 0]; // retries are timed for a real runner restart; not in tests
import { isLoopbackUrl, ollamaBaseUrl, setOllamaBaseUrl, ollamaNumCtx, setOllamaNumCtx } from "@/lib/providers/ollamaConfig";
import { chatReady, describeModel, modelProvider, providerConfigured, providerKey, resolveModel } from "@/lib/providers/registry";
import type { ChatStreamEvent } from "@/lib/providers/types";

/** A Response whose body streams the given NDJSON objects, split mid-line to
 *  prove the parser buffers across network chunks. */
function ndjsonResponse(objs: unknown[], status = 200): Response {
  const text = objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  const mid = Math.floor(text.length / 2);
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, mid)));
      c.enqueue(enc.encode(text.slice(mid)));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/x-ndjson" } });
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("registry: the ollama: namespace", () => {
  it("routes ollama: ids to the local adapter and strips the prefix once", () => {
    const r = resolveModel("ollama:qwen3.5:4b");
    expect(r.provider).toBe("ollama");
    expect(r.localId).toBe("qwen3.5:4b"); // the model's own colon survives
    expect(r.adapter).toBe(ollamaAdapter);
    expect(describeModel("ollama:qwen3.5:4b")).toBe("Local · qwen3.5:4b");
  });

  it("bare ids still fall through to OpenRouter", () => {
    expect(modelProvider("qwen/qwen3-8b")).toBe("openrouter");
  });

  it("is configured with no key at all, and sends none", () => {
    expect(providerConfigured("ollama", {})).toBe(true);
    expect(providerKey("ollama", { apiKey: "sk-or-secret" })).toBe("");
    // NVIDIA's keyless-in-browser rule is unchanged.
    expect(providerConfigured("nvidia", {})).toBe(false);
  });
});

describe("chatReady", () => {
  it("a local model needs no key; a cloud model needs some key", () => {
    expect(chatReady({}, "ollama:qwen3:4b-instruct-2507-q4_K_M")).toBe(true);
    expect(chatReady({}, "openai/gpt-4o-mini")).toBe(false);
    expect(chatReady({ geminiApiKey: "g" }, "openai/gpt-4o-mini")).toBe(true);
    expect(chatReady({}, null)).toBe(false);
  });
});

describe("ollamaConfig", () => {
  it("accepts only loopback servers", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:11434")).toBe(false);
    expect(isLoopbackUrl("https://evil.example/ollama")).toBe(false);
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(setOllamaBaseUrl("http://10.0.0.2:11434")).toBe(false);
    expect(ollamaBaseUrl()).toBe("http://127.0.0.1:11434");
    expect(setOllamaBaseUrl("http://localhost:11500/")).toBe(true);
    expect(ollamaBaseUrl()).toBe("http://localhost:11500");
  });

  it("clamps the context size", () => {
    expect(ollamaNumCtx()).toBe(16384);
    setOllamaNumCtx(32768);
    expect(ollamaNumCtx()).toBe(32768);
    setOllamaNumCtx(100);
    expect(ollamaNumCtx()).toBe(16384);
  });
});

describe("toOllamaMessages", () => {
  it("turns image_url parts into raw base64 images and joins text parts", async () => {
    const out = await toOllamaMessages([
      { role: "user", content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "What is this?", images: ["AAAA"] });
  });

  it("parses assistant tool-call arguments back to objects and names tool replies", async () => {
    const out = await toOllamaMessages([
      { role: "assistant", content: null, tool_calls: [
        { id: "call_1", type: "function", function: { name: "list_books", arguments: "{\"limit\":3}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", content: "{\"books\":[]}" },
    ]);
    expect(out[0].tool_calls).toEqual([{ function: { name: "list_books", arguments: { limit: 3 } } }]);
    expect(out[0].content).toBe("");
    expect(out[1]).toEqual({ role: "tool", content: "{\"books\":[]}", tool_name: "list_books" });
  });

  it("unparseable arguments become {} rather than throwing", async () => {
    const out = await toOllamaMessages([
      { role: "assistant", content: "", tool_calls: [{ id: "x", function: { name: "f", arguments: "{oops" } }] },
    ]);
    expect(out[0].tool_calls[0].function.arguments).toEqual({});
  });
});

describe("ollamaAdapter.streamChat", () => {
  it("normalizes text, whole tool calls, usage, and reports tool_calls despite done_reason stop", async () => {
    // Shapes captured from Ollama 0.33.3 + qwen3.5:4b.
    const fetchMock = vi.fn(async () => ndjsonResponse([
      { message: { role: "assistant", content: "", tool_calls: [{ id: "call_a", function: { index: 0, name: "get_weather", arguments: { city: "Paris" } } }] }, done: false },
      { message: { role: "assistant", content: "", tool_calls: [{ id: "call_b", function: { index: 1, name: "get_weather", arguments: { city: "Rome" } } }] }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 284, prompt_eval_cached_count: 200, eval_count: 53 },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(ollamaAdapter.streamChat({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "get_weather" } }] }));

    const calls = events.filter((e) => e.type === "tool_call_delta") as any[];
    expect(calls.map((c) => [c.index, c.name, JSON.parse(c.argsDelta).city])).toEqual([[0, "get_weather", "Paris"], [1, "get_weather", "Rome"]]);
    expect(calls[0].id).toBe("call_a");
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { inputTokens: 284, outputTokens: 53, cachedTokens: 200, costUsd: 0 } });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls", native: "stop" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.think).toBe(false);
    expect(body.options.num_ctx).toBe(16384);
    expect(body.keep_alive).toBe("30m");
    expect(body.tools).toHaveLength(1);
  });

  it("routes thinking and inline <think> tags to reasoning", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([
      { message: { content: "", thinking: "hmm" }, done: false },
      { message: { content: "<think>inner</think>Four." }, done: false },
      { message: { content: "" }, done: true, done_reason: "stop" },
    ])));
    const events = await collect(ollamaAdapter.streamChat({ model: "m", messages: [] }));
    const reasoning = events.filter((e) => e.type === "reasoning").map((e: any) => e.delta).join("");
    const text = events.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    expect(reasoning).toBe("hmminner");
    expect(text).toBe("Four.");
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it("toolChoice none sends no tools (Ollama has no tool_choice)", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([{ message: { content: "ok" }, done: true, done_reason: "stop" }]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(ollamaAdapter.streamChat({ model: "m", messages: [], tools: [{}], toolChoice: "none" }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.tools).toBeUndefined();
  });

  it("extraBody can turn thinking on and add options without losing num_ctx", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([{ message: { content: "" }, done: true }]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(ollamaAdapter.streamChat({ model: "m", messages: [], extraBody: { think: true, options: { temperature: 0.1 } } }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.think).toBe(true);
    expect(body.options).toEqual({ num_ctx: 16384, num_batch: 512, temperature: 0.1 });
  });

  it("a server that isn't running is a network error that says how to start it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(collect(ollamaAdapter.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({
      provider: "ollama", code: "network",
    });
  });

  it("a missing model is not_provisioned with a pull hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "model \"x\" not found, try pulling it first" }), { status: 404 })));
    const err: any = await collect(ollamaAdapter.streamChat({ model: "x", messages: [] })).catch((e) => e);
    expect(err.code).toBe("not_provisioned");
    expect(err.message).toContain("ollama pull");
  });

  it("an error line inside a 200 stream throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([{ error: "unable to allocate Vulkan buffer" }])));
    await expect(collect(ollamaAdapter.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "server" });
  });

  it("retries once, silently, when the runner dies before answering (GPU device lost)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "decode() failed: vk::Queue::submit: ErrorDeviceLost" }), { status: 500 }))
      .mockResolvedValueOnce(ndjsonResponse([{ message: { content: "ok" }, done: true, done_reason: "stop" }]));
    vi.stubGlobal("fetch", fetchMock);
    const evs = await collect(ollamaAdapter.streamChat({ model: "m", messages: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(evs.filter((e) => e.type === "text").map((e: any) => e.delta).join("")).toBe("ok");
  });

  it("a stream that ends with no done line and no output counts as a crash", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ndjsonResponse([]))
      .mockResolvedValueOnce(ndjsonResponse([{ message: { content: "ok" }, done: true }]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(ollamaAdapter.streamChat({ model: "m", messages: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries after output reached the screen, nor out-of-memory, nor endlessly", async () => {
    const partial = vi.fn(async () => ndjsonResponse([{ message: { content: "half" } }, { error: "llama runner process has terminated" }]));
    vi.stubGlobal("fetch", partial);
    await expect(collect(ollamaAdapter.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "server" });
    expect(partial).toHaveBeenCalledTimes(1);

    const oom = vi.fn(async () => new Response(JSON.stringify({ error: "out of memory" }), { status: 500 }));
    vi.stubGlobal("fetch", oom);
    await expect(collect(ollamaAdapter.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "server" });
    expect(oom).toHaveBeenCalledTimes(1);

    const dead = vi.fn(async () => new Response(JSON.stringify({ error: "ErrorDeviceLost" }), { status: 500 }));
    vi.stubGlobal("fetch", dead);
    await expect(collect(ollamaAdapter.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "server" });
    expect(dead).toHaveBeenCalledTimes(3); // first try + two retries
  });
});

describe("ollamaAdapter.completeChat", () => {
  it("returns visible text only and maps maxTokens to num_predict", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: { content: "<think>x</think> Summary." }, done: true, done_reason: "length", prompt_eval_count: 10, eval_count: 5,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const onMeta = vi.fn();
    const text = await ollamaAdapter.completeChat({ model: "m", messages: [], maxTokens: 300, onMeta });
    expect(text).toBe("Summary.");
    expect(onMeta).toHaveBeenCalledWith({ finish: "length", usage: { inputTokens: 10, outputTokens: 5, cachedTokens: undefined, costUsd: 0 } });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ num_ctx: 16384, num_batch: 512, num_predict: 300 });
  });

  it("an empty unfinished reply (the runner died) is retried once instead of returning ''", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "", done: false, message: { content: "" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "fine" }, done: true, done_reason: "stop" })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await ollamaAdapter.completeChat({ model: "m", messages: [] })).toBe("fine");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ndjson", () => {
  it("handles a final line with no trailing newline", async () => {
    const res = new Response('{"a":1}\n{"b":2}');
    const out: any[] = [];
    for await (const o of ndjson(res)) out.push(o);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
