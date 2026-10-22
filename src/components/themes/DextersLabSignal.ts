/**
 * Dexter's Laboratory — the model behind the app-bar brainwave monitor
 * (DextersLabArt.tsx). Pure functions, so the test suite can pin them down.
 *
 * The bar is an EEG of the reader. Left alone it draws calm alpha waves; every
 * keystroke, click or scroll pumps "energy" into it and the trace climbs into
 * spiky beta, then settles back as the energy decays. The lab's lighting
 * follows the local clock: lights up by day, half-lit at dusk, and after
 * bedtime it goes into secret-lab mode (instruments brighter, room darker) —
 * which is, after all, when the real work in that lab gets done.
 */

// ── The palette, by name. Mirrored as --dl-* custom props in index.css. ──────
export const DL = {
  ink: "#0c0219", // the cartoon's ink line: outlines, hard shadows, text on light
  well: "#150629", // the deepest surface: app bar, input wells
  night: "#1a0b2e", // canvas
  surface: "#27183b", // panel glass
  surfaceHigh: "#322346",
  line: "#4a2f6b", // hairlines between panels
  on: "#eddcff", // lab-coat lavender white — body text
  onVariant: "#d4c0d7", // secondary text
  dim: "#a996b8", // placeholders, tertiary labels
  violet: "#bd00ff", // the lab's signature (fills, never small text)
  violetDeep: "#7a12c4", // violet that carries white text
  lavender: "#ecb2ff", // primary text-on-dark
  cyan: "#00eefc", // phosphor: scopes, focus, the AI's voice
  cyanSoft: "#5ff3ff",
  magenta: "#e7006e", // alarm (fills, white text)
  pink: "#ff5cad", // magenta that reads as text on violet
  lemon: "#f8d878", // warning lamps, the LAB sticker
} as const;

/**
 * Every text/background pair the skin sets, with the WCAG minimum it must
 * clear (4.5 body text, 3 for large display text / non-text UI).
 */
export const DL_CONTRAST_PAIRS: ReadonlyArray<[fg: string, bg: string, min: number, what: string]> = [
  [DL.on, DL.night, 4.5, "body text on canvas"],
  [DL.on, DL.surface, 4.5, "body text on panels"],
  [DL.onVariant, DL.surface, 4.5, "secondary text on panels"],
  [DL.dim, DL.surface, 4.5, "placeholder text on panels"],
  [DL.dim, DL.well, 4.5, "placeholder text in inputs"],
  [DL.on, DL.well, 4.5, "input text, app bar"],
  [DL.lavender, DL.night, 4.5, "primary text on canvas"],
  [DL.pink, DL.night, 4.5, "accent text on canvas"],
  [DL.pink, DL.surface, 4.5, "accent text on panels"],
  [DL.cyan, DL.well, 4.5, "phosphor labels on the app bar"],
  [DL.ink, DL.lavender, 4.5, "holo button text (lavender end)"],
  [DL.ink, DL.cyanSoft, 4.5, "holo button text (cyan middle)"],
  [DL.ink, DL.lemon, 4.5, "holo button text / LAB sticker"],
  ["#ffffff", DL.violetDeep, 4.5, "user chat bubble, violet fills"],
  ["#ffffff", DL.magenta, 4.5, "alarm fills"],
  ["#ffffff", DL.violet, 4.5, "selection"],
  ["#e08bff", DL.surface, 4.5, "holo headline (violet end)"],
  [DL.cyanSoft, DL.surface, 4.5, "holo headline (cyan middle)"],
  [DL.lemon, DL.surface, 4.5, "holo headline (lemon end)"],
  [DL.cyan, DL.night, 3, "focus ring"],
];

/** WCAG relative-luminance contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace("#", "");
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ── Lab lighting ────────────────────────────────────────────────────────────
export type LabShift = "day" | "dusk" | "night";

/** Lights up 07–17, half-lit 06–07 and 17–21, secret lab 21–06 (local time). */
export function labShift(d: Date): LabShift {
  const h = d.getHours();
  if (h >= 21 || h < 6) return "night";
  if (h >= 7 && h < 17) return "day";
  return "dusk";
}

// ── Brain energy ────────────────────────────────────────────────────────────
export type Stimulus = "key" | "pointer" | "wheel";
const BUMP: Record<Stimulus, number> = { key: 0.09, pointer: 0.22, wheel: 0.04 };
/** Energy halves every this many ms once the reader goes quiet. */
export const HALF_LIFE_MS = 1400;
/** Above this the monitor reads beta (focused) instead of alpha (calm). */
export const BETA_AT = 0.4;

export function bump(energy: number, s: Stimulus): number {
  return Math.min(1, energy + BUMP[s]);
}

export function decay(energy: number, dtMs: number): number {
  const e = energy * Math.pow(0.5, Math.max(0, dtMs) / HALF_LIFE_MS);
  return e < 0.01 ? 0 : e;
}

// ── Waveforms ───────────────────────────────────────────────────────────────
// One tile is TILE units wide; the path covers two tiles and the CSS slides it
// left by exactly one, so every frequency must complete a whole number of
// cycles per tile or the loop would show a seam.
export const TILE = 1200;
export const WAVE_H = 40;
const MID = WAVE_H / 2;

function pathOf(fn: (x: number) => number, step: number): string {
  let d = "";
  for (let x = 0; x <= TILE * 2; x += step) {
    const y = MID - fn(x % TILE);
    d += `${x === 0 ? "M" : "L"}${x} ${y.toFixed(2)}`;
  }
  return d;
}

const TAU = Math.PI * 2;
const wave = (cycles: number, x: number) => Math.sin((TAU * cycles * x) / TILE);

/** Alpha rhythm: a slow, rounded ~10-cycle swell. */
export function calmWave(x: number): number {
  return 13 * (0.72 * wave(9, x) + 0.18 * wave(23, x) + 0.16 * wave(2, x));
}

/** Beta rhythm: fast and jagged, with a spike every quarter tile. */
export function hotWave(x: number): number {
  let y = 6 * (0.6 * wave(37, x) + 0.4 * wave(61, x));
  for (const c of [170, 470, 760, 1060]) {
    const t = (x - c) / 7;
    y += 17 * -t * Math.exp(-t * t); // a sharp up-down blip
  }
  return Math.max(-MID + 1, Math.min(MID - 1, y));
}

export const CALM_PATH = pathOf(calmWave, 6);
export const HOT_PATH = pathOf(hotWave, 3);
