import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Same hermetic mocks as promptToolTruth.test.ts, so the size budget below
// measures the real builder with no network.
vi.mock("@/lib/knowledgeApi", () => ({
  fetchKnowledgeEntries: async () => [],
  fetchConversationMemory: async () => null,
  retrieveKnowledge: async () => ({ nodes: [], edges: [] }),
  filterSupersededNodes: async (nodes: unknown[]) => nodes,
  fetchCardPointers: async () => new Map(),
}));
vi.mock("@/lib/imageGen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/imageGen")>()),
  fetchImagesForEntries: async () => [],
}));
vi.mock("@/lib/memoryLens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memoryLens")>()),
  getRecallStates: async () => new Map(),
}));
vi.mock("@/lib/toolFoundry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toolFoundry")>()),
  listTools: async () => [],
}));

const {
  FIND_TOOLS_DEFINITION, LOCAL_CORE_TOOLS, ROSTER_CAP, findTools, lexicalScore, planLocalRoster, readRoster, resetRoster, slimToolDef,
} = await import("@/lib/localRoster");
const { CHAT_TOOL_DEFINITIONS } = await import("@/lib/chatTools");
const { buildChatSystemPrompt } = await import("@/lib/buildChatSystemPrompt");

const ALL: any[] = CHAT_TOOL_DEFINITIONS as unknown as any[];
const names = (defs: any[]) => defs.map((d) => d.function.name);

beforeEach(() => {
  // No embedder in tests: every fetch fails, so ranking takes the lexical path.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("planLocalRoster", () => {
  it("first turn: core tools first, then the best matches for the request", async () => {
    const plan = await planLocalRoster({ userId: "u", query: "make an image of a lighthouse", pool: ALL });
    expect(plan.names.slice(0, LOCAL_CORE_TOOLS.length)).toEqual([...LOCAL_CORE_TOOLS]);
    expect(plan.names).toContain("generate_image");
    expect(readRoster("u")).toEqual(plan.names);
  });

  it("is append-only: an unrelated later turn leaves the roster byte-identical", async () => {
    const first = await planLocalRoster({ userId: "u", query: "make an image of a lighthouse", pool: ALL });
    const second = await planLocalRoster({ userId: "u", query: "thanks", pool: ALL });
    expect(second.names).toEqual(first.names);
    expect(second.added).toEqual([]);
  });

  it("a strong later match is appended at the END, never inserted", async () => {
    const first = await planLocalRoster({ userId: "u", query: "hello there", pool: ALL });
    const second = await planLocalRoster({ userId: "u", query: "list my generated videos", pool: ALL });
    expect(second.names.slice(0, first.names.length)).toEqual(first.names);
    expect(second.names).toContain("list_videos");
  });

  it("never offers a tool the gates withheld", async () => {
    const pool = ALL.filter((d) => d.function.name !== "generate_image" && d.function.name !== "web_search");
    const plan = await planLocalRoster({ userId: "u", query: "make an image and search the web", pool });
    expect(plan.names).not.toContain("generate_image");
    expect(plan.names).not.toContain("web_search");
    for (const n of plan.names) expect(names(pool)).toContain(n);
  });

  it("drops a remembered tool once the gates withhold it", async () => {
    await planLocalRoster({ userId: "u", query: "make an image", pool: ALL });
    const pool = ALL.filter((d) => d.function.name !== "generate_image");
    const plan = await planLocalRoster({ userId: "u", query: "ok", pool });
    expect(plan.names).not.toContain("generate_image");
  });

  it("rebuilds once past the cap instead of growing forever", async () => {
    localStorage.setItem("localRoster:u", JSON.stringify(names(ALL).slice(0, ROSTER_CAP)));
    const plan = await planLocalRoster({ userId: "u", query: "delete a splat", pool: ALL });
    expect(plan.rebuilt).toBe(true);
    expect(plan.names.length).toBeLessThanOrEqual(ROSTER_CAP);
  });

  it("resetRoster starts the next conversation from core", async () => {
    await planLocalRoster({ userId: "u", query: "make an image", pool: ALL });
    resetRoster("u");
    expect(readRoster("u")).toEqual([]);
  });
});

describe("findTools", () => {
  it("adds the best matches the model doesn't have yet and remembers them", async () => {
    const offered = new Set<string>(LOCAL_CORE_TOOLS);
    writeCore();
    const { result, added } = await findTools({ userId: "u", need: "delete a chapter", pool: ALL, offered });
    expect(added).toContain("delete_chapter");
    expect(added.every((n) => !offered.has(n))).toBe(true);
    expect((result as any).found.length).toBe(added.length);
    expect(readRoster("u")).toEqual(expect.arrayContaining(added));
  });

  it("an empty need is an error the model can act on", async () => {
    const { result, added } = await findTools({ userId: "u", need: " ", pool: ALL, offered: new Set() });
    expect(added).toEqual([]);
    expect((result as any).error).toBeTruthy();
  });
});

function writeCore() {
  localStorage.setItem("localRoster:u", JSON.stringify([...LOCAL_CORE_TOOLS]));
}

describe("slimToolDef", () => {
  it("keeps every name, type, enum and required list — only prose shrinks", () => {
    for (const def of ALL) {
      const slim = slimToolDef(def);
      expect(slim.function.name).toBe(def.function.name);
      expect(JSON.stringify(slim).length).toBeLessThanOrEqual(JSON.stringify(def).length);
      const strip = (n: any): any => Array.isArray(n) ? n.map(strip) : n && typeof n === "object"
        ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== "description" && k !== "examples").map(([k, v]) => [k, strip(v)]))
        : n;
      expect(strip(slim.function.parameters)).toEqual(strip(def.function.parameters));
    }
  });

  it("is deterministic (wire bytes must be cache-stable)", () => {
    for (const def of ALL) expect(JSON.stringify(slimToolDef(def))).toBe(JSON.stringify(slimToolDef(def)));
  });
});

describe("lexicalScore", () => {
  it("scores overlapping words, ignoring stopwords and plurals", () => {
    expect(lexicalScore("show my videos", "list videos: List the user's generated video clips")).toBeGreaterThan(0.4);
    expect(lexicalScore("the a of", "anything")).toBe(0);
  });
});

describe("local request budget (the reason this module exists)", () => {
  it("a first local turn fits comfortably in a 16K context", async () => {
    const plan = await planLocalRoster({ userId: "u", query: "What books do I have?", pool: ALL });
    const defs = [...plan.names.map((n) => slimToolDef(ALL.find((d) => d.function.name === n))), FIND_TOOLS_DEFINITION];
    const { stablePrompt } = await buildChatSystemPrompt({ books: [], selectedBook: undefined, deepResearch: false, offeredTools: plan.names });
    const toolChars = JSON.stringify(defs).length;
    const fullToolChars = JSON.stringify(ALL).length;
    const totalTokens = (stablePrompt.length + toolChars) / 3.6;
    // Logged so a regression shows the number, not just a red line.
    console.log(`local turn: prompt ${stablePrompt.length} chars + tools ${toolChars} chars (full roster ${fullToolChars}) ≈ ${Math.round(totalTokens)} tokens`);
    expect(toolChars).toBeLessThan(fullToolChars / 4);
    expect(totalTokens).toBeLessThan(9000);
  });
});
