import { describe, it, expect } from "vitest";
import {
  blockedTools,
  blockedToolResult,
  isToolBlocked,
  leanModeFromPhrase,
  leanModePromptBlock,
  LEAN_MODES,
  LEAN_MODE_INFO,
} from "@/lib/leanMode";
import { modelProvider, localModelId, namespacedId, providerLabel, allProviders, resolveModel, providerKey, providerConfigured, providerKeyField } from "@/lib/providers/registry";
import { geminiModelInfo, namespacedGeminiId, isChatworthyGeminiModel, GEMINI_STARTER_MODEL, GEMINI_FEATURED } from "@/lib/geminiCatalog";
import { looksLikeTavilyKey } from "@/lib/tavilySearch";

describe("Lean Mode tiers", () => {
  it("blocks nothing at full", () => {
    expect(blockedTools("full")).toEqual([]);
  });

  it("lean blocks dollar-per-artifact media but keeps images", () => {
    const b = blockedTools("lean");
    expect(b).toContain("generate_video");
    expect(b).toContain("generate_splat");
    // Images are cents, not dollars — killing them at the first stop would
    // throw away the cheap thing to stop the expensive one.
    expect(b).not.toContain("generate_image");
    expect(b).not.toContain("edit_image");
  });

  it("chat_only blocks all paid generation AND paid search", () => {
    const b = blockedTools("chat_only");
    for (const t of ["generate_video", "generate_splat", "generate_image", "edit_image", "web_search"]) {
      expect(b, t).toContain(t);
    }
  });

  it("never blocks viewing what the user already paid for", () => {
    // A budget mode that hid your own library would punish you for being broke.
    const free = [
      "show_image", "list_images", "view_image", "recall_image_memories",
      "show_video", "list_videos", "show_splat", "list_splats",
    ];
    for (const mode of LEAN_MODES) {
      for (const t of free) {
        expect(isToolBlocked(mode, t), `${mode}/${t}`).toBe(false);
      }
    }
  });

  it("tiers are strictly nested — nothing unblocks as you go stricter", () => {
    const lean = new Set(blockedTools("lean"));
    for (const t of lean) expect(blockedTools("chat_only")).toContain(t);
  });
});

describe("Lean Mode refusal is terminal", () => {
  it("marks the result non-retriable and says so in words", () => {
    const r = blockedToolResult("chat_only", "generate_image");
    expect(r.error).toBe("lean_mode_blocked");
    expect(r.retriable).toBe(false);
    // Models self-correct 2-3 times by default; the copy has to read as
    // final or the loop burns the tokens the mode exists to save.
    expect(r.message.toLowerCase()).toContain("do not retry");
    expect(r.capability).toBe("image generation");
  });

  it("tells the model to substitute a free answer, not another generator", () => {
    const r = blockedToolResult("lean", "generate_video");
    expect(r.message.toLowerCase()).toContain("do not substitute");
    expect(r.message.toLowerCase()).toContain("free version");
  });
});

describe("the user's own words turn it on", () => {
  it("maps 'broke' phrasings to a tier", () => {
    expect(leanModeFromPhrase("broke mode")).toBe("lean");
    expect(leanModeFromPhrase("I'm broke right now")).toBe("lean");
    expect(leanModeFromPhrase("can't afford images")).toBe("chat_only");
    expect(leanModeFromPhrase("chat only please")).toBe("chat_only");
  });

  it("doesn't fire on ordinary sentences", () => {
    expect(leanModeFromPhrase("write me a poem about the sea")).toBeNull();
    expect(leanModeFromPhrase("make an image of a lighthouse")).toBeNull();
  });
});

describe("Lean Mode prompt block", () => {
  it("is empty at full — no tokens spent describing a mode that's off", () => {
    expect(leanModePromptBlock("full")).toBe("");
  });

  it("names what is off, insists on a real answer, and forbids faking media", () => {
    const p = leanModePromptBlock("chat_only");
    expect(p).toContain("Lean Mode is ON");
    expect(p).toContain("image generation");
    expect(p.toLowerCase()).toContain("never say or imply you generated");
    // The failure mode this exists to prevent: a markdown image link standing
    // in for a real one, which renders as a broken image.
    expect(p.toLowerCase()).toContain("markdown image link");
    // Must not apologise or moralise about money.
    expect(p.toLowerCase()).toContain("no apology");
  });

  it("every tier has honest one-line copy", () => {
    for (const m of LEAN_MODES) {
      expect(LEAN_MODE_INFO[m].summary.length).toBeGreaterThan(20);
    }
  });
});

describe("provider registry at N=3", () => {
  it("routes all three providers and strips prefixes exactly once", () => {
    expect(modelProvider("google/gemini-2.5-flash")).toBe("openrouter");
    expect(modelProvider("nvidia:deepseek-ai/deepseek-v4-flash")).toBe("nvidia");
    expect(modelProvider("gemini:gemini-2.5-flash")).toBe("gemini");
    expect(localModelId("gemini:gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("the one-punctuation-mark collision routes to different providers", () => {
    // "google/gemini-2.5-flash" (OpenRouter resale) vs "gemini:gemini-2.5-flash"
    // (Google direct) bill completely different accounts.
    expect(modelProvider("google/gemini-2.5-flash")).not.toBe(modelProvider("gemini:gemini-2.5-flash"));
  });

  it("round-trips through namespacedId for every provider", () => {
    for (const p of allProviders()) {
      const id = namespacedId(p, "some/model");
      expect(modelProvider(id)).toBe(p);
      expect(localModelId(id)).toBe("some/model");
    }
  });

  it("resolves an adapter for every provider — no silent fallthrough", () => {
    for (const p of allProviders()) {
      const r = resolveModel(namespacedId(p, "x"));
      expect(r.provider).toBe(p);
      expect(r.adapter.id).toBe(p);
    }
  });

  it("labels every provider distinctly", () => {
    const labels = allProviders().map(providerLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("Gemini catalog", () => {
  it("the starter model is free-tier and tool-capable", () => {
    const s = GEMINI_FEATURED.find((m) => m.localId === GEMINI_STARTER_MODEL);
    expect(s).toBeTruthy();
    expect(s!.freeTier).toBe(true);
    expect(s!.caps.tools).toBe(true);
  });

  it("marks image models as needing billing — the free tier cannot run them", () => {
    const img = GEMINI_FEATURED.filter((m) => m.caps.images);
    expect(img.length).toBeGreaterThan(0);
    for (const m of img) expect(m.freeTier, m.localId).toBe(false);
  });

  it("hides embeddings and legacy models from the chat picker", () => {
    expect(isChatworthyGeminiModel("text-embedding-004")).toBe(false);
    expect(isChatworthyGeminiModel("gemini-1.0-pro")).toBe(false);
    expect(isChatworthyGeminiModel("gemini-2.5-flash")).toBe(true);
  });

  it("namespaces ids so they route to Google, not OpenRouter", () => {
    expect(modelProvider(namespacedGeminiId("gemini-2.5-flash"))).toBe("gemini");
  });

  it("uncurated image-ish models are assumed to need billing", () => {
    expect(geminiModelInfo("gemini-9-ultra-image-preview").freeTier).toBe(false);
  });
});

describe("Tavily free search", () => {
  it("recognises its key format", () => {
    expect(looksLikeTavilyKey("tvly-abc123")).toBe(true);
    expect(looksLikeTavilyKey("sk-or-v1-xxx")).toBe(false);
    expect(looksLikeTavilyKey("pp_xxx")).toBe(false);
  });
});


describe("provider key selection (the blocker that shipped)", () => {
  // Gemini shipped authenticating with the OpenRouter key: `apiKey` was
  // passed to whichever adapter resolveModel returned. Google got an
  // sk-or-… string and blamed the user for a key the app never sent.
  const keys = { apiKey: "sk-or-v1-ROUTER", geminiApiKey: "AIza-GOOGLE", nvidiaKeyLast4: "9999" };

  it("never hands one provider's key to another", () => {
    expect(providerKey("openrouter", keys)).toBe("sk-or-v1-ROUTER");
    expect(providerKey("gemini", keys)).toBe("AIza-GOOGLE");
    expect(providerKey("gemini", keys)).not.toBe(keys.apiKey);
  });

  it("sends no key at all for relay-backed providers", () => {
    // NVIDIA's key is write-only and read server-side; the browser must not
    // send anything, least of all a different provider's secret.
    expect(providerKey("nvidia", keys)).toBe("");
    expect(providerKeyField("nvidia")).toBeNull();
  });

  it("every provider declares where its browser key comes from", () => {
    for (const p of allProviders()) {
      const f = providerKeyField(p);
      expect(f === null || f === "apiKey" || f === "geminiApiKey", p).toBe(true);
    }
  });

  it("configured-ness is per provider, so one key never unlocks another", () => {
    const only = { apiKey: "", geminiApiKey: "AIza-GOOGLE", nvidiaKeyLast4: "" };
    expect(providerConfigured("gemini", only)).toBe(true);
    expect(providerConfigured("openrouter", only)).toBe(false);
    expect(providerConfigured("nvidia", only)).toBe(false);
  });
});

describe("lean alias safety", () => {
  it("does not fire on ordinary prose containing 'broke'", () => {
    // A novel-writing app: these must never silently switch spending off.
    for (const line of [
      "write a story about a broke musician",
      "he broke down crying in the rain",
      "the deal broke down at the last minute",
      "she broke the window with a stone",
    ]) {
      expect(leanModeFromPhrase(line), line).toBeNull();
    }
  });

  it("still catches the real thing", () => {
    expect(leanModeFromPhrase("broke mode")).toBe("lean");
    expect(leanModeFromPhrase("im broke")).toBe("lean");
    expect(leanModeFromPhrase("I can't afford images right now")).toBe("chat_only");
  });
});
