import { describe, expect, it } from "vitest";
import {
  auroraState, brightestBackdrop, contrast, dayLength, equinoxFactor, nightlyKp, overrideDate,
  type RGB,
} from "@/components/themes/auroraSky";
import { THEMES } from "@/lib/themes";
import { hslToRgb, parseHslTriplet } from "@/lib/oklch";

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const tokenRgb = (triplet: string): RGB => {
  const { r, g, b } = hslToRgb(parseHslTriplet(triplet)!);
  return [r, g, b].map((v) => Math.round(v * 255)) as RGB;
};
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min);

describe("auroraState", () => {
  it("is daylight at noon with only the faint day shimmer", () => {
    const s = auroraState(at(10, 21, 13));
    expect(s.phase).toBe("day");
    expect(s.strength).toBeCloseTo(0.16, 2);
    expect(s.crown).toBe(0);
  });
  it("is night at 23:30 and brighter than early evening", () => {
    const late = auroraState(at(10, 21, 23, 30), "north", 5);
    const early = auroraState(at(10, 21, 20, 0), "north", 5);
    expect(late.phase).toBe("night");
    expect(late.strength).toBeGreaterThan(early.strength);
  });
  it("a quiet night never grows a red crown; a storm does", () => {
    expect(auroraState(at(9, 22, 23, 30), "north", 2).crown).toBe(0);
    expect(auroraState(at(9, 22, 23, 30), "north", 8).crown).toBeGreaterThan(0.5);
  });
  it("equinox nights burn brighter than solstice nights", () => {
    expect(equinoxFactor(80)).toBeCloseTo(1, 2);
    expect(equinoxFactor(172)).toBeLessThan(0.85);
  });
  it("summer days are long in the north and short in the south", () => {
    expect(dayLength(172, "north")).toBeGreaterThan(15);
    expect(dayLength(172, "south")).toBeLessThan(9);
    // A July 21:00 is still twilight up north, already night down south.
    expect(auroraState(at(7, 1, 21), "north").night).toBeLessThan(auroraState(at(7, 1, 21), "south").night);
  });
  it("keeps the same Kp all night, small hours included", () => {
    expect(nightlyKp(at(3, 4, 22))).toBe(nightlyKp(at(3, 5, 3)));
    for (let d = 1; d < 60; d++) {
      const kp = nightlyKp(at(1, d, 23));
      expect(kp).toBeGreaterThanOrEqual(1);
      expect(kp).toBeLessThanOrEqual(8);
    }
  });
  it("parses preview overrides", () => {
    expect(overrideDate("night")!.getHours()).toBe(23);
    expect(overrideDate("day")!.getHours()).toBe(13);
    expect(overrideDate(null)).toBeNull();
    expect(overrideDate("garbage")).toBeNull();
  });
});

describe("header text over a full-storm aurora (WCAG AA)", () => {
  const worst = brightestBackdrop(1, "text");
  // Wordmark "Chapter", inactive nav (secondary token), icons/accent chip,
  // and every stop of the "Craft" gradient.
  const texts: Record<string, string> = {
    frost: "#f2f5fc",
    navMist: "secondary",
    green: "#6ff0c0",
    craftMint: "#c9fbe6",
    craftIce: "#b8f0ff",
    craftViolet: "#e0d6ff",
    craftRose: "#ffd6e4",
  };
  for (const [name, c] of Object.entries(texts)) {
    it(`${name} keeps 4.5:1`, () => {
      const fg = c === "secondary" ? tokenRgb(THEMES.find((t) => t.id === "aurora")!.tokens["--secondary"]) : hex(c);
      expect(contrast(fg, worst)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("aurora tokens (WCAG AA)", () => {
  const tok = THEMES.find((t) => t.id === "aurora")!.tokens;
  const c = (k: string) => tokenRgb(tok[k]);
  const pairs: [string, string][] = [
    ["--foreground", "--background"],
    ["--card-foreground", "--card"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--card"],
    ["--accent", "--background"],
    ["--accent-foreground", "--accent"],
    ["--primary-foreground", "--primary"],
    ["--secondary-foreground", "--secondary"],
    ["--destructive-foreground", "--destructive"],
    ["--on-primary-container", "--primary-container"],
    ["--on-secondary-container", "--secondary-container"],
    ["--on-error-container", "--error-container"],
    ["--on-surface-variant", "--surface-container-high"],
  ];
  for (const [fg, bg] of pairs) {
    it(`${fg} on ${bg}`, () => expect(contrast(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5));
  }
});
