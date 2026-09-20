/**
 * The OKLCH math in src/lib/oklch.ts is hand-rolled, and hand-rolled colour
 * math is worth exactly as much as its verification. The repo already depends
 * on culori; it is kept out of the bundle behind dynamic imports, but a test
 * run can import it freely. So every transform here is checked against culori
 * rather than against numbers this file made up.
 *
 * What these lock down:
 *  - conversions round-trip and match a reference implementation
 *  - gamut mapping reduces chroma and never lightness (the entire safety
 *    argument for the seasonal layer rests on lightness being immovable)
 *  - the bare "H S% L%" triplet format the theme registry stores parses and
 *    re-emits losslessly enough to survive a round trip
 */
import { describe, it, expect } from "vitest";
import {
  clampToSrgb, contrastRatio, formatHslTriplet, hexToRgb, hslToRgb,
  hslTripletToOklch, inSrgbGamut, oklchToHslTriplet, oklchToRgb,
  parseHslTriplet, relativeLuminance, rgbToHsl, rgbToOklch,
} from "@/lib/oklch";
import { converter, clampChroma, wcagContrast, wcagLuminance } from "culori";

const toOklch = converter("oklch");
const toRgbC = converter("rgb");

/** Deterministic spread of colours, so a failure is always reproducible. */
function sampleColors(n: number): string[] {
  let a = 12345;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  return Array.from({ length: n }, () =>
    "#" + Array.from({ length: 3 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join(""));
}

describe("rgb <-> oklch", () => {
  it("matches culori across 200 colours", () => {
    for (const hex of sampleColors(200)) {
      const rgb = hexToRgb(hex)!;
      const mine = rgbToOklch(rgb);
      const ref = toOklch(hex)!;
      expect(mine.l).toBeCloseTo(ref.l, 6);
      expect(mine.c).toBeCloseTo(ref.c, 6);
      // Hue is meaningless when there is no chroma to have a hue of.
      if (ref.c > 1e-4) {
        const arc = Math.abs(((mine.h - (ref.h ?? 0) + 540) % 360) - 180);
        expect(arc).toBeLessThan(1e-3);
      }
    }
  });

  it("round-trips back to the same rgb", () => {
    // 5 decimals, not 6: the forward and inverse both go through cbrt/pow, and
    // the residual lands around 5e-7 — roughly a seven-thousandth of one 8-bit
    // step, so it cannot survive quantization to a real colour channel.
    for (const hex of sampleColors(200)) {
      const rgb = hexToRgb(hex)!;
      const back = oklchToRgb(rgbToOklch(rgb));
      expect(back.r).toBeCloseTo(rgb.r, 5);
      expect(back.g).toBeCloseTo(rgb.g, 5);
      expect(back.b).toBeCloseTo(rgb.b, 5);
    }
  });

  it("pins hue to 0 for achromatic colours instead of leaving it to atan2", () => {
    expect(rgbToOklch({ r: 0.5, g: 0.5, b: 0.5 }).h).toBe(0);
    expect(rgbToOklch({ r: 0, g: 0, b: 0 }).h).toBe(0);
  });
});

describe("gamut mapping", () => {
  it("holds lightness and hue exactly, sacrificing only chroma", () => {
    // Deliberately impossible: maximum chroma at a mid lightness.
    for (const h of [0, 60, 120, 180, 240, 300]) {
      const wanted = { l: 0.6, c: 0.4, h };
      const got = clampToSrgb(wanted);
      expect(got.l).toBe(wanted.l);
      expect(got.h).toBe(wanted.h);
      expect(got.c).toBeLessThan(wanted.c);
      expect(inSrgbGamut(oklchToRgb(got))).toBe(true);
    }
  });

  it("leaves in-gamut colours untouched", () => {
    const inside = { l: 0.5, c: 0.02, h: 200 };
    expect(clampToSrgb(inside)).toEqual(inside);
  });

  it("lands within a hair of culori's clampChroma", () => {
    for (const h of [10, 95, 175, 260, 330]) {
      const mine = clampToSrgb({ l: 0.7, c: 0.4, h });
      const ref = toOklch(clampChroma({ mode: "oklch", l: 0.7, c: 0.4, h }, "oklch"))!;
      expect(mine.c).toBeCloseTo(ref.c, 2);
    }
  });
});

describe("hsl triplets — the format the theme registry stores", () => {
  it("parses the registry's real values", () => {
    expect(parseHslTriplet("265 61% 11%")).toEqual({ h: 265, s: 61, l: 11 });
    expect(parseHslTriplet(" 0 0% 100% ")).toEqual({ h: 0, s: 0, l: 100 });
    expect(parseHslTriplet("331 100% 45%")).toEqual({ h: 331, s: 100, l: 45 });
  });

  it("rejects anything that is not one", () => {
    for (const bad of ["", "not a color", "#fff", "hsl(1,2%,3%)", "265 61 11"]) {
      expect(parseHslTriplet(bad)).toBeNull();
    }
  });

  it("round-trips triplet -> oklch -> triplet without visible drift", () => {
    for (const t of ["265 61% 11%", "355 78% 56%", "44 86% 66%", "8 40% 49%", "220 30% 95%"]) {
      const back = oklchToHslTriplet(hslTripletToOklch(t)!);
      const a = parseHslTriplet(t)!, b = parseHslTriplet(back)!;
      expect(Math.abs(((a.h - b.h + 540) % 360) - 180)).toBeLessThan(0.5);
      expect(b.s).toBeCloseTo(a.s, 0);
      expect(b.l).toBeCloseTo(a.l, 0);
    }
  });

  it("agrees with culori on hsl -> rgb", () => {
    for (const t of ["265 61% 11%", "44 86% 66%", "184 100% 49%"]) {
      const { h, s, l } = parseHslTriplet(t)!;
      const ref = toRgbC(`hsl(${h} ${s}% ${l}%)`)!;
      const mine = hslToRgb({ h, s, l });
      expect(mine.r).toBeCloseTo(ref.r, 5);
      expect(mine.g).toBeCloseTo(ref.g, 5);
      expect(mine.b).toBeCloseTo(ref.b, 5);
    }
  });

  it("rgbToHsl inverts hslToRgb", () => {
    for (const t of ["265 61% 11%", "44 86% 66%", "0 0% 7%", "48 33% 97%"]) {
      const hsl = parseHslTriplet(t)!;
      const back = rgbToHsl(hslToRgb(hsl));
      if (hsl.s > 0.5) expect(Math.abs(((back.h - hsl.h + 540) % 360) - 180)).toBeLessThan(0.01);
      expect(back.s).toBeCloseTo(hsl.s, 4);
      expect(back.l).toBeCloseTo(hsl.l, 4);
    }
  });

  it("formats within the ranges CSS accepts", () => {
    expect(formatHslTriplet({ h: 400, s: 150, l: -20 })).toBe("40 100% 0%");
  });
});

describe("wcag contrast", () => {
  it("matches culori's luminance and contrast", () => {
    for (const hex of sampleColors(60)) {
      expect(relativeLuminance(hexToRgb(hex)!)).toBeCloseTo(wcagLuminance(hex), 6);
    }
    for (const hex of sampleColors(30)) {
      expect(contrastRatio(hexToRgb(hex)!, hexToRgb("#ffffff")!)).toBeCloseTo(wcagContrast(hex, "#ffffff"), 5);
    }
  });

  it("is symmetric and bounded by black on white", () => {
    const w = { r: 1, g: 1, b: 1 }, k = { r: 0, g: 0, b: 0 };
    expect(contrastRatio(w, k)).toBeCloseTo(21, 5);
    expect(contrastRatio(k, w)).toBeCloseTo(21, 5);
  });
});
