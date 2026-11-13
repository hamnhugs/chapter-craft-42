/**
 * Minimal, synchronous OKLab/OKLCH color math.
 *
 * The repo already depends on `culori`, but every existing use is behind a
 * dynamic `await import("culori")` to keep ~50KB out of the main bundle. The
 * seasonal theme layer needs color math at theme-apply time, on the critical
 * path, where an async import would mean the accent visibly changes one frame
 * after paint. So the handful of transforms it needs live here instead:
 * synchronous, dependency-free, ~zero bundle cost.
 *
 * Hand-rolled math is only worth it if it is *verified* math. Every function
 * here is checked against culori in src/test/oklch.test.ts — culori is a
 * devDependency of the test run, so the reference implementation costs the
 * bundle nothing while still being the thing that decides whether this file
 * is correct.
 *
 * Why OKLab and not HSL, when the themes are stored as HSL triplets: HSL's
 * "lightness" is not lightness. hsl(60 100% 50%) (yellow) and hsl(240 100% 50%)
 * (blue) claim the same L and differ by roughly 15:1 in actual luminance. Any
 * seasonal hue rotation done in HSL would therefore change how readable text
 * is, by an amount that depends on which way the hue happened to move. OKLab's
 * L *is* perceptual lightness, so rotating hue at fixed L is contrast-safe by
 * construction — which is the entire safety argument for the season layer.
 *
 * Coefficients are Björn Ottosson's (https://bottosson.github.io/posts/oklab/).
 */

export interface Rgb { r: number; g: number; b: number }        // 0..1, sRGB
export interface Oklch { l: number; c: number; h: number }      // l 0..1, c 0..~0.4, h degrees

/** sRGB companding (gamma) — transfer function from IEC 61966-2-1. */
const toLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

const fromLinear = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);

  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  const c = Math.hypot(A, B);
  // Hue of an achromatic color is meaningless; pin it to 0 so round-trips are
  // stable instead of returning whatever atan2(±0, ±0) happens to give.
  const h = c < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** OKLCH → sRGB. May return components outside 0..1 (out of gamut). */
export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);

  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.2914855480 * B;

  const L = l_ * l_ * l_, M = m_ * m_ * m_, S = s_ * s_ * s_;

  return {
    r: fromLinear(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: fromLinear(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: fromLinear(-0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S),
  };
}

const IN_GAMUT_EPS = 1e-4;
export const inSrgbGamut = ({ r, g, b }: Rgb): boolean =>
  r >= -IN_GAMUT_EPS && r <= 1 + IN_GAMUT_EPS &&
  g >= -IN_GAMUT_EPS && g <= 1 + IN_GAMUT_EPS &&
  b >= -IN_GAMUT_EPS && b <= 1 + IN_GAMUT_EPS;

/**
 * Bring a color into sRGB by reducing chroma, holding L and H fixed.
 *
 * Naive per-channel clipping is the alternative, and it is wrong for us: it
 * shifts lightness (clipping a blown red channel darkens nothing, clipping a
 * negative one lightens) and drags hue. Since the whole season design rests on
 * "L never moves", the one dimension we are allowed to sacrifice is chroma.
 * This is the same strategy as culori's clampChroma and CSS Color 4's gamut
 * mapping, minus the deltaE refinement step, which is not worth the bytes at
 * the chroma levels UI accents actually live at.
 */
export function clampToSrgb(color: Oklch): Oklch {
  if (inSrgbGamut(oklchToRgb(color))) return color;
  let lo = 0, hi = color.c;
  // 20 halvings resolves chroma to ~4e-7 — far below a 1/255 quantization step.
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(oklchToRgb({ ...color, c: mid }))) lo = mid; else hi = mid;
  }
  return { ...color, c: lo };
}

const hex2 = (v: number): string =>
  Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");

export const rgbToHex = ({ r, g, b }: Rgb): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export const oklchToHex = (c: Oklch): string => rgbToHex(oklchToRgb(clampToSrgb(c)));

export function hexToRgb(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.split("").map((ch) => ch + ch).join("") : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ---------------------------------------------------------------------------
// The theme registry's currency: bare HSL triplets like "265 61% 11%", which
// is what Tailwind's hsl(var(--token)) pattern requires. Parsing and
// re-emitting that exact shape is what lets the season layer hand its output
// straight back to ThemeContext without changing how any consumer reads it.
// ---------------------------------------------------------------------------

export interface Hsl { h: number; s: number; l: number } // h deg, s/l 0..100

/** Parse a bare Tailwind-style triplet: "265 61% 11%". Commas tolerated. */
export function parseHslTriplet(token: string): Hsl | null {
  const m = token.trim().match(
    /^(-?[\d.]+)\s*(?:deg)?[\s,]+(-?[\d.]+)%[\s,]+(-?[\d.]+)%$/,
  );
  if (!m) return null;
  const [h, s, l] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![h, s, l].every(Number.isFinite)) return null;
  return { h: ((h % 360) + 360) % 360, s, l };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export const formatHslTriplet = ({ h, s, l }: Hsl): string =>
  `${round2(((h % 360) + 360) % 360)} ${round2(clampPct(s))}% ${round2(clampPct(l))}%`;

const clampPct = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v);

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const S = clampPct(s) / 100, L = clampPct(l) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const R = clamp01(r), G = clamp01(g), B = clamp01(b);
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === R) h = 60 * (((G - B) / d) % 6);
  else if (max === G) h = 60 * ((B - R) / d + 2);
  else h = 60 * ((R - G) / d + 4);
  return { h: ((h % 360) + 360) % 360, s: s * 100, l: l * 100 };
}

export const hslTripletToOklch = (token: string): Oklch | null => {
  const hsl = parseHslTriplet(token);
  return hsl ? rgbToOklch(hslToRgb(hsl)) : null;
};

/** OKLCH back to the bare triplet the theme registry stores, gamut-mapped. */
export const oklchToHslTriplet = (c: Oklch): string =>
  formatHslTriplet(rgbToHsl(oklchToRgb(clampToSrgb(c))));

// ---------------------------------------------------------------------------
// WCAG 2.x contrast. Present so the season layer's central safety claim — that
// it cannot make text harder to read — is an assertion rather than a promise.
// ---------------------------------------------------------------------------

export const relativeLuminance = ({ r, g, b }: Rgb): number =>
  0.2126 * toLinear(clamp01(r)) + 0.7152 * toLinear(clamp01(g)) + 0.0722 * toLinear(clamp01(b));

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
