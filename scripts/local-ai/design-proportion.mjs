// Proportion guides for a DesignCraft page: where things look right.
//
// Why (the user, 2026-10-14): when the chat moves things around a page by
// raw commands it "has trouble with visual appeal" and is "unaware of the
// page size and frequently allows the text to be cut off". The model was
// inventing coordinates. So every page carries a set of guides a designer
// would lay down first, and whatever the model moves is snapped to the
// nearest one and kept on the page:
//
// - the margins and the centre line;
// - the golden section, 0.382 / 0.618 of the content box (Tschichold's and
//   Le Corbusier's proportion; a focal point there reads as deliberate,
//   where the dead centre reads as static);
// - the rule of thirds (the photographer's cousin of the golden section);
// - the edges of the other parts on the page, so things line up, and of the
//   same parts on the pages it sits with, so a spread matches;
// - gaps from a Fibonacci spacing scale (8, 13, 21, 34, 55, 89 pt) between a
//   part and the one above it, so the spacing has a rhythm instead of
//   whatever was left over.
//
// Type sizes follow a golden scale from MIN_TYPE (14, 23, 37, 59, 96 pt).
// Bringhurst, The Elements of Typographic Style, ch. 8 (page and margin
// proportions; the golden section and its musical intervals as type scales).

export const PHI = (1 + Math.sqrt(5)) / 2;
/** Gaps between parts, in points. */
export const SPACING = [8, 13, 21, 34, 55, 89];
const r1 = (v) => Math.round(v * 10) / 10;

/** Golden type scale: base × φ^n, up to what a line of `width` can hold. */
export function typeScale(base = 14, width = 540) {
  const out = [];
  for (let s = base; s <= Math.max(base, width / 4); s *= PHI) out.push(Math.round(s));
  return out;
}

/** Guide lines across a page's content box. `page` is designPage()'s shape:
 *  {bounds:[x0,y0,x1,y1], content:{left,top,right,bottom}}. Each guide is
 *  {at, kind}; kinds rank margin > align > golden > thirds > centre. */
export function pageGuides(page, minType = 14) {
  const [x0, y0, x1, y1] = page.bounds;
  const c = page.content;
  const cw = c.right - c.left, ch = c.bottom - c.top;
  const line = (lo, len) => [
    { at: lo + len / PHI ** 2, kind: "golden" }, { at: lo + len / PHI, kind: "golden" },
    { at: lo + len / 3, kind: "thirds" }, { at: lo + (2 * len) / 3, kind: "thirds" },
    { at: lo + len / 2, kind: "centre" },
  ];
  return {
    page: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    content: c,
    // A margin holds the edge on its side: a left edge on the left margin, never a middle.
    x: [{ at: c.left, kind: "margin", only: "start" }, { at: c.right, kind: "margin", only: "end" }, ...line(c.left, cw)].map((g) => ({ ...g, at: r1(g.at) })),
    y: [{ at: c.top, kind: "margin", only: "start" }, { at: c.bottom, kind: "margin", only: "end" }, ...line(c.top, ch)].map((g) => ({ ...g, at: r1(g.at) })),
    type_scale: typeScale(minType, cw),
    spacing: SPACING,
  };
}

/** The guides as the model reads them: page size, safe box, and the lines,
 *  in the page's own coordinates (DesignCraft's spread coordinates). */
export function guideSummary(page, minType = 14) {
  const g = pageGuides(page, minType);
  const pick = (list, kind) => list.filter((l) => l.kind === kind).map((l) => l.at);
  const inch = (pt) => Math.round((pt / 72) * 100) / 100;
  return {
    size: `${r1(g.page.w)} × ${r1(g.page.h)} pt (${inch(g.page.w)} × ${inch(g.page.h)} in), top-left at x ${r1(g.page.x)}, y ${r1(g.page.y)}`,
    safe_box: { left: r1(g.content.left), top: r1(g.content.top), right: r1(g.content.right), bottom: r1(g.content.bottom) },
    golden: { x: pick(g.x, "golden"), y: pick(g.y, "golden") },
    thirds: { x: pick(g.x, "thirds"), y: pick(g.y, "thirds") },
    centre: { x: pick(g.x, "centre")[0], y: pick(g.y, "centre")[0] },
    type_scale_pt: g.type_scale,
    spacing_pt: g.spacing,
  };
}

const RANK = { margin: 0, match: 1, align: 2, spacing: 3, golden: 4, thirds: 5, centre: 6 };

/** Best snap of a span [a, b] to `lines`: its start, middle or end onto one
 *  line, within `tol`. → {delta, edge, line} or null. Closer wins; within a
 *  point, the stronger kind wins (a margin over a golden line). */
export function snapSpan(a, b, lines, tol) {
  let best = null;
  const edges = [["start", a], ["middle", (a + b) / 2], ["end", b]];
  for (const l of lines) for (const [edge, v] of edges) {
    if (l.only && l.only !== edge) continue;
    const d = l.at - v;
    if (Math.abs(d) > tol) continue;
    const score = Math.abs(d) + (RANK[l.kind] ?? 9) * 0.25;
    if (!best || score < best.score) best = { delta: d, edge, line: l, score };
  }
  return best;
}

/** Where a moved or new part should sit. `box` [x0,y0,x1,y1]; `others` the
 *  other parts on the page ({bounds}); `matches` boxes of the same part on the
 *  pages this one sits with, already in this page's coordinates; `isText`
 *  keeps text inside the safe box (pictures may run to the trim and bleed).
 *  → {box, snapped: ["left edge to the margin", …], clamped}. */
export function placeBox(box, page, { others = [], matches = [], isText = true, bleed = 0, tol } = {}) {
  const g = pageGuides(page);
  tol ??= Math.max(6, g.page.w * 0.02);
  let [x0, y0, x1, y1] = box;
  const snapped = [];
  const say = (axis, s) => snapped.push(`${axis === "x" ? { start: "left edge", middle: "centre", end: "right edge" }[s.edge] : { start: "top", middle: "middle", end: "bottom" }[s.edge]} to the ${s.line.kind === "align" ? "edge of the part beside it" : s.line.kind === "match" ? "same part on the other page" : s.line.kind === "spacing" ? `${s.line.gap} pt gap ${s.line.above ? "above the part below" : "below the part above"}` : `${s.line.kind} line`} (${r1(s.line.at)})`);

  // Lines from the page, from the other parts and from the matching pages.
  const xs = [...g.x], ys = [...g.y];
  for (const o of others) {
    const [a, b, c, d] = o.bounds;
    xs.push({ at: a, kind: "align" }, { at: c, kind: "align" });
    // Below a part that shares the column: gaps on the spacing scale.
    if (a < x1 && c > x0 && d <= y0 + tol) for (const gap of SPACING) ys.push({ at: d + gap, kind: "spacing", gap, only: "start" });
    if (a < x1 && c > x0 && b >= y1 - tol) for (const gap of SPACING) ys.push({ at: b - gap, kind: "spacing", gap, only: "end", above: true });
  }
  for (const m of matches) xs.push({ at: m[0], kind: "match" }, { at: m[2], kind: "match" }), ys.push({ at: m[1], kind: "match" });

  const sx = snapSpan(x0, x1, xs, tol);
  if (sx && Math.abs(sx.delta) > 0.4) { x0 += sx.delta; x1 += sx.delta; say("x", sx); }
  // A text frame whose other side is near a line too takes its width from it
  // (left margin to right margin, to the golden line…).
  if (isText && sx) {
    const free = sx.edge === "start" ? "end" : sx.edge === "end" ? "start" : null;
    const v = free === "end" ? x1 : x0;
    const near = free && xs.filter((l) => l !== sx.line && Math.abs(l.at - v) <= tol && Math.abs(l.at - v) > 0.4).sort((p, q) => Math.abs(p.at - v) - Math.abs(q.at - v) || RANK[p.kind] - RANK[q.kind])[0];
    if (near && (free === "end" ? near.at - x0 : x1 - near.at) > 36) { if (free === "end") x1 = near.at; else x0 = near.at; snapped.push(`${free === "end" ? "right" : "left"} edge to the ${near.kind === "align" ? "edge of the part beside it" : `${near.kind} line`} (${r1(near.at)})`); }
  }
  const sy = snapSpan(y0, y1, ys, tol);
  if (sy && Math.abs(sy.delta) > 0.4) { y0 += sy.delta; y1 += sy.delta; say("y", sy); }

  // Keep it on the page: text inside the safe box, pictures inside the bleed.
  const c = g.content;
  const lim = isText ? [c.left, c.top, c.right, c.bottom] : [g.page.x - bleed, g.page.y - bleed, g.page.x + g.page.w + bleed, g.page.y + g.page.h + bleed];
  let clamped = false;
  const fit = (lo, hi, a, b) => {
    if (b - a > hi - lo) { clamped = true; return [lo, hi]; }
    if (a < lo - 0.4) { clamped = true; return [lo, lo + (b - a)]; }
    if (b > hi + 0.4) { clamped = true; return [hi - (b - a), hi]; }
    return [a, b];
  };
  [x0, x1] = fit(lim[0], lim[2], x0, x1);
  [y0, y1] = fit(lim[1], lim[3], y0, y1);
  return { box: [r1(x0), r1(y0), r1(x1), r1(y1)], snapped, clamped };
}

/** Uneven gaps between parts stacked in a column on one page: a page whose
 *  spacing is 12, 31 and 9 pt looks unplanned. → [{above, below, gap}] for
 *  gaps that aren't within 3 pt of the column's most common one, and the
 *  scale gap it's nearest. */
export function unevenGaps(items, tol = 3) {
  const out = [];
  const sorted = [...items].sort((a, b) => a.bounds[1] - b.bounds[1]);
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted.slice(i + 1).find((x) => x.bounds[0] < a.bounds[2] && x.bounds[2] > a.bounds[0] && x.bounds[1] >= a.bounds[3] - 0.5);
    if (b) pairs.push({ above: a.id, below: b.id, gap: r1(b.bounds[1] - a.bounds[3]) });
  }
  if (pairs.length < 2) return out;
  const usual = [...pairs].sort((p, q) => p.gap - q.gap)[Math.floor(pairs.length / 2)].gap;
  for (const p of pairs) if (Math.abs(p.gap - usual) > tol && p.gap < 120) out.push({ ...p, usual, scale: SPACING.reduce((s, v) => (Math.abs(v - p.gap) < Math.abs(s - p.gap) ? v : s)) });
  return out;
}
