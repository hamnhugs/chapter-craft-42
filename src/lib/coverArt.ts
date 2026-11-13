/**
 * A cover for a book that has none — which is most of them: nothing in the
 * client ever writes `cover_image_url`.
 *
 * The placeholder used to be a blank gradient rectangle with the title in one
 * corner, and a wall of those is what made the Showcase look unfinished: the
 * largest thing on the stage was an empty box. This draws one instead. Every
 * book gets a flat, two-tone geometric composition in the manner of a
 * mid-century paperback series — a sun over a horizon, stacked arcs, a run of
 * columns, quarter-circle tiles — chosen and proportioned by the book's id
 * hash, so a book looks like itself every time and like nothing else on the
 * shelf. A library of a thousand books has a thousand covers and nobody drew
 * any of them.
 *
 * PURE. Numbers in, shapes out: no DOM, no colour, no randomness that is not
 * the seed. Tones are KEYS, resolved by the caller from the theme layer, which
 * is the same split the worm's geometry uses and for the same reason — the
 * drawing must not know what theme it is in.
 *
 * FLAT. No gradients, no shadows, no outlines, at most three tones. The
 * compositions are deliberately few and strict; variety comes from proportion,
 * not from a bigger vocabulary. Six families read as a series. Sixty would
 * read as noise.
 */

/** The art sits in this box; the caller reserves its own band for the title. */
export const ART_W = 60;
export const ART_H = 52;

export type CoverTone = "figure" | "accent" | "ground";

export type CoverShape =
  | { k: "circle"; cx: number; cy: number; r: number; tone: CoverTone }
  | { k: "rect"; x: number; y: number; w: number; h: number; tone: CoverTone }
  | { k: "path"; d: string; tone: CoverTone };

export interface CoverArt {
  family: (typeof FAMILIES)[number];
  shapes: CoverShape[];
}

export const FAMILIES = ["sun", "arcs", "columns", "tiles", "eclipse", "strata"] as const;

/** mulberry32 — small, fast, and well distributed from a 32-bit seed. */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function coverArt(seed: number): CoverArt {
  const rnd = rngFrom(seed);
  // The family comes off the generator rather than `seed % 6`: FNV hashes of
  // similar ids share low bits, and a shelf of "Book 1".."Book 9" came out
  // with the same composition nine times.
  const family = FAMILIES[Math.floor(rnd() * FAMILIES.length)];
  const between = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const shapes: CoverShape[] = [];
  const W = ART_W, H = ART_H;

  if (family === "sun") {
    // A disc over a horizon. The oldest cover there is.
    const horizon = between(0.58, 0.74) * H;
    const r = between(0.2, 0.3) * W;
    const cx = between(0.3, 0.7) * W;
    // Rising or set: the disc either clears the horizon or is cut by it.
    const cy = horizon - r * between(0.15, 1.15);
    shapes.push({ k: "circle", cx: r2(cx), cy: r2(cy), r: r2(r), tone: "accent" });
    shapes.push({ k: "rect", x: 0, y: r2(horizon), w: W, h: r2(H - horizon), tone: "figure" });
  } else if (family === "arcs") {
    // Concentric half-discs from the foot of the art, alternating tone.
    const cx = pick([0.5, 0.5, 0.22, 0.78]) * W;
    const n = 3 + Math.floor(rnd() * 3);
    const outer = between(0.62, 0.8) * W;
    for (let i = 0; i < n; i++) {
      const r = outer * (1 - i / n);
      shapes.push({ k: "circle", cx: r2(cx), cy: H, r: r2(r), tone: i % 2 ? "ground" : i === 0 ? "figure" : "accent" });
    }
  } else if (family === "columns") {
    // A run of bars standing on the foot — spines, a skyline, a histogram.
    const n = 4 + Math.floor(rnd() * 3);
    const gap = 2;
    const margin = 7;
    const bw = (W - margin * 2 - gap * (n - 1)) / n;
    const hot = Math.floor(rnd() * n);
    for (let i = 0; i < n; i++) {
      const h = between(0.28, 0.82) * H;
      shapes.push({ k: "rect", x: r2(margin + i * (bw + gap)), y: r2(H - h), w: r2(bw), h: r2(h), tone: i === hot ? "accent" : "figure" });
    }
  } else if (family === "tiles") {
    // Quarter-circle tiles. Each cell turns its quarter to one of four
    // corners; the eye joins them into paths nobody laid out.
    const cols = 4, rows = 3;
    const s = Math.min((W - 8) / cols, (H - 8) / rows);
    const ox = (W - s * cols) / 2, oy = (H - s * rows) / 2;
    const hot = Math.floor(rnd() * cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = ox + i * s, y = oy + j * s;
        const c = Math.floor(rnd() * 4);
        const [px, py] = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]][c];
        const [ax, ay] = [[x + s, y], [x + s, y + s], [x, y + s], [x, y]][c];
        const [bx, by] = [[x, y + s], [x, y], [x + s, y], [x + s, y + s]][c];
        shapes.push({
          k: "path",
          d: `M${r2(px)},${r2(py)}L${r2(ax)},${r2(ay)}A${r2(s)},${r2(s)} 0 0 1 ${r2(bx)},${r2(by)}Z`,
          tone: j * cols + i === hot ? "accent" : "figure",
        });
      }
    }
  } else if (family === "eclipse") {
    // Two discs, one biting the other. The bite is drawn in the ground tone,
    // so it is a crescent without being a path.
    const r = between(0.26, 0.34) * W;
    const cx = between(0.4, 0.6) * W, cy = between(0.42, 0.56) * H;
    const a = between(0, Math.PI * 2);
    const d = r * between(0.45, 0.8);
    shapes.push({ k: "circle", cx: r2(cx), cy: r2(cy), r: r2(r), tone: "figure" });
    shapes.push({ k: "circle", cx: r2(cx + Math.cos(a) * d), cy: r2(cy + Math.sin(a) * d), r: r2(r * between(0.78, 0.98)), tone: "ground" });
    shapes.push({ k: "circle", cx: r2(cx - Math.cos(a) * r * 1.35), cy: r2(cy - Math.sin(a) * r * 1.35), r: r2(r * 0.13), tone: "accent" });
  } else {
    // Strata: horizontal bands of uneven weight, one of them lit.
    const n = 4 + Math.floor(rnd() * 3);
    const weights = Array.from({ length: n }, () => between(0.5, 1.6));
    const total = weights.reduce((a, b) => a + b, 0);
    const hot = 1 + Math.floor(rnd() * (n - 1));
    let y = H * 0.16;
    const span = H - y;
    weights.forEach((wt, i) => {
      const h = (wt / total) * span;
      if (i % 2 === 0 || i === hot) {
        shapes.push({ k: "rect", x: 0, y: r2(y), w: W, h: r2(h + 0.05), tone: i === hot ? "accent" : "figure" });
      }
      y += h;
    });
  }

  return { family, shapes };
}
