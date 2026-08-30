import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeModel, isNvidiaModel, localModelId, modelProvider, providerLabel, resolveModel, NVIDIA_PREFIX } from "@/lib/providers/registry";
import { openrouterAdapter, withCacheBreakpoint } from "@/lib/providers/openrouterAdapter";
import type { ChatStreamRequest } from "@/lib/providers/types";
import { ThoughtRouter, ToolCallIndexer, mapFinishReason } from "@/lib/providers/sse";
import { isChatworthyNvidiaModel, namespacedNvidiaId, nvidiaModelInfo, nvidiaNoThinkingBody, NVIDIA_FEATURED, NVIDIA_STARTER_MODEL, SHARED_WITH_OPENROUTER } from "@/lib/nvidiaCatalog";
import { isEmbeddingModel } from "@/lib/utils";

describe("provider registry", () => {
  it("routes by the nvidia: prefix and strips it exactly once", () => {
    expect(modelProvider("google/gemini-2.5-flash")).toBe("openrouter");
    expect(modelProvider("nvidia:deepseek-ai/deepseek-v4-flash")).toBe("nvidia");
    expect(localModelId("nvidia:deepseek-ai/deepseek-v4-flash")).toBe("deepseek-ai/deepseek-v4-flash");
    expect(localModelId("google/gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    const r = resolveModel("nvidia:meta/llama-3.3-70b-instruct");
    expect(r.provider).toBe("nvidia");
    expect(r.localId).toBe("meta/llama-3.3-70b-instruct");
  });

  it("bare vendor prefixes are NOT NVIDIA routing — the collision case", () => {
    // "nvidia/..." is a valid model id on BOTH OpenRouter and NVIDIA; only
    // the explicit "nvidia:" namespace may route to the relay.
    expect(modelProvider("nvidia/nemotron-nano-12b-v2-vl:free")).toBe("openrouter");
    expect(isNvidiaModel("nvidia/llama-3.1-nemotron-70b-instruct")).toBe(false);
  });
});

describe("provider is always named (the bug that made this unreadable)", () => {
  it("describeModel puts the provider in front of every model label", () => {
    // <option> can't hold a badge, so the provider has to live in the TEXT.
    expect(describeModel("nvidia:openai/gpt-oss-120b")).toBe("NVIDIA · openai/gpt-oss-120b");
    expect(describeModel("openai/gpt-oss-120b")).toBe("OpenRouter · openai/gpt-oss-120b");
    expect(providerLabel("nvidia")).toBe("NVIDIA");
  });

  it("the same model name on both providers renders differently", () => {
    // The whole failure mode: 13 names exist byte-identically on both.
    for (const id of SHARED_WITH_OPENROUTER) {
      expect(describeModel(id)).not.toBe(describeModel(`nvidia:${id}`));
    }
  });

  it("every shared name is a real NVIDIA catalog shape (vendor/slug, no routing suffix)", () => {
    for (const id of SHARED_WITH_OPENROUTER) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i);
      expect(id).not.toMatch(/:(free|nitro|floor|exacto)$/);
    }
  });
});

describe("OpenRouter adapter request shape", () => {
  const src = readFileSync(resolve(process.cwd(), "src", "lib", "providers", "openrouterAdapter.ts"), "utf8");

  it("sends an explicit max_tokens on the streaming path", () => {
    // OpenRouter reserves the MAX possible reply against the balance before
    // running; omitting this 402s users who have real credit.
    expect(src).toContain("max_tokens: OR_MAX_TOKENS");
  });

  it("keeps upstream's explanation instead of discarding it", () => {
    expect(src).toContain("upstreamText");
    // The old code fetched the body then threw it away for 401/402/429.
    expect(src).not.toContain('402, "Insufficient credits."');
  });

  it("distinguishes the reservation 402 from an empty balance", () => {
    expect(src).toMatch(/max_tokens\|can only afford/);
  });

  it("catches an error delivered inside a 200 stream", () => {
    expect(src).toContain("parsed?.error");
  });
});

describe("relay key validation", () => {
  const doc = readFileSync(resolve(process.cwd(), "supabase", "functions", "nvidia-chat", "index.ts"), "utf8");

  it("supports a validate action — the only NVIDIA key oracle that exists", () => {
    // NVIDIA publishes no auth-check or balance endpoint, and /v1/models is
    // unauthenticated, so only a real completion proves a key works.
    expect(doc).toContain('body?.action === "validate"');
    expect(doc).toContain("max_tokens: 1");
  });

  it("still requires model+messages for ordinary chat requests", () => {
    expect(doc).toContain("!validating && (typeof body?.model");
  });
});

describe("ThoughtRouter", () => {
  it("routes <think> content to reasoning, rest to text", () => {
    const r = new ThoughtRouter();
    const a = r.push("Hello <think>secret plan</think> world");
    const rest = r.flush();
    expect(a.text + rest.text).toBe("Hello  world");
    expect(a.reasoning + rest.reasoning).toBe("secret plan");
  });

  it("handles DiffusionGemma channel tags split across chunks", () => {
    const r = new ThoughtRouter();
    let text = "", reasoning = "";
    for (const chunk of ["<|chan", "nel>thought\nponder", "ing here<chan", "nel|>The answer is 4."]) {
      const out = r.push(chunk);
      text += out.text; reasoning += out.reasoning;
    }
    const rest = r.flush();
    text += rest.text; reasoning += rest.reasoning;
    expect(text).toBe("The answer is 4.");
    expect(reasoning).toBe("pondering here");
  });

  it("strips the EMPTY tag pair DiffusionGemma emits with thinking off", () => {
    const r = new ThoughtRouter();
    const a = r.push("<|channel>thought\n<channel|>Plain reply.");
    const rest = r.flush();
    expect(a.text + rest.text).toBe("Plain reply.");
    expect(a.reasoning + rest.reasoning).toBe("");
  });

  it("an unclosed thought block stays reasoning at flush (never leaks as text)", () => {
    const r = new ThoughtRouter();
    const a = r.push("<think>still going");
    const rest = r.flush();
    expect(a.text + rest.text).toBe("");
    expect(a.reasoning + rest.reasoning).toBe("still going");
  });

  it("holds back a partial tag then releases it when it turns out to be text", () => {
    const r = new ThoughtRouter();
    const a = r.push("a < b");
    const rest = r.flush();
    // "< b" can't start any tag once flushed — nothing may be lost.
    expect(a.text + rest.text).toBe("a < b");
  });
});

describe("ToolCallIndexer", () => {
  it("passes through explicit OpenAI-style indices", () => {
    const ix = new ToolCallIndexer();
    expect(ix.resolve({ index: 0, id: "a" })).toBe(0);
    expect(ix.resolve({ index: 1, id: "b" })).toBe(1);
    expect(ix.resolve({ index: 0 })).toBe(0); // args continuation
  });

  it("separates parallel whole-call chunks that lack index (NIM shape)", () => {
    const ix = new ToolCallIndexer();
    const a = ix.resolve({ id: "call_1", function: { name: "get_weather" } });
    const b = ix.resolve({ id: "call_2", function: { name: "get_time" } });
    expect(a).not.toBe(b);
    // Continuation for a known id returns its slot, not a new one.
    expect(ix.resolve({ id: "call_1" })).toBe(a);
  });

  it("bare argument fragments continue the last slot", () => {
    const ix = new ToolCallIndexer();
    const a = ix.resolve({ id: "call_1", function: { name: "f" } });
    expect(ix.resolve({ function: undefined })).toBe(a);
  });

  it("separates parallel named calls with NEITHER index nor id", () => {
    // The shape this class exists for: two whole tool calls, no index, no id.
    // Collapsing them into one slot concatenates their argument JSON into an
    // unparseable blob and loses both actions.
    const ix = new ToolCallIndexer();
    const a = ix.resolve({ function: { name: "get_weather" } });
    const b = ix.resolve({ function: { name: "get_time" } });
    expect(a).toBe(0);
    expect(b).toBe(1);
    // Args continuation after the second call still targets the second slot.
    expect(ix.resolve({})).toBe(b);
  });

  it("maps finish reasons to the normalized set", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("weird_native_value")).toBe("other");
  });
});

describe("NVIDIA catalog curation", () => {
  it("features DiffusionGemma — the user asked for it by name", () => {
    const dg = NVIDIA_FEATURED.find((m) => m.localId === "google/diffusiongemma-26b-a4b-it");
    expect(dg).toBeTruthy();
    expect(dg!.featured).toBe(true);
    expect(isChatworthyNvidiaModel("google/diffusiongemma-26b-a4b-it")).toBe(true);
  });

  it("hides embeddings, safety, utility and legacy-endpoint rows", () => {
    for (const id of [
      "baai/bge-m3",
      "nvidia/nv-embedqa-e5-v5",
      "nvidia/nvclip",
      "meta/llama-guard-4-12b",
      "nvidia/nemotron-3.5-content-safety",
      "nvidia/riva-translate-4b-instruct",
      "nvidia/nemotron-parse",
      "nvidia/cosmos-reason2-8b",
      "bigcode/starcoder2-15b",
      "nvidia/vila",
      "microsoft/phi-3-vision-128k-instruct",
      "meta/llama2-70b",
    ]) {
      expect(isChatworthyNvidiaModel(id), id).toBe(false);
    }
  });

  it("keeps plausible chat models it doesn't know, with conservative caps", () => {
    expect(isChatworthyNvidiaModel("mistralai/mistral-large-2-instruct")).toBe(true);
    const info = nvidiaModelInfo("mistralai/mistral-large-2-instruct");
    expect(info.caps.tools).toBe(true);
    expect(info.caps.vision).toBe(false);
    expect(info.contextLength).toBeUndefined();
  });

  it("namespaces ids with the colon prefix", () => {
    expect(namespacedNvidiaId("moonshotai/kimi-k2.6")).toBe(`${NVIDIA_PREFIX}moonshotai/kimi-k2.6`);
  });

  it("reasoning toggles are explicit in every curated entry that has one", () => {
    // Defaults are undocumented server-side — a curated reasoning model must
    // pin its toggle rather than inherit whatever NVIDIA decides this month.
    for (const m of NVIDIA_FEATURED) {
      if (m.extraBody) {
        const kw = (m.extraBody as any).chat_template_kwargs;
        expect(kw && typeof kw === "object", m.localId).toBe(true);
      }
    }
  });

  it("VL models that disable tools with images are flagged", () => {
    const vl = NVIDIA_FEATURED.find((m) => m.localId === "nvidia/nemotron-nano-12b-v2-vl");
    expect(vl?.imagesDisableTools).toBe(true);
  });

  it("the onboarding starter model is curated, tool-capable and thinking-free", () => {
    const starter = NVIDIA_FEATURED.find((m) => m.localId === NVIDIA_STARTER_MODEL);
    expect(starter).toBeTruthy();
    expect(starter!.caps.tools).toBe(true);
    expect(starter!.caps.reasoning).toBe(false);
  });

  it("background summaries pin thinking OFF per family", () => {
    // A reasoning model that spends a 500-token summary budget thinking
    // returns empty content — the summary never advances and the wasted
    // call repeats every turn.
    const ds: any = nvidiaNoThinkingBody("deepseek-ai/deepseek-v4-pro");
    expect(ds.chat_template_kwargs.thinking).toBe(false);
    expect(ds.chat_template_kwargs.reasoning_effort).toBeUndefined();
    const nem: any = nvidiaNoThinkingBody("nvidia/nemotron-3-nano-30b-a3b");
    expect(nem.chat_template_kwargs.enable_thinking).toBe(false);
    // Models with no declared toggle stay untouched.
    expect(nvidiaNoThinkingBody("meta/llama-3.3-70b-instruct")).toBeUndefined();
  });
});

describe("embedding-model filter (NVIDIA extensions)", () => {
  it("catches NVIDIA embedding ids that don't contain 'embed'", () => {
    expect(isEmbeddingModel("nvidia:baai/bge-m3")).toBe(true);
    expect(isEmbeddingModel("nvidia/nvclip")).toBe(true);
    expect(isEmbeddingModel("nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1")).toBe(true);
  });
  it("does not over-match chat models", () => {
    expect(isEmbeddingModel("nvidia:deepseek-ai/deepseek-v4-flash")).toBe(false);
    expect(isEmbeddingModel("nvidia:google/diffusiongemma-26b-a4b-it")).toBe(false);
    expect(isEmbeddingModel("meta/llama-3.3-70b-instruct")).toBe(false);
  });
});

describe("nvidia-chat relay function source", () => {
  const doc = readFileSync(resolve(process.cwd(), "supabase", "functions", "nvidia-chat", "index.ts"), "utf8");

  it("hardcodes the upstream host — no caller-supplied URL, no SSRF", () => {
    expect(doc).toContain('const UPSTREAM_CHAT = "https://integrate.api.nvidia.com/v1/chat/completions"');
    expect(doc).not.toMatch(/fetch\(\s*body/);
  });

  it("verifies the caller and reads the key under the caller's RLS", () => {
    expect(doc).toContain("supabase.auth.getUser()");
    expect(doc).toContain('.select("nvidia_api_key")');
    expect(doc).toContain('.eq("user_id", user.id)');
  });

  it("propagates browser aborts upstream (credits stop burning on Stop)", () => {
    expect(doc).toContain("signal: req.signal");
  });

  it("uses 428 for the no-key case — a status NVIDIA never sends", () => {
    expect(doc).toContain('"no_key", 428');
  });
});

describe("OpenRouter cache breakpoint (Stage 0)", () => {
  // Anthropic bills cached prefix reads at 0.1x, but only below an explicit
  // cache_control marker. The transform must mark EXACTLY the last byte-stable
  // leading message (the book block) and change nothing else on the wire —
  // for any other provider, any other message, any non-string content.
  const mkReq = (over: Partial<ChatStreamRequest> = {}): ChatStreamRequest =>
    ({
      model: "anthropic/claude-sonnet-4.5",
      messages: [
        { role: "system", content: "BOOK BLOCK" },
        { role: "system", content: "MAIN PROMPT" },
      ],
      cacheStablePrefixCount: 1,
      ...over,
    }) as ChatStreamRequest;

  it("marks exactly the last stable message, as a content-part array", () => {
    const out = withCacheBreakpoint(mkReq()) as any[];
    expect(out[0].content).toEqual([{ type: "text", text: "BOOK BLOCK", cache_control: { type: "ephemeral" } }]);
    expect(out[0].role).toBe("system");
    expect(out[1].content).toBe("MAIN PROMPT");
  });

  it("non-Anthropic models get the untouched array — no wire-shape change at all", () => {
    const req = mkReq({ model: "deepseek/deepseek-v4-flash" });
    expect(withCacheBreakpoint(req)).toBe(req.messages);
  });

  it("a zero/absent count means no marker even on Anthropic", () => {
    const zero = mkReq({ cacheStablePrefixCount: 0 });
    expect(withCacheBreakpoint(zero)).toBe(zero.messages);
    const absent = mkReq({ cacheStablePrefixCount: undefined });
    expect(withCacheBreakpoint(absent)).toBe(absent.messages);
  });

  it("never rewrites non-string content — an image part array is not the book block", () => {
    const req = mkReq({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] });
    expect(withCacheBreakpoint(req)).toBe(req.messages);
  });

  it("an anthropic stream request carries the breakpoint ON THE WIRE — a behavioral check a dead wire cannot pass", async () => {
    // Review finding: source-substring pins stay green when the wired line is
    // commented out. This drives the real streamChat through a fetch mock and
    // asserts the OUTGOING BODY, which only the live transform can produce.
    const captured: any[] = [];
    const fakeRes = {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
    } as unknown as Response;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: unknown, init: any) => {
      captured.push(JSON.parse(init.body));
      return fakeRes;
    };
    try {
      const drive = async (model: string) => {
        captured.length = 0;
        const gen = openrouterAdapter.streamChat({
          model,
          apiKey: "test-key",
          cacheStablePrefixCount: 1,
          messages: [
            { role: "system", content: "BOOK BLOCK" },
            { role: "user", content: "hi" },
          ],
        } as ChatStreamRequest);
        for await (const _ev of gen) { /* drain to completion */ }
        return captured[0];
      };
      const anth = await drive("anthropic/claude-sonnet-4.5");
      expect(anth.messages[0].content).toEqual([
        { type: "text", text: "BOOK BLOCK", cache_control: { type: "ephemeral" } },
      ]);
      expect(anth.messages[1].content).toBe("hi");
      const ds = await drive("deepseek/deepseek-v4-flash");
      expect(ds.messages[0].content).toBe("BOOK BLOCK");
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  it("the pipeline flags only the book block as stable — pinned to a LIVE line a comment cannot satisfy", () => {
    const ctx = readFileSync(resolve(process.cwd(), "src", "context", "ChatContext.tsx"), "utf8");
    expect(ctx).toMatch(/^\s*cacheStablePrefixCount: bookBlock\?\.message \? 1 : 0,$/m);
    expect(ctx).not.toMatch(/^\s*\/\/+\s*cacheStablePrefixCount:/m);
    const adapter = readFileSync(resolve(process.cwd(), "src", "lib", "providers", "openrouterAdapter.ts"), "utf8");
    expect(adapter).toMatch(/^\s*messages: withCacheBreakpoint\(req\),$/m);
    expect(adapter).not.toMatch(/^\s*\/\/+\s*messages: withCacheBreakpoint/m);
  });
});
