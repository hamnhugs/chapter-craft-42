import { z } from "zod";
import type { BlueprintProblem } from "./schema";
import { SENSORS, DEFAULT_SENSOR, coverageWidthAt, sensorById, shotSizeLabel, coversPoint } from "./camera";

// Scene: the stage plan and shot list for one location.
//
// The app has chapters and it has characters, and until now nothing in between
// — no scene, no camera, no shot. This is that layer, and it is deliberately a
// TECHVIS document rather than a previs one: previs is about what a shot looks
// like, techvis is the physical numbers that make it achievable — lens, throw,
// coverage, who is actually in frame. A floor plan with angle-of-view wedges is
// squarely the second thing, and calling it previs would misdescribe it.
//
// SHOT NUMBERS STEP BY TEN. This is the single most useful convention in the
// whole domain and it costs nothing: with ids at 0010, 0020, 0030, an inserted
// shot becomes 0015 instead of renumbering everything downstream. In a system
// where the story changes under the plan — which is the entire premise of a
// novel-writing app — renumbering is the failure that makes people abandon the
// document.

export const SCENE_VERSION = 1;

const ID = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "id must be lowercase letters, digits, '-' or '_' (max 40)");
const LABEL = z.string().min(1).max(80);
const Point = z.object({ x: z.number(), y: z.number() });

export const WALL_KINDS = ["wall", "flat", "opening", "window"] as const;
export const LIGHT_KINDS = ["key", "fill", "back", "practical", "ambient"] as const;
export const MOVEMENTS = ["static", "pan", "tilt", "dolly", "track", "crane", "handheld", "steadicam", "zoom"] as const;

export const WallSchema = z.object({
  id: ID,
  name: LABEL.optional(),
  from: Point,
  to: Point,
  kind: z.enum(WALL_KINDS).default("wall"),
});

export const PlanPropSchema = z.object({
  id: ID,
  name: LABEL,
  at: Point,
  /** Footprint in plan units. */
  w: z.number(),
  d: z.number(),
  rotationDeg: z.number().default(0),
  /** Master asset @name this prop is an instance of, when one exists. */
  master: z.string().max(60).optional(),
});

export const BlockingSchema = z.object({
  id: ID,
  name: LABEL,
  at: Point,
  /** Degrees clockwise from plan north. */
  facingDeg: z.number().default(0),
  master: z.string().max(60).optional(),
  /** Height in plan units, used to label shot size from coverage width. */
  height: z.number().optional(),
});

export const CameraSchema = z.object({
  id: ID,
  label: LABEL,
  at: Point,
  headingDeg: z.number().default(0),
  focalMm: z.number(),
  sensorId: z.string().max(40).default(DEFAULT_SENSOR),
  squeeze: z.number().default(1),
  throwDistance: z.number().optional(),
  heightAbove: z.number().optional(),
});

export const LightSchema = z.object({
  id: ID,
  name: LABEL,
  at: Point,
  kind: z.enum(LIGHT_KINDS).default("key"),
  aimDeg: z.number().optional(),
});

export const ShotSchema = z.object({
  id: ID,
  /** Full designator, e.g. "AGM_104_TCC_067_0010". Generated when omitted. */
  number: z.string().max(60).optional(),
  camera: ID.optional(),
  movement: z.enum(MOVEMENTS).default("static"),
  /** Blocking ids in frame. Used to check the camera actually covers them. */
  subjects: z.array(ID).max(12).default([]),
  action: z.string().max(300).default(""),
  durationS: z.number().optional(),
  notes: z.string().max(300).optional(),
});

export const SceneSchema = z.object({
  version: z.number().int().default(SCENE_VERSION),
  name: LABEL,
  /** Master scene heading, e.g. "INT. FORGE — NIGHT". */
  slug: z.string().max(120).default(""),
  unit: z.enum(["m", "ft"]).default("m"),
  extent: z.object({ w: z.number(), h: z.number() }),
  /** Prefix for generated shot numbers: show, episode, sequence, scene. */
  designator: z.object({
    show: z.string().max(8).default(""),
    episode: z.string().max(8).default(""),
    sequence: z.string().max(8).default(""),
    scene: z.string().max(8).default(""),
  }).default({ show: "", episode: "", sequence: "", scene: "" }),
  walls: z.array(WallSchema).max(60).default([]),
  props: z.array(PlanPropSchema).max(40).default([]),
  blocking: z.array(BlockingSchema).max(20).default([]),
  cameras: z.array(CameraSchema).max(16).default([]),
  lights: z.array(LightSchema).max(24).default([]),
  shots: z.array(ShotSchema).max(60).default([]),
  notes: z.array(z.string().max(300)).max(20).default([]),
});

export type Scene = z.infer<typeof SceneSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type PlanCamera = z.infer<typeof CameraSchema>;

// ── shot numbering ──────────────────────────────────────────────────────────

const PAD = 4;

function pad(n: number): string {
  return String(Math.max(0, Math.round(n))).padStart(PAD, "0");
}

/** The numeric tail of a designator, or null when it has none. */
export function shotOrdinal(number: string | undefined): number | null {
  if (!number) return null;
  const m = /(\d+)\s*$/.exec(number);
  return m ? Number(m[1]) : null;
}

/** Assemble a full designator from the scene prefix and an ordinal. */
export function shotDesignator(scene: Scene, ordinal: number): string {
  const parts = [scene.designator.show, scene.designator.episode, scene.designator.sequence, scene.designator.scene]
    .map((p) => p.trim())
    .filter(Boolean);
  return [...parts, pad(ordinal)].join("_");
}

/** Next number in sequence — a clean multiple of ten past the highest so far,
 *  leaving nine slots for later inserts. */
export function nextShotOrdinal(scene: Scene): number {
  const used = scene.shots.map((s) => shotOrdinal(s.number)).filter((n): n is number => n !== null);
  if (!used.length) return 10;
  return (Math.floor(Math.max(...used) / 10) + 1) * 10;
}

/**
 * A number that sorts between two shots.
 *
 * Between 0010 and 0020 this gives 0015 — the whole reason for the gap. When
 * the gap is already exhausted it returns null rather than colliding, because
 * a duplicate shot number is worse than an honest refusal.
 */
export function insertShotOrdinal(before: number, after: number): number | null {
  const lo = Math.min(before, after);
  const hi = Math.max(before, after);
  if (hi - lo < 2) return null;
  return Math.floor((lo + hi) / 2);
}

/** Fill in any missing shot numbers, preserving the ones already assigned. */
export function numberShots(scene: Scene): Scene {
  let next = nextShotOrdinal(scene);
  const shots = scene.shots.map((s) => {
    if (s.number) return s;
    const numbered = { ...s, number: shotDesignator(scene, next) };
    next += 10;
    return numbered;
  });
  return { ...scene, shots };
}

// ── validation ──────────────────────────────────────────────────────────────

const MAX_LIST = 12;
function allowList(ids: string[]): string[] {
  return ids.length > MAX_LIST ? [...ids.slice(0, MAX_LIST), `…and ${ids.length - MAX_LIST} more`] : ids;
}

export function validateScene(scene: Scene): BlueprintProblem[] {
  const problems: BlueprintProblem[] = [];
  const cameraIds = scene.cameras.map((c) => c.id);
  const blockingIds = scene.blocking.map((b) => b.id);

  const seen = new Map<string, string>();
  const claim = (id: string, where: string) => {
    const prior = seen.get(id);
    if (prior) problems.push({ where, problem: `id "${id}" is already used by ${prior}.` });
    else seen.set(id, where);
  };
  scene.walls.forEach((w, i) => claim(w.id, `walls[${i}]`));
  scene.props.forEach((p, i) => claim(p.id, `props[${i}]`));
  scene.blocking.forEach((b, i) => claim(b.id, `blocking[${i}]`));
  scene.cameras.forEach((c, i) => claim(c.id, `cameras[${i}]`));
  scene.lights.forEach((l, i) => claim(l.id, `lights[${i}]`));
  scene.shots.forEach((s, i) => claim(s.id, `shots[${i}]`));

  if (!(scene.extent.w > 0) || !(scene.extent.h > 0)) {
    problems.push({
      where: "extent",
      problem: `the plan area must be positive; got ${scene.extent.w}×${scene.extent.h}. A zero extent renders nothing at all.`,
    });
  }

  scene.cameras.forEach((c, i) => {
    if (!(c.focalMm > 0)) {
      problems.push({ where: `cameras[${i}].focalMm`, problem: `focal length must be positive; got ${c.focalMm}.` });
    }
    if (!SENSORS[c.sensorId]) {
      problems.push({
        where: `cameras[${i}].sensorId`,
        problem: `"${c.sensorId}" is not a known sensor format.`,
        allowed: Object.keys(SENSORS),
      });
    }
    if (c.throwDistance !== undefined && !(c.throwDistance > 0)) {
      problems.push({ where: `cameras[${i}].throwDistance`, problem: `throw distance must be positive; got ${c.throwDistance}.` });
    }
  });

  scene.shots.forEach((s, i) => {
    if (s.camera && !cameraIds.includes(s.camera)) {
      problems.push({
        where: `shots[${i}].camera`,
        problem: `"${s.camera}" is not a declared camera setup.`,
        allowed: allowList(cameraIds),
      });
    }
    s.subjects.forEach((sub, k) => {
      if (!blockingIds.includes(sub)) {
        problems.push({
          where: `shots[${i}].subjects[${k}]`,
          problem: `"${sub}" is not a blocking position in this scene.`,
          allowed: allowList(blockingIds),
        });
      }
    });
    if (s.durationS !== undefined && !(s.durationS > 0)) {
      problems.push({ where: `shots[${i}].durationS`, problem: `duration must be positive; got ${s.durationS}.` });
    }
  });

  // Duplicate shot numbers defeat the entire point of the numbering scheme.
  const numbers = new Set<string>();
  scene.shots.forEach((s, i) => {
    if (!s.number) return;
    if (numbers.has(s.number)) {
      problems.push({
        where: `shots[${i}].number`,
        problem: `shot number "${s.number}" is used twice.`,
        allowed: ["leave `number` off and let it be assigned", "renumber using the gap between neighbours"],
      });
    }
    numbers.add(s.number);
  });

  return problems;
}

export function parseScene(raw: unknown): { ok: true; scene: Scene } | { ok: false; problems: BlueprintProblem[] } {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch (e) {
      return { ok: false, problems: [{ where: "(document)", problem: `not valid JSON: ${String((e as Error).message).slice(0, 120)}` }] };
    }
  }
  const parsed = SceneSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((iss) => ({
        where: iss.path.length ? iss.path.join(".") : "(document)",
        problem: iss.message,
      })),
    };
  }
  const problems = validateScene(parsed.data);
  return problems.length ? { ok: false, problems } : { ok: true, scene: numberShots(parsed.data) };
}

// ── derived coverage ────────────────────────────────────────────────────────

export interface ShotCoverage {
  shotId: string;
  number: string;
  cameraLabel: string;
  focalMm: number;
  /** Distance from the camera to the nearest declared subject. */
  subjectDistance: number | null;
  /** Frame width at that distance, in plan units. */
  coverageWidth: number | null;
  /** Conventional shot-size name derived from coverage vs subject height. */
  size: string;
  /** Subjects the camera does NOT actually see — the check a floor plan
   *  exists to make, and the one people get wrong from a text shot list. */
  missing: string[];
}

/** What each shot actually covers. Every number here is derived from the plan,
 *  never asserted by whoever wrote the shot list. */
export function shotCoverage(scene: Scene): ShotCoverage[] {
  const cameraById = new Map(scene.cameras.map((c) => [c.id, c]));
  const blockingById = new Map(scene.blocking.map((b) => [b.id, b]));

  return scene.shots.map((shot) => {
    const cam = shot.camera ? cameraById.get(shot.camera) : undefined;
    const subjects = shot.subjects.map((id) => blockingById.get(id)).filter(Boolean) as Array<{ id: string; name: string; at: { x: number; y: number }; height?: number }>;

    if (!cam) {
      return {
        shotId: shot.id, number: shot.number || shot.id, cameraLabel: "—", focalMm: 0,
        subjectDistance: null, coverageWidth: null, size: "unknown", missing: [],
      };
    }

    const distances = subjects.map((s) => Math.hypot(s.at.x - cam.at.x, s.at.y - cam.at.y));
    const nearest = distances.length ? Math.min(...distances) : null;
    const width = nearest !== null ? coverageWidthAt(sensorById(cam.sensorId), cam.focalMm, nearest, cam.squeeze) : null;
    const subjectHeight = subjects.find((s) => s.height)?.height ?? 1.7;

    return {
      shotId: shot.id,
      number: shot.number || shot.id,
      cameraLabel: cam.label,
      focalMm: cam.focalMm,
      subjectDistance: nearest,
      coverageWidth: width,
      size: width !== null ? shotSizeLabel(width, subjectHeight) : "unknown",
      missing: subjects.filter((s) => !coversPoint(cam, s.at)).map((s) => s.name),
    };
  });
}
