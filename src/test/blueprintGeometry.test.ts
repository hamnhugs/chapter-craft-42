import { describe, it, expect } from "vitest";
import {
  SENSORS, sensorById, angleOfViewDeg, lensCoverage, coverageWidthAt,
  frustumWedge, coversPoint, shotSizeLabel,
} from "@/lib/blueprint/camera";
import {
  identity, multiply, translation, rotation, transformPoint,
  attachLocalPosition, primitivePoints, resolveAssembly, projectAssembly,
  projectPoint, convexHull, boundsOf, clampBox, boxContains, commonBounds,
  clipPolygonToBox, DEFAULT_VIEWS, VIEWS,
} from "@/lib/blueprint/geometry";
import { packShelves, packGrid } from "@/lib/blueprint/pack";
import { parseBlueprint, validateBlueprint, formatProblems, BlueprintSchema } from "@/lib/blueprint/schema";
import type { Blueprint } from "@/lib/blueprint/schema";

// ── camera ──────────────────────────────────────────────────────────────────

describe("angle of view", () => {
  // The published table for a rectilinear lens focused at infinity. If these
  // drift, the frustum wedges on every stage plan are wrong.
  const FULL_FRAME: Array<[number, number]> = [
    [18, 90.0], [24, 73.7], [35, 54.4], [50, 39.6], [85, 23.9], [100, 20.4],
  ];
  it.each(FULL_FRAME)("full frame, %imm → %f°", (focal, expected) => {
    expect(angleOfViewDeg(SENSORS.full_frame.w, focal)).toBeCloseTo(expected, 1);
  });

  // Super 35 is looser on purpose. Full frame is 36.0 × 24.0 by definition, so
  // those figures are exact; "Super 35, 4-perf" is quoted as 24.89mm in some
  // references and 24.92mm in others, and published angle tables don't say
  // which they used. We keep 24.89 (Academy) and allow 0.1° rather than bending
  // a physical constant to match a table whose input is unstated.
  const SUPER35: Array<[number, number]> = [
    [18, 69.3], [24, 54.9], [35, 39.2], [50, 28.0], [85, 16.7], [100, 14.2],
  ];
  it.each(SUPER35)("super 35, %imm → %f°", (focal, expected) => {
    const actual = angleOfViewDeg(SENSORS.super35_4perf.w, focal);
    expect(Math.abs(actual - expected)).toBeLessThan(0.1);
  });

  it("is exactly 90° when the focal length is half the sensor width", () => {
    expect(angleOfViewDeg(36, 18)).toBeCloseTo(90, 6);
  });

  it("narrows as focal length grows", () => {
    const wide = angleOfViewDeg(36, 24);
    const tele = angleOfViewDeg(36, 200);
    expect(wide).toBeGreaterThan(tele);
  });

  it("narrows at close focus, because the lens extends", () => {
    const atInfinity = angleOfViewDeg(36, 50, 0);
    const atHalfLife = angleOfViewDeg(36, 50, 0.5);
    expect(atHalfLife).toBeLessThan(atInfinity);
  });

  it("returns 0 rather than NaN for nonsense input", () => {
    expect(angleOfViewDeg(36, 0)).toBe(0);
    expect(angleOfViewDeg(0, 50)).toBe(0);
    expect(angleOfViewDeg(36, -50)).toBe(0);
  });

  // A 2x anamorphic lens fits twice as wide a scene onto the same sensor, so
  // its horizontal field is WIDER than the spherical lens of the same marked
  // focal length. Getting this backwards makes every wide anamorphic setup draw
  // as a narrow wedge on the floor plan.
  it("treats anamorphic squeeze as extra horizontal coverage", () => {
    const spherical = lensCoverage(SENSORS.super35_4perf, 40, 1);
    const anamorphic = lensCoverage(SENSORS.super35_4perf, 40, 2);
    expect(anamorphic.horizontalDeg).toBeGreaterThan(spherical.horizontalDeg);
    // Squeeze is horizontal only — the vertical field is untouched.
    expect(anamorphic.verticalDeg).toBeCloseTo(spherical.verticalDeg, 10);
  });

  it("makes a 2x anamorphic match a spherical lens of half the focal length", () => {
    const anamorphic = lensCoverage(SENSORS.super35_4perf, 50, 2).horizontalDeg;
    const spherical25 = lensCoverage(SENSORS.super35_4perf, 25, 1).horizontalDeg;
    expect(anamorphic).toBeCloseTo(spherical25, 10);
  });

  it("draws a wider wedge for an anamorphic lens", () => {
    const base = { id: "c", label: "C", at: { x: 0, y: 0 }, headingDeg: 0, focalMm: 50, throwDistance: 10 };
    const spherical = frustumWedge({ ...base, squeeze: 1 }, 4);
    const anamorphic = frustumWedge({ ...base, squeeze: 2 }, 4);
    const span = (pts: Array<{ x: number }>) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    expect(span(anamorphic)).toBeGreaterThan(span(spherical));
  });

  it("falls back to a real sensor for an unknown id", () => {
    expect(sensorById("does-not-exist").w).toBeGreaterThan(0);
    expect(sensorById(undefined).id).toBe("super35_4perf");
  });

  it("computes coverage width geometrically", () => {
    // At 90° horizontal, coverage width equals twice the distance.
    expect(coverageWidthAt({ id: "t", label: "t", w: 36, h: 24 }, 18, 5)).toBeCloseTo(10, 6);
  });

  it("labels shot size from coverage relative to the subject", () => {
    expect(shotSizeLabel(0.2, 1.7)).toBe("extreme close-up");
    expect(shotSizeLabel(1.7, 1.7)).toBe("medium");
    expect(shotSizeLabel(12, 1.7)).toBe("extreme wide");
    expect(shotSizeLabel(1, 0)).toBe("unknown");
  });
});

describe("frustum wedge", () => {
  const setup = {
    id: "a", label: "A",
    at: { x: 0, y: 0 },
    headingDeg: 0,          // pointing plan-north
    focalMm: 18,
    sensorId: "full_frame", // 90° horizontal
    throwDistance: 10,
  };

  it("starts at the camera and spans the full angle of view", () => {
    const pts = frustumWedge(setup, 8);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    const first = pts[1];
    const last = pts[pts.length - 1];
    // ±45° from north at 10 units out.
    expect(first.x).toBeCloseTo(-Math.SQRT1_2 * 10, 6);
    expect(last.x).toBeCloseTo(Math.SQRT1_2 * 10, 6);
    expect(first.y).toBeCloseTo(Math.SQRT1_2 * 10, 6);
  });

  it("keeps every arc point at the throw distance", () => {
    const pts = frustumWedge(setup, 12).slice(1);
    for (const p of pts) {
      expect(Math.sqrt(p.x * p.x + p.y * p.y)).toBeCloseTo(10, 6);
    }
  });

  it("respects heading", () => {
    const east = frustumWedge({ ...setup, headingDeg: 90 }, 4);
    // Centre ray now points along +X.
    const mid = east[Math.ceil((east.length - 1) / 2)];
    expect(mid.x).toBeGreaterThan(0);
    expect(Math.abs(mid.y)).toBeLessThan(1e-6);
  });

  it("covers what is in front and not what is behind", () => {
    expect(coversPoint(setup, { x: 0, y: 5 })).toBe(true);
    expect(coversPoint(setup, { x: 0, y: -5 })).toBe(false);
    // Just inside and just outside the 45° edge.
    expect(coversPoint(setup, { x: 4.9, y: 5 })).toBe(true);
    expect(coversPoint(setup, { x: 5.1, y: 5 })).toBe(false);
  });

  it("does not cover past the throw distance", () => {
    expect(coversPoint(setup, { x: 0, y: 9 })).toBe(true);
    expect(coversPoint(setup, { x: 0, y: 11 })).toBe(false);
  });

  it("handles a heading that wraps past 180°", () => {
    const south = { ...setup, headingDeg: 170 };
    expect(coversPoint(south, { x: 1, y: -5 })).toBe(true);
  });
});

// ── matrices ────────────────────────────────────────────────────────────────

describe("transforms", () => {
  it("identity leaves a point alone", () => {
    expect(transformPoint(identity(), { x: 3, y: -2, z: 7 })).toEqual({ x: 3, y: -2, z: 7 });
  });

  it("translates", () => {
    const m = translation({ x: 1, y: 2, z: 3 });
    expect(transformPoint(m, { x: 0, y: 0, z: 0 })).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("composes parent then child, in that order", () => {
    const parent = translation({ x: 10, y: 0, z: 0 });
    const child = translation({ x: 1, y: 0, z: 0 });
    const world = multiply(parent, child);
    expect(transformPoint(world, { x: 0, y: 0, z: 0 }).x).toBeCloseTo(11, 10);
  });

  it("rotates 90° about Y taking +X to -Z", () => {
    const m = rotation({ x: 0, y: 90, z: 0 });
    const p = transformPoint(m, { x: 1, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.z).toBeCloseTo(-1, 10);
  });
});

describe("attach points", () => {
  const size = { x: 2, y: 4, z: 6 };

  it("puts a face centre on the correct face", () => {
    expect(attachLocalPosition(size, "front", 0.5, 0.5)).toEqual({ x: 0, y: 0, z: 3 });
    expect(attachLocalPosition(size, "back", 0.5, 0.5)).toEqual({ x: 0, y: 0, z: -3 });
    expect(attachLocalPosition(size, "top", 0.5, 0.5)).toEqual({ x: 0, y: 2, z: 0 });
    expect(attachLocalPosition(size, "bottom", 0.5, 0.5)).toEqual({ x: 0, y: -2, z: 0 });
    expect(attachLocalPosition(size, "right", 0.5, 0.5)).toEqual({ x: 1, y: 0, z: 0 });
    expect(attachLocalPosition(size, "left", 0.5, 0.5)).toEqual({ x: -1, y: 0, z: 0 });
  });

  it("never leaves the part's own extent", () => {
    for (const face of ["front", "back", "left", "right", "top", "bottom"] as const) {
      for (const [u, v] of [[0, 0], [1, 1], [0, 1], [1, 0], [0.3, 0.8]]) {
        const p = attachLocalPosition(size, face, u, v);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(size.x / 2 + 1e-9);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(size.y / 2 + 1e-9);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(size.z / 2 + 1e-9);
      }
    }
  });

  it("mirrors u on the faces you view from the other side", () => {
    // The same u must not mean opposite sides of the body on front vs back.
    const front = attachLocalPosition(size, "front", 0, 0.5);
    const back = attachLocalPosition(size, "back", 0, 0.5);
    expect(front.x).toBeLessThan(0);
    expect(back.x).toBeGreaterThan(0);
  });
});

// ── primitives and projection ───────────────────────────────────────────────

describe("primitives", () => {
  it("gives a box its eight corners", () => {
    const pts = primitivePoints({ id: "b", name: "B", primitive: "box", size: { x: 2, y: 2, z: 2 } });
    expect(pts).toHaveLength(8);
  });

  it("keeps every sample inside the declared extent", () => {
    for (const primitive of ["box", "plate", "wedge", "cylinder", "capsule", "cone", "sphere"] as const) {
      const size = { x: 3, y: 5, z: 2 };
      const pts = primitivePoints({ id: "p", name: "P", primitive, size });
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(size.x / 2 + 1e-9);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(size.y / 2 + 1e-9);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(size.z / 2 + 1e-9);
      }
    }
  });
});

describe("projection", () => {
  it("uses third-angle: the front faces left in the right view", () => {
    const front = { x: 0, y: 0, z: 1 };
    expect(projectPoint(front, "right").x).toBeLessThan(0);
  });

  it("uses third-angle: the front sits at the bottom of the top view", () => {
    const front = { x: 0, y: 0, z: 1 };
    // SVG y grows downward, so "bottom" is a larger y.
    expect(projectPoint(front, "top").y).toBeGreaterThan(projectPoint({ x: 0, y: 0, z: -1 }, "top").y);
  });

  it("flips X in the back view", () => {
    expect(projectPoint({ x: 1, y: 0, z: 0 }, "back").x).toBeCloseTo(-1, 10);
  });

  it("puts up at a smaller y in every elevation", () => {
    for (const view of ["front", "back", "left", "right", "three_quarter"] as const) {
      const up = projectPoint({ x: 0, y: 1, z: 0 }, view);
      const down = projectPoint({ x: 0, y: -1, z: 0 }, view);
      expect(up.y).toBeLessThan(down.y);
    }
  });

  it("three-quarter shows both the front and the side", () => {
    // A point purely on +X and one purely on +Z both get non-zero screen x,
    // with opposite signs — that is what makes the view read as three-quarter.
    const fromX = projectPoint({ x: 1, y: 0, z: 0 }, "three_quarter").x;
    const fromZ = projectPoint({ x: 0, y: 0, z: 1 }, "three_quarter").x;
    expect(Math.abs(fromX)).toBeGreaterThan(0.5);
    expect(Math.abs(fromZ)).toBeGreaterThan(0.5);
    expect(Math.sign(fromX)).not.toBe(Math.sign(fromZ));
  });
});

describe("convex hull", () => {
  it("returns the four corners of a square, ignoring interior points", () => {
    const hull = convexHull([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.5, y: 0.5 },
    ]);
    expect(hull).toHaveLength(4);
  });

  it("collapses collinear runs rather than emitting duplicates", () => {
    const hull = convexHull([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
    ]);
    expect(hull).toHaveLength(4);
  });

  it("passes tiny inputs through untouched", () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([{ x: 1, y: 1 }])).toHaveLength(1);
    expect(convexHull([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toHaveLength(2);
  });

  it("survives every point being identical", () => {
    const same = Array.from({ length: 8 }, () => ({ x: 3, y: 3 }));
    expect(() => convexHull(same)).not.toThrow();
  });
});

describe("bounds", () => {
  it("measures a point cloud", () => {
    expect(boundsOf([{ x: -1, y: 2 }, { x: 3, y: -4 }])).toEqual({ x: -1, y: -4, w: 4, h: 6 });
  });

  it("returns a zero box for no points", () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  // A viewBox with a zero dimension disables rendering entirely, and a negative
  // one invalidates the attribute — this is the guard that stops a flat part
  // from silently blanking its panel.
  it("never yields a zero or negative extent", () => {
    for (const box of [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 5, y: 5, w: 10, h: 0 },
      { x: 5, y: 5, w: 0, h: 10 },
      { x: 0, y: 0, w: NaN, h: 4 },
      { x: NaN, y: 0, w: 2, h: 2 },
    ]) {
      const c = clampBox(box);
      expect(c.w).toBeGreaterThan(0);
      expect(c.h).toBeGreaterThan(0);
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
    }
  });

  it("leaves a healthy box alone", () => {
    const box = { x: 1, y: 2, w: 30, h: 40 };
    expect(clampBox(box)).toEqual(box);
  });

  it("clips a polygon to a box", () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    const clipped = clipPolygonToBox([{ x: -5, y: 5 }, { x: 15, y: 5 }, { x: 5, y: 15 }], box);
    expect(clipped.length).toBeGreaterThan(2);
    for (const p of clipped) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(10 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it("leaves a polygon already inside the box untouched", () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    const poly = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 5, y: 8 }];
    expect(clipPolygonToBox(poly, box)).toEqual(poly);
  });

  it("returns nothing for a polygon entirely outside", () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(clipPolygonToBox([{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 55, y: 60 }], box)).toEqual([]);
  });

  it("returns nothing for degenerate input", () => {
    expect(clipPolygonToBox([{ x: 1, y: 1 }, { x: 2, y: 2 }], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });

  it("knows containment", () => {
    const outer = { x: 0, y: 0, w: 10, h: 10 };
    expect(boxContains(outer, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
    expect(boxContains(outer, { x: 9, y: 9, w: 2, h: 2 })).toBe(false);
    expect(boxContains(outer, { x: -1, y: 0, w: 2, h: 2 })).toBe(false);
  });
});

// ── assembly ────────────────────────────────────────────────────────────────

function robot(): Blueprint {
  return BlueprintSchema.parse({
    kind: "character",
    form: "hard_surface",
    name: "Test robot",
    heightHeads: 6,
    palette: [{ role: "shell", hex: "#2f8f8f" }, { role: "trim", hex: "#e8e8e8" }],
    parts: [
      { id: "torso", name: "Torso", primitive: "box", size: { x: 2, y: 3, z: 1 }, swatch: "shell" },
      { id: "head", name: "Head", primitive: "sphere", size: { x: 1, y: 1, z: 1 }, parent: "torso", attach: "neck", offset: { x: 0, y: 0.5, z: 0 }, swatch: "trim" },
      { id: "arm", name: "Arm", primitive: "cylinder", size: { x: 0.4, y: 2, z: 0.4 }, parent: "torso", attach: "shoulder", offset: { x: 0, y: -1, z: 0 }, symmetry: "mirror_x", swatch: "shell" },
    ],
    attachPoints: [
      { id: "neck", name: "Neck", part: "torso", face: "top", u: 0.5, v: 0.5 },
      { id: "shoulder", name: "Shoulder", part: "torso", face: "right", u: 0.5, v: 0.9 },
    ],
    joints: [{ id: "shoulder_j", name: "Shoulder", part: "arm", at: "shoulder", axis: "x", range: [-90, 180] }],
  });
}

describe("assembly resolution", () => {
  it("places children relative to their parent's attach point", () => {
    const asm = resolveAssembly(robot());
    const head = asm.parts.find((p) => p.id === "head")!;
    const centre = transformPoint(head.matrix, { x: 0, y: 0, z: 0 });
    // Torso is 3 tall centred on origin → top face at +1.5, plus 0.5 offset.
    expect(centre.y).toBeCloseTo(2, 10);
    expect(centre.x).toBeCloseTo(0, 10);
  });

  it("emits a mirrored twin that is a true reflection", () => {
    const asm = resolveAssembly(robot());
    const arms = asm.parts.filter((p) => p.sourceId === "arm");
    expect(arms).toHaveLength(2);
    const [right, left] = arms;
    expect(right.mirrored).toBe(false);
    expect(left.mirrored).toBe(true);
    const rc = right.points[0];
    const lc = left.points[0];
    expect(lc.x).toBeCloseTo(-rc.x, 10);
    expect(lc.y).toBeCloseTo(rc.y, 10);
    expect(lc.z).toBeCloseTo(rc.z, 10);
  });

  it("resolves attach points to world positions", () => {
    const asm = resolveAssembly(robot());
    const neck = asm.anchors.find((a) => a.id === "neck")!;
    expect(neck.at.y).toBeCloseTo(1.5, 10);
  });

  it("does not loop forever on an unreachable part", () => {
    const bp = robot();
    bp.parts.push({ id: "ghost", name: "Ghost", primitive: "box", size: { x: 1, y: 1, z: 1 }, parent: "nowhere" });
    const asm = resolveAssembly(bp);
    expect(asm.orphans).toContain("ghost");
    expect(asm.parts.some((p) => p.id === "ghost")).toBe(false);
  });

  it("places every part regardless of declaration order", () => {
    const bp = robot();
    bp.parts.reverse(); // children before parents
    const asm = resolveAssembly(bp);
    expect(asm.orphans).toHaveLength(0);
    expect(asm.parts).toHaveLength(4); // torso, head, arm, arm-mirror
  });
});

describe("projected views", () => {
  it("produces a drawable box for every view", () => {
    const asm = resolveAssembly(robot());
    for (const view of VIEWS) {
      const projected = projectAssembly(asm, view);
      expect(projected.bounds.w).toBeGreaterThan(0);
      expect(projected.bounds.h).toBeGreaterThan(0);
      expect(projected.parts.length).toBeGreaterThan(0);
    }
  });

  it("keeps every outline inside the reported bounds", () => {
    const asm = resolveAssembly(robot());
    for (const view of DEFAULT_VIEWS) {
      const projected = projectAssembly(asm, view);
      for (const part of projected.parts) {
        expect(boxContains(projected.bounds, boundsOf(part.outline), 1e-6)).toBe(true);
      }
    }
  });

  // The whole reason views are projected rather than drawn: they cannot
  // disagree about how tall the figure is.
  it("gives every elevation the same height", () => {
    const asm = resolveAssembly(robot());
    const heights = (["front", "back", "left", "right"] as const)
      .map((v) => projectAssembly(asm, v).bounds.h);
    for (const h of heights) expect(h).toBeCloseTo(heights[0], 8);
  });

  it("makes the front and back views mirror images in width", () => {
    const asm = resolveAssembly(robot());
    const front = projectAssembly(asm, "front");
    const back = projectAssembly(asm, "back");
    expect(back.bounds.w).toBeCloseTo(front.bounds.w, 8);
  });

  it("shares one scale across a turnaround", () => {
    const asm = resolveAssembly(robot());
    const views = DEFAULT_VIEWS.map((v) => projectAssembly(asm, v));
    const common = commonBounds(views);
    for (const v of views) expect(boxContains(common, v.bounds, 1e-6)).toBe(true);
  });

  it("survives a part collapsed flat to the camera", () => {
    const bp = robot();
    bp.parts.push({ id: "fin", name: "Fin", primitive: "plate", size: { x: 2, y: 2, z: 0.0001 }, parent: "torso" });
    const asm = resolveAssembly(bp);
    const right = projectAssembly(asm, "right");
    expect(right.bounds.w).toBeGreaterThan(0);
  });
});

// ── packing ─────────────────────────────────────────────────────────────────

describe("shelf packing", () => {
  const items = [
    { id: "a", w: 40, h: 60 },
    { id: "b", w: 40, h: 60 },
    { id: "c", w: 40, h: 30 },
    { id: "d", w: 90, h: 20 },
  ];

  it("never overlaps two panels", () => {
    const { placements } = packShelves(items, { width: 100, gap: 5 });
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i], b = placements[j];
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  it("keeps everything within the sheet width", () => {
    const { placements } = packShelves(items, { width: 100, gap: 5 });
    for (const p of placements) expect(p.x + p.w).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("returns placements in input order", () => {
    const { placements } = packShelves(items, { width: 100, gap: 5 });
    expect(placements.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is deterministic — the same input gives byte-identical output", () => {
    const a = packShelves(items, { width: 100, gap: 5 });
    const b = packShelves(items, { width: 100, gap: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reports overflow instead of silently dropping panels", () => {
    const { placements, overflow } = packShelves(items, { width: 100, gap: 5, maxHeight: 61 });
    expect(overflow.length).toBeGreaterThan(0);
    expect(placements.length + overflow.length).toBe(items.length);
  });

  it("handles an empty sheet", () => {
    const r = packShelves([], { width: 100 });
    expect(r.placements).toEqual([]);
    expect(r.height).toBe(0);
  });

  it("gives an oversized panel its own shelf rather than dropping it", () => {
    const r = packShelves([{ id: "wide", w: 500, h: 10 }, { id: "ok", w: 10, h: 10 }], { width: 100, gap: 4 });
    expect(r.placements).toHaveLength(2);
  });

  it("lays a grid out in even columns", () => {
    const r = packGrid([{ id: "a", w: 10, h: 10 }, { id: "b", w: 10, h: 10 }, { id: "c", w: 10, h: 10 }], 2, 2);
    expect(r.placements[0]).toEqual({ id: "a", x: 0, y: 0, w: 10, h: 10 });
    expect(r.placements[1].x).toBe(12);
    expect(r.placements[2].y).toBe(12);
  });
});

// ── schema validation ───────────────────────────────────────────────────────

describe("blueprint validation", () => {
  it("accepts a sound blueprint", () => {
    const result = parseBlueprint(robot());
    expect(result.ok).toBe(true);
  });

  it("accepts a JSON string", () => {
    const result = parseBlueprint(JSON.stringify(robot()));
    expect(result.ok).toBe(true);
  });

  it("reports unparseable JSON without throwing", () => {
    const result = parseBlueprint("{not json");
    expect(result.ok).toBe(false);
  });

  // The finding that decides the error format: a repair loop's gain comes from
  // location + violation + ADMISSIBLE ALTERNATIVES, and dropping that third
  // field wipes out 36-40 of the ~42 points it is worth.
  it("names the valid options when a reference is dangling", () => {
    const bp = robot();
    bp.parts[1].parent = "nonexistent";
    const problems = validateBlueprint(bp);
    const p = problems.find((x) => x.where === "parts[1].parent")!;
    expect(p).toBeTruthy();
    expect(p.allowed).toContain("torso");
    expect(formatProblems([p])[0]).toContain("Valid here:");
  });

  it("names the palette roles when a swatch is unknown", () => {
    const bp = robot();
    bp.parts[0].swatch = "chartreuse";
    const p = validateBlueprint(bp).find((x) => x.where === "parts[0].swatch")!;
    expect(p.allowed).toEqual(["shell", "trim"]);
  });

  it("catches a dangling attach point", () => {
    const bp = robot();
    bp.parts[1].attach = "elbow";
    const p = validateBlueprint(bp).find((x) => x.where === "parts[1].attach")!;
    expect(p.allowed).toContain("neck");
  });

  it("catches a parent cycle", () => {
    const bp = robot();
    bp.parts[0].parent = "head";
    const problems = validateBlueprint(bp);
    expect(problems.some((p) => /cycle/i.test(p.problem))).toBe(true);
  });

  it("rejects two roots", () => {
    const bp = robot();
    bp.parts.push({ id: "floater", name: "Floater", primitive: "box", size: { x: 1, y: 1, z: 1 } });
    expect(validateBlueprint(bp).some((p) => /exactly one root/i.test(p.problem))).toBe(true);
  });

  it("rejects a zero extent, because it blanks the panel", () => {
    const bp = robot();
    bp.parts[0].size.y = 0;
    const p = validateBlueprint(bp).find((x) => x.where === "parts[0].size.y")!;
    expect(p.problem).toMatch(/positive/);
  });

  it("rejects an attach point off its face", () => {
    const bp = robot();
    bp.attachPoints[0].u = 1.4;
    expect(validateBlueprint(bp).some((p) => p.where === "attachPoints[0].u")).toBe(true);
  });

  it("catches duplicate ids across different collections", () => {
    const bp = robot();
    bp.attachPoints[0].id = "torso";
    expect(validateBlueprint(bp).some((p) => /already used/.test(p.problem))).toBe(true);
  });

  it("rejects a duplicate palette role", () => {
    const bp = robot();
    bp.palette.push({ role: "shell", hex: "#123456" });
    expect(validateBlueprint(bp).some((p) => /declared twice/.test(p.problem))).toBe(true);
  });

  // Mirroring is what makes a turnaround cheap, and it is also what silently
  // copies a scar onto both cheeks.
  it("refuses a one-sided mark on a mirrored part", () => {
    const bp = robot();
    bp.marks.push({ name: "Weld scar", part: "arm", side: "left", description: "old repair" });
    const p = validateBlueprint(bp).find((x) => /mirror/i.test(x.problem))!;
    expect(p).toBeTruthy();
    expect(p.allowed?.length).toBeGreaterThan(0);
  });

  it("allows a centred mark on a mirrored part", () => {
    const bp = robot();
    bp.marks.push({ name: "Serial plate", part: "arm", side: "center", description: "stamped" });
    expect(validateBlueprint(bp).some((x) => /mirror/i.test(x.problem))).toBe(false);
  });

  it("requires landmarks on an organic blueprint, because nothing else is drawn", () => {
    const bp = robot();
    bp.form = "organic";
    const p = validateBlueprint(bp).find((x) => x.where === "landmarks")!;
    expect(p).toBeTruthy();
    expect(p.allowed).toContain("eye line");
  });

  it("accepts an organic blueprint that has landmarks", () => {
    const bp = robot();
    bp.form = "organic";
    bp.landmarks = [
      { id: "eye", name: "Eye line", atHeads: 5.6 },
      { id: "waist", name: "Waist", atHeads: 3.1 },
    ];
    expect(validateBlueprint(bp).some((x) => x.where === "landmarks")).toBe(false);
  });

  it("rejects a landmark outside the figure", () => {
    const bp = robot();
    bp.landmarks = [{ id: "halo", name: "Halo", atHeads: 99 }];
    expect(validateBlueprint(bp).some((x) => x.where === "landmarks[0].atHeads")).toBe(true);
  });

  it("rejects a non-positive height", () => {
    const bp = robot();
    bp.heightHeads = 0;
    expect(validateBlueprint(bp).some((x) => x.where === "heightHeads")).toBe(true);
  });

  it("reports every problem rather than stopping at the first", () => {
    const bp = robot();
    bp.parts[0].swatch = "nope";
    bp.parts[1].parent = "gone";
    bp.heightHeads = -1;
    expect(validateBlueprint(bp).length).toBeGreaterThanOrEqual(3);
  });
});
