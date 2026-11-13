/**
 * The Scriptorium is the one theme with a clock that changes the whole
 * palette and a light that lies over the text, so there are two promises
 * here that no other theme has to make:
 *
 *  1. Each face is a complete theme. It is switched to, never blended into,
 *     and every text pair clears WCAG AA on it — in every week of the year,
 *     because the season tints whichever face is showing.
 *  2. The light never costs the reader the text. Sun through the window, the
 *     amber of the golden hour and the dark beyond the candle are all laid
 *     OVER the ink; each is composited here at its strongest and the
 *     faintest ink in the theme has to survive it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANDLE_MARGIN, hoursAt, LIGHT, moonPhase, officesFor, overrideHours, type RGB,
} from "@/components/themes/scriptoriumHours";
import { faceTokens, getTheme } from "@/lib/themes";
import { seasonAt } from "@/lib/season";
import { seasonalTheme } from "@/lib/seasonTheme";
import { contrastRatio, hslToRgb, parseHslTriplet } from "@/lib/oklch";

const theme = getTheme("scriptorium");
const FACES = Object.keys(theme.living!.faces);
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min);
const css = readFileSync(resolve(__dirname, "../styles/themes/scriptorium.css"), "utf8");

const rgbOf = (triplet: string): RGB => {
  const { r, g, b } = hslToRgb(parseHslTriplet(triplet)!);
  return [r * 255, g * 255, b * 255];
};
/** `over` laid on `under` at `alpha`, in sRGB as the compositor does it. */
const lay = (under: RGB, over: RGB, alpha: number): RGB =>
  under.map((c, i) => c * (1 - alpha) + over[i] * alpha) as RGB;
const ratio = (a: RGB, b: RGB) =>
  contrastRatio({ r: a[0] / 255, g: a[1] / 255, b: a[2] / 255 }, { r: b[0] / 255, g: b[1] / 255, b: b[2] / 255 });

/** [ink, ground] pairs that carry text, and the least each may measure. */
const PAIRS: [string, string, number][] = [
  ["--foreground", "--background", 7],
  ["--foreground", "--card", 7],
  ["--card-foreground", "--card", 7],
  ["--popover-foreground", "--popover", 7],
  ["--muted-foreground", "--background", 4.5],
  ["--muted-foreground", "--card", 4.5],
  ["--muted-foreground", "--surface-container-highest", 4.5],
  ["--on-surface-variant", "--surface-container-highest", 4.5],
  ["--primary", "--background", 4.5],
  ["--primary-foreground", "--primary", 4.5],
  ["--accent", "--background", 4.5],
  ["--accent", "--card", 4.5],
  ["--accent-foreground", "--accent", 4.5],
  ["--destructive", "--background", 4.5],
  ["--destructive-foreground", "--destructive", 4.5],
  ["--on-primary-container", "--primary-container", 4.5],
  ["--on-secondary-container", "--secondary-container", 4.5],
  ["--on-error-container", "--error-container", 4.5],
  ["--tertiary", "--background", 4.5],
  ["--sidebar-foreground", "--sidebar-background", 7],
];

describe("the horarium", () => {
  it("is daylight at noon and candle at night, all year", () => {
    for (const month of [1, 4, 7, 10]) {
      expect(hoursAt(at(month, 15, 12, 30)).face).toBe("day");
      expect(hoursAt(at(month, 15, 23)).face).toBe("night");
      expect(hoursAt(at(month, 15, 3)).face).toBe("night");
    }
  });

  it("lights the candle just after sunset and snuffs it just before sunrise", () => {
    const noon = hoursAt(at(10, 21, 12));
    const before = new Date(2026, 9, 21); before.setMinutes(Math.round((noon.sunset + CANDLE_MARGIN) * 60) - 2);
    const after = new Date(2026, 9, 21); after.setMinutes(Math.round((noon.sunset + CANDLE_MARGIN) * 60) + 2);
    expect(hoursAt(before).face).toBe("day");
    expect(hoursAt(after).face).toBe("night");
    const dawn = new Date(2026, 9, 21); dawn.setMinutes(Math.round((noon.sunrise - CANDLE_MARGIN) * 60) + 2);
    expect(hoursAt(dawn).face).toBe("day");
  });

  it("changes face exactly twice a day — a switch, not a flicker", () => {
    for (const [m, d] of [[1, 10], [3, 20], [6, 21], [9, 22], [12, 21]]) {
      let flips = 0;
      let last = hoursAt(at(m, d, 0, 0)).face;
      for (let min = 1; min < 1440; min++) {
        const f = hoursAt(at(m, d, 0, min)).face;
        if (f !== last) flips++;
        last = f;
      }
      expect(flips, `${m}/${d}`).toBe(2);
    }
  });

  it("keeps longer days in summer, and flips them for the south", () => {
    const june = hoursAt(at(6, 21, 12));
    const december = hoursAt(at(12, 21, 12));
    expect(june.sunset - june.sunrise).toBeGreaterThan(15);
    expect(december.sunset - december.sunrise).toBeLessThan(9);
    // 20:00 in June: still working by the window up north, by candle down south.
    expect(hoursAt(at(6, 21, 20), "north").face).toBe("day");
    expect(hoursAt(at(6, 21, 20), "south").face).toBe("night");
  });

  it("goes amber toward the candle and is clear at midday and at night", () => {
    const noon = hoursAt(at(10, 21, 12, 30));
    expect(noon.golden).toBe(0);
    const late = new Date(2026, 9, 21); late.setMinutes(Math.round((noon.sunset + CANDLE_MARGIN) * 60) - 3);
    expect(hoursAt(late).golden).toBeGreaterThan(0.95);
    expect(hoursAt(at(10, 21, 23)).golden).toBe(0);
    // Deepest exactly as the face changes, so the turn is from amber to candle.
    let prev = 0;
    for (let min = Math.round((noon.sunset - 1.3) * 60); min < Math.round((noon.sunset + CANDLE_MARGIN) * 60); min += 5) {
      const d = new Date(2026, 9, 21); d.setMinutes(min);
      const g = hoursAt(d).golden;
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });

  it("keeps the eight offices, in order, by the sun rather than the clock", () => {
    const summer = officesFor(4.7, 20.3);
    const winter = officesFor(8.3, 16.7);
    for (const offices of [summer, winter]) {
      expect(offices.map((o) => o.id)).toEqual(["matins", "lauds", "prime", "terce", "sext", "none", "vespers", "compline"]);
      for (let i = 1; i < offices.length; i++) expect(offices[i].at).toBeGreaterThan(offices[i - 1].at);
      expect(offices[offices.length - 1].at).toBeLessThan(24);
    }
    // Temporal hours: Terce is three-twelfths of the DAY after sunrise, so it
    // falls later by the clock in winter and Sext is solar noon in both.
    expect(winter[3].at).toBeGreaterThan(summer[3].at);
    expect(summer[4].at).toBeCloseTo(winter[4].at, 5);
    expect(hoursAt(at(10, 21, 12, 45)).office.id).toBe("sext");
    expect(hoursAt(at(10, 21, 1)).office.id).toBe("matins");
    expect(hoursAt(at(10, 21, 22)).office.id).toBe("compline");
  });

  it("burns the candle down from dusk to dawn and never relights it", () => {
    const dusk = hoursAt(at(10, 21, 19));
    const midnight = hoursAt(at(10, 22, 0, 30));
    const small = hoursAt(at(10, 22, 5));
    expect(dusk.candle).toBeGreaterThan(midnight.candle);
    expect(midnight.candle).toBeGreaterThan(small.candle);
    expect(small.candle).toBeGreaterThanOrEqual(0);
    expect(hoursAt(at(10, 22, 12)).candle).toBe(1);
  });

  it("grows the vine from midnight to midnight", () => {
    expect(hoursAt(at(10, 21, 0, 0)).dayFrac).toBe(0);
    expect(hoursAt(at(10, 21, 12, 0)).dayFrac).toBeCloseTo(0.5, 5);
    expect(hoursAt(at(10, 21, 23, 59)).dayFrac).toBeLessThan(1);
  });

  it("knows the moon", () => {
    // Two total solar eclipses (a new moon by definition) and a full moon.
    // A mean synodic month, so right to within a day — plenty for a 14px disc.
    const near = (phase: number, want: number) => Math.min(Math.abs(phase - want), 1 - Math.abs(phase - want));
    expect(near(moonPhase(new Date(Date.UTC(2017, 7, 21, 18, 30))), 0)).toBeLessThan(0.03);
    expect(near(moonPhase(new Date(Date.UTC(2024, 3, 8, 18, 21))), 0)).toBeLessThan(0.03);
    expect(near(moonPhase(new Date(Date.UTC(2024, 0, 25, 17, 54))), 0.5)).toBeLessThan(0.03);
  });

  it("parses preview overrides", () => {
    expect(hoursAt(overrideHours("day")!).face).toBe("day");
    expect(hoursAt(overrideHours("night")!).face).toBe("night");
    expect(hoursAt(overrideHours("dusk")!).golden).toBeGreaterThan(0.5);
    expect(overrideHours("14:30")!.getHours()).toBe(14);
    expect(overrideHours("14:30")!.getMinutes()).toBe(30);
    expect(overrideHours(null)).toBeNull();
    expect(overrideHours("garbage")).toBeNull();
  });
});

describe("each face is a whole theme (WCAG AA)", () => {
  it("has a daylight face and a candle face, and they are opposites", () => {
    expect(FACES).toEqual(["day", "night"]);
    const day = rgbOf(faceTokens(theme, "day")["--background"]);
    const night = rgbOf(faceTokens(theme, "night")["--background"]);
    expect(ratio(day, [0, 0, 0])).toBeGreaterThan(14);   // a light ground
    expect(ratio(night, [255, 255, 255])).toBeGreaterThan(14); // a dark one
    // An unknown face is the base face, never a half-applied one.
    expect(faceTokens(theme, "dusk")).toBe(theme.tokens);
    expect(faceTokens(theme, null)).toBe(theme.tokens);
  });

  it("the candle face restates every colour the daylight face sets", () => {
    // A token left out of the night face would keep its daylight value: ink-
    // coloured text on a near-black ground.
    const colours = Object.keys(theme.tokens).filter((k) => k !== "--radius");
    for (const key of colours) expect(theme.living!.faces.night.tokens, key).toHaveProperty(key);
  });

  for (const face of FACES) {
    it(`${face}: every text pair clears its bar`, () => {
      const t = faceTokens(theme, face);
      for (const [ink, ground, least] of PAIRS) {
        const got = ratio(rgbOf(t[ink]), rgbOf(t[ground]));
        expect(got, `${face} ${ink} on ${ground}: ${got.toFixed(2)}`).toBeGreaterThanOrEqual(least);
      }
    });

    it(`${face}: the season never takes the accent below AA`, () => {
      const worn = { ...theme, tokens: faceTokens(theme, face) };
      const bg = rgbOf(worn.tokens["--background"]);
      const card = rgbOf(worn.tokens["--card"]);
      for (let d = 0; d < 365; d += 3) {
        const vars = seasonalTheme(worn, seasonAt(new Date(Date.UTC(2026, 0, 1 + d)))).vars;
        expect(ratio(rgbOf(vars["--accent"]), bg), `${face} day ${d}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(rgbOf(vars["--accent"]), card), `${face} day ${d}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("the light never costs the reader the text", () => {
  const INKS = ["--foreground", "--muted-foreground", "--accent", "--primary"];
  const GROUNDS = ["--background", "--card"];

  it("by day: inside the brightest pane, at noon and at the amber end", () => {
    const t = faceTokens(theme, "day");
    for (const golden of [0, 1]) {
      const sun = golden ? LIGHT.window.golden : LIGHT.window.rgb;
      const lit = (c: RGB) => {
        const pane = lay(c, sun, LIGHT.window.alpha);
        return golden ? lay(pane, LIGHT.goldenWash.rgb, LIGHT.goldenWash.alpha) : pane;
      };
      // …and out of the sun, in the shade the window is cut from.
      const shaded = (c: RGB) => {
        // Twice over: where a glazing bar crosses the mullion the shade doubles.
        const dim = lay(lay(c, LIGHT.shade.rgb, LIGHT.shade.alpha), LIGHT.shade.rgb, LIGHT.shade.alpha);
        return golden ? lay(dim, LIGHT.goldenWash.rgb, LIGHT.goldenWash.alpha) : dim;
      };
      for (const ink of INKS) for (const ground of GROUNDS) {
        const got = ratio(lit(rgbOf(t[ink])), lit(rgbOf(t[ground])));
        expect(got, `golden ${golden}: ${ink} on ${ground} ${got.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        const dim = ratio(shaded(rgbOf(t[ink])), shaded(rgbOf(t[ground])));
        expect(dim, `shade, golden ${golden}: ${ink} on ${ground} ${dim.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("by night: at the far edge of the candle's dark, and in the heart of its glow", () => {
    const t = faceTokens(theme, "night");
    const dark = (c: RGB) => lay(c, LIGHT.candleDark.rgb, LIGHT.candleDark.alpha);
    const glow = (c: RGB) => lay(c, LIGHT.candleGlow.rgb, LIGHT.candleGlow.alpha);
    for (const ink of INKS) for (const ground of GROUNDS) {
      const far = ratio(dark(rgbOf(t[ink])), dark(rgbOf(t[ground])));
      const near = ratio(glow(rgbOf(t[ink])), glow(rgbOf(t[ground])));
      expect(far, `dark: ${ink} on ${ground} ${far.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(near, `glow: ${ink} on ${ground} ${near.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the stylesheet uses the alphas that were measured", () => {
    const [wr, wg, wb] = LIGHT.window.rgb;
    const [gr, gg, gb] = LIGHT.window.golden;
    // The pane's colour is computed in CSS from --scr-golden: noon minus a
    // per-channel swing must land on the golden colour.
    expect(css).toContain(`rgb(${wr} calc(${wg} - var(--scr-golden, 0) * ${wg - gg}) calc(${wb} - var(--scr-golden, 0) * ${wb - gb}) / ${LIGHT.window.alpha}) 0%`);
    expect(gr).toBe(wr);
    expect(css).toContain(`rgba(${LIGHT.goldenWash.rgb.join(", ")}, ${LIGHT.goldenWash.alpha})`);
    expect(css).toContain(`rgba(${LIGHT.shade.rgb.join(", ")}, ${LIGHT.shade.alpha})`);
    expect(css).toContain(`rgba(${LIGHT.candleDark.rgb.join(", ")}, ${LIGHT.candleDark.alpha})`);
    expect(css).toContain(`rgba(${LIGHT.candleGlow.rgb.join(", ")}, ${LIGHT.candleGlow.alpha})`);
    // Nothing in the stylesheet lays the dark on thicker than the measured peak.
    const darks = [...css.matchAll(/rgba\(8, 5, 2, ([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(Math.max(...darks)).toBe(LIGHT.candleDark.alpha);
  });

  it("never lights the page by animating a property on :root", () => {
    // An inherited custom property changing on the root restyles the whole
    // document: measured at 19ms a frame on the Library. The light's position
    // is written to the gilded elements, and :root only holds its resting place.
    const ambient = readFileSync(resolve(__dirname, "../components/themes/ScriptoriumAmbient.tsx"), "utf8");
    expect(ambient).not.toMatch(/documentElement\.style\.setProperty/);
    expect(ambient).not.toMatch(/mix-blend-mode/);
    expect(css).not.toMatch(/mix-blend-mode/);
  });
});
