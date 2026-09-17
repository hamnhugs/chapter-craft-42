import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/knowledgeApi", () => ({}));
vi.mock("@/lib/imageGen", () => ({}));
vi.mock("@/lib/memoryLens", () => ({}));
vi.mock("@/lib/toolFoundry", () => ({}));

const { applyRelevanceFloor, applyRetrievalBudget, retrievalQueryFor, cardClipLength } = await import("@/lib/buildChatSystemPrompt");

describe("retrieval budget", () => {
  it("builds a query only when the message asks something", () => {
    expect(retrievalQueryFor("ok")).toBeNull();
    expect(retrievalQueryFor("Thanks!")).toBeNull();
    expect(retrievalQueryFor("   ")).toBeNull();
    expect(retrievalQueryFor("what does chapter four say about grief?")).toBe("what does chapter four say about grief?");
    expect(retrievalQueryFor("why?", "Grief, the author argues, is a form of love.")).toContain("Grief, the author argues");
  });

  it("drops nodes far below the best score and their edges", () => {
    const r = applyRelevanceFloor({
      nodes: [{ id: "a", score: 1 }, { id: "b", score: 0.5 }, { id: "c", score: 0.2 }, { id: "d" }],
      edges: [{ source_entry_id: "a", target_entry_id: "c" }, { source_entry_id: "a", target_entry_id: "b" }],
    });
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b", "d"]);
    expect(r.edges).toHaveLength(1);
  });

  it("fills best-first within the character budget and always keeps the top node", () => {
    const long = "x".repeat(4000);
    const nodes = [1, 2, 3, 4, 5].map((i) => ({ id: String(i), title: "t", content: long, score: 1 }));
    const kept = applyRetrievalBudget({ nodes, edges: [] }, { totalChars: 9000, clipFor: (n) => cardClipLength(n, false, false) });
    expect(kept.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    const tiny = applyRetrievalBudget({ nodes, edges: [] }, { totalChars: 10, clipFor: () => 4000 });
    expect(tiny.nodes.map((n) => n.id)).toEqual(["1"]);
  });
});
