import { describe, expect, it } from "vitest";
import { sizeFor, sizeForDimensions } from "@/lib/localImageGen";

const parse = (s: string) => s.split("x").map(Number) as [number, number];

describe("sizeForDimensions (local edits keep the input's shape)", () => {
  it("keeps a square input at 512x512", () => {
    expect(sizeForDimensions(1024, 1024)).toBe("512x512");
  });

  it("keeps a wide input wide and a tall one tall", () => {
    const [w, h] = parse(sizeForDimensions(1920, 1080));
    expect(w).toBeGreaterThan(h);
    expect(w / h).toBeCloseTo(16 / 9, 1);
    const [tw, th] = parse(sizeForDimensions(800, 1200));
    expect(th).toBeGreaterThan(tw);
  });

  it("stays near 512x512's pixel count, in multiples of 32", () => {
    for (const [iw, ih] of [[1920, 1080], [300, 200], [4000, 3000], [640, 1600]]) {
      const [w, h] = parse(sizeForDimensions(iw, ih));
      expect(w % 32).toBe(0);
      expect(h % 32).toBe(0);
      expect(w * h).toBeGreaterThan(0.8 * 512 * 512);
      expect(w * h).toBeLessThan(1.2 * 512 * 512);
    }
  });

  it("clamps extreme ratios and falls back on bad input", () => {
    const [w, h] = parse(sizeForDimensions(10000, 100));
    expect(w).toBeLessThanOrEqual(1024);
    expect(h).toBeGreaterThanOrEqual(256);
    expect(sizeForDimensions(0, 0)).toBe(sizeFor());
  });
});
