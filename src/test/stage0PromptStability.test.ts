import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * STAGE 0 OF THE CARD CATALOG REDESIGN — the prompt is a pure function of its
 * inputs, byte for byte.
 *
 * Per-BUILD fence nonces made every prompt byte-unique, which defeated
 * provider-side prefix caching for the whole suffix after the first fence.
 * The nonce is now session-stable (like the focus and book blocks before it),
 * which is safe exactly as long as promptFencing.test.ts's fixpoint-strip and
 * fence-defang properties hold — weaken those and this stability becomes a
 * forgery surface. These tests pin the payoff (byte-identical rebuilds) and
 * the two content changes that rode with it: the inline Chapter Contents
 * double-send is gone, and the capture sentence stopped claiming an
 * auto-capture that does not exist.
 */

let retrievalPayload: { nodes: any[]; edges: any[] } = { nodes: [], edges: [] };
let retrievalThrows = false;
vi.mock("@/lib/knowledgeApi", () => ({
  fetchKnowledgeEntries: async () => [
    { id: "fb1", title: "Fallback entry", content: "fallback body", entry_type: "fact", source_book_id: null },
  ],
  fetchConversationMemory: async () => null,
  retrieveKnowledge: async () => {
    if (retrievalThrows) throw new Error("retrieval down");
    return retrievalPayload;
  },
  filterSupersededNodes: async (nodes: unknown[]) => nodes,
}));
afterEach(() => {
  retrievalPayload = { nodes: [], edges: [] };
  retrievalThrows = false;
});
vi.mock("@/lib/imageGen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/imageGen")>()),
  fetchImagesForEntries: async () => [],
}));
vi.mock("@/lib/memoryLens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memoryLens")>()),
  getRecallStates: async () => new Map(),
}));
const APPROVED = [
  { id: "t1", root_id: null, name: "word_tally", description: "Counts words per chapter.", version: 1, superseded_by: null, fail_count: 0, last_run_at: null },
];
vi.mock("@/lib/toolFoundry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toolFoundry")>()),
  listTools: async () => APPROVED,
}));

const { buildChatSystemPrompt } = await import("@/lib/buildChatSystemPrompt");

type Opts = Parameters<typeof buildChatSystemPrompt>[0];
const build = (extra: Partial<Opts> = {}) =>
  buildChatSystemPrompt({ books: [], selectedBook: undefined, deepResearch: false, ...extra });

const hydratedBook: any = {
  id: "b1", title: "Tidepools", fileName: "tidepools.pdf", pageCount: 120,
  chapters: [
    { id: "c1", name: "Shore", startPage: 1, endPage: 10, textContent: "INLINE-CHAPTER-BODY ".repeat(200) },
    { id: "c2", name: "Reef", startPage: 11, endPage: 30, textContent: "" },
  ],
};

describe("the prompt is byte-stable for unchanged inputs", () => {
  it("two builds with retrieval nodes and a foundry roster are byte-identical", async () => {
    retrievalPayload = {
      nodes: [{ id: "n1", title: "Node", content: "body", entry_type: "concept", score: 1, hop: 0, via: null, from_seed: "n1" }],
      edges: [],
    };
    // The query names the approved tool so it RANKS IN — the roster fence must
    // actually render for the stability assertion to mean anything.
    const a = await build({ latestUserQuery: "word tally counts", foundryTools: true });
    const b = await build({ latestUserQuery: "word tally counts", foundryTools: true });
    expect(a.prompt).toBe(b.prompt);
    // Stability must not be vacuous: both fence families are actually present.
    expect(a.prompt).toContain("<<<memory:");
    expect(a.prompt).toContain("<<<tools:");
  });

  it("the degraded fallback dump is byte-identical too", async () => {
    retrievalThrows = true;
    const a = await build({ latestUserQuery: "tides" });
    const b = await build({ latestUserQuery: "tides" });
    expect(a.prompt).toBe(b.prompt);
    expect(a.prompt).toContain("Your Knowledge Wiki (fallback)");
  });
});

describe("inline Chapter Contents is gone (the double-send)", () => {
  it("hydrated chapter text never enters the prompt, even on a reading query", async () => {
    const { prompt } = await build({
      books: [hydratedBook],
      selectedBook: hydratedBook,
      latestUserQuery: "what does the book say about the shore",
    });
    expect(prompt).not.toContain("### Chapter Contents");
    expect(prompt).not.toContain("INLINE-CHAPTER-BODY");
    expect(prompt).not.toContain("Text not loaded here");
    // What remains: the catalog with ids, the active-book header, the
    // on-demand fetch line (this build implies every tool).
    expect(prompt).toContain('## Currently Active Book: "Tidepools" (id: b1)');
    expect(prompt).toContain('Chapter: "Shore" (id: c1, pages 1–10)');
    expect(prompt).toContain("Chapter text is fetched on demand with `get_chapter_text`.");
  });
});

describe("the capture sentence tells the truth", () => {
  it("no longer claims an auto-capture that does not exist", async () => {
    const { prompt } = await build({});
    expect(prompt).not.toContain("already auto-captures");
    expect(prompt).toContain("Nothing is captured from conversation automatically");
  });
});
