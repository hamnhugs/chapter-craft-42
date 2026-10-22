import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BETA_AT, CALM_PATH, DL, DL_CONTRAST_PAIRS, HALF_LIFE_MS, HOT_PATH, TILE,
  bump, calmWave, contrast, decay, hotWave, labShift,
} from "@/components/themes/DextersLabSignal";
import { THEMES } from "@/lib/themes";

const CSS = readFileSync(resolve(__dirname, "../index.css"), "utf8");
const BLOCK = CSS.slice(CSS.indexOf("PRISMATIC LAB (Dexter's Lab)"), CSS.indexOf("BOOKWORM STUDIO"));

describe("Dexter's Lab palette", () => {
  it("clears WCAG AA on every text pair the skin sets", () => {
    for (const [fg, bg, min, what] of DL_CONTRAST_PAIRS) {
      expect(contrast(fg, bg), `${what}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("keeps the stylesheet's palette in step with the model", () => {
    const decl = (name: string) => BLOCK.match(new RegExp(`--dl-${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1]?.toLowerCase();
    expect(decl("ink")).toBe(DL.ink);
    expect(decl("night")).toBe(DL.night);
    expect(decl("surface")).toBe(DL.surface);
    expect(decl("on")).toBe(DL.on);
    expect(decl("dim")).toBe(DL.dim);
    expect(decl("pink")).toBe(DL.pink);
    expect(decl("violet-deep")).toBe(DL.violetDeep);
  });

  it("matches the theme tokens' canvas", () => {
    const theme = THEMES.find((t) => t.id === "dexters-lab")!;
    expect(theme.swatch[0]).toBe(DL.night);
    expect(theme.fonts?.display).toContain("Bungee");
  });

  it("keeps list rows out of the uppercase button treatment", () => {
    expect(BLOCK).toMatch(/button:not\(\[data-no-sticker\]\)[^{]*:not\(\.text-left\)\s*\{[^}]*text-transform: uppercase/);
  });

  it("freezes its motion under prefers-reduced-motion", () => {
    expect(BLOCK).toContain("prefers-reduced-motion: reduce");
    const art = readFileSync(resolve(__dirname, "../styles/themes/dexters-lab-art.css"), "utf8");
    expect(art).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^]*animation: none !important/);
  });
});

describe("lab lighting", () => {
  const at = (h: number) => new Date(2026, 9, 21, h, 30);
  it("is lit by day, half-lit at the edges, a secret lab after bedtime", () => {
    expect(labShift(at(12))).toBe("day");
    expect(labShift(at(7))).toBe("day");
    expect(labShift(at(6))).toBe("dusk");
    expect(labShift(at(18))).toBe("dusk");
    expect(labShift(at(21))).toBe("night");
    expect(labShift(at(2))).toBe("night");
  });
});

describe("brain energy", () => {
  it("climbs with activity and never passes 1", () => {
    let e = 0;
    e = bump(e, "pointer");
    expect(e).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) e = bump(e, "key");
    expect(e).toBe(1);
  });

  it("a burst of typing crosses into beta; a single scroll does not", () => {
    let e = 0;
    for (let i = 0; i < 6; i++) e = bump(e, "key");
    expect(e).toBeGreaterThanOrEqual(BETA_AT);
    expect(bump(0, "wheel")).toBeLessThan(BETA_AT);
  });

  it("halves every half-life and settles to exactly zero", () => {
    expect(decay(1, HALF_LIFE_MS)).toBeCloseTo(0.5, 5);
    expect(decay(1, 0)).toBe(1);
    expect(decay(1, -50)).toBe(1);
    expect(decay(1, HALF_LIFE_MS * 20)).toBe(0);
  });
});

describe("waveforms", () => {
  it("tile seamlessly, so the scrolling trace never shows a seam", () => {
    for (const fn of [calmWave, hotWave]) {
      expect(fn(0)).toBeCloseTo(fn(TILE), 6);
      expect(fn(1)).toBeCloseTo(fn(TILE + 1), 6);
    }
  });

  it("stay inside the scope's screen", () => {
    for (let x = 0; x < TILE; x += 1) {
      expect(Math.abs(calmWave(x))).toBeLessThan(20);
      expect(Math.abs(hotWave(x))).toBeLessThan(20);
    }
  });

  it("span two tiles", () => {
    for (const d of [CALM_PATH, HOT_PATH]) {
      expect(d.startsWith("M0 ")).toBe(true);
      expect(d).toContain(`L${TILE * 2} `);
    }
  });
});
