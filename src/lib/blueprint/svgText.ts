// Shared drawing primitives for every sheet the app produces.
//
// One implementation of the text rules, because they are the easiest thing to
// get subtly wrong twice. In particular: SVG text width is unknowable before
// render (getComputedTextLength returns 0 for anything not in the render tree),
// so a label that must fit is PINNED with textLength + lengthAdjust rather than
// measured, and anything longer is truncated against an estimate that is
// documented as an estimate.

export const INK = "#16191d";
export const MUTED = "#5c6570";
export const RULE = "#c7ced6";
export const FAINT = "#e6eaef";
export const PAPER = "#ffffff";
export const ACCENT = "#b8402a";
export const NONPHOTO = "#6d97ba";

export const SANS = "system-ui, Segoe UI, Helvetica, Arial, sans-serif";
export const MONO = "ui-monospace, Consolas, monospace";

/** Average glyph advance as a fraction of font size. Used ONLY to decide where
 *  to wrap or truncate — never to position anything. Anything that must fit
 *  exactly gets textLength instead. */
export const ADVANCE = 0.52;

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Round to 2dp so the same input always yields byte-identical markup and two
 *  sheets can be diffed. */
export function n(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 100) / 100);
}

export function charsThatFit(width: number, fontSize: number): number {
  return Math.max(1, Math.floor(width / (fontSize * ADVANCE)));
}

export function truncate(text: string, width: number, fontSize: number): string {
  const max = charsThatFit(width, fontSize);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function wrap(text: string, width: number, fontSize: number): string[] {
  const max = charsThatFit(width, fontSize);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > max && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface LabelOptions {
  size?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  /** When given, the run is pinned to this width if it would otherwise be
   *  wider — which is the only way to guarantee fit without measuring. */
  maxWidth?: number;
  weight?: number;
  mono?: boolean;
}

export function label(text: string, x: number, y: number, opts: LabelOptions = {}): string {
  const size = opts.size ?? 12;
  const fill = opts.fill ?? INK;
  const anchor = opts.anchor ?? "start";
  const family = opts.mono ? MONO : SANS;
  const weightAttr = opts.weight ? ` font-weight="${opts.weight}"` : "";
  let fit = "";
  if (opts.maxWidth !== undefined && opts.maxWidth > 0) {
    const estimated = String(text).length * size * ADVANCE;
    if (estimated > opts.maxWidth) fit = ` textLength="${n(opts.maxWidth)}" lengthAdjust="spacingAndGlyphs"`;
  }
  return `<text x="${n(x)}" y="${n(y)}" font-family="${family}" font-size="${n(size)}" fill="${fill}" text-anchor="${anchor}"${weightAttr}${fit}>${esc(text)}</text>`;
}
