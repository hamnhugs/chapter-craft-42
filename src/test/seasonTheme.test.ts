/**
 * The seasonal layer makes one promise the rest of the app depends on: it can
 * tint a theme but it cannot make anything harder to read. That promise is not
 * a matter of taste, so it is not tested by looking at it.
 *
 * The mechanism is that every transform happens in OKLCH with L pinned, and
 * OKLCH's L *is* perceptual lightness. The sweep below is what turns that from
 * an argument into a fact: all four themes, every day of the year, checking
 * that measured WCAG contrast against the theme's own background never falls
 * meaningfully below where the theme put it.
 *
 * The other thing under test is restraint. A seasonal palette that swapped
 * colours in would look striking and would destroy Desolate Lab, whose whole
 * premise is one signal hue in a grey facility. So the hue swing is bounded,
 * scaled per theme, and checked: Fruit Stripe is allowed to move several times
 * as far as Desolate Lab, and neither is allowed to become a different theme.
 */
import { describe, it, expect } from "vitest";
import { THEMES, getTheme } from "@/lib/themes";
import { seasonAt } from "@/lib/season";
import {
  coverGradient, hueArc, modulate, seasonalTheme, SEASONAL_TOKENS, SEASON_TUNING,
} from "@/lib/seasonTheme";
import { contrastRatio, hexToRgb, hslToRgb, hslTripletToOklch, parseHslTriplet } from "@/lib/oklch";

/** Every day of a year, so nothing can hide between sample points. */
const YEAR = Array.from({ length: 365 }, (_, d) => seasonAt(new Date(Date.UTC(2026, 0, 1 + d))));

const rgbOf = (triplet: string) => hslToRgb(parseHslTriplet(triplet)!);

describe("contrast is preserved, every theme, every day", () => {
  it("never drops accent contrast against the background by more than 5%", () => {
    for (const theme of THEMES) {
      const bg = rgbOf(theme.tokens["--background"]);
      const base = contrastRatio(rgbOf(theme.tokens["--accent"]), bg);
      for (const season of YEAR) {
        const got = contrastRatio(rgbOf(seasonalTheme(theme, season).vars["--accent"]), bg);
        expect(
          got / base,
          `${theme.id} on day ${Math.round(season.angle * 58)}: ${base.toFixed(2)} -> ${got.toFixed(2)}`,
        ).toBeGreaterThan(0.95);
        expect(got / base).toBeLessThan(1.1);
      }
    }
  });

  it("holds perceptual lightness of every modulated token to within a rounding step", () => {
    for (const theme of THEMES) {
      for (const season of YEAR) {
        const vars = seasonalTheme(theme, season).vars;
        for (const key of SEASONAL_TOKENS) {
          const before = hslTripletToOklch(theme.tokens[key]);
          const after = hslTripletToOklch(vars[key]);
          if (!before || !after) continue;
          // The only movement allowed is the 2-decimal rounding the theme
          // registry's HSL triplet format imposes on the way back out.
          expect(Math.abs(after.l - before.l), `${theme.id} ${key}`).toBeLessThan(0.005);
        }
      }
    }
  });

  it("refuses to touch the tokens that carry structure or body text", () => {
    // If a future edit adds --background or --foreground to the seasonal set,
    // the contrast guarantee above stops meaning anything. Fail loudly.
    const forbidden = [
      "--background", "--foreground", "--card", "--card-foreground", "--border",
      "--muted-foreground", "--on-surface-variant", "--popover", "--input",
      "--surface-container", "--surface-container-high", "--radius",
    ];
    for (const key of forbidden) {
      expect(SEASONAL_TOKENS as readonly string[]).not.toContain(key);
    }
    for (const theme of THEMES) {
      const vars = seasonalTheme(theme, YEAR[180]).vars;
      for (const key of forbidden) expect(Object.keys(vars)).not.toContain(key);
    }
  });
});

describe("restraint", () => {
  /** Total hue swing an accent makes across a whole year, in degrees. */
  const swingOf = (themeId: string) => {
    const theme = getTheme(themeId as never);
    const hues = YEAR.map((s) => hslTripletToOklch(seasonalTheme(theme, s).vars["--accent"])!.h);
    const base = hslTripletToOklch(theme.tokens["--accent"])!.h;
    return Math.max(...hues.map((h) => Math.abs(hueArc(base, h)))) * 2;
  };

  it("scales the swing by each theme's declared amplitude", () => {
    const fruit = swingOf("fruit-stripe");
    const desolate = swingOf("desolate-lab");
    const dexter = swingOf("dexters-lab");
    expect(desolate).toBeLessThan(fruit);
    expect(desolate).toBeLessThan(dexter);
    // Desolate Lab is one signal hue in a grey facility; it may breathe only.
    expect(desolate).toBeLessThan(16);
  });

  it("never rotates any theme past the declared cap", () => {
    for (const theme of THEMES) {
      expect(swingOf(theme.id) / 2).toBeLessThanOrEqual(SEASON_TUNING.maxDegrees + 0.01);
    }
  });

  it("is the identity when a theme opts out", () => {
    const base = { l: 0.6, c: 0.15, h: 200 };
    expect(modulate(base, YEAR[0], 0)).toEqual(base);
    const optedOut = { ...THEMES[0], seasonalAmplitude: 0 };
    const vars = seasonalTheme(optedOut, YEAR[0]).vars;
    for (const key of SEASONAL_TOKENS) {
      const a = hslTripletToOklch(optedOut.tokens[key])!;
      const b = hslTripletToOklch(vars[key])!;
      expect(Math.abs(hueArc(a.h, b.h))).toBeLessThan(0.5);
    }
  });

  it("keeps chroma non-negative and in gamut all year", () => {
    for (const theme of THEMES) {
      for (const season of YEAR) {
        for (const value of Object.entries(seasonalTheme(theme, season).vars)) {
          const [key, v] = value;
          if (!key.startsWith("--season-") && !SEASONAL_TOKENS.includes(key as never)) continue;
          const parsed = parseHslTriplet(v);
          if (!parsed) continue; // the numeric --season-* scalars
          expect(parsed.s).toBeGreaterThanOrEqual(0);
          expect(parsed.s).toBeLessThanOrEqual(100);
          expect(parsed.l).toBeGreaterThanOrEqual(0);
          expect(parsed.l).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe("what the season actually says", () => {
  it("drifts down in autumn and up in spring, on both sides of the planet", () => {
    const iso = new Date("2026-10-15T12:00:00Z");
    const north = seasonalTheme(THEMES[0], seasonAt(iso, "north"));
    const south = seasonalTheme(THEMES[0], seasonAt(iso, "south"));
    expect(north.drift).toBeGreaterThan(0);   // northern autumn: settling
    expect(south.drift).toBeLessThan(0);      // southern spring: rising
    expect(north.vars["--season-drift"]).toBe(north.drift.toFixed(3));
  });

  it("nearly stops the drift at the solstices", () => {
    const june = seasonalTheme(THEMES[0], seasonAt(new Date("2026-06-21T08:25:00Z")));
    expect(Math.abs(june.drift)).toBeLessThan(0.02);
  });

  it("leans warm in summer and cool in winter, relative to the theme's own accent", () => {
    for (const theme of THEMES.filter((t) => (t.seasonalAmplitude ?? 0) > 0.3)) {
      const base = hslTripletToOklch(theme.tokens["--accent"])!;
      const summer = hslTripletToOklch(seasonalTheme(theme, seasonAt(new Date("2026-07-26T12:00:00Z"))).vars["--accent"])!;
      const winter = hslTripletToOklch(seasonalTheme(theme, seasonAt(new Date("2026-01-28T12:00:00Z"))).vars["--accent"])!;
      // Summer moves toward amber, winter toward azure — from wherever the
      // theme started, not to some fixed seasonal hue.
      expect(Math.sign(hueArc(base.h, summer.h)), theme.id).toBe(Math.sign(hueArc(base.h, 70)));
      expect(Math.sign(hueArc(base.h, winter.h)), theme.id).toBe(Math.sign(hueArc(base.h, 250)));
    }
  });

  it("emits every variable the ambience and the stylesheet read", () => {
    const vars = seasonalTheme(THEMES[0], YEAR[100]).vars;
    for (const key of ["--season-glow", "--season-mote", "--season-haze", "--season-drift",
                       "--season-light", "--season-warmth", "--season-tempo", "--season-amplitude",
                       "--season-elevation", "--season-polarity", "--season-aurora"]) {
      expect(Object.keys(vars)).toContain(key);
    }
    for (const key of ["--season-drift", "--season-light", "--season-warmth", "--season-tempo",
                       "--season-elevation", "--season-polarity", "--season-aurora"]) {
      expect(Number.isFinite(Number(vars[key])), key).toBe(true);
    }
  });

  it("keeps motes visible on a light theme and on a near-black one", () => {
    const paper = THEMES.find((t) => t.id === "fruit-stripe")!;
    const facility = THEMES.find((t) => t.id === "desolate-lab")!;
    for (const theme of [paper, facility]) {
      const bg = rgbOf(theme.tokens["--background"]);
      for (const season of [YEAR[15], YEAR[195]]) {
        const mote = rgbOf(seasonalTheme(theme, season).vars["--season-mote"]);
        // Enough separation to see, not so much that ambience becomes content.
        const c = contrastRatio(mote, bg);
        expect(c, `${theme.id}`).toBeGreaterThan(1.6);
        expect(c).toBeLessThan(4.5);
      }
    }
  });
});

describe("placeholder covers", () => {
  it("gives a book the same cover regardless of its neighbours", () => {
    const glow = { l: 0.7, c: 0.15, h: 330 };
    // The grid seeds this from the array index, so a re-sort restains a book.
    // Seeded from the id hash, the same book is the same colour forever.
    expect(coverGradient(12345, glow, 0.11)).toEqual(coverGradient(12345, glow, 0.11));
    expect(coverGradient(12345, glow, 0.11)).not.toEqual(coverGradient(999, glow, 0.11));
  });

  it("produces real hex colours that sit near the canvas", () => {
    for (const theme of THEMES) {
      const bgL = hslTripletToOklch(theme.tokens["--background"])!.l;
      const glow = seasonalTheme(theme, YEAR[200]).glow;
      for (const seed of [1, 7777, 4242424]) {
        const [a, b] = coverGradient(seed, glow, bgL);
        expect(a).toMatch(/^#[0-9a-f]{6}$/);
        expect(b).toMatch(/^#[0-9a-f]{6}$/);
        // A cover is a surface, not a highlight: never far from the canvas.
        const contrast = contrastRatio(hexToRgb(a)!, rgbOf(theme.tokens["--background"]));
        expect(contrast, `${theme.id}`).toBeLessThan(3);
      }
    }
  });
});

describe("the light show's inputs", () => {
  it("rakes the light low in winter and puts it overhead in summer", () => {
    const winter = Number(seasonalTheme(THEMES[0], seasonAt(new Date("2026-12-21T20:50:00Z"))).vars["--season-elevation"]);
    const summer = Number(seasonalTheme(THEMES[0], seasonAt(new Date("2026-06-21T08:25:00Z"))).vars["--season-elevation"]);
    expect(winter).toBeGreaterThan(15);
    expect(winter).toBeLessThan(30);
    expect(summer).toBeGreaterThan(60);
    expect(summer).toBeLessThan(75);
    // And it passes through the horizon-neutral midpoint at the equinoxes.
    const equinox = Number(seasonalTheme(THEMES[0], seasonAt(new Date("2026-03-20T14:46:00Z"))).vars["--season-elevation"]);
    expect(equinox).toBeCloseTo(45, 0);
  });

  it("raises the curtains as the daylight falls, and never below zero", () => {
    for (let d = 0; d < 365; d++) {
      const a = Number(seasonalTheme(THEMES[0], YEAR[d]).vars["--season-aurora"]);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    const dec = Number(seasonalTheme(THEMES[0], seasonAt(new Date("2026-12-21T20:50:00Z"))).vars["--season-aurora"]);
    const jun = Number(seasonalTheme(THEMES[0], seasonAt(new Date("2026-06-21T08:25:00Z"))).vars["--season-aurora"]);
    expect(dec).toBeGreaterThan(0.95);
    expect(jun).toBe(0);
  });

  it("tells the canvas which way to composite, per theme", () => {
    const paper = THEMES.find((t) => t.id === "fruit-stripe")!;
    const facility = THEMES.find((t) => t.id === "desolate-lab")!;
    // Light added to paper reads as nothing; the show has to darken there.
    expect(seasonalTheme(paper, YEAR[10]).vars["--season-polarity"]).toBe("0");
    expect(seasonalTheme(facility, YEAR[10]).vars["--season-polarity"]).toBe("1");
  });
});
