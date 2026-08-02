import type { Blueprint, Face, Part } from "./schema";

// The geometry kernel. Every number on a sheet is computed here, and nothing
// here is ever authored by a model.
//
// WHY THE SPLIT IS ABSOLUTE. The measured result that decides this design:
// giving a frontier model a code interpreter improves geometric questions by
// ~+40 points when the task is EVALUATING a known formula (pair distance
// 56%→99%, view angle 55%→96%) and makes it WORSE when the model has to invent
// the procedure (shortest path 25%→12.5%). So the library is fixed and tested;
// the model's only job is to say what the thing is made of.
//
// WHY VIEWS ARE PROJECTED AND NEVER DRAWN. Multi-view consistency is the single
// weakest axis for every frontier model on technical drawings — the projection
// subtask scores 54-60% against 71-77% overall. Asking for three drawings that
// agree is asking for the thing they are worst at. Deriving front, profile and
// top from one assembly makes disagreement structurally impossible instead of
// something we check for afterwards.
//
// DETERMINISM. Arithmetic and sqrt are correctly-rounded per spec; sin/cos are
// not, and differ across engines. Resolution therefore happens ONCE and callers
// persist the resulting matrices and points — never the euler angles that
// produced them. Re-deriving a saved sheet from its inputs on a different
// browser is not guaranteed to give the same drawing.

export interface Vec3 { x: number; y: number; z: number }
export interface Vec2 { x: number; y: number }

/** Row-major 4x4. m[row * 4 + col]. */
export type Mat4 = number[];

const DEG = Math.PI / 180;

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

export function translation(t: Vec3): Mat4 {
  return [1, 0, 0, t.x, 0, 1, 0, t.y, 0, 0, 1, t.z, 0, 0, 0, 1];
}

/** Euler rotation, X then Y then Z. The only place trig enters the pipeline. */
export function rotation(deg: Vec3): Mat4 {
  const cx = Math.cos(deg.x * DEG), sx = Math.sin(deg.x * DEG);
  const cy = Math.cos(deg.y * DEG), sy = Math.sin(deg.y * DEG);
  const cz = Math.cos(deg.z * DEG), sz = Math.sin(deg.z * DEG);
  const rx: Mat4 = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1];
  const ry: Mat4 = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1];
  const rz: Mat4 = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return multiply(rz, multiply(ry, rx));
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  };
}

// ── attach points ───────────────────────────────────────────────────────────

/**
 * Where an attach point sits in its own part's local frame.
 *
 * Parts are centred on their origin, so a face lies at ±half the extent. `u`
 * and `v` run 0..1 across that face: on the four side faces v is bottom-to-top
 * and u is left-to-right *as seen looking at that face*, which is why back and
 * right invert u — otherwise "u: 0.2" would mean a different side of the body
 * depending on which face you named.
 */
export function attachLocalPosition(size: Vec3, face: Face, u: number, v: number): Vec3 {
  const hw = size.x / 2, hh = size.y / 2, hd = size.z / 2;
  switch (face) {
    case "front":  return { x: (u - 0.5) * size.x, y: (v - 0.5) * size.y, z: hd };
    case "back":   return { x: (0.5 - u) * size.x, y: (v - 0.5) * size.y, z: -hd };
    case "right":  return { x: hw,                 y: (v - 0.5) * size.y, z: (0.5 - u) * size.z };
    case "left":   return { x: -hw,                y: (v - 0.5) * size.y, z: (u - 0.5) * size.z };
    case "top":    return { x: (u - 0.5) * size.x, y: hh,                 z: (0.5 - v) * size.z };
    case "bottom": return { x: (u - 0.5) * size.x, y: -hh,                z: (v - 0.5) * size.z };
  }
}

// ── primitive silhouettes ───────────────────────────────────────────────────

const RING = 16;

/** Sample points on a primitive's surface, in the part's local frame.
 *
 *  These are hulled after projection to give a silhouette. Curved primitives
 *  are sampled rather than solved: the hull of 16-per-ring samples sits a
 *  fraction of a percent inside the true circle, which is invisible at sheet
 *  scale and keeps every primitive on one code path. */
export function primitivePoints(part: Part): Vec3[] {
  const { x: w, y: h, z: d } = part.size;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const pts: Vec3[] = [];

  const ring = (y: number, rx: number, rz: number) => {
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * rx, y, z: Math.sin(a) * rz });
    }
  };

  switch (part.primitive) {
    case "box":
    case "plate":
      for (const sx of [-hw, hw]) for (const sy of [-hh, hh]) for (const sz of [-hd, hd]) pts.push({ x: sx, y: sy, z: sz });
      break;
    case "wedge":
      // Triangular prism: full at the back, tapering to an edge at the front.
      for (const sz of [-hd, hd]) {
        pts.push({ x: -hw, y: -hh, z: sz });
        pts.push({ x: hw, y: -hh, z: sz });
        pts.push({ x: 0, y: hh, z: sz });
      }
      break;
    case "cylinder":
      ring(-hh, hw, hd);
      ring(hh, hw, hd);
      break;
    case "cone":
      ring(-hh, hw, hd);
      pts.push({ x: 0, y: hh, z: 0 });
      break;
    case "capsule": {
      // Straight section plus two hemispherical caps, approximated by rings.
      const capR = Math.min(hw, hd);
      const straight = Math.max(0, hh - capR);
      ring(-straight, hw, hd);
      ring(straight, hw, hd);
      for (const sign of [-1, 1]) {
        for (const t of [0.35, 0.7]) {
          const a = t * (Math.PI / 2);
          ring(sign * (straight + Math.sin(a) * capR), hw * Math.cos(a), hd * Math.cos(a));
        }
        pts.push({ x: 0, y: sign * (straight + capR), z: 0 });
      }
      break;
    }
    case "sphere":
      for (const t of [-0.75, -0.4, 0, 0.4, 0.75]) {
        const a = t * (Math.PI / 2);
        ring(Math.sin(a) * hh, Math.cos(a) * hw, Math.cos(a) * hd);
      }
      pts.push({ x: 0, y: -hh, z: 0 }, { x: 0, y: hh, z: 0 });
      break;
  }
  return pts;
}

// ── assembly resolution ─────────────────────────────────────────────────────

export interface ResolvedPart {
  id: string;
  /** Source part id — differs from `id` on the mirrored twin. */
  sourceId: string;
  name: string;
  swatch?: string;
  mirrored: boolean;
  /** World transform. PERSIST THIS, not the euler angles that produced it. */
  matrix: Mat4;
  /** Surface samples already in world space. */
  points: Vec3[];
}

export interface ResolvedAnchor {
  id: string;
  name: string;
  /** World position of the attach point. */
  at: Vec3;
  partId: string;
}

export interface ResolvedAssembly {
  parts: ResolvedPart[];
  anchors: ResolvedAnchor[];
  /** Parts whose parent chain never reached the root, so they were skipped. */
  orphans: string[];
}

function mirrorWorldX(p: Vec3): Vec3 {
  return { x: -p.x, y: p.y, z: p.z };
}

/**
 * Walk the assembly tree and place every part in world space.
 *
 * Assumes a validated blueprint (see validateBlueprint) — cycles and dangling
 * parents are caught there. It still degrades safely: anything unreachable from
 * the root lands in `orphans` rather than looping.
 */
export function resolveAssembly(bp: Blueprint): ResolvedAssembly {
  const byId = new Map(bp.parts.map((p) => [p.id, p]));
  const attachById = new Map(bp.attachPoints.map((a) => [a.id, a]));
  const worldOf = new Map<string, Mat4>();
  const parts: ResolvedPart[] = [];
  const orphans: string[] = [];

  // Depth order: a part can only be placed once its parent has been.
  const pending = [...bp.parts];
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const part = pending[i];
      const parentWorld = part.parent ? worldOf.get(part.parent) : identity();
      if (!parentWorld) continue;

      // Position: parent's frame → the attach point on the parent → the
      // declared offset → the part's own rotation.
      let local = identity();
      if (part.attach) {
        const ap = attachById.get(part.attach);
        const host = ap ? byId.get(ap.part) : undefined;
        if (ap && host) {
          local = multiply(local, translation(attachLocalPosition(host.size, ap.face, ap.u, ap.v)));
        }
      }
      if (part.offset) local = multiply(local, translation(part.offset));
      if (part.rotate) local = multiply(local, rotation(part.rotate));

      const world = multiply(parentWorld, local);
      worldOf.set(part.id, world);

      const localPts = primitivePoints(part);
      const worldPts = localPts.map((p) => transformPoint(world, p));
      parts.push({
        id: part.id,
        sourceId: part.id,
        name: part.name,
        swatch: part.swatch,
        mirrored: false,
        matrix: world,
        points: worldPts,
      });

      // The mirrored twin is a reflection through the world YZ plane, so one
      // declaration yields two limbs that cannot drift apart.
      if (part.symmetry === "mirror_x") {
        parts.push({
          id: `${part.id}__mirror`,
          sourceId: part.id,
          name: `${part.name} (mirrored)`,
          swatch: part.swatch,
          mirrored: true,
          matrix: multiply([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], world),
          points: worldPts.map(mirrorWorldX),
        });
      }

      pending.splice(i, 1);
      progressed = true;
    }
  }
  for (const p of pending) orphans.push(p.id);

  const anchors: ResolvedAnchor[] = [];
  for (const ap of bp.attachPoints) {
    const host = byId.get(ap.part);
    const world = worldOf.get(ap.part);
    if (!host || !world) continue;
    anchors.push({
      id: ap.id,
      name: ap.name,
      partId: ap.part,
      at: transformPoint(world, attachLocalPosition(host.size, ap.face, ap.u, ap.v)),
    });
  }

  return { parts, anchors, orphans };
}

// ── views ───────────────────────────────────────────────────────────────────

export const VIEWS = ["front", "right", "top", "back", "left", "three_quarter"] as const;
export type ViewName = (typeof VIEWS)[number];

/**
 * Third-angle projection, which is the convention in animation and North
 * American practice: the right-side view unfolds to the RIGHT of the front view
 * and the top view unfolds ABOVE it. Consequence, and the part that is easy to
 * get backwards: in the right view the object's front faces LEFT, toward the
 * front view it unfolded from; in the top view the object's front is at the
 * BOTTOM. Screen y is SVG's downward y throughout.
 */
const COS45 = Math.cos(45 * DEG);
const SIN45 = Math.sin(45 * DEG);

export function projectPoint(p: Vec3, view: ViewName): Vec2 {
  switch (view) {
    case "front": return { x: p.x, y: -p.y };
    case "back":  return { x: -p.x, y: -p.y };
    case "right": return { x: -p.z, y: -p.y };
    case "left":  return { x: p.z, y: -p.y };
    case "top":   return { x: p.x, y: p.z };
    case "three_quarter": {
      // Yaw the world -45° about Y, then project as front.
      const x = p.x * COS45 - p.z * SIN45;
      return { x, y: -p.y };
    }
  }
}

export const VIEW_LABEL: Record<ViewName, string> = {
  front: "Front",
  right: "Right",
  top: "Top",
  back: "Back",
  left: "Left",
  three_quarter: "Three-quarter",
};

/** The evidence-backed default turnaround. Front / three-quarter / right /
 *  back mirrors the reference pack the video path already uses, and the back
 *  view is the highest-value member — turnarounds hallucinate without it. */
export const DEFAULT_VIEWS: ViewName[] = ["front", "three_quarter", "right", "back"];

// ── hulls and bounds ────────────────────────────────────────────────────────

/**
 * Convex hull by monotone chain. Deterministic, O(n log n), and the popping
 * test uses `<= 0` so collinear runs collapse rather than producing duplicate
 * vertices — which matters because near-collinear input is exactly where a
 * naive orientation test flips sign and yields a self-intersecting outline.
 */
export function convexHull(points: Vec2[]): Vec2[] {
  if (points.length < 3) return [...points];
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface Box { x: number; y: number; w: number; h: number }

export function boundsOf(points: Vec2[]): Box {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Guarantee a drawable box.
 *
 * A viewBox with zero width or height DISABLES RENDERING of the element
 * entirely, and a negative one invalidates the attribute — and degenerate
 * extents happen constantly with generated geometry (a flat plate seen edge-on,
 * a single point, an empty view). Without this the panel silently goes blank,
 * which reads as a bug in the drawing rather than in the data.
 */
export function clampBox(box: Box, minSize = 1e-3): Box {
  const w = Number.isFinite(box.w) && box.w > minSize ? box.w : minSize;
  const h = Number.isFinite(box.h) && box.h > minSize ? box.h : minSize;
  const x = Number.isFinite(box.x) ? box.x : 0;
  const y = Number.isFinite(box.y) ? box.y : 0;
  // Keep the original centre when we had to inflate a collapsed axis.
  return {
    x: box.w > minSize ? x : x - (w - (Number.isFinite(box.w) ? box.w : 0)) / 2,
    y: box.h > minSize ? y : y - (h - (Number.isFinite(box.h) ? box.h : 0)) / 2,
    w,
    h,
  };
}

export function padBox(box: Box, pad: number): Box {
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

export function boxContains(outer: Box, inner: Box, tolerance = 1e-6): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

// ── projected view ──────────────────────────────────────────────────────────

export interface ProjectedPart {
  id: string;
  sourceId: string;
  name: string;
  swatch?: string;
  mirrored: boolean;
  /** Silhouette outline in view space. */
  outline: Vec2[];
}

export interface ProjectedView {
  view: ViewName;
  label: string;
  parts: ProjectedPart[];
  anchors: Array<{ id: string; name: string; at: Vec2 }>;
  /** Tight bounds of everything drawn, already clamped to be drawable. */
  bounds: Box;
}

export function projectAssembly(asm: ResolvedAssembly, view: ViewName): ProjectedView {
  const parts: ProjectedPart[] = asm.parts.map((p) => ({
    id: p.id,
    sourceId: p.sourceId,
    name: p.name,
    swatch: p.swatch,
    mirrored: p.mirrored,
    outline: convexHull(p.points.map((pt) => projectPoint(pt, view))),
  }));
  const anchors = asm.anchors.map((a) => ({ id: a.id, name: a.name, at: projectPoint(a.at, view) }));
  const all: Vec2[] = [];
  for (const p of parts) all.push(...p.outline);
  for (const a of anchors) all.push(a.at);
  return { view, label: VIEW_LABEL[view], parts, anchors, bounds: clampBox(boundsOf(all)) };
}

/** Union of several views' bounds, so every panel on a sheet can share one
 *  scale. Panels drawn at different scales are the fastest way to make a
 *  turnaround useless as a proportion reference. */
export function commonBounds(views: ProjectedView[]): Box {
  const corners: Vec2[] = [];
  for (const v of views) {
    corners.push({ x: v.bounds.x, y: v.bounds.y });
    corners.push({ x: v.bounds.x + v.bounds.w, y: v.bounds.y + v.bounds.h });
  }
  return clampBox(boundsOf(corners));
}
