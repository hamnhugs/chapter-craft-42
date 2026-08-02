import type { Blueprint } from "./schema";
import {
  resolveAssembly, projectAssembly, commonBounds, boundsOf,
  type ProjectedView, type ViewName, type Box, type Vec2,
  DEFAULT_VIEWS, VIEW_LABEL,
} from "./geometry";
import { packGrid } from "./pack";

// The production sheet renderer. Blueprint in, SVG out, deterministically.
//
// EVERY NUMBER HERE IS COMPUTED, NEVER AUTHORED. That is the entire point: a
// model asked to emit SVG coordinates scores at chance on path geometry, and
// asked to draw three agreeing views it scores 54-60% — its worst subtask. So
// the views come out of one projection of one assembly and the layout comes out
// of a packer.
//
// DRAWING RULES, each of which exists because of a specific failure:
//   - Presentation attributes only. No <style>, no CSS, no class-based theming
//     — DOMPurify's own threat model excludes CSS attacks, and a technical
//     drawing loses nothing by painting with fill= and stroke=.
//   - Labels are pinned with textLength + lengthAdjust. You cannot measure text
//     before it renders (getComputedTextLength returns 0 off the render tree),
//     so width is DECIDED rather than discovered and nothing can overflow.
//   - Repeated marks come from <defs>/<use>. Node count is what makes a large
//     SVG slow, and a dimensioned turnaround reaches hundreds of nodes fast.
//   - No width/height on the root; a viewBox and nothing else, so the panel
//     sizes it. Extents are clamped upstream because a zero-extent viewBox
//     disables rendering entirely and blanks the panel silently.
//   - Same scale across every panel of a turnaround. Panels at different scales
//     are the fastest way to make a proportion reference useless.

export const SHEET_WIDTH = 1000;
const MARGIN = 32;
const GAP = 16;
const TITLE_H = 74;
const PANEL_LABEL_H = 22;
const SECTION_GAP = 26;

const INK = "#16191d";
const RULE = "#c7ced6";
const FAINT = "#e6eaef";
const PART_FILL = "#ffffff";
const PART_STROKE = "#1c2126";
const MIRROR_STROKE = "#7d8894";
const ACCENT = "#b8402a";
const NONPHOTO = "#6d97ba";
const PAPER = "#ffffff";

/** Average advance width as a fraction of font size, used ONLY to decide where
 *  to wrap a note or truncate a long name. It is an estimate and is documented
 *  as one: anything that must fit exactly gets textLength instead. */
const ADVANCE = 0.52;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Round to 2dp so the same blueprint always yields byte-identical markup and
 *  a sheet can be diffed. */
function n(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 100) / 100);
}

function charsThatFit(width: number, fontSize: number): number {
  return Math.max(1, Math.floor(width / (fontSize * ADVANCE)));
}

function truncate(text: string, width: number, fontSize: number): string {
  const max = charsThatFit(width, fontSize);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function wrap(text: string, width: number, fontSize: number): string[] {
  const max = charsThatFit(width, fontSize);
  const words = text.split(/\s+/).filter(Boolean);
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

/**
 * A label that cannot overflow its box.
 *
 * `textLength` + `lengthAdjust="spacingAndGlyphs"` makes the user agent squeeze
 * the run to exactly the width given, which is the one way to guarantee fit
 * without measuring. It is only applied when the estimate says the text would
 * otherwise be too wide — squeezing short text would look wrong.
 */
function label(
  text: string,
  x: number,
  y: number,
  opts: { size?: number; fill?: string; anchor?: "start" | "middle" | "end"; maxWidth?: number; weight?: number; mono?: boolean } = {},
): string {
  const size = opts.size ?? 12;
  const fill = opts.fill ?? INK;
  const anchor = opts.anchor ?? "start";
  const family = opts.mono
    ? "ui-monospace, Consolas, monospace"
    : "system-ui, Segoe UI, Helvetica, Arial, sans-serif";
  const weightAttr = opts.weight ? ` font-weight="${opts.weight}"` : "";
  const clean = esc(text);
  let fit = "";
  if (opts.maxWidth !== undefined) {
    const estimated = text.length * size * ADVANCE;
    if (estimated > opts.maxWidth) fit = ` textLength="${n(opts.maxWidth)}" lengthAdjust="spacingAndGlyphs"`;
  }
  return `<text x="${n(x)}" y="${n(y)}" font-family="${family}" font-size="${n(size)}" fill="${fill}" text-anchor="${anchor}"${weightAttr}${fit}>${clean}</text>`;
}

// ── symbol library ──────────────────────────────────────────────────────────
//
// One definition, many <use>. A turnaround with attach points and pivots would
// otherwise emit the same six-node glyph twenty times.

const DEFS = [
  '<defs>',
  // Attach point: a small open ring with a cross, the drafting convention for
  // a located point rather than a drawn feature.
  `<g id="bp-anchor"><circle r="4" fill="none" stroke="${ACCENT}" stroke-width="1.2"/>`,
  `<path d="M -6 0 L 6 0 M 0 -6 L 0 6" stroke="${ACCENT}" stroke-width="0.8"/></g>`,
  // Joint pivot: filled centre, so it reads differently from an attach point at
  // a glance — they frequently sit on top of each other.
  `<g id="bp-pivot"><circle r="3.4" fill="${NONPHOTO}" stroke="${INK}" stroke-width="1"/>`,
  `<circle r="1.1" fill="${INK}"/></g>`,
  // Registration mark for the sheet corners.
  `<g id="bp-reg"><path d="M -7 0 L 7 0 M 0 -7 L 0 7" stroke="${RULE}" stroke-width="0.8"/>`,
  `<circle r="3.5" fill="none" stroke="${RULE}" stroke-width="0.8"/></g>`,
  // Dimension arrowhead.
  `<marker id="bp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`,
  `<path d="M 0 0 L 8 4 L 0 8 z" fill="${INK}"/></marker>`,
  '</defs>',
].join("");

// ── sheet assembly ──────────────────────────────────────────────────────────

export interface SheetOptions {
  views?: ViewName[];
  /** Drawn line weight. Also the control-strength dial when the sheet is
   *  rasterised for conditioning: thicker lines let a generator reinterpret
   *  more, thinner lines hold it closer to the drawing. */
  strokeWidth?: number;
  showAnchors?: boolean;
  showLandmarks?: boolean;
  /** Sheet revision string printed in the title block. */
  revision?: string;
}

export interface SheetResult {
  svg: string;
  width: number;
  height: number;
  /** Element count, so a caller can refuse to render something that would
   *  crawl. Degradation starts in the low thousands of nodes. */
  nodeCount: number;
  views: ViewName[];
  /** Anything the renderer had to leave off, named out loud rather than
   *  silently dropped. */
  omitted: string[];
}

interface PanelPlan {
  view: ViewName;
  projected: ProjectedView;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Map a point from view space into a panel's pixel space. */
function makeMapper(bounds: Box, panel: { x: number; y: number; w: number; h: number }, scale: number) {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const px = panel.x + panel.w / 2;
  const py = panel.y + panel.h / 2;
  return (p: Vec2) => ({ x: px + (p.x - cx) * scale, y: py + (p.y - cy) * scale });
}

export function renderBlueprintSheet(bp: Blueprint, opts: SheetOptions = {}): SheetResult {
  const views = (opts.views?.length ? opts.views : DEFAULT_VIEWS).slice(0, 6);
  const strokeWidth = Math.max(0.4, Math.min(6, opts.strokeWidth ?? 1.4));
  const showAnchors = opts.showAnchors ?? true;
  const showLandmarks = opts.showLandmarks ?? true;
  const omitted: string[] = [];

  const asm = resolveAssembly(bp);
  if (asm.orphans.length) {
    omitted.push(`${asm.orphans.length} part(s) never reached the root and are not drawn: ${asm.orphans.join(", ")}`);
  }
  const projected = views.map((v) => projectAssembly(asm, v));
  const shared = commonBounds(projected);

  // Solids are drawn for anything hard-surface. A purely organic blueprint gets
  // the scaffold instead — real model sheets do the same thing, because a
  // turnaround of an organic character is a proportion guide, not a projection.
  const drawSolids = bp.form !== "organic" && asm.parts.length > 0;

  const body: string[] = [];
  let nodes = 0;
  const push = (markup: string, count = 1) => { body.push(markup); nodes += count; };

  // ── panels ──
  const panelW = (SHEET_WIDTH - MARGIN * 2 - GAP * (views.length - 1)) / views.length;
  const panelH = Math.max(200, Math.min(420, panelW * (shared.h / Math.max(shared.w, 1e-6))));
  const grid = packGrid(views.map((v) => ({ id: v, w: panelW, h: panelH + PANEL_LABEL_H })), views.length, GAP);

  const panelsTop = MARGIN + TITLE_H + SECTION_GAP;
  const scale = Math.min(panelW / shared.w, panelH / shared.h) * 0.86;

  const panels: PanelPlan[] = grid.placements.map((place, i) => ({
    view: views[i],
    projected: projected[i],
    x: MARGIN + place.x,
    y: panelsTop + place.y + PANEL_LABEL_H,
    w: panelW,
    h: panelH,
  }));

  // Landmark lines run across ALL panels at one height. This is the single
  // clearest proof on the page that the views agree — and for an organic
  // subject it is the drawing.
  const worldAll = asm.parts.flatMap((p) => p.points);
  const groundY = worldAll.length ? Math.min(...worldAll.map((p) => p.y)) : 0;
  const topY = worldAll.length ? Math.max(...worldAll.map((p) => p.y)) : bp.heightHeads;
  const headUnit = worldAll.length && bp.heightHeads > 0 ? (topY - groundY) / bp.heightHeads : 1;

  for (const panel of panels) {
    const map = makeMapper(shared, panel, scale);

    push(`<rect x="${n(panel.x)}" y="${n(panel.y)}" width="${n(panel.w)}" height="${n(panel.h)}" fill="${PAPER}" stroke="${RULE}" stroke-width="1"/>`);
    push(label(VIEW_LABEL[panel.view], panel.x, panel.y - 7, { size: 11, fill: "#5c6570", weight: 600, maxWidth: panel.w, mono: true }));

    // Landmarks first so solids overprint them.
    if (showLandmarks && bp.landmarks.length) {
      for (const lm of bp.landmarks) {
        const worldY = groundY + lm.atHeads * headUnit;
        const sy = map({ x: 0, y: -worldY }).y;
        if (sy < panel.y || sy > panel.y + panel.h) continue;
        push(`<line x1="${n(panel.x)}" y1="${n(sy)}" x2="${n(panel.x + panel.w)}" y2="${n(sy)}" stroke="${NONPHOTO}" stroke-width="0.7" stroke-dasharray="4 3"/>`);
        if (panel === panels[0]) {
          push(label(lm.name, panel.x + 4, sy - 3, { size: 9, fill: NONPHOTO, maxWidth: panel.w - 8 }));
        }
      }
    }

    if (drawSolids) {
      for (const part of panel.projected.parts) {
        if (part.outline.length < 3) continue;
        const swatch = bp.palette.find((s) => s.role === part.swatch);
        const pts = part.outline.map((p) => { const m = map(p); return `${n(m.x)},${n(m.y)}`; }).join(" ");
        push(
          `<polygon points="${pts}" fill="${swatch ? esc(swatch.hex) : PART_FILL}" fill-opacity="${swatch ? "0.9" : "1"}" ` +
          `stroke="${part.mirrored ? MIRROR_STROKE : PART_STROKE}" stroke-width="${n(strokeWidth)}" stroke-linejoin="round"/>`,
        );
      }
    } else {
      // Scaffold: the silhouette envelope plus a centre line. Honest about what
      // it is — a proportion guide, not a depiction.
      const env = panel.projected.parts.length ? boundsOf(panel.projected.parts.flatMap((p) => p.outline)) : shared;
      const a = map({ x: env.x, y: env.y });
      const b = map({ x: env.x + env.w, y: env.y + env.h });
      push(`<rect x="${n(a.x)}" y="${n(a.y)}" width="${n(b.x - a.x)}" height="${n(b.y - a.y)}" fill="none" stroke="${RULE}" stroke-width="${n(strokeWidth)}" stroke-dasharray="6 4"/>`);
      const mid = (a.x + b.x) / 2;
      push(`<line x1="${n(mid)}" y1="${n(a.y)}" x2="${n(mid)}" y2="${n(b.y)}" stroke="${FAINT}" stroke-width="1"/>`);
    }

    if (showAnchors) {
      for (const anchor of panel.projected.anchors) {
        const m = map(anchor.at);
        if (m.x < panel.x || m.x > panel.x + panel.w || m.y < panel.y || m.y > panel.y + panel.h) continue;
        push(`<use href="#bp-anchor" x="${n(m.x)}" y="${n(m.y)}"/>`);
      }
      for (const joint of bp.joints) {
        const anchor = panel.projected.anchors.find((a) => a.id === joint.at);
        if (!anchor) continue;
        const m = map(anchor.at);
        if (m.x < panel.x || m.x > panel.x + panel.w || m.y < panel.y || m.y > panel.y + panel.h) continue;
        push(`<use href="#bp-pivot" x="${n(m.x)}" y="${n(m.y)}"/>`);
      }
    }
  }

  let cursorY = panelsTop + PANEL_LABEL_H + panelH + SECTION_GAP;

  // ── palette ──
  //
  // This block is the highest-value thing on the sheet. Hex in a prompt string
  // measures under 10% adherence; the same colour rendered as a swatch and
  // shown to the model measured ΔE 0.90 against 11.25 for the text. The picture
  // is the specification.
  if (bp.palette.length) {
    push(label("PALETTE", MARGIN, cursorY, { size: 10, fill: "#5c6570", weight: 700, mono: true }));
    cursorY += 12;
    const chipW = 96, chipH = 52, chipGap = 10;
    const perRow = Math.max(1, Math.floor((SHEET_WIDTH - MARGIN * 2 + chipGap) / (chipW + chipGap)));
    bp.palette.forEach((sw, i) => {
      const x = MARGIN + (i % perRow) * (chipW + chipGap);
      const y = cursorY + Math.floor(i / perRow) * (chipH + chipGap);
      push(`<rect x="${n(x)}" y="${n(y)}" width="${n(chipW)}" height="${n(chipH - 20)}" fill="${esc(sw.hex)}" stroke="${RULE}" stroke-width="0.8"/>`);
      push(label(sw.role, x, y + chipH - 8, { size: 10, weight: 600, maxWidth: chipW }));
      push(label(sw.hex.toUpperCase(), x, y + chipH + 3, { size: 9, fill: "#5c6570", maxWidth: chipW, mono: true }));
    });
    cursorY += Math.ceil(bp.palette.length / perRow) * (chipH + chipGap) + SECTION_GAP;
  }

  // ── scale bar ──
  push(label("SCALE", MARGIN, cursorY, { size: 10, fill: "#5c6570", weight: 700, mono: true }));
  cursorY += 16;
  const scaleW = 240;
  push(`<line x1="${n(MARGIN)}" y1="${n(cursorY)}" x2="${n(MARGIN + scaleW)}" y2="${n(cursorY)}" stroke="${INK}" stroke-width="1" marker-start="url(#bp-arrow)" marker-end="url(#bp-arrow)"/>`);
  const heightText = bp.absoluteHeight
    ? `${bp.heightHeads} heads · ${bp.absoluteHeight.value}${bp.absoluteHeight.unit}`
    : `${bp.heightHeads} heads`;
  push(label(heightText, MARGIN + scaleW + 10, cursorY + 4, { size: 11, maxWidth: 300 }));
  // Head-unit ticks make the proportion legible without reading the number.
  const headsToShow = Math.min(12, Math.max(1, Math.round(bp.heightHeads)));
  for (let i = 0; i <= headsToShow; i++) {
    const x = MARGIN + (scaleW * i) / headsToShow;
    push(`<line x1="${n(x)}" y1="${n(cursorY - 4)}" x2="${n(x)}" y2="${n(cursorY + 4)}" stroke="${INK}" stroke-width="0.7"/>`);
  }
  cursorY += SECTION_GAP + 6;

  // ── text blocks ──
  const textBlock = (heading: string, lines: string[]) => {
    if (!lines.length) return;
    push(label(heading, MARGIN, cursorY, { size: 10, fill: "#5c6570", weight: 700, mono: true }));
    cursorY += 15;
    const colW = SHEET_WIDTH - MARGIN * 2;
    for (const line of lines) {
      for (const part of wrap(line, colW - 12, 11)) {
        push(label(part, MARGIN + 10, cursorY, { size: 11, maxWidth: colW - 12 }));
        cursorY += 15;
      }
    }
    cursorY += SECTION_GAP - 10;
  };

  if (bp.silhouette) textBlock("SILHOUETTE", [bp.silhouette]);
  textBlock("CONSTRUCTION", bp.notes);
  if (bp.marks.length) {
    textBlock("MARKS", bp.marks.map((m) => `${m.name} — ${m.side} of ${m.part}: ${m.description}`));
  }
  if (bp.costume.length) {
    textBlock("COSTUME", bp.costume.map((c) => `${c.name}${c.state ? ` (${c.state})` : ""} — covers ${c.covers.join(", ") || "nothing declared"}`));
  }
  if (bp.negatives.length) textBlock("NEVER", bp.negatives);

  const height = Math.max(400, cursorY + MARGIN);

  // ── title block + frame ──
  const head: string[] = [];
  head.push(`<rect x="0" y="0" width="${n(SHEET_WIDTH)}" height="${n(height)}" fill="${PAPER}"/>`);
  head.push(`<rect x="${n(MARGIN / 2)}" y="${n(MARGIN / 2)}" width="${n(SHEET_WIDTH - MARGIN)}" height="${n(height - MARGIN)}" fill="none" stroke="${RULE}" stroke-width="1"/>`);
  for (const [cx, cy] of [[MARGIN / 2, MARGIN / 2], [SHEET_WIDTH - MARGIN / 2, MARGIN / 2], [MARGIN / 2, height - MARGIN / 2], [SHEET_WIDTH - MARGIN / 2, height - MARGIN / 2]]) {
    head.push(`<use href="#bp-reg" x="${n(cx)}" y="${n(cy)}"/>`);
  }
  head.push(label(truncate(bp.name, SHEET_WIDTH - MARGIN * 2 - 260, 22), MARGIN, MARGIN + 26, { size: 22, weight: 650, maxWidth: SHEET_WIDTH - MARGIN * 2 - 260 }));
  const meta = [bp.kind, bp.form.replace(/_/g, " "), `${bp.parts.length} parts`, opts.revision ? `rev ${opts.revision}` : ""].filter(Boolean).join("  ·  ");
  head.push(label(meta, MARGIN, MARGIN + 44, { size: 10, fill: "#5c6570", maxWidth: SHEET_WIDTH - MARGIN * 2 - 260, mono: true }));
  if (bp.validity && (bp.validity.fromChapter !== undefined || bp.validity.toChapter !== undefined)) {
    const from = bp.validity.fromChapter ?? "start";
    const to = bp.validity.toChapter ?? "end";
    head.push(label(`valid: chapters ${from}–${to}`, SHEET_WIDTH - MARGIN, MARGIN + 44, { size: 10, fill: ACCENT, anchor: "end", maxWidth: 250, mono: true }));
  }
  head.push(`<line x1="${n(MARGIN)}" y1="${n(MARGIN + TITLE_H - 16)}" x2="${n(SHEET_WIDTH - MARGIN)}" y2="${n(MARGIN + TITLE_H - 16)}" stroke="${INK}" stroke-width="1.4"/>`);
  nodes += head.length + 6;

  const descParts = [
    `${bp.kind} blueprint sheet for ${bp.name}.`,
    `${views.map((v) => VIEW_LABEL[v]).join(", ")} ${views.length === 1 ? "view" : "views"} projected from one assembly of ${bp.parts.length} parts.`,
    bp.palette.length ? `Palette of ${bp.palette.length} locked swatches.` : "",
  ].filter(Boolean).join(" ");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(SHEET_WIDTH)} ${n(height)}" role="graphics-document" aria-labelledby="bp-title" preserveAspectRatio="xMidYMid meet">`,
    `<title id="bp-title">${esc(bp.name)} — blueprint sheet</title>`,
    `<desc>${esc(descParts)}</desc>`,
    DEFS,
    ...head,
    ...body,
    `</svg>`,
  ].join("");

  return { svg, width: SHEET_WIDTH, height, nodeCount: nodes, views, omitted };
}
