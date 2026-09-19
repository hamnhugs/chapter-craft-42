import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { modelToolSupport, type ToolSupport } from "@/lib/modelCapabilities";
import { cachedOrToolSupport, type ORModel } from "@/lib/openrouterCatalog";
import { NVIDIA_FEATURED } from "@/lib/nvidiaCatalog";
import { GEMINI_FEATURED } from "@/lib/geminiCatalog";

/** Shape fetchCatalog writes: whole rows under one bucket per query string. */
function seedCatalog(query: string, rows: Partial<ORModel>[], t = Date.now()) {
  localStorage.setItem(`or_catalog_${query}`, JSON.stringify({ t, data: rows }));
}

// A verified real supported_parameters value, trimmed.
const WITH_TOOLS = ["max_tokens", "stop", "temperature", "tool_choice", "tools"];
const WITHOUT_TOOLS = ["max_tokens", "response_format", "stop", "temperature"];

beforeEach(() => localStorage.clear());

describe("modelToolSupport — declared catalogs", () => {
  it("reports a curated NVIDIA tool model as capable and known", () => {
    const r = modelToolSupport("nvidia:meta/llama-3.3-70b-instruct");
    expect(r.supportsTools).toBe(true);
    expect(r.known).toBe(true);
  });

  it("echoes every curated NVIDIA row's declared caps.tools verbatim", () => {
    // The declaration in nvidiaCatalog is the single source of truth; this
    // module may never second-guess it in either direction.
    for (const m of NVIDIA_FEATURED) {
      const r = modelToolSupport(`nvidia:${m.localId}`);
      expect(r.supportsTools, m.localId).toBe(m.caps.tools);
      expect(r.known, m.localId).toBe(true);
    }
  });

  it("reports a Gemini model declared caps.tools:false as false and known", () => {
    // gemini-3-pro-image-preview is an image model — no function calling.
    const declared = GEMINI_FEATURED.find((m) => m.caps.tools === false);
    expect(declared, "geminiCatalog must keep at least one non-tool row").toBeTruthy();
    const r = modelToolSupport(`gemini:${declared!.localId}`);
    expect(r.supportsTools).toBe(false);
    expect(r.known).toBe(true);
  });

  it("echoes every curated Gemini row's declared caps.tools verbatim", () => {
    for (const m of GEMINI_FEATURED) {
      const r = modelToolSupport(`gemini:${m.localId}`);
      expect(r.supportsTools, m.localId).toBe(m.caps.tools);
      expect(r.known, m.localId).toBe(true);
    }
  });

  it("does not mistake a bare vendor prefix for the NVIDIA namespace", () => {
    // "nvidia/..." without the colon is an OpenRouter id — with a cold cache
    // it must fail open, not read NVIDIA's declared caps.
    const r = modelToolSupport("nvidia/nemotron-3-super-120b-a12b");
    expect(r.known).toBe(false);
    expect(r.supportsTools).toBe(true);
  });
});

describe("modelToolSupport — the fail-open rule (do not tighten)", () => {
  // This is the rule the whole tool-visibility fix rests on: when we do not
  // KNOW, we send the tools. Failing closed here would strip an assistant of
  // every tool because of our own async state — a catalog fetch that had not
  // landed yet — rather than because of anything the user configured.
  it("an unrecognised model id is treated as capable, and marked not-known", () => {
    const r = modelToolSupport("totally-made-up/model-9000");
    expect(r).toMatchObject({ supportsTools: true, known: false });
  });

  it("garbage, empty and namespaced-but-uncatalogued ids all fail open", () => {
    for (const id of ["", "   ", "???", "nvidia:acme/never-heard-of-it", "gemini:gemini-99-ultra"]) {
      const r = modelToolSupport(id);
      expect(r.supportsTools, id).toBe(true);
      expect(r.known, id).toBe(false);
    }
  });

  it("an OpenRouter model with a cold cache fails open rather than losing its tools", () => {
    expect(localStorage.length).toBe(0);
    expect(modelToolSupport("anthropic/claude-sonnet-4.5")).toMatchObject({
      supportsTools: true,
      known: false,
    });
  });
});

describe("modelToolSupport — OpenRouter reads the cached catalog", () => {
  it("uses the published supported_parameters for a bare id", () => {
    seedCatalog("sort=top-weekly", [
      { id: "acme/talks-to-tools", supported_parameters: WITH_TOOLS },
      { id: "acme/prose-only", supported_parameters: WITHOUT_TOOLS },
    ]);
    expect(modelToolSupport("acme/talks-to-tools")).toMatchObject({ supportsTools: true, known: true });
    expect(modelToolSupport("acme/prose-only")).toMatchObject({ supportsTools: false, known: true });
  });
});

describe("cachedOrToolSupport", () => {
  it("returns null when nothing is cached — never false", () => {
    expect(cachedOrToolSupport("acme/talks-to-tools")).toBe(null);
  });

  it("returns true when the cached row lists tools, false when it does not", () => {
    seedCatalog("sort=top-weekly", [
      { id: "acme/talks-to-tools", supported_parameters: WITH_TOOLS },
      { id: "acme/prose-only", supported_parameters: WITHOUT_TOOLS },
    ]);
    expect(cachedOrToolSupport("acme/talks-to-tools")).toBe(true);
    expect(cachedOrToolSupport("acme/prose-only")).toBe(false);
  });

  it("sweeps every bucket — the cache key is per query string", () => {
    seedCatalog("sort=newest", [{ id: "acme/only-in-newest", supported_parameters: WITH_TOOLS }]);
    seedCatalog("category=programming&sort=top-weekly", [
      { id: "acme/only-in-programming", supported_parameters: WITHOUT_TOOLS },
    ]);
    expect(cachedOrToolSupport("acme/only-in-newest")).toBe(true);
    expect(cachedOrToolSupport("acme/only-in-programming")).toBe(false);
    expect(cachedOrToolSupport("acme/in-neither")).toBe(null);
  });

  it("prefers the newest bucket when buckets disagree", () => {
    seedCatalog("sort=newest", [{ id: "acme/changed", supported_parameters: WITHOUT_TOOLS }], 1000);
    seedCatalog("sort=top-weekly", [{ id: "acme/changed", supported_parameters: WITH_TOOLS }], 2000);
    expect(cachedOrToolSupport("acme/changed")).toBe(true);
  });

  it("returns null for a row with no supported_parameters (a cache written before this read)", () => {
    seedCatalog("sort=top-weekly", [{ id: "acme/legacy-row", name: "Legacy" }]);
    expect(cachedOrToolSupport("acme/legacy-row")).toBe(null);
  });

  it("survives the localStorage round trip and ignores corrupt or foreign buckets", () => {
    localStorage.setItem("or_catalog_sort=broken", "{not json");
    localStorage.setItem("some_other_app_key", JSON.stringify({ data: [] }));
    seedCatalog("sort=top-weekly", [{ id: "acme/talks-to-tools", supported_parameters: WITH_TOOLS }]);
    expect(cachedOrToolSupport("acme/talks-to-tools")).toBe(true);
  });

  it("answers a routing-suffix id from its base row", () => {
    // ":free" / ":nitro" choose an upstream for the SAME model.
    seedCatalog("sort=top-weekly", [{ id: "acme/talks-to-tools", supported_parameters: WITH_TOOLS }]);
    expect(cachedOrToolSupport("acme/talks-to-tools:free")).toBe(true);
  });

  it("ignores age — tool support is a stable property, unlike price", () => {
    seedCatalog("sort=top-weekly", [{ id: "acme/prose-only", supported_parameters: WITHOUT_TOOLS }], 1);
    expect(cachedOrToolSupport("acme/prose-only")).toBe(false);
  });
});

describe("copy invariant: no safety or blame vocabulary in any `why`", () => {
  // Same list as src/test/toolAvailability.test.ts. Safety framing in copy a
  // model reads raises unfaithful refusals on benign requests; the register
  // that suppresses tool use is the same register that reads as blame.
  const FORBIDDEN = [
    "not permitted", "not allowed", "for safety", "unsafe", "blocked", "block ",
    "denied", "deny", "forbidden", "prohibited", "disallowed", "unauthorized",
    "restricted", "violation", "security", "harmful", "dangerous", "abuse",
    "you cannot", "you can't", "you may not", "you must not", "misuse",
  ];

  it("holds for every branch, and every branch says something", () => {
    seedCatalog("sort=top-weekly", [
      { id: "acme/talks-to-tools", supported_parameters: WITH_TOOLS },
      { id: "acme/prose-only", supported_parameters: WITHOUT_TOOLS },
    ]);
    const results: ToolSupport[] = [
      modelToolSupport("nvidia:meta/llama-3.3-70b-instruct"), // known + capable
      modelToolSupport("gemini:gemini-3-pro-image-preview"), // known + not capable
      modelToolSupport("acme/talks-to-tools"),
      modelToolSupport("acme/prose-only"),
      modelToolSupport("totally-made-up/model-9000"), // unknown
      modelToolSupport(""),
    ];
    const seen = new Set<string>();
    for (const r of results) {
      expect(r.why.length).toBeGreaterThan(20);
      expect(r.why.endsWith(".")).toBe(true);
      seen.add(r.why);
      const lower = r.why.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(lower.includes(word), `"${word}" appears in: ${r.why}`).toBe(false);
      }
    }
    // Three distinct outcomes must read as three distinct sentences —
    // "we checked and it cannot" and "we have not checked" are different
    // facts and must never render identically.
    expect(seen.size).toBe(3);
  });
});

describe("a declared non-tool NVIDIA row", () => {
  // Every curated NVIDIA model happens to declare tools:true today, so the
  // false branch is exercised against a stand-in row. This pins the wiring
  // (declared false -> reported false, known true) for the day NVIDIA's
  // curated table gains an image or audio model.
  afterEach(() => {
    vi.doUnmock("@/lib/nvidiaCatalog");
    vi.resetModules();
  });

  it("reports supportsTools:false with known:true", async () => {
    vi.resetModules();
    vi.doMock("@/lib/nvidiaCatalog", async () => {
      const actual = await vi.importActual<typeof import("@/lib/nvidiaCatalog")>("@/lib/nvidiaCatalog");
      return {
        ...actual,
        NVIDIA_FEATURED: [
          ...actual.NVIDIA_FEATURED,
          {
            localId: "acme/pixels-only-8b",
            label: "Pixels Only 8B",
            caps: { tools: false, vision: true, reasoning: false },
            featured: true,
          },
        ],
      };
    });
    const { modelToolSupport: fresh } = await import("@/lib/modelCapabilities");
    expect(fresh("nvidia:acme/pixels-only-8b")).toMatchObject({ supportsTools: false, known: true });
  });
});
