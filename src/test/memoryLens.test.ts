import { describe, it, expect } from "vitest";
import { lensVerdict, RESHOW_AFTER_DAYS, type RecallState } from "@/lib/memoryLens";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

const state = (over: Partial<RecallState> = {}): RecallState => ({
  shownCount: 0,
  lastShownAt: null,
  lastSession: null,
  suppressed: false,
  fromDb: true,
  ...over,
});

describe("Memory Lens display policy", () => {
  it("unknown state fails closed to a chip — never auto-expands", () => {
    expect(lensVerdict(null, true)).toBe("chip");
  });

  it("never-seen auto-expands (the whole point)", () => {
    expect(lensVerdict(state(), true)).toBe("expand");
  });

  it("auto-show toggle off demotes every expand to a chip", () => {
    expect(lensVerdict(state(), false)).toBe("chip");
  });

  it("seen recently collapses to a chip", () => {
    expect(lensVerdict(state({ shownCount: 1, lastShownAt: daysAgo(2) }), true)).toBe("chip");
  });

  it("re-expands after the novelty window — no lifetime cap", () => {
    expect(lensVerdict(state({ shownCount: 7, lastShownAt: daysAgo(RESHOW_AFTER_DAYS + 1) }), true)).toBe("expand");
  });

  it("suppression hides entirely, regardless of everything else", () => {
    expect(lensVerdict(state({ suppressed: true }), true)).toBe("hide");
    expect(lensVerdict(state({ suppressed: true, shownCount: 9, lastShownAt: daysAgo(400) }), true)).toBe("hide");
  });

  it("a corrupt timestamp counts as long-ago (expand rather than stuck-chip)", () => {
    expect(lensVerdict(state({ shownCount: 1, lastShownAt: "not-a-date" }), true)).toBe("expand");
  });
});
