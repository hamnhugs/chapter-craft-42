import { describe, it, expect } from "vitest";
import { jacketLayout, titleDate } from "@/lib/bookJacket";

describe("generated jackets", () => {
  it("are stable for a book and differ between books", () => {
    const a = jacketLayout(12345, "#22d3ee");
    expect(jacketLayout(12345, "#22d3ee")).toEqual(a);
    const looks = new Set(Array.from({ length: 16 }, (_, i) => JSON.stringify(jacketLayout(i * 7919 + 1, "#22d3ee"))));
    expect(looks.size).toBe(16);
  });

  it("never centres the glyph", () => {
    for (let i = 0; i < 200; i++) {
      const left = parseFloat(jacketLayout(i * 104729, "#fff").glyph.left);
      expect(Math.abs(left - 50)).toBeGreaterThan(7);
    }
  });
});

describe("titleDate", () => {
  it("reads the filing dates the research shelves actually use", () => {
    expect(titleDate("2026-09 - What Drives Citations")).toBe("Sep 2026");
    expect(titleDate("2025-1- LLM-Generated Ads")).toBe("Jan 2025");
    expect(titleDate("2026 - AI Labels, Perceived Authenticity")).toBe("2026");
    expect(titleDate("2026-01 Mapping Morality in Marketing")).toBe("Jan 2026");
  });

  it("leaves ordinary titles alone", () => {
    expect(titleDate("The NEPQ Black Book Of Questions")).toBe(null);
    expect(titleDate("1984 is a novel")).toBe(null);
    expect(titleDate("1984 Revisited")).toBe(null);
    expect(titleDate("2026-13 - not a month")).toBe("2026");
  });
});
