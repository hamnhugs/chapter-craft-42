// Aurora theme — the sky model behind the app bar's northern lights
// (AuroraArt.tsx). Pure functions, no network, no location: everything is
// read off the device clock, so the bar does what a real aurora would do on
// the night you are looking at it.
//
// What the model is honest about:
//  - Daylight hides the aurora. A mid-latitude day length is derived from the
//    date (longer summers, shorter winters, flipped for the south), and the
//    curtains fade in through nautical twilight after sunset and out before
//    sunrise. By day the bar keeps only a faint pastel shimmer.
//  - Substorms peak around local magnetic midnight, so the display swells
//    toward ~23:30 and settles in the small hours.
//  - Geomagnetic activity is stronger near the equinoxes than the solstices
//    (the Russell–McPherron effect), so March and September nights burn
//    brighter.
//  - Each night gets its own Kp index (1..8, weighted toward quiet nights the
//    way the real distribution is), seeded from that night's date, so the
//    show is the same all evening and different tomorrow.
//  - Colour follows the physics: green oxygen (557.7nm) always; a red crown
//    (630nm high-altitude oxygen) only in strong storms; a violet nitrogen
//    hem under the lower edge as the display intensifies.
//
// Contrast: the curtains are laid over the bar's night ink at capped alpha
// (CURTAIN_ALPHA), so the header's text keeps WCAG AA (4.5:1) at the brightest
// point where all three curtains overlap at full storm — checked in
// src/test/auroraSky.test.ts. The very brightest rays (the lower edges) are
// kept in the bar's bottom band, under the text.

export type RGB = [number, number, number];
export type Hemisphere = "north" | "south";

export interface AuroraState {
  phase: "day" | "twilight" | "night";
  /** 0 = full daylight, 1 = astronomical night. */
  night: number;
  /** 0..1 — overall visibility of the curtains. */
  strength: number;
  /** Tonight's geomagnetic activity, 1..8. */
  kp: number;
  /** 0..1 — the red 630nm crown, strong storms only. */
  crown: number;
  /** 0..1 — the violet nitrogen hem below the lower edge. */
  hem: number;
  /** 0..1 — peaks mid-twilight; drives the horizon glow. */
  twilight: number;
}

/** The bar's own ink under the art (the header background in aurora-art.css). */
export const BAR_INK: RGB = [9, 13, 28];
/** Curtain colours: main oxygen green, a teal fold, a distant violet fold. */
export const CURTAINS: { core: RGB; edge: RGB }[] = [
  { core: [79, 240, 168], edge: [140, 255, 205] },
  { core: [63, 216, 224], edge: [130, 236, 248] },
  { core: [169, 139, 255], edge: [200, 182, 255] },
];
export const CROWN: RGB = [255, 93, 122];
export const HEM: RGB = [176, 124, 255];
/**
 * Peak opacity of each curtain's brightest ray at strength 1 (scaled down by
 * strength in CSS). The lower edges — the brightest part, as in the sky —
 * sit in the bar's bottom band, below the text.
 */
export const CURTAIN_ALPHA = [0.3, 0.15, 0.12] as const;
/**
 * The `.au-lights` mask holds the band where header text sits (21%–79% of the
 * bar's height) to at most this fraction of the curtains' alpha, so the text
 * is measured against CURTAIN_ALPHA × TEXT_BAND, not the full edge.
 */
export const TEXT_BAND = 0.55;
/**
 * The luminous band along the bottom of the bar (`.au-glow`): its peak alpha
 * at strength 1, and the fraction of that peak still present where the text
 * band begins (it ramps up from 76% to 92% of the bar's height, so at 80%
 * it is 0.25 of peak). The violet sky-glow at the top is held below this.
 */
export const GLOW_ALPHA = 0.5;
export const GLOW_AT_TEXT = 0.25;
export const GLOW: RGB = [111, 240, 192];
/** The bar never goes fully dark: the aurora "behind the daylight". */
export const DAY_FLOOR = 0.16;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

/** Hours of daylight at ~45° latitude: 8.4h at midwinter, 15.6h at midsummer. */
export function dayLength(doy: number, hemisphere: Hemisphere = "north"): number {
  const s = Math.sin((2 * Math.PI * (doy - 80)) / 365.24);
  return 12 + 3.6 * (hemisphere === "south" ? -s : s);
}

/** Small deterministic hash → 0..1, for the nightly Kp. */
function hash01(n: number): number {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Kp for the night containing `d` (before noon belongs to the night before). */
export function nightlyKp(d: Date): number {
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getHours() < 12 ? 1 : 0));
  const key = n.getFullYear() * 1000 + dayOfYear(n);
  return 1 + Math.floor(7.999 * Math.pow(hash01(key), 1.6));
}

/** 0.82 at the solstices → 1 at the equinoxes. */
export function equinoxFactor(doy: number): number {
  const c = Math.cos((2 * Math.PI * (doy - 80)) / 365.24);
  return 0.82 + 0.18 * c * c;
}

export function auroraState(d: Date, hemisphere: Hemisphere = "north", kpOverride?: number): AuroraState {
  const doy = dayOfYear(d);
  const L = dayLength(doy, hemisphere);
  const noon = 12.5; // clock noon sits ~30min before solar noon on most civil clocks
  const sunrise = noon - L / 2;
  const sunset = noon + L / 2;
  const h = d.getHours() + d.getMinutes() / 60;

  const night = h < noon
    ? 1 - smoothstep(sunrise - 1.4, sunrise + 0.25, h)
    : smoothstep(sunset - 0.25, sunset + 1.4, h);

  const kp = kpOverride ?? nightlyKp(d);
  const activity = 0.45 + 0.55 * ((kp - 1) / 7);
  let dh = Math.abs(h - 23.5);
  if (dh > 12) dh = 24 - dh;
  const substorm = 0.55 + 0.45 * Math.exp(-(dh * dh) / (2 * 2.5 * 2.5));
  const raw = night * substorm * activity * equinoxFactor(doy);
  const strength = clamp(Math.max(DAY_FLOOR, raw));

  return {
    phase: night > 0.85 ? "night" : night < 0.05 ? "day" : "twilight",
    night,
    strength,
    kp,
    crown: kp >= 5 ? smoothstep(0.45, 0.85, raw) : 0,
    hem: smoothstep(0.3, 0.75, raw),
    twilight: clamp(1 - Math.abs(2 * night - 1)),
  };
}

/**
 * Preview/testing override: `?auroraSky=day|dusk|night|<ISO>`. Returns the
 * Date to model, or null for "now".
 */
export function overrideDate(param: string | null, now = new Date()): Date | null {
  if (!param) return null;
  const at = (h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (param === "day") return at(13);
  if (param === "dusk") {
    const L = dayLength(dayOfYear(now));
    const sunset = 12.5 + L / 2 + 0.6;
    return at(Math.floor(sunset), Math.round((sunset % 1) * 60));
  }
  if (param === "night") return at(23, 30);
  const t = Date.parse(param);
  return Number.isNaN(t) ? null : new Date(t);
}

// ── Contrast helpers (WCAG 2.x) ─────────────────────────────────────────────
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Source-over in sRGB, the way the browser composites the curtains. */
export const over = (bg: RGB, fg: RGB, a: number): RGB =>
  bg.map((c, i) => Math.round(c + (fg[i] - c) * a)) as RGB;

/**
 * The brightest pixel the bar can show at a given strength: all three
 * curtains' bright lower edges stacked, plus the crown and hem.
 */
export function brightestBackdrop(strength: number, band: "text" | "edge" = "text"): RGB {
  const k = band === "text" ? TEXT_BAND : 1;
  let px = BAR_INK;
  px = over(px, GLOW, GLOW_ALPHA * strength * (band === "text" ? GLOW_AT_TEXT * TEXT_BAND : 1));
  CURTAINS.forEach((c, i) => { px = over(px, c.edge, CURTAIN_ALPHA[i] * strength * k); });
  return px;
}
