import { describe, it, expect } from "vitest";
import {
  computeVibrancy,
  rankAnchorCandidates,
  VIBRANCY_FLOOR,
} from "../../supabase/functions/_shared/memory-layers.ts";

const DAY = 86400;

// The sanity table documented in memory-layers.ts and in migration
// 20260917130300_vibrancy_idle_days.sql (rerank_vibrancy is the SQL twin).
const TABLE: Array<[number, number[]]> = [
  [0,  [1.00, 1.00, 0.98, 0.87, 0.55, 0.33, 0.21, 0.11]],
  [1,  [1.00, 1.00, 0.99, 0.92, 0.70, 0.50, 0.36, 0.18]],
  [3,  [1.00, 1.00, 0.99, 0.94, 0.77, 0.60, 0.48, 0.26]],
  [10, [1.00, 1.00, 0.99, 0.96, 0.83, 0.70, 0.59, 0.36]],
  [30, [1.00, 1.00, 1.00, 0.97, 0.87, 0.76, 0.66, 0.45]],
];
const IDLE = [0, 3600, DAY, 7 * DAY, 30 * DAY, 60 * DAY, 90 * DAY, 180 * DAY];

describe("computeVibrancy", () => {
  it("matches the documented sanity table", () => {
    for (const [n, row] of TABLE) {
      row.forEach((expected, i) => {
        // table is rounded to 2 dp
        expect(Math.abs(computeVibrancy(n, IDLE[i]) - expected)).toBeLessThanOrEqual(0.0051);
      });
    }
  });

  it("has a true 30-day half-life above the floor for an unused node", () => {
    const above = (s: number) => computeVibrancy(0, s) - VIBRANCY_FLOOR;
    expect(above(30 * DAY) / above(0)).toBeCloseTo(0.5, 6);
    expect(above(60 * DAY) / above(0)).toBeCloseTo(0.25, 6);
  });

  it("keeps fresh nodes above the core threshold (the old formula scored 0.115 after an hour)", () => {
    expect(computeVibrancy(0, 3600)).toBeGreaterThan(0.7);
    expect(computeVibrancy(10, DAY)).toBeGreaterThan(0.7);
  });

  it("is monotone: more idle → lower, more use → higher", () => {
    expect(computeVibrancy(0, 10 * DAY)).toBeGreaterThan(computeVibrancy(0, 20 * DAY));
    expect(computeVibrancy(5, 40 * DAY)).toBeGreaterThan(computeVibrancy(1, 40 * DAY));
    expect(computeVibrancy(0, 10_000 * DAY)).toBeCloseTo(VIBRANCY_FLOOR, 6);
  });
});

describe("rankAnchorCandidates", () => {
  it("drops unrelated nodes regardless of vibrancy and prefers similarity", () => {
    const ranked = rankAnchorCandidates([
      { id: "vivid-unrelated", similarity: 0.1, vibrancy: 1 },
      { id: "close-dim", similarity: 0.9, vibrancy: 0.2 },
      { id: "ok-vivid", similarity: 0.6, vibrancy: 1 },
      { id: "self", similarity: 0.99, vibrancy: 1 },
    ], { excludeId: "self" });
    expect(ranked.map((r) => r.id)).toEqual(["close-dim", "ok-vivid"]);
  });
});
