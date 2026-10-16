/**
 * Generated jackets for books without a cover image.
 *
 * A book on a shelf with no cover wears a jacket in its shelf's color (see
 * shelfMarks.ts). Every jacket used to be identical — same gradient, same
 * glyph dead centre — so a shelf of sixteen papers read as sixteen copies of
 * one picture, and the eye had nothing to tell them apart by but the small
 * title underneath. A series design keeps the family resemblance (color,
 * glyph) and varies the composition per book, the way a publisher's series
 * covers do: where the light falls, the rule spacing, where and how large the
 * glyph sits. Everything derives from the book's id, so a book keeps its face
 * whatever order the grid is sorted in.
 */

/** Small deterministic PRNG over a 32-bit seed (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface JacketLayout {
  /** CSS background for the jacket layer. */
  background: string;
  /** Glyph placement, as CSS for an absolutely positioned element. */
  glyph: { left: string; top: string; fontSize: string; transform: string; opacity: number };
}

export function jacketLayout(seed: number, color: string): JacketLayout {
  const r = rng(seed);
  const lx = Math.round(15 + r() * 70); // light source x %
  const ly = Math.round(r() * 60); // light source y %
  const angle = [90, 90, 75, 105, 60, 120][Math.floor(r() * 6)];
  const gap = 10 + Math.floor(r() * 3) * 4; // 10, 14 or 18px rules
  // Glyph: off-centre, toward the side away from the light — never centred.
  const gx = lx < 50 ? 58 + r() * 22 : 20 + r() * 22;
  const gy = 30 + r() * 30;
  const size = 3 + r() * 1.6; // rem
  const rot = Math.round((r() - 0.5) * 30);
  return {
    background:
      `radial-gradient(120% 110% at ${lx}% ${ly}%, ${color}d9, ${color}59 55%, transparent 100%), ` +
      `repeating-linear-gradient(${angle}deg, rgba(255,255,255,0.05) 0 2px, transparent 2px ${gap}px), #0b0812`,
    glyph: {
      left: `${gx.toFixed(1)}%`,
      top: `${gy.toFixed(1)}%`,
      fontSize: `${size.toFixed(2)}rem`,
      transform: `translate(-50%, -50%) rotate(${rot}deg)`,
      opacity: 0.9,
    },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A leading date in a title — "2026-09 - What Drives…", "2026 - AI Labels…",
 * "2025-1- LLM…" — as a jacket kicker ("Sep 2026"). Research PDFs are filed
 * under their date, which is useful, but as the first eleven characters of
 * every title it pushes the words that differ into the ellipsis.
 */
export function titleDate(title: string): string | null {
  // Year, optional month, then a separator — or, after a month, just a space
  // before a capitalised word ("2026-01 Mapping Morality…").
  const m = /^\s*((?:19|20)\d{2})(?:\s*[-./]\s*(\d{1,2})(?!\d))?(?:\s*[-–—:]|\s+(?=[A-Z]))/.exec(title);
  // A bare year before a word is a title ("1984 Revisited"), not a filing date.
  if (!m || (!m[2] && /\s$/.test(m[0]))) return null;
  const month = m[2] ? Number(m[2]) : 0;
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : m[1];
}
