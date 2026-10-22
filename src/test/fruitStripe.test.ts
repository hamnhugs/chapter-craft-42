import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEMES } from "@/lib/themes";
import { seasonAt } from "@/lib/season";
import { seasonalTheme } from "@/lib/seasonTheme";
import { contrastRatio, hexToRgb, hslToRgb, parseHslTriplet } from "@/lib/oklch";
import {
  FLAVORS, STRIPE, currentHour, flavorAtHour, wrapperAt, wrapperStripes,
} from "@/components/themes/fruitStripeClock";

const theme = THEMES.find((t) => t.id === "fruit-stripe")!;
const tok = (k: string) => hslToRgb(parseHslTriplet(theme.tokens[k])!);
const hex = (h: string) => hexToRgb(h)!;

describe("Fruit Stripe — flavour of the hour", () => {
  it("runs the day lemon → lime → tangerine → cherry → melon", () => {
    expect(flavorAtHour(7).id).toBe("lemon");
    expect(flavorAtHour(12).id).toBe("lime");
    expect(flavorAtHour(15.5).id).toBe("tangerine");
    expect(flavorAtHour(19).id).toBe("cherry");
    expect(flavorAtHour(23).id).toBe("melon");
    // melon carries past midnight until lemon at 5am
    expect(flavorAtHour(0).id).toBe("melon");
    expect(flavorAtHour(4.99).id).toBe("melon");
    expect(flavorAtHour(5).id).toBe("lemon");
  });

  it("walks the starburst left to right through the wrapper day, 5am to 5am", () => {
    expect(wrapperAt(5).progress).toBeCloseTo(0);
    expect(wrapperAt(17).progress).toBeCloseTo(0.5);
    expect(wrapperAt(4.5).progress).toBeGreaterThan(0.97);
    for (let h = 0; h < 24; h += 0.25) {
      const p = wrapperAt(h).progress;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("prints the lead flavour first and keeps all five", () => {
    const w = wrapperAt(19);
    expect(w.order[0].id).toBe("cherry");
    expect(new Set(w.order.map((f) => f.id)).size).toBe(5);
    expect(w.night).toBe(false);
    expect(wrapperAt(23).night).toBe(true);
  });

  it("drifts by exactly one horizontal period so the loop is seamless", () => {
    const { period, background } = wrapperStripes(wrapperAt(12).order);
    const along = STRIPE.band * 6 + STRIPE.gap * 5; // lead is double-width
    expect(period).toBeCloseTo(along / Math.sin((STRIPE.angle * Math.PI) / 180), 2);
    expect(background).toMatch(/^repeating-linear-gradient\(118deg, #D6EDD0 0px 26px/);
  });

  it("honours the preview override and otherwise reads the local clock", () => {
    expect(currentHour(new Date(), "?fsHour=8.5")).toBe(8.5);
    expect(currentHour(new Date(2026, 9, 21, 14, 30), "")).toBe(14.5);
  });
});

describe("Fruit Stripe — every text pair clears WCAG AA", () => {
  const paper = tok("--background");
  it("tokens", () => {
    expect(contrastRatio(tok("--foreground"), paper)).toBeGreaterThan(15);
    expect(contrastRatio(tok("--muted-foreground"), paper)).toBeGreaterThan(7);
    // cherry ink as text on paper and under white
    expect(contrastRatio(tok("--primary"), paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tok("--primary-foreground"), tok("--primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tok("--on-primary-container"), tok("--primary-container"))).toBeGreaterThanOrEqual(4.5);
    // burnt tangerine accent, used as text ~40 times
    expect(contrastRatio(tok("--accent"), paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tok("--accent-foreground"), tok("--accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tok("--primary"), tok("--surface-container-highest"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the accent stays readable as the season swings it (amplitude 1)", () => {
    for (let d = 0; d < 365; d += 3) {
      const season = seasonAt(new Date(Date.UTC(2026, 0, 1 + d)));
      const a = hslToRgb(parseHslTriplet(seasonalTheme(theme, season).vars["--accent"])!);
      expect(contrastRatio(a, paper), `day ${d}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tok("--accent-foreground"), a), `day ${d}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("skin: ink on every printed tint, the header icons on them, pencil on paper", () => {
    for (const f of FLAVORS) {
      expect(contrastRatio(hex("#111111"), hex(f.tint)), f.id).toBeGreaterThan(13);
      expect(contrastRatio(hex("#2A2A2A"), hex(f.tint)), f.id).toBeGreaterThan(10);
      // cherry-ink icons over the wrapper are non-text: 3:1
      expect(contrastRatio(hex("#C11F2D"), hex(f.tint)), f.id).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(hex("#5C5A55"), hex("#FBFAF6"))).toBeGreaterThan(6);
    expect(contrastRatio(hex("#111111"), hex("#F4C95D"))).toBeGreaterThan(11); // 5 FLAVORS tag, selection
    expect(contrastRatio(hex("#6B6862"), hex("#FFFFFF"))).toBeGreaterThanOrEqual(4.5); // placeholders
  });
});

describe("Fruit Stripe — skin contract", () => {
  const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
  const block = css.slice(css.indexOf("FRUIT STRIPE THEME"), css.indexOf("PRISMATIC LAB"));
  it("keeps the .prose measure other code depends on", () => {
    expect(block).toContain('[data-theme="fruit-stripe"] .prose');
    expect(block).toContain("max-width: 68ch");
  });
  it("freezes its motion under prefers-reduced-motion", () => {
    expect(block).toMatch(/prefers-reduced-motion: reduce/);
    const art = readFileSync(resolve(__dirname, "../styles/themes/fruit-stripe-art.css"), "utf8");
    expect(art).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });
  it("respects data-no-sticker on general buttons", () => {
    expect(block).toContain("button:not([data-no-sticker])");
  });
});
