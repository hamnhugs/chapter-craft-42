import { describe, it, expect } from "vitest";
import {
  applySeedFloor,
  fuseRetrieval,
  normalizeWikiIds,
} from "../../supabase/functions/_shared/retrieval-rank.ts";

const seed = (id: string, score: number, similarity: number | null, extra: Record<string, unknown> = {}) => ({
  id, title: id, content: `${id} body`, entry_type: "fact", score, similarity, ...extra,
});

describe("applySeedFloor", () => {
  it("drops weak cosine seeds unless they matched full text; keeps unknown cosine", () => {
    const kept = applySeedFloor([
      seed("strong", 0.03, 0.62),
      seed("weak", 0.02, 0.12),
      seed("weak-but-keyword", 0.02, 0.12, { ft_match: true }),
      seed("no-vector", 0.02, null),
    ]);
    expect(kept.map((s) => s.id)).toEqual(["strong", "weak-but-keyword", "no-vector"]);
  });
});

describe("fuseRetrieval", () => {
  it("returns nothing when every seed is below the cosine floor", () => {
    const r = fuseRetrieval([seed("a", 0.03, 0.1), seed("b", 0.02, 0.05)], [], { limit: 18 });
    expect(r.nodes).toEqual([]);
    expect(r.dropped_seeds).toBe(2);
  });

  it("drops nodes under 0.35x the top score and respects limit", () => {
    const seeds = [
      seed("top", 0.04, 0.8, { vibrancy: 1, confidence: 1 }),
      seed("mid", 0.03, 0.7, { vibrancy: 1, confidence: 1 }),
      // normalized 0.7*0.005/0.04 = 0.0875 → far below 0.35 × 0.7
      seed("tail", 0.005, 0.31, { vibrancy: 1, confidence: 1 }),
    ];
    const r = fuseRetrieval(seeds, [], { limit: 18 });
    expect(r.nodes.map((n) => n.id)).toEqual(["top", "mid"]);
    expect(r.dropped_below_floor).toBe(1);
    expect(fuseRetrieval(seeds, [], { limit: 1 }).nodes.map((n) => n.id)).toEqual(["top"]);
  });

  it("lets a neighbour in only when it is relevant to the query", () => {
    const seeds = [seed("s", 0.04, 0.8, { vibrancy: 0.5, confidence: 0.8 })];
    const r = fuseRetrieval(seeds, [
      { entry_id: "relevant", title: "r", content: "", hop: 1, via_relationship: "supports", from_seed: "s", similarity: 0.6, vibrancy: 0.5, confidence: 0.8 },
      { entry_id: "adjacent-only", title: "x", content: "", hop: 1, via_relationship: "supports", from_seed: "s", similarity: 0.02, vibrancy: 0.5, confidence: 0.8 },
    ], { limit: 18 });
    expect(r.nodes.map((n) => n.id)).toEqual(["s", "relevant"]);
    const rel = r.nodes.find((n) => n.id === "relevant")!;
    expect(rel.hop).toBe(1);
    expect(rel.via).toBe("supports");
    expect(rel.similarity).toBe(0.6);
  });

  it("boosts a seed that is also a neighbour and exposes similarity + meta", () => {
    const r = fuseRetrieval(
      [seed("a", 0.04, 0.7, { wiki_id: "w1", ft_match: true }), seed("b", 0.04, 0.7)],
      [{ entry_id: "b", title: "b", content: "", hop: 1, from_seed: "a" }],
      { limit: 18 },
    );
    expect(r.nodes[0].id).toBe("b");
    const a = r.nodes.find((n) => n.id === "a")!;
    expect(a.similarity).toBe(0.7);
    expect(a.wiki_id).toBe("w1");
    expect(a.ft_match).toBe(true);
  });
});

describe("normalizeWikiIds", () => {
  const w1 = "11111111-1111-4111-8111-111111111111";
  const w2 = "22222222-2222-4222-8222-222222222222";
  it("merges wiki_ids with the legacy wiki_id, dedupes and drops junk", () => {
    expect(normalizeWikiIds([w1, w2, "nope", w1], w2)).toEqual([w1, w2]);
    expect(normalizeWikiIds(undefined, w1)).toEqual([w1]);
    expect(normalizeWikiIds([], null)).toBeNull();
    expect(normalizeWikiIds(null, "bad),wiki_id.is.null")).toBeNull();
  });
});
