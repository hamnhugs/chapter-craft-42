// Page looks for DesignCraft — what makes a flyer, poster or cover from the
// chat look designed rather than typed.
//
// A model placing frames by coordinates lays pages out badly (even GPT-5:
// arXiv 2509.16891), and a 4B local model can't hold a type scale in its head.
// So the design knowledge lives here, the way Canva-style tools keep it in
// templates: each look is a designer's recipe — one display face and one text
// face, a type scale, a grid, a palette taken from the picture, and the
// devices pros use (full-bleed photos, scrims under type, colour blocks,
// rules, tracked small caps). The model picks a look by name and writes the
// words; the bridge (craft-bridge.mjs) measures, places and checks.
//
// Pure functions only: no DesignCraft calls here, so the looks are unit-tested
// (src/test/designLooks.test.ts) and rendered by scripts/local-ai/design-looks-gallery.mjs.
// The reasoning behind each choice: docs/local-ai/DESIGN-LOOKS.md.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Colour: sRGB ⇄ OKLab/OKLCH (perceptual, so "same lightness" means it),
// WCAG contrast, and a palette read off the picture.
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
export function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function rgbToOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
export function oklch(hex) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}
/** OKLCH → hex, pulling chroma in until the colour exists in sRGB. */
export function fromOklch(L, C, h) {
  for (let c = C; c >= 0; c -= 0.005) {
    const lin = oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)]);
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005)) return rgbToHex(lin.map((v) => toGam(clamp(v, 0, 1)) * 255));
  }
  return rgbToHex(oklabToLinear([L, 0, 0]).map((v) => toGam(clamp(v, 0, 1)) * 255));
}
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => toLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Same hue, new lightness (and optionally a chroma cap). */
export function withL(hex, L, maxC = Infinity) {
  const c = oklch(hex);
  return fromOklch(L, Math.min(c.C, maxC), c.h);
}
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
/** The darkest (or lightest) version of `hex` that reaches `ratio` against `bg`. */
export function readableOn(bg, hex, ratio = 4.5) {
  if (contrast(bg, hex) >= ratio) return hex;
  const { L, C, h } = oklch(hex);
  const dark = luminance(bg) > 0.18;
  for (let k = 1; k <= 40; k++) {
    const c = fromOklch(clamp(dark ? L - k * 0.025 : L + k * 0.025, 0, 1), C, h);
    if (contrast(bg, c) >= ratio) return c;
  }
  return dark ? "#111111" : "#FFFFFF";
}

/** k-means in OKLab over a picture's pixels (`rgb`: flat [r,g,b,…]) → the
 *  colour groups, biggest first, each {hex, share, L, C}. Seeded by farthest
 *  point so the same picture always gives the same palette. */
export function clusterColours(rgb, k = 6, iters = 12) {
  const pts = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) pts.push(rgbToOklab([rgb[i], rgb[i + 1], rgb[i + 2]]));
  if (!pts.length) return [];
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const centres = [pts.reduce((s, p) => s.map((v, i) => v + p[i] / pts.length), [0, 0, 0])];
  while (centres.length < Math.min(k, pts.length)) {
    let best = null, bd = -1;
    for (const p of pts) { const d = Math.min(...centres.map((c) => d2(p, c))); if (d > bd) { bd = d; best = p; } }
    if (bd <= 1e-6) break;
    centres.push(best.slice());
  }
  let assign = new Array(pts.length).fill(0);
  for (let it = 0; it < iters; it++) {
    assign = pts.map((p) => { let bi = 0, bd = Infinity; centres.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; bi = i; } }); return bi; });
    const sum = centres.map(() => [0, 0, 0, 0]);
    pts.forEach((p, i) => { const s = sum[assign[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
    sum.forEach((s, i) => { if (s[3]) centres[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = centres.map((_, i) => assign.filter((a) => a === i).length);
  return centres
    .map((c, i) => {
      const lin = oklabToLinear(c).map((v) => toGam(clamp(v, 0, 1)) * 255);
      return { hex: rgbToHex(lin), share: counts[i] / pts.length, L: c[0], C: Math.hypot(c[1], c[2]), h: Math.atan2(c[2], c[1]) };
    })
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
}

/** A design palette from a picture's colour groups — the way a designer
 *  samples a cover photo: a near-black and a paper white tinted with the
 *  picture's own hue (so they belong with it), and its most vivid colour as
 *  the accent, in a version that reads on dark and one that reads on light. */
export function paletteFrom(groups, fallbackAccent = "#E4572E") {
  if (!groups?.length) return defaultPalette(fallbackAccent);
  const dom = groups[0];
  const darkest = groups.filter((g) => g.share >= 0.04).sort((a, b) => a.L - b.L)[0] || dom;
  const lightest = groups.filter((g) => g.share >= 0.04).sort((a, b) => b.L - a.L)[0] || dom;
  const vivid = groups.filter((g) => g.C > 0.05 && g.share >= 0.02 && g.L > 0.25 && g.L < 0.92).sort((a, b) => b.C * Math.sqrt(b.share) - a.C * Math.sqrt(a.share))[0];
  const accentHue = vivid ? vivid.h : oklch(fallbackAccent).h;
  const accentC = vivid ? clamp(vivid.C * 1.15, 0.11, 0.2) : oklch(fallbackAccent).C;
  const meanL = groups.reduce((s, g) => s + g.L * g.share, 0);
  return {
    dark: fromOklch(clamp(Math.min(darkest.L, 0.22), 0.14, 0.22), Math.min(darkest.C, 0.045), darkest.h),
    ink: fromOklch(0.2, Math.min(darkest.C, 0.03), darkest.h),
    light: fromOklch(0.965, Math.min(lightest.C, 0.018), lightest.h),
    paper: fromOklch(0.955, Math.min(dom.C * 0.25, 0.02), dom.h),
    accent: fromOklch(0.62, accentC, accentHue),
    accentOnDark: fromOklch(0.76, accentC, accentHue),
    accentOnLight: fromOklch(0.5, accentC, accentHue),
    vivid: !!vivid,
    imageIsDark: meanL < 0.5,
    groups: groups.map((g) => ({ hex: g.hex, share: Math.round(g.share * 100) / 100 })),
  };
}

export function defaultPalette(accent = "#E4572E") {
  const a = oklch(accent);
  return {
    dark: "#15171C", ink: "#1B1B1F", light: "#F7F5F0", paper: "#F4F0E8",
    accent, accentOnDark: fromOklch(0.76, a.C, a.h), accentOnLight: fromOklch(0.5, a.C, a.h),
    vivid: true, imageIsDark: false, groups: [],
  };
}

// ---------------------------------------------------------------------------
// Type: the look's fonts are measured from their own files (advance widths
// from cmap+hmtx, cap height and descender from OS/2), so a headline can be
// set as large as fits on its lines before DesignCraft ever sees it.
// ---------------------------------------------------------------------------

export const FONT_DIR = process.env.CC_FONT_DIR || join(homedir(), ".local/share/fonts/chapter-craft");
const fontCache = new Map();

/** The parts of a TrueType file needed to measure text. */
export function parseTtf(buf) {
  const u16 = (o) => buf.readUInt16BE(o), i16 = (o) => buf.readInt16BE(o), u32 = (o) => buf.readUInt32BE(o);
  const tables = {};
  for (let i = 0, n = u16(4); i < n; i++) { const r = 12 + i * 16; tables[buf.toString("latin1", r, r + 4)] = u32(r + 8); }
  const upm = u16(tables.head + 18);
  const hhea = tables.hhea;
  const ascender = i16(hhea + 4), descender = i16(hhea + 6), nHM = u16(hhea + 34);
  const os2 = tables["OS/2"];
  const capHeight = os2 != null && u16(os2) >= 2 ? i16(os2 + 88) : Math.round(ascender * 0.7);
  const xHeight = os2 != null && u16(os2) >= 2 ? i16(os2 + 86) : Math.round(capHeight * 0.68);
  // DesignCraft keeps the deepest of the font's descents clear under the last
  // line (usWinDescent is usually it), so frames are measured with that.
  const winDescent = os2 != null ? u16(os2 + 76) : 0, typoDescent = os2 != null ? -i16(os2 + 70) : 0;
  const advances = [];
  for (let g = 0; g < nHM; g++) advances.push(u16(tables.hmtx + g * 4));
  // cmap format 4 (BMP) from the Windows Unicode or Unicode subtable.
  const cmap = tables.cmap, map = new Map();
  let sub = null;
  for (let i = 0, n = u16(cmap + 2); i < n; i++) {
    const p = u16(cmap + 4 + i * 8), e = u16(cmap + 6 + i * 8), off = u32(cmap + 8 + i * 8);
    if (u16(cmap + off) === 4 && ((p === 3 && e === 1) || p === 0)) { sub = cmap + off; break; }
  }
  if (sub != null) {
    const segX2 = u16(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = u16(ends + s * 2), start = u16(starts + s * 2), delta = i16(deltas + s * 2), ro = u16(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else { const gi = u16(ranges + s * 2 + ro + (c - start) * 2); g = gi ? (gi + delta) & 0xffff : 0; }
        map.set(c, g);
      }
    }
  }
  const adv = (cp) => { const g = map.get(cp) ?? 0; return advances[Math.min(g, advances.length - 1)] / upm; };
  return { upm, ascent: ascender / upm, descent: Math.max(-descender, winDescent, typoDescent) / upm, capHeight: capHeight / upm, xHeight: xHeight / upm, adv };
}

/** File for a family + style as install-design-fonts.sh names them. */
export function fontFile(family, style = "Regular") {
  return join(FONT_DIR, `${family.replace(/ /g, "")}-${style.replace(/ /g, "")}.ttf`);
}
export function hasFont(family, style = "Regular") {
  return existsSync(fontFile(family, style));
}
export function fontMetrics(family, style = "Regular") {
  const key = `${family}|${style}`;
  if (!fontCache.has(key)) {
    let m = null;
    try { m = parseTtf(readFileSync(fontFile(family, style))); } catch { /* not installed: estimate */ }
    fontCache.set(key, m || { upm: 1000, ascent: 0.95, descent: 0.25, capHeight: 0.7, xHeight: 0.5, adv: () => 0.52, estimated: true });
  }
  return fontCache.get(key);
}

/** Width of `text` in points as DesignCraft sets it (tracking in 1/1000 em). */
export function textWidth(text, t, size) {
  const m = fontMetrics(t.font, t.style);
  const s = t.caps ? String(text).toUpperCase() : String(text);
  let w = 0;
  for (const ch of s) w += m.adv(ch.codePointAt(0));
  return (w + ((t.tracking || 0) / 1000) * Math.max(0, [...s].length)) * size;
}

/** Greedy line breaks at `size` in `width` (no hyphenation) → lines, and
 *  whether any single word is wider than the measure. */
export function wrap(text, t, size, width) {
  const lines = [];
  let tooWide = false;
  for (const para of String(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      if (textWidth(w, t, size) > width) tooWide = true;
      const next = line ? `${line} ${w}` : w;
      if (!line || textWidth(next, t, size) <= width) line = next;
      else { lines.push(line); line = w; }
    }
    lines.push(line);
  }
  return { lines, tooWide };
}

/** Height of a frame that holds `n` lines with the first baseline at the cap
 *  height (frames are set that way, so the frame's top IS the type's top). */
export function blockHeight(t, size, n) {
  const m = fontMetrics(t.font, t.style);
  const lead = (t.lead || 1.2) * size;
  // + 6% of the size: DesignCraft's own clearance under the last line runs a
  // point or two deeper than the metrics say for some faces (Playfair, DM Serif).
  return Math.ceil(m.capHeight * size + Math.max(0, n - 1) * lead + m.descent * size + 2 + size * 0.06);
}

/** Largest size in [min, max] at which `text` takes at most `lines` lines in
 *  `width` without breaking a word — how a designer sizes a headline: as big
 *  as the measure allows. Steps of 1 pt (or 0.5 below 24). */
export function fitSize(text, t, width, { min = 12, max = 200, lines = 3 } = {}) {
  let lo = min, hi = Math.max(min, max), best = null;
  for (let k = 0; k < 24 && hi - lo > 0.5; k++) {
    const mid = (lo + hi) / 2;
    const w = wrap(text, t, mid, width);
    if (!w.tooWide && w.lines.length <= lines) { best = mid; lo = mid; } else hi = mid;
  }
  const size = best == null ? min : best >= 24 ? Math.floor(best) : Math.floor(best * 2) / 2;
  return { size, lines: wrap(text, t, size, width).lines.length };
}

// ---------------------------------------------------------------------------
// The looks.
// ---------------------------------------------------------------------------

/** Display + text pairings. Each with a fallback family when the fonts
 *  aren't installed (DesignCraft bundles Source Sans 3). */
const T = {
  anton: { font: "Anton", style: "Regular", caps: true, tracking: 0, lead: 0.98 },
  bebas: { font: "Bebas Neue", style: "Regular", caps: true, tracking: 20, lead: 0.92 },
  playfairBlack: { font: "Playfair Display", style: "Black", tracking: -15, lead: 1.02 },
  playfairItalic: { font: "Playfair Display", style: "Italic", tracking: 0, lead: 1.3 },
  cinzel: { font: "Cinzel", style: "Bold", caps: true, tracking: 80, lead: 1.08 },
  interTightBlack: { font: "Inter Tight", style: "Black", tracking: -45, lead: 0.9 },
  cormorant: { font: "Cormorant Garamond", style: "SemiBold", tracking: -5, lead: 1.0 },
  cormorantItalic: { font: "Cormorant Garamond", style: "Medium Italic", tracking: 0, lead: 1.25 },
  dmSerif: { font: "DM Serif Display", style: "Regular", tracking: -10, lead: 1.04 },
  archivoBlack: { font: "Archivo Black", style: "Regular", caps: true, tracking: -20, lead: 0.92 },
  fraunces: { font: "Fraunces", style: "Black", tracking: -20, lead: 0.98 },
  interLabel: { font: "Inter", style: "SemiBold", caps: true, tracking: 220, lead: 1.3 },
  interBold: { font: "Inter", style: "Bold", tracking: -10, lead: 1.25 },
  inter: { font: "Inter", style: "Regular", tracking: 0, lead: 1.5 },
  interLight: { font: "Inter", style: "Light", tracking: -25, lead: 1.12 },
  interSmall: { font: "Inter", style: "Medium", caps: true, tracking: 160, lead: 1.4 },
  montLabel: { font: "Montserrat", style: "SemiBold", caps: true, tracking: 380, lead: 1.4 },
  garamond: { font: "EB Garamond", style: "Regular", tracking: 0, lead: 1.42 },
  garamondItalic: { font: "EB Garamond", style: "Italic", tracking: 0, lead: 1.4 },
  cinzelSmall: { font: "Cinzel", style: "Regular", caps: true, tracking: 250, lead: 1.4 },
  dmSans: { font: "DM Sans", style: "Regular", tracking: 0, lead: 1.5 },
  dmSansLabel: { font: "DM Sans", style: "Bold", caps: true, tracking: 200, lead: 1.3 },
  space: { font: "Space Grotesk", style: "Medium", tracking: 0, lead: 1.4 },
  spaceBold: { font: "Space Grotesk", style: "Bold", tracking: 0, lead: 1.25 },
};
/** Every family install-design-fonts.sh installs. */
export const DESIGN_FAMILIES = ["Inter", "Inter Tight", "Playfair Display", "Bebas Neue", "Anton", "Archivo Black", "Archivo", "Cormorant Garamond", "EB Garamond", "Cinzel", "DM Serif Display", "DM Sans", "Fraunces", "Montserrat", "Oswald", "Space Grotesk", "Lora", "Abril Fatface", "Libre Baskerville", "Josefin Sans"];
const FALLBACK = { font: "Source Sans 3", style: "Regular" };
const FALLBACK_BOLD = { font: "Source Sans 3", style: "Bold" };
/** A type spec, or Source Sans when its font file isn't there. */
function face(key, over = {}) {
  const t = { ...T[key], ...over };
  if (hasFont(t.font, t.style)) return t;
  return { ...t, ...(/Bold|Black|Semi/.test(t.style) ? FALLBACK_BOLD : FALLBACK) };
}

/** What each look is for, in a line — the tool card and the docs read this. */
export const LOOKS = {
  bold: "full-bleed photo over a dark colour block, huge condensed caps (event flyers, promos)",
  cinematic: "photo fills the page, dark fade, centred spaced capitals (book covers, movie-style posters)",
  editorial: "magazine page: paper white, big serif headline, framed photo, rules (articles, newsletters)",
  swiss: "grid, giant tight sans headline flush left, one accent colour (modern, business, talks)",
  classic: "centred serif, cream paper, double rule border, ornament (literary, invitations, awards)",
  minimal: "lots of white space, light type, small photo, one accent (calm, premium)",
  split: "photo on one half, text panel on the other (announcements, launches)",
  pop: "bright colour field, heavy caps, tilted photo with shadow, tag label (kids, sales, fun)",
};
export const LOOK_NAMES = Object.keys(LOOKS);

/** A look for a page that never had one: editorial — it keeps the headline
 *  on top, where people ask for it ("add a headline to the top"), and suits
 *  any picture. The louder looks are a word away. */
export function autoLook(_parts) {
  return "editorial";
}

/** Text spec helpers: a part set in `t` on `width`, sized to fit `fit` or at `size`. */
/** The look's type in a family the user picked: the same style when that
 *  family has it, else the nearest weight it does have. */
function overFont(t, font) {
  const heavy = /Black|ExtraBold|Bold|Semi/.test(t.style), italic = /Italic/.test(t.style);
  const tries = [t.style, ...(heavy ? ["Black", "ExtraBold", "Bold", "SemiBold"] : []), italic ? "Italic" : null, "Regular"].filter(Boolean);
  return { ...t, font, style: tries.find((st) => hasFont(font, st)) || t.style };
}
let SQUEEZE = 1;
function setText(part, t, width, opt = {}) {
  let size = opt.size != null ? Math.max(6.5, Math.round(opt.size * Math.sqrt(SQUEEZE) * 2) / 2) : undefined;
  if (part.over?.size) size = Number(part.over.size);
  // DesignCraft kerns and composes whole paragraphs, so it can break a line
  // earlier or later than the estimate; `fudge` (learned from the page, see
  // layoutLook) narrows or widens the measure the estimate uses.
  // 3% narrower than the frame: headlines are sized right to the edge, where
  // DesignCraft's measure (within ~1% of ours, more with wide tracking) would
  // otherwise break the longest word ("SUMME / R").
  const mw = (width * 0.97) / (part.fudge || 1);
  if (!part.over?.size && opt.fit) size = fitSize(part.text, t, mw, { ...opt.fit, max: Math.max(opt.fit.min, opt.fit.max * SQUEEZE) }).size;
  const tt = part.over?.font ? overFont(t, part.over.font) : t;
  const n = part.dcLines?.size === size && part.dcLines?.w === Math.round(width) ? part.dcLines.lines : wrap(part.text, tt, size, mw).lines.length;
  return { t: tt, size, lines: n, w: width, h: blockHeight(tt, size, n) + Math.ceil((part.extraEm || 0) * size), align: part.over?.align || opt.align || "left" };
}
const firstOf = (parts, role) => parts.find((p) => p.role === role);
const allOf = (parts, role) => parts.filter((p) => p.role === role);
const joinText = (ps) => ps.map((p) => p.text).join("\n");

/** Each look: (page, parts, palette) → a plan. Page: {x, y, W, H} (spread
 *  coordinates of the page's top-left and its size). Parts: {id, role, kind,
 *  text?, aspect?, over?} — `over` holds what the user set by hand (colour,
 *  size, font, align), which wins over the look. Plan:
 *    shapes: [{name, kind: rect|ellipse|line|diamond, box|a,b, fill?, gradient?, stroke?, opacity?, corner?}] back to front
 *    frames: [{id, role, box:[x,y,w,h], text?: {t,size,color,align,…}, image?: {corner, shadow, rotate}}]
 *  Shapes go behind everything; frames stack in the order given. */
export function planLook(look, page, parts, pal) {
  const fn = PLANS[look] || PLANS.editorial;
  const P = { ...page, m: Math.round(Math.min(page.W, page.H) * 0.075) };
  // Copy that runs long: step the type down (headlines faster than text)
  // until it fits, the way a designer would, rather than let it collide.
  let plan;
  try {
    for (let k = 0; k < 8; k++) {
      SQUEEZE = 0.88 ** k;
      plan = fn(P, parts, pal);
      if (!planIssues(plan, page).length) break;
    }
  } finally { SQUEEZE = 1; }
  // Balanced headings: the tightest measure that keeps the line count, so a
  // two-line title doesn't leave one word on its own ("Summer Book / Fair" →
  // "Summer / Book Fair"). Done by narrowing the frame (centred ones stay
  // centred); DesignCraft's own balancing splits words.
  for (const f of plan.frames) {
    if (!f.text || !["headline", "subhead"].includes(f.role) || f.text.lines < 2) continue;
    const part = parts.find((p) => p.id === f.id);
    if (!part || part.dcLines) continue;
    const k = 0.97 / (part.fudge || 1), t = f.text.t, size = f.text.size, n = f.text.lines;
    const fits = (w) => { const r = wrap(part.text, t, size, w * k); return !r.tooWide && r.lines.length <= n; };
    let lo = f.box[2] * 0.4, hi = f.box[2];
    if (fits(lo)) continue;
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    const bw = Math.ceil(hi + 1);
    if (bw >= f.box[2] - 2) continue;
    const dx = f.text.align === "center" ? (f.box[2] - bw) / 2 : f.text.align === "right" ? f.box[2] - bw : 0;
    f.box = [f.box[0] + dx, f.box[1], bw, f.box[3]];
    f.text = { ...f.text, w: bw };
  }
  // A colour picked by hand keeps its hue but is lightened or darkened until
  // it reads on what's behind it (red on navy becomes a brighter red).
  for (const f of plan.frames) {
    const over = parts.find((p) => p.id === f.id)?.over?.color;
    if (!f.text || !over) continue;
    // WCAG: 3:1 for large type on a flat colour; 4.5:1 for text, and for any
    // type over a photo, whose fade is never quite the flat colour.
    const onPhoto = plan.frames.some((g) => g.image?.under);
    f.text.color = readableOn(f.text.on || plan.bg, over, f.text.size >= 24 && !onPhoto ? 3 : 4.5);
  }
  plan.look = look;
  return plan;
}

const colourOf = (part, c) => part.over?.color || c;

/** Body parts stacked at (x, y) in width w, each with its spec. */
function stackBodies(frames, ps, t, x, y, w, size, color, gap, opt = {}) {
  for (const p of ps) {
    const s = setText(p, t, w, { size, align: opt.align });
    frames.push({ id: p.id, role: p.role, box: [x, y, w, s.h], text: { ...s, color: colourOf(p, color), columns: opt.columns } });
    y += s.h + gap;
  }
  return y;
}
const bodiesHeight = (ps, t, w, size, gap) => ps.reduce((s, p) => s + setText(p, t, w, { size }).h + gap, 0) - (ps.length ? gap : 0);

/** Extra pictures (after the first) as a row of equal tiles. */
function imageRow(frames, imgs, x, y, w, h, gap) {
  if (!imgs.length) return;
  const tw = (w - gap * (imgs.length - 1)) / imgs.length;
  imgs.forEach((p, i) => frames.push({ id: p.id, role: "image", box: [x + i * (tw + gap), y, tw, h], image: { fill: true } }));
}

const PLANS = {
  // Photo bleeds off the top, a deep colour block below carries huge condensed
  // caps; a short accent rule and a tracked label set the scale contrast.
  bold(P, parts, pal) {
    const { x, y, W, H, m } = P;
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = [...allOf(parts, "body"), ...allOf(parts, "caption")], foot = firstOf(parts, "footer");
    const bg = pal.dark, fg = pal.light;
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    const cw = W - 2 * m;
    // Measure the type block first: the headline fills the measure, and the
    // photo takes what's left (between 40 and 60% of the page).
    const fs = foot && setText(foot, face("interSmall"), cw, { size: Math.max(7.5, Math.round(W / 70 * 10) / 10) });
    const ss = sub && setText(sub, face("interLabel"), cw * 0.8, { size: Math.round(W / 48) });
    const bodyT = face("inter", { lead: 1.45 });
    const bodySize = Math.max(10, Math.round(W / 46 * 2) / 2);
    const bodyW = Math.min(cw, cw * 0.86);
    const bodyH = bodiesHeight(bodies, bodyT, bodyW, bodySize, m * 0.25);
    const fixed = (ss ? ss.h + m * 0.85 : 0) + (bodies.length ? bodyH + m * 0.5 : 0) + (fs ? fs.h + m * 0.8 : 0) + m * 1.45;
    const t = face("anton");
    let hs = head && setText(head, t, cw, { fit: { min: 24, max: Math.round(H * (imgs.length ? 0.17 : 0.26)), lines: imgs.length ? 3 : 4 } });
    const minImg = imgs.length ? H * 0.4 : 0;
    while (hs && fixed + hs.h > H - minImg && hs.size > 24) hs = setText(head, t, cw, { fit: { min: 24, max: hs.size - 2, lines: 3 } });
    const imgH = imgs.length ? Math.round(clamp(H - fixed - (hs ? hs.h + m * 0.5 : 0), H * 0.4, H * 0.6)) : 0;
    if (imgs[0]) frames.push({ id: imgs[0].id, role: "image", box: [x, y, W, imgH], image: { fill: true } });
    if (imgs.length) shapes.push({ name: "Fade", kind: "rect", box: [x, y + imgH - H * 0.12, W, H * 0.12], gradient: { angle: -90, stops: [[0, bg, 0], [100, bg, 85]] } });
    let cy = y + imgH + (imgs.length ? m * 0.6 : m * 1.6);
    const fy = y + H - m * 0.8 - (fs ? fs.h : 0);
    if (sub) {
      shapes.push({ name: "Accent rule", kind: "rect", box: [x + m, cy, Math.round(m * 0.9), Math.max(3, Math.round(W / 150))], fill: pal.accentOnDark });
      cy += Math.round(m * 0.45);
      frames.push({ id: sub.id, role: "subhead", box: [x + m, cy, cw * 0.8, ss.h], text: { ...ss, color: colourOf(sub, pal.accentOnDark) } });
      cy += ss.h + m * 0.4;
    }
    if (head) {
      frames.push({ id: head.id, role: "headline", box: [x + m, cy, cw, hs.h], text: { ...hs, color: colourOf(head, fg) } });
      cy += hs.h + m * 0.5;
    }
    cy = stackBodies(frames, bodies, bodyT, x + m, cy, bodyW, bodySize, mix(fg, bg, 0.22), m * 0.25);
    if (imgs.length > 1) imageRow(frames, imgs.slice(1), x + m, cy + m * 0.3, cw, Math.max(40, fy - cy - m * 0.9), m * 0.25);
    if (foot) {
      shapes.push({ name: "Footer rule", kind: "rect", box: [x + m, fy - m * 0.35, cw, 0.75], fill: mix(fg, bg, 0.7) });
      frames.push({ id: foot.id, role: "footer", box: [x + m, fy, cw, fs.h], text: { ...fs, color: colourOf(foot, mix(fg, bg, 0.3)) } });
    }
    return { shapes, frames, bg };
  },

  // Movie-poster / book-cover: the photo is the page, a fade to near-black
  // under the type, spaced capitals centred, a credit line at the foot.
  cinematic(P, parts, pal) {
    const { x, y, W, H, m } = P;
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = [...allOf(parts, "body"), ...allOf(parts, "caption")], foot = firstOf(parts, "footer");
    const bg = pal.dark, fg = pal.light;
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    if (imgs[0]) frames.push({ id: imgs[0].id, role: "image", box: [x, y, W, H], image: { fill: true, under: true } });
    // Fades: a long one at the foot for the title, a short one at the top for the line above it.
    shapes.push({ name: "Fade", kind: "rect", box: [x, y + H * 0.34, W, H * 0.66], gradient: { angle: -90, stops: [[0, bg, 0], [30, bg, 72], [55, bg, 94], [100, bg, 100]] } });
    if (sub) shapes.push({ name: "Top fade", kind: "rect", box: [x, y, W, H * 0.22], gradient: { angle: 90, stops: [[0, bg, 0], [60, bg, 75], [100, bg, 92]] } });
    const cw = W - 2 * m;
    if (sub) {
      const s = setText(sub, face("montLabel"), cw, { size: Math.max(8, Math.round(W / 56)), align: "center" });
      frames.push({ id: sub.id, role: "subhead", box: [x + m, y + m, cw, s.h], text: { ...s, color: colourOf(sub, mix(fg, bg, 0.12)) } });
    }
    const fs = foot && setText(foot, face("montLabel", { tracking: 300 }), cw, { size: Math.max(7, Math.round(W / 72)), align: "center" });
    let by = y + H - m - (fs ? fs.h : 0);
    if (foot) frames.push({ id: foot.id, role: "footer", box: [x + m, by, cw, fs.h], text: { ...fs, color: colourOf(foot, mix(fg, bg, 0.25)) } });
    by -= m * 0.9;
    const bodyT = face("garamondItalic"), bodyW = Math.min(cw, W * 0.62), bodySize = Math.max(10, Math.round(W / 40));
    const bh = bodiesHeight(bodies, bodyT, bodyW, bodySize, m * 0.2);
    let ty = by - bh;
    stackBodies(frames, bodies, bodyT, x + (W - bodyW) / 2, ty, bodyW, bodySize, mix(fg, bg, 0.15), m * 0.2, { align: "center" });
    if (head) {
      const t = face("cinzel");
      const s = setText(head, t, cw, { fit: { min: 22, max: Math.round(W / 6.5), lines: 3 }, align: "center" });
      const hy = ty - (bodies.length ? m * 0.55 : 0) - s.h;
      // A thin accent rule between the title and the line under it.
      if (bodies.length) shapes.push({ name: "Accent rule", kind: "rect", box: [x + W / 2 - m * 0.5, ty - m * 0.32, m, 1.5], fill: pal.accentOnDark });
      frames.push({ id: head.id, role: "headline", box: [x + m, hy, cw, s.h], text: { ...s, color: colourOf(head, fg) } });
    }
    if (imgs.length > 1) imageRow(frames, imgs.slice(1), x + m, y + H * 0.42, cw, H * 0.14, m * 0.25);
    return { shapes, frames, bg };
  },

  // Magazine page: warm paper, a tracked label, a big black serif headline
  // flush left, a hairline, the photo inside the margins, an italic caption.
  editorial(P, parts, pal) {
    const { x, y, W, H } = P;
    const m = Math.round(P.m * 1.05);
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = allOf(parts, "body"), cap = firstOf(parts, "caption"), foot = firstOf(parts, "footer");
    // Warm stock with a trace of the picture's hue: cold blue-white reads as a screen, not paper.
    const bg = mix("#F6F2E9", pal.paper, 0.25), ink = pal.ink, acc = readableOn(bg, pal.accentOnLight, 4.5);
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    const cw = W - 2 * m;
    let cy = y + m;
    shapes.push({ name: "Top rule", kind: "rect", box: [x + m, cy, cw, 2.5], fill: ink });
    cy += m * 0.45;
    if (sub) {
      const s = setText(sub, face("interLabel", { tracking: 200 }), cw, { size: Math.max(8, Math.round(W / 60)) });
      frames.push({ id: sub.id, role: "subhead", box: [x + m, cy, cw, s.h], text: { ...s, color: colourOf(sub, acc) } });
      cy += s.h + m * 0.4;
    }
    const fs = foot && setText(foot, face("interSmall", { tracking: 140 }), cw, { size: Math.max(7, Math.round(W / 76)) });
    const fy = y + H - m - (fs ? fs.h : 0);
    const bodyT = face("inter", { lead: 1.5 }), bodySize = Math.max(9.5, Math.round(W / 52 * 2) / 2);
    const long = joinText(bodies).length > 380;
    const bodyCols = long ? 2 : 1;
    const bodyW = long ? cw : cw * 0.74;
    const colW = (bodyW - (bodyCols - 1) * m * 0.4) / bodyCols;
    const bh = bodies.length ? bodiesHeight(bodies, bodyT, colW, bodySize, m * 0.2) / bodyCols + bodySize : 0;
    if (head) {
      const t = face("playfairBlack");
      const s = setText(head, t, cw, { fit: { min: 22, max: Math.round(H * (imgs.length ? 0.085 : 0.13)), lines: imgs.length ? 3 : 4 } });
      frames.push({ id: head.id, role: "headline", box: [x + m, cy, cw, s.h], text: { ...s, color: colourOf(head, ink) } });
      cy += s.h + m * 0.45;
    }
    const cs = cap && setText(cap, face("playfairItalic"), cw, { size: Math.max(8, Math.round(W / 62)) });
    if (imgs.length) {
      const room = fy - cy - (bodies.length ? bh + m * 0.5 : 0) - (cs ? cs.h + m * 0.25 : 0) - m * 0.6;
      const a = imgs[0].aspect || 1.5;
      const ih = Math.max(60, Math.min(room, cw / clamp(a, 0.8, 2.2)));
      frames.push({ id: imgs[0].id, role: "image", box: [x + m, cy, cw, ih], image: { fill: true } });
      imageRow(frames, imgs.slice(1), x + m, cy + ih + m * 0.25, cw, Math.min(ih * 0.4, 120), m * 0.25);
      cy += ih + (imgs.length > 1 ? Math.min(ih * 0.4, 120) + m * 0.25 : 0) + m * 0.2;
    }
    if (cap) { frames.push({ id: cap.id, role: "caption", box: [x + m, cy, cw, cs.h], text: { ...cs, color: colourOf(cap, mix(ink, bg, 0.35)) } }); cy += cs.h + m * 0.3; }
    if (bodies.length) {
      cy += m * 0.2;
      shapes.push({ name: "Body rule", kind: "rect", box: [x + m, cy - m * 0.25, m * 0.8, 1.5], fill: acc });
      cy = stackBodies(frames, bodies, bodyT, x + m, cy + m * 0.1, bodyW, bodySize, mix(ink, bg, 0.1), m * 0.2, { columns: bodyCols });
    }
    if (foot) {
      shapes.push({ name: "Footer rule", kind: "rect", box: [x + m, fy - m * 0.3, cw, 0.75], fill: ink });
      frames.push({ id: foot.id, role: "footer", box: [x + m, fy, cw, fs.h], text: { ...fs, color: colourOf(foot, mix(ink, bg, 0.3)) } });
    }
    return { shapes, frames, bg };
  },

  // International style: a six-column grid, a giant tight sans headline flush
  // left, the photo across four columns, the small text in the first two,
  // one accent colour, a heavy rule at the foot.
  swiss(P, parts, pal) {
    const { x, y, W, H, m } = P;
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = [...allOf(parts, "body"), ...allOf(parts, "caption")], foot = firstOf(parts, "footer");
    const bg = "#F3F1EC", ink = "#111111", acc = pal.vivid ? readableOn(bg, pal.accent, 3) : "#E63322";
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    const cw = W - 2 * m, g = m * 0.4, col = (cw - 5 * g) / 6, cx = (i) => x + m + i * (col + g);
    let cy = y + m;
    shapes.push({ name: "Accent block", kind: "rect", box: [x + m, cy, col * 0.55, col * 0.55], fill: acc });
    cy += col * 0.55 + m * 0.5;
    const fs = foot && setText(foot, face("interBold", { tracking: 0 }), cw, { size: Math.max(8, Math.round(W / 64)) });
    const fy = y + H - m - (fs ? fs.h : 0);
    if (head) {
      const t = face("interTightBlack");
      const s = setText(head, t, cw, { fit: { min: 24, max: Math.round(H * (imgs.length ? 0.11 : 0.18)), lines: imgs.length ? 3 : 5 } });
      frames.push({ id: head.id, role: "headline", box: [x + m, cy, cw, s.h], text: { ...s, color: colourOf(head, ink) } });
      cy += s.h + m * 0.6;
    }
    const leftW = 2 * col + g;
    const top = cy;
    if (sub) {
      const s = setText(sub, face("interBold"), leftW, { size: Math.max(10, Math.round(W / 40)) });
      frames.push({ id: sub.id, role: "subhead", box: [cx(0), cy, leftW, s.h], text: { ...s, color: colourOf(sub, acc) } });
      cy += s.h + m * 0.35;
    }
    const bodyT = face("inter", { lead: 1.45 }), bodySize = Math.max(9, Math.round(W / 58 * 2) / 2);
    if (imgs.length) {
      const iw = 4 * col + 3 * g;
      const ih = Math.max(80, Math.min(fy - top - m * 0.9, iw / clamp(imgs[0].aspect || 1, 0.7, 1.6)));
      frames.push({ id: imgs[0].id, role: "image", box: [cx(2), top, iw, ih], image: { fill: true } });
      imageRow(frames, imgs.slice(1), cx(0), top + ih - 70, leftW, 70, g);
      stackBodies(frames, bodies, bodyT, cx(0), cy, leftW, bodySize, "#333333", m * 0.25);
    } else {
      stackBodies(frames, bodies, bodyT, cx(2), top, 4 * col + 3 * g, bodySize * 1.25, "#222222", m * 0.3);
    }
    if (foot) {
      shapes.push({ name: "Footer rule", kind: "rect", box: [x + m, fy - m * 0.35, cw, 4], fill: ink });
      frames.push({ id: foot.id, role: "footer", box: [x + m, fy, cw, fs.h], text: { ...fs, color: colourOf(foot, ink) } });
    }
    return { shapes, frames, bg };
  },

  // Literary / invitation: cream stock, a double rule border, everything
  // centred in a Garamond, an ornament between title and text.
  classic(P, parts, pal) {
    const { x, y, W, H } = P;
    const m = Math.round(P.m * 1.35);
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = allOf(parts, "body"), cap = firstOf(parts, "caption"), foot = firstOf(parts, "footer");
    const bg = "#F4EEE1", ink = "#2A211A", gold = pal.vivid ? readableOn(bg, withL(pal.accent, 0.55, 0.09), 3) : "#9A7533";
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    const b = Math.round(P.m * 0.55);
    shapes.push({ name: "Border", kind: "rect", box: [x + b, y + b, W - 2 * b, H - 2 * b], stroke: { color: gold, weight: 1.5 } });
    shapes.push({ name: "Inner border", kind: "rect", box: [x + b + 5, y + b + 5, W - 2 * b - 10, H - 2 * b - 10], stroke: { color: gold, weight: 0.5 } });
    const cw = W - 2 * m;
    let cy = y + m;
    if (sub) {
      const s = setText(sub, face("cinzelSmall"), cw, { size: Math.max(8, Math.round(W / 58)), align: "center" });
      frames.push({ id: sub.id, role: "subhead", box: [x + m, cy, cw, s.h], text: { ...s, color: colourOf(sub, gold) } });
      cy += s.h + m * 0.35;
    }
    if (head) {
      const t = face("cormorant");
      const s = setText(head, t, cw, { fit: { min: 22, max: Math.round(H * (imgs.length ? 0.09 : 0.12)), lines: 3 }, align: "center" });
      frames.push({ id: head.id, role: "headline", box: [x + m, cy, cw, s.h], text: { ...s, color: colourOf(head, ink) } });
      cy += s.h + m * 0.35;
    }
    // Ornament: rule · diamond · rule.
    const ow = Math.min(cw * 0.5, 140), oy = cy + 4;
    shapes.push({ name: "Ornament left", kind: "rect", box: [x + W / 2 - ow / 2, oy, ow / 2 - 9, 0.75], fill: gold });
    shapes.push({ name: "Ornament right", kind: "rect", box: [x + W / 2 + 9, oy, ow / 2 - 9, 0.75], fill: gold });
    shapes.push({ name: "Ornament", kind: "diamond", box: [x + W / 2 - 4, oy - 3.6, 8, 8], fill: gold });
    cy += m * 0.55;
    const fs = foot && setText(foot, face("cinzelSmall", { tracking: 200 }), cw, { size: Math.max(7, Math.round(W / 70)), align: "center" });
    const fy = y + H - m - (fs ? fs.h : 0);
    const bodyT = face("garamond"), bodySize = Math.max(9.5, Math.round(W / 46 * 2) / 2), bodyW = Math.min(cw, W * 0.6);
    const bh = bodiesHeight(bodies, bodyT, bodyW, bodySize, m * 0.2);
    const cs = cap && setText(cap, face("garamondItalic"), bodyW, { size: bodySize * 0.85, align: "center" });
    if (imgs.length) {
      const full = fy - cy - (bodies.length ? bh + m * 0.5 : 0) - (cs ? cs.h + m * 0.25 : 0) - m * 0.4;
      const rowH = imgs.length > 1 ? Math.min(110, full * 0.28) : 0;
      const room = full - (rowH ? rowH + m * 0.25 : 0);
      const a = clamp(imgs[0].aspect || 1, 0.7, 1.6);
      let iw = Math.min(cw * 0.78, room * a), ih = iw / a;
      frames.push({ id: imgs[0].id, role: "image", box: [x + (W - iw) / 2, cy, iw, ih], image: { fill: true, stroke: { color: gold, weight: 0.75 } } });
      cy += ih + m * 0.3;
      if (rowH) { imageRow(frames, imgs.slice(1), x + (W - iw) / 2, cy - m * 0.05, iw, rowH, m * 0.2); cy += rowH + m * 0.3; }
    }
    if (cap) { frames.push({ id: cap.id, role: "caption", box: [x + (W - bodyW) / 2, cy, bodyW, cs.h], text: { ...cs, color: colourOf(cap, mix(ink, bg, 0.3)) } }); cy += cs.h + m * 0.3; }
    stackBodies(frames, bodies, bodyT, x + (W - bodyW) / 2, cy, bodyW, bodySize, mix(ink, bg, 0.08), m * 0.2, { align: "center" });
    if (foot) frames.push({ id: foot.id, role: "footer", box: [x + m, fy, cw, fs.h], text: { ...fs, color: colourOf(foot, gold) } });
    return { shapes, frames, bg };
  },

  // Quiet and premium: wide margins, light large type, a small photo set
  // off-centre, one accent dot.
  minimal(P, parts, pal) {
    const { x, y, W, H } = P;
    const m = Math.round(P.m * 1.6);
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = [...allOf(parts, "body"), ...allOf(parts, "caption")], foot = firstOf(parts, "footer");
    const bg = "#FAFAF7", ink = "#161616", acc = pal.vivid ? readableOn(bg, pal.accent, 3) : "#C8553D";
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    const cw = W - 2 * m;
    let cy = y + m;
    if (sub) {
      const s = setText(sub, face("interSmall", { tracking: 200 }), cw, { size: Math.max(7.5, Math.round(W / 68)) });
      shapes.push({ name: "Accent dot", kind: "ellipse", box: [x + m, cy + s.size * 0.12, s.size * 0.7, s.size * 0.7], fill: acc });
      frames.push({ id: sub.id, role: "subhead", box: [x + m + s.size * 1.4, cy, cw - s.size * 1.4, s.h], text: { ...s, color: colourOf(sub, mix(ink, bg, 0.35)) } });
      cy += s.h + m * 0.5;
    }
    if (head) {
      const t = face("interLight");
      const s = setText(head, t, cw * 0.88, { fit: { min: 20, max: Math.round(W / 8.5), lines: 3 } });
      frames.push({ id: head.id, role: "headline", box: [x + m, cy, cw * 0.88, s.h], text: { ...s, color: colourOf(head, ink) } });
      cy += s.h + m * 0.6;
    }
    const fs = foot && setText(foot, face("inter", { lead: 1.4 }), cw, { size: Math.max(7, Math.round(W / 80)) });
    const fy = y + H - m - (fs ? fs.h : 0);
    const bodyT = face("inter", { lead: 1.6 }), bodySize = Math.max(9, Math.round(W / 60 * 2) / 2), bodyW = cw * 0.6;
    const bh = bodiesHeight(bodies, bodyT, bodyW, bodySize, m * 0.2);
    if (imgs.length) {
      const full = fy - cy - (bodies.length ? bh + m * 0.5 : 0) - m * 0.3;
      const rowH = imgs.length > 1 ? Math.min(90, full * 0.25) : 0;
      const room = full - (rowH ? rowH + m * 0.2 : 0);
      const a = clamp(imgs[0].aspect || 1, 0.75, 1.5);
      const iw = Math.min(cw * 0.62, room * a), ih = iw / a;
      frames.push({ id: imgs[0].id, role: "image", box: [x + W - m - iw, cy, iw, ih], image: { fill: true } });
      cy += ih + m * 0.5;
      if (rowH) { imageRow(frames, imgs.slice(1), x + W - m - iw, cy - m * 0.3, iw, rowH, m * 0.15); cy += rowH + m * 0.2; }
    }
    stackBodies(frames, bodies, bodyT, x + m, cy, bodyW, bodySize, mix(ink, bg, 0.2), m * 0.2);
    if (foot) frames.push({ id: foot.id, role: "footer", box: [x + m, fy, cw, fs.h], text: { ...fs, color: colourOf(foot, mix(ink, bg, 0.45)) } });
    return { shapes, frames, bg };
  },

  // Half photo, half colour panel; the text sits in the panel, centred
  // vertically, with a serif display headline.
  split(P, parts, pal) {
    const { x, y, W, H, m } = P;
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = [...allOf(parts, "body"), ...allOf(parts, "caption")], foot = firstOf(parts, "footer");
    const panel = pal.dark, fg = pal.light;
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: panel });
    const portrait = H > W * 1.1;
    // Portrait pages split top/bottom (photo on top); landscape left/right.
    const imgBox = portrait ? [x, y, W, Math.round(H * 0.5)] : [x, y, Math.round(W * 0.5), H];
    const area = portrait ? [x + m, y + H * 0.5 + m * 0.8, W - 2 * m, H * 0.5 - m * 1.6] : [x + W * 0.5 + m, y + m, W * 0.5 - 2 * m, H - 2 * m];
    if (imgs[0]) frames.push({ id: imgs[0].id, role: "image", box: imgBox, image: { fill: true } });
    else shapes.push({ name: "Panel", kind: "rect", box: imgBox, fill: pal.accent });
    shapes.push({ name: "Accent bar", kind: "rect", box: portrait ? [x, y + H * 0.5 - 3, W, 6] : [x + W * 0.5 - 3, y, 6, H], fill: pal.accentOnDark });
    const [ax, ay, aw, ah] = area;
    const items = [];
    if (sub) items.push(["subhead", sub, setText(sub, face("dmSansLabel"), aw, { size: Math.max(8, Math.round(W / 60)) }), pal.accentOnDark, m * 0.4]);
    if (head) {
      const t = face("dmSerif");
      items.push(["headline", head, setText(head, t, aw, { fit: { min: 20, max: Math.round(Math.min(aw / 3.2, ah / 3)), lines: 4 } }), fg, m * 0.45]);
    }
    const bodyT = face("dmSans"), bodySize = Math.max(8.5, Math.round(W / 60 * 2) / 2);
    for (const p of bodies) items.push([p.role, p, setText(p, bodyT, aw, { size: bodySize }), mix(fg, panel, 0.2), m * 0.2]);
    const fs = foot && setText(foot, face("dmSansLabel", { tracking: 120 }), aw, { size: Math.max(7, Math.round(W / 80)) });
    const total = items.reduce((s, it) => s + it[2].h + it[4], 0) - (items.length ? items[items.length - 1][4] : 0);
    let cy = ay + Math.max(0, (ah - (fs ? fs.h + m : 0) - total) / 2);
    for (const [role, p, s, c, gap] of items) {
      frames.push({ id: p.id, role, box: [ax, cy, aw, s.h], text: { ...s, color: colourOf(p, c) } });
      cy += s.h + gap;
    }
    if (foot) frames.push({ id: foot.id, role: "footer", box: [ax, ay + ah - fs.h, aw, fs.h], text: { ...fs, color: colourOf(foot, mix(fg, panel, 0.35)) } });
    if (imgs.length > 1) imageRow(frames, imgs.slice(1), ax, ay + ah - fs?.h - 80 || ay + ah - 80, aw, 60, m * 0.2);
    return { shapes, frames, bg: panel };
  },

  // Loud: the picture's most vivid colour as the field, heavy caps, a
  // tilted photo with a shadow, a dark tag for the label.
  pop(P, parts, pal) {
    const { x, y, W, H, m } = P;
    const shapes = [], frames = [];
    const imgs = allOf(parts, "image"), head = firstOf(parts, "headline"), sub = firstOf(parts, "subhead");
    const bodies = [...allOf(parts, "body"), ...allOf(parts, "caption")], foot = firstOf(parts, "footer");
    const bg = pal.vivid ? withL(pal.accent, 0.82, 0.17) : "#FFD23F";
    const ink = "#111111";
    shapes.push({ name: "Background", kind: "rect", box: [x, y, W, H], fill: bg });
    const cw = W - 2 * m;
    let cy = y + m;
    if (sub) {
      const t = face("spaceBold", { caps: true, tracking: 80 });
      const size = Math.max(8, Math.round(W / 50));
      const s = setText(sub, t, cw - 24, { size });
      const tw = Math.min(cw, textWidth(sub.text, t, size) + size * 1.6);
      shapes.push({ name: "Tag", kind: "rect", box: [x + m, cy, tw, s.h + size * 0.9], fill: ink, corner: (s.h + size * 0.9) / 2 });
      frames.push({ id: sub.id, role: "subhead", box: [x + m + size * 0.8, cy + size * 0.45, tw - size * 1.6, s.h], text: { ...s, color: colourOf(sub, bg), on: ink } });
      cy += s.h + size * 0.9 + m * 0.45;
    }
    if (head) {
      const t = face("archivoBlack");
      const s = setText(head, t, cw, { fit: { min: 24, max: Math.round(H * (imgs.length ? 0.11 : 0.18)), lines: imgs.length ? 3 : 4 } });
      frames.push({ id: head.id, role: "headline", box: [x + m, cy, cw, s.h], text: { ...s, color: colourOf(head, ink) } });
      cy += s.h + m * 0.6;
    }
    const fs = foot && setText(foot, face("spaceBold"), cw, { size: Math.max(8, Math.round(W / 60)) });
    const fy = y + H - m - (fs ? fs.h : 0);
    const bodyT = face("space", { lead: 1.4 }), bodySize = Math.max(9, Math.round(W / 50 * 2) / 2), bodyW = cw * 0.8;
    const bh = bodiesHeight(bodies, bodyT, bodyW, bodySize, m * 0.2);
    if (imgs.length) {
      const full = fy - cy - (bodies.length ? bh + m * 0.6 : 0) - m * 0.6;
      const rowH = imgs.length > 1 ? Math.min(110, full * 0.28) : 0;
      const room = full - (rowH ? rowH + m * 0.5 : 0);
      const a = clamp(imgs[0].aspect || 1, 0.75, 1.8);
      const iw = Math.min(cw * 0.9, room * a), ih = iw / a;
      frames.push({ id: imgs[0].id, role: "image", box: [x + (W - iw) / 2, cy + m * 0.1, iw, ih], image: { fill: true, corner: Math.round(m * 0.35), rotate: -2.5, shadow: true } });
      cy += ih + m * 0.7;
      if (rowH) {
        imgs.slice(1).forEach((p, i, a2) => { const tw = (cw - m * 0.3 * (a2.length - 1)) / a2.length; frames.push({ id: p.id, role: "image", box: [x + m + i * (tw + m * 0.3), cy - m * 0.2, tw, rowH], image: { fill: true, corner: Math.round(m * 0.25), rotate: i % 2 ? 2 : -2, shadow: true } }); });
        cy += rowH + m * 0.3;
      }
    }
    stackBodies(frames, bodies, bodyT, x + m, cy, bodyW, bodySize, ink, m * 0.2);
    if (foot) frames.push({ id: foot.id, role: "footer", box: [x + m, fy, cw, fs.h], text: { ...fs, color: colourOf(foot, ink) } });
    return { shapes, frames, bg };
  },
};

/** Problems a designer would catch at a glance, from the plan alone: text
 *  under the size it can be read at, too little contrast on a flat colour,
 *  frames off the page or on top of each other (text over a photo is fine
 *  when the look put a fade under it). */
export function planIssues(plan, page) {
  const issues = [];
  const { x, y, W, H } = page;
  for (const f of plan.frames) {
    const [fx, fy, fw, fh] = f.box;
    if (fx < x - 0.5 || fy < y - 0.5 || fx + fw > x + W + 0.5 || fy + fh > y + H + 0.5) issues.push(`${f.role} runs off the page`);
    if (f.text && f.text.size < 6.5) issues.push(`${f.role} text is too small to read (${f.text.size} pt): shorten it`);
    if (f.text && plan.bg && !plan.frames.some((g) => g.image && overlaps(g.box, f.box)) && contrast(f.text.on || plan.bg, f.text.color) < 3) issues.push(`${f.role} colour ${f.text.color} is hard to read on ${f.text.on || plan.bg}`);
  }
  const texts = plan.frames.filter((f) => f.text);
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) if (overlaps(texts[i].box, texts[j].box)) issues.push(`${texts[i].role} and ${texts[j].role} overlap`);
  // Type on a picture only where the look put a fade under it.
  const pics = plan.frames.filter((f) => f.image && !f.image.under);
  for (const t of texts) for (const p of pics) if (overlaps(t.box, p.box)) issues.push(`${t.role} sits on the picture`);
  for (let i = 0; i < pics.length; i++) for (let j = i + 1; j < pics.length; j++) if (overlaps(pics[i].box, pics[j].box)) issues.push("two pictures overlap");
  return issues;
}
function overlaps(a, b) {
  return a[0] < b[0] + b[2] - 0.5 && b[0] < a[0] + a[2] - 0.5 && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5;
}

// ---------------------------------------------------------------------------
// Putting a plan on the page. `call(tool, args)` reaches DesignCraft's MCP
// tools and returns the parsed JSON — the bridge's session, or the gallery's
// own headless one — so this stays testable without the app.
// ---------------------------------------------------------------------------

/** Names the bridge gives what a look draws, so the next layout can clear
 *  them: the background carries the look ("Look bold"), the rest "Deco …". */
export const LOOK_PREFIX = "Look ";
export const DECO_PREFIX = "Deco ";
/** A page started from a saved template carries a hidden "Template <slug>"
 *  marker (craft-bridge.mjs useTemplate); a look clears it with the rest. */
export const TEMPLATE_PREFIX = "Template ";
export const isDecoName = (n) => [LOOK_PREFIX, DECO_PREFIX, TEMPLATE_PREFIX].some((pre) => String(n || "").startsWith(pre));
export function lookOf(items) {
  const bg = (items || []).find((it) => String(it.name || "").startsWith(LOOK_PREFIX));
  const name = bg ? String(bg.name).slice(LOOK_PREFIX.length).trim() : null;
  return LOOK_NAMES.includes(name) ? name : null;
}

const swatchName = (hex) => `CC ${hex.toUpperCase()}`;

export async function applyPlan(call, plan, doc, page) {
  const exec = (command, params = {}) => call("execute", { command, params });
  // Only this page's: a look on page 2 mustn't clear page 1's.
  const onPage = (it) => !page || !Array.isArray(it.bounds) || (() => { const cx = (it.bounds[0] + it.bounds[2]) / 2, cy = (it.bounds[1] + it.bounds[3]) / 2; return cx >= page.x && cx <= page.x + page.W && cy >= page.y && cy <= page.y + page.H; })();
  const items = (doc?.spreads || []).flatMap((sp) => sp.items || []).filter(onPage);
  const swatches = new Set((doc?.swatches || []).map((s) => (typeof s === "string" ? s : s.name)));
  const swatch = async (hex) => {
    const name = swatchName(hex);
    if (!swatches.has(name)) { await exec("swatch.create", { color: hex, name }); swatches.add(name); }
    return name;
  };
  // Clear what the last look drew.
  const old = items.filter((it) => isDecoName(it.name)).map((it) => it.id);
  if (old.length) await exec("edit.clear", { ids: old });
  const steps = [];
  const z = { back: [], over: [] };
  for (const s of plan.shapes) {
    const [bx, by, bw, bh] = s.box;
    const shape = s.kind === "ellipse" ? "ellipse" : s.kind === "diamond" ? "polygon" : "rectangle";
    const r = await exec("frame.create", { rect: [bx, by, bx + bw, by + bh], shape, content: "unassigned", ...(s.kind === "diamond" ? { sides: 4 } : {}) });
    const id = r?.id;
    if (id == null) continue;
    steps.push({ command: "object.rename", params: { id, name: s.name === "Background" ? `${LOOK_PREFIX}${plan.look}` : `${DECO_PREFIX}${s.name}` } });
    if (s.stroke) steps.push({ command: "object.stroke", params: { swatch: await swatch(s.stroke.color), weight: s.stroke.weight, ids: [id] } });
    else steps.push({ command: "object.stroke", params: { swatch: "[None]", ids: [id] } });
    if (s.gradient) {
      steps.push({ command: "object.gradient", params: { kind: "linear", angle: s.gradient.angle, stops: s.gradient.stops.map(([location, color, opacity]) => ({ location, color, opacity })), ids: [id] } });
    } else if (s.fill) steps.push({ command: "object.fill", params: { swatch: await swatch(s.fill), ids: [id] } });
    else steps.push({ command: "object.fill", params: { swatch: "[None]", ids: [id] } });
    if (s.corner) steps.push({ command: "object.cornerOptions", params: { shape: "rounded", size: s.corner, ids: [id] } });
    (s.name === "Background" ? z.back : z.over).push(id);
  }
  const images = [], texts = [];
  for (const f of plan.frames) {
    const [fx, fy, fw, fh] = f.box;
    steps.push({ command: "transform.set", params: { x: fx, y: fy, width: fw, height: fh, rotation: 0, ref: 0, ids: [f.id] } });
    if (f.image) {
      images.push(f.id);
      steps.push({ command: "object.fit", params: { mode: f.image.fill ? "fillProportionally" : "fitProportionally", ids: [f.id] } });
      steps.push({ command: "object.fittingOptions", params: { fitting: f.image.fill ? "fillProportionally" : "fitProportionally", align: 4, ids: [f.id] } });
      steps.push({ command: "object.stroke", params: f.image.stroke ? { swatch: await swatch(f.image.stroke.color), weight: f.image.stroke.weight, ids: [f.id] } : { swatch: "[None]", ids: [f.id] } });
      steps.push({ command: "object.cornerOptions", params: { shape: f.image.corner ? "rounded" : "none", size: f.image.corner || 0, ids: [f.id] } });
      steps.push({ command: "object.dropShadow", params: f.image.shadow ? { on: true, distance: 10, angle: 120, opacity: 0.35, size: 18, color: "[Black]", ids: [f.id] } : { on: false, ids: [f.id] } });
      if (f.image.rotate) steps.push({ command: "transform.rotate", params: { angle: f.image.rotate, ids: [f.id] } });
      continue;
    }
    texts.push(f.id);
    const t = f.text;
    steps.push({ command: "object.textFrameOptions", params: { inset: 0, firstBaseline: "capHeight", verticalJustification: "top", columns: t.columns || 1, gutter: Math.round(t.size * 1.6), ids: [f.id] } });
    steps.push({ command: "object.fill", params: { swatch: "[None]", ids: [f.id] } });
    steps.push({ command: "object.stroke", params: { swatch: "[None]", ids: [f.id] } });
    steps.push({ command: "selection.set", params: { ids: [f.id] } });
    steps.push({ command: "type.char", params: { attrs: {
      fontFamily: t.t.font, fontStyle: t.t.style, size: t.size,
      leading: { kind: "points", value: Math.round(t.size * (t.t.lead || 1.2) * 10) / 10 },
      tracking: t.t.tracking || 0, capitalization: t.t.caps ? "allCaps" : "normal",
      fill: await swatch(t.color), fillTint: 1,
    } } });
    steps.push({ command: "type.para", params: { attrs: { align: t.align, hyphenate: f.role === "body" && (t.columns || 1) > 1, balanceRagged: false /* DesignCraft 0.7.1 splits words to balance ("SUMME / R BOOK") */, spaceBefore: 0, spaceAfter: f.role === "body" ? Math.round(t.size * 0.6) : 0 } } });
  }
  // Stacking, back to front: the look's background, the photos, the look's
  // fades and blocks, then the type.
  for (const id of [...z.back, ...images, ...z.over, ...texts]) steps.push({ command: "object.arrange", params: { to: "front", ids: [id] } });
  steps.push({ command: "selection.set", params: { ids: [] } });
  const r = await call("batch", { commands: steps });
  // Measured against DesignCraft's own line breaks: grow anything it cut off.
  const cut = [], lines = {}, grew = {};
  for (const f of plan.frames.filter((g) => g.text)) {
    let s = await call("get_story", { frame: f.id });
    let h = f.box[3];
    for (let k = 0; s?.overset != null && k < 40; k++) {
      h += Math.max(1, Math.ceil(f.text.size * 0.1));
      await exec("transform.set", { height: h, ref: 0, ids: [f.id] });
      s = await call("get_story", { frame: f.id });
    }
    if (s?.overset != null) cut.push(f.role);
    lines[f.id] = s?.lines;
    if (h > f.box[3]) grew[f.id] = (h - f.box[3]) / f.text.size;
  }
  return { batch: r, cut, lines, grew };
}

/** The palette of a picture file (PNG, JPEG, WebP…). sharp comes with the
 *  app's dependencies; without it, or for a file it can't read, the look's
 *  own colours are used. */
const paletteCache = new Map();
export async function imagePalette(path) {
  if (!path) return defaultPalette();
  if (paletteCache.has(path)) return paletteCache.get(path);
  let pal;
  try {
    const sharp = (await import("sharp")).default;
    const { data } = await sharp(path).resize(56, 56, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    pal = paletteFrom(clusterColours(data, 6));
  } catch {
    pal = defaultPalette();
  }
  paletteCache.set(path, pal);
  return pal;
}

/** Plan, set, and plan again where DesignCraft broke lines differently from
 *  the estimate (kerning), so the spacing is built on the real line count. */
export async function layoutLook(call, look, page, parts, pal) {
  let plan, res;
  for (let pass = 0; pass < 4; pass++) {
    plan = planLook(look, page, parts, pal);
    res = await applyPlan(call, plan, await call("inspect_document", {}), page);
    const off = plan.frames.filter((f) => f.text && ((res.lines[f.id] != null && res.lines[f.id] !== f.text.lines) || res.grew[f.id]));
    if (process.env.CC_LOOK_DEBUG) console.error("pass", pass, plan.frames.filter((f) => f.text).map((f) => `${f.role} ${f.text.size}pt plan ${f.text.lines} dc ${res.lines[f.id]} h ${Math.round(f.box[3])}`).join(" / "));
    if (!off.length) break;
    for (const f of off) {
      const p = parts.find((q) => q.id === f.id);
      if (!p) continue;
      // Exact at this size; and a nudge for any other size the next plan picks.
      p.dcLines = { size: f.text.size, w: Math.round(f.text.w), lines: res.lines[f.id] };
      if (res.lines[f.id] !== f.text.lines) p.fudge = (p.fudge || 1) * (res.lines[f.id] > f.text.lines ? 1.05 : 0.97);
      // Same lines but DesignCraft still wanted more depth: plan that in.
      else if (res.grew[f.id]) p.extraEm = (p.extraEm || 0) + res.grew[f.id];
    }
  }
  return { plan, cut: res.cut, issues: [...planIssues(plan, page), ...res.cut.map((r) => `${r} is cut off: its text doesn't fit`)] };
}
