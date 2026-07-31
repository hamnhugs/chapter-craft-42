import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isNvidiaModel, localModelId, modelProvider, resolveModel, NVIDIA_PREFIX } from "@/lib/providers/registry";
import { ThoughtRouter, ToolCallIndexer, mapFinishReason } from "@/lib/providers/sse";
import { isChatworthyNvidiaModel, namespacedNvidiaId, nvidiaModelInfo, nvidiaNoThinkingBody, NVIDIA_FEATURED, NVIDIA_STARTER_MODEL } from "@/lib/nvidiaCatalog";
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
