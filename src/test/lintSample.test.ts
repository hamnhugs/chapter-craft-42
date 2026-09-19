import { describe, it, expect } from "vitest";
import { selectLintSample, normalizeTitleKey } from "../../supabase/functions/_shared/lint-sample.ts";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString();

describe("selectLintSample", () => {
  it("keeps everything when the library fits the budget", () => {
    const entries = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
    expect(selectLintSample(entries, new Set(), 150).ids).toEqual(["a", "b"]);
  });

  it("caps at the budget and prioritizes duplicates, low confidence, orphans, stale", () => {
    const entries = Array.from({ length: 400 }, (_, i) => ({
      id: `e${i}`,
      title: `Unique topic number ${i}`,
      confidence: 0.9,
      updated_at: day(400 - i), // e399 oldest
    }));
    entries.push({ id: "dup1", title: "Memory Palace!", confidence: 0.9, updated_at: day(500) });
    entries.push({ id: "dup2", title: "memory palace", confidence: 0.9, updated_at: day(501) });
    entries.push({ id: "weak", title: "Shaky claim", confidence: 0.1, updated_at: day(502) });
    entries.push({ id: "lonely", title: "Island", confidence: 0.9, updated_at: day(503) });
    const connected = new Set(entries.map((e) => e.id).filter((id) => id !== "lonely"));

    const s = selectLintSample(entries, connected, 20);
    expect(s.ids.length).toBe(20);
    expect(new Set(s.ids).size).toBe(20);
    expect(s.reasons.dup1).toBe("duplicate");
    expect(s.reasons.dup2).toBe("duplicate");
    expect(s.reasons.weak).toBe("low_confidence");
    expect(s.reasons.lonely).toBe("orphan");
    expect(s.ids).toContain("e399"); // stalest
  });

  it("normalizes titles for duplicate detection", () => {
    expect(normalizeTitleKey("  Memory—Palace!! ")).toBe("memory palace");
  });
});
