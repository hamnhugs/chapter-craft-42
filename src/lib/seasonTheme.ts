/**
 * Seasonal modulation of the active theme.
 *
 * The brief was a library that changes with the season but still "syncs with
 * the loaded theme", and those two things fight unless the relationship
 * between them is settled up front. The obvious build — four seasonal palettes
 * that get swapped in — loses the fight immediately. Paint autumn orange over
 * Desolate Lab and you have destroyed it: that theme is light-absorbing black
 * and exactly one signal red, and a second hue is not a season, it is a
 * different theme. Paint pastel spring over Dexter's Lab and the same.
 *
 * So the season supplies no colour of its own. It supplies a *transform* of
 * the colours the theme already chose. The theme stays the noun; the season is
 * only ever an adjective. Concretely, three rules:
 *
 *  1. Perceptual lightness never moves. Every transform happens in OKLCH with
 *     L pinned, so text contrast is preserved by construction rather than by
 *     testing afterwards — and it is then tested anyway, across all four
 *     themes for all 365 days, in src/test/seasonTheme.test.ts. This is also
 *     why the math is OKLab and not HSL: HSL's "lightness" is not lightness,
 *     so an HSL hue rotation silently changes how readable text is.
 *
 *  2. Hue is pulled a bounded fraction of the way toward warm or cool, never
 *     set to a seasonal hue. Dexter's magenta leans coral in August and plum
 *     in February; it never becomes amber. A theme's accent stays recognisably
 *     that theme's accent in every week of the year.
 *
 *  3. Each theme declares how much of this it will tolerate, as
 *     `seasonalAmplitude` in the registry. Fruit Stripe is a mid-century
 *     rainbow and takes the full swing; Desolate Lab takes a quarter of it and
 *     merely breathes.
 *
 * Tokens that carry structure or body text — background, foreground, card,
 * border, the surface ladder — are never touched at all. The season is allowed
 * to tint what the theme uses for emphasis, and nothing else.
 */

import {
  clampToSrgb, hslTripletToOklch, oklchToHex, oklchToHslTriplet, Oklch,
} from "@/lib/oklch";
import type { SeasonState } from "@/lib/season";
import type { ThemeDef } from "@/lib/themes";

/** Amber and azure in OKLCH hue degrees — the two poles the year swings between. */
const WARM_ANCHOR = 70;
const COOL_ANCHOR = 250;

export const SEASON_TUNING = {
  /** Most of the way toward an anchor the year may ever pull a hue. */
  maxPull: 0.3,
  /** Hard cap on rotation in degrees, so hues far from an anchor stay put. */
  maxDegrees: 26,
  /** How much summer saturates and winter mutes, before theme amplitude. */
  chromaSwing: 0.18,
  /** Spring's extra lift, so it reads as more than a cool summer. */
  growthChroma: 0.06,
  /** Perceptual lightness gap the ambient motes keep from the background. */
  moteContrast: 0.26,
} as const;

/** Tokens the season may tint: emphasis only, never structure or body text. */
export const SEASONAL_TOKENS = ["--accent", "--ring", "--book-spine"] as const;

/** Signed shortest path from `a` to `b` around the hue circle, in degrees. */
export function hueArc(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The season's effect on one colour, in OKLCH, with L untouched.
 * `amplitude` is the theme's tolerance; 0 returns the colour unchanged.
 */
export function modulate(base: Oklch, season: SeasonState, amplitude: number): Oklch {
  if (amplitude <= 0) return base;
  const { maxPull, maxDegrees, chromaSwing, growthChroma } = SEASON_TUNING;

  // Hue follows `warmth`, not `light` — the palette should still feel warm in
  // early September for the same reason the weather still is.
  const anchor = season.warmth >= 0 ? WARM_ANCHOR : COOL_ANCHOR;
  const pull = Math.abs(season.warmth) * maxPull * amplitude;
  const delta = clamp(hueArc(base.h, anchor) * pull, -maxDegrees, maxDegrees);

  const chromaFactor =
    1 + (season.light * chromaSwing + season.growth * growthChroma) * amplitude;

  return clampToSrgb({
    l: base.l,
    c: Math.max(0, base.c * chromaFactor),
    h: ((base.h + delta) % 360 + 360) % 360,
  });
}

export interface SeasonalTheme {
  /** CSS custom properties to apply, all bare HSL triplets or plain numbers. */
  vars: Record<string, string>;
  /** The season's version of the theme accent, for canvas work. */
  glow: Oklch;
  /** Ambient particle colour, held a fixed perceptual gap from the canvas. */
  mote: Oklch;
  /** Screen-space drift: positive falls, negative rises. */
  drift: number;
}

/**
 * Derive everything the seasonal layer needs from a theme and an instant.
 * Pure: same theme and same season in, same CSS out.
 */
export function seasonalTheme(theme: ThemeDef, season: SeasonState): SeasonalTheme {
  const amplitude = theme.seasonalAmplitude ?? 0;
  const vars: Record<string, string> = {};

  for (const key of SEASONAL_TOKENS) {
    const base = hslTripletToOklch(theme.tokens[key] ?? "");
    if (!base) continue;
    vars[key] = oklchToHslTriplet(modulate(base, season, amplitude));
  }

  // The showcase's own palette. These are additive — nothing outside the
  // seasonal library reads them — so they can be freer than the shared tokens.
  const accent = hslTripletToOklch(theme.tokens["--accent"] ?? "") ?? { l: 0.7, c: 0.1, h: 0 };
  const background = hslTripletToOklch(theme.tokens["--background"] ?? "") ?? { l: 0.2, c: 0, h: 0 };

  const glow = modulate(accent, season, Math.max(amplitude, 0.35));

  // Motes have to be visible on Fruit Stripe's paper white and on Desolate
  // Lab's near-black, so their lightness is chosen relative to the canvas
  // rather than fixed: always a set perceptual step toward the far end.
  const away = background.l > 0.5 ? -1 : 1;
  const mote = clampToSrgb({
    l: clamp(background.l + away * SEASON_TUNING.moteContrast, 0.06, 0.96),
    c: Math.min(glow.c * 0.8, 0.12),
    h: glow.h,
  });

  // Motes rise while the days are lengthening and fall while they shorten.
  // Screen-space y grows downward, hence the negation: this single sign is the
  // whole reason spring looks like spring and autumn looks like autumn, and
  // nobody had to author either one.
  const drift = -season.growth;

  vars["--season-glow"] = oklchToHslTriplet(glow);
  vars["--season-mote"] = oklchToHslTriplet(mote);
  vars["--season-haze"] = oklchToHslTriplet(clampToSrgb({ ...glow, c: glow.c * 0.35 }));
  vars["--season-drift"] = drift.toFixed(3);
  vars["--season-light"] = season.light.toFixed(3);
  vars["--season-warmth"] = season.warmth.toFixed(3);
  vars["--season-amplitude"] = amplitude.toFixed(2);

  // Solar elevation, in degrees, for a mid-latitude noon: 45 degrees of
  // co-latitude plus the declination. About 22 in midwinter and 68 at
  // midsummer. This is what the light show rakes its beams along, and it is
  // the reason a winter afternoon looks like a winter afternoon — the light
  // comes in low and sideways rather than from overhead.
  vars["--season-elevation"] = (45 + 23.44 * season.light).toFixed(2);

  // 1 on a dark canvas, 0 on a light one. Light added to black reads as light;
  // light added to paper reads as nothing, so the show has to composite the
  // other way round on Fruit Stripe or it simply will not be there.
  vars["--season-polarity"] = background.l > 0.5 ? "0" : "1";

  // Aurorae are a dark-sky phenomenon, so the curtains rise as the daylight
  // falls. Nothing seasonal is authored here either; it is just -light.
  vars["--season-aurora"] = Math.max(0, -season.light).toFixed(3);
  // Winter is slow and summer is languid; spring and autumn are the brisk
  // ones. Speed tracks |growth| — how fast the year itself is moving.
  vars["--season-tempo"] = (0.7 + Math.abs(season.growth) * 0.6).toFixed(3);

  return { vars, glow, mote, drift };
}

/**
 * Placeholder cover for a book that has no cover image — which, in practice,
 * is most of them: nothing in the client ever writes `cover_image_url`.
 *
 * The grid's version of this picks from six hard-coded warm hues that predate
 * the theme system, so a cover-less book is the same brown on Fruit Stripe's
 * paper as on Desolate Lab's black. Here the family of covers is derived from
 * the theme's own seasonal accent instead: one hue family, fanned out by the
 * book's id hash so neighbours stay distinguishable, and sitting near the
 * canvas in lightness because a cover is a surface and not a highlight.
 */
export function coverGradient(seed: number, glow: Oklch, backgroundL: number): [string, string] {
  // Golden-angle fan: consecutive seeds land far apart, and no amount of them
  // clusters. Kept to a 96-degree arc so every cover still reads as this theme.
  const spread = (((seed * 0.6180339887) % 1) - 0.5) * 96;
  const h = ((glow.h + spread) % 360 + 360) % 360;
  const toward = backgroundL > 0.5 ? -1 : 1;
  const c = Math.min(glow.c * 0.55, 0.09);
  const a = clampToSrgb({ l: clamp(backgroundL + toward * 0.10, 0.05, 0.95), c, h });
  const b = clampToSrgb({ l: clamp(backgroundL + toward * 0.02, 0.03, 0.92), c: c * 0.7, h: (h + 18) % 360 });
  return [oklchToHex(a), oklchToHex(b)];
}
