import { z } from "zod";

// Blueprint — the structured tech pack. This is the app's ONE authoritative
// definition of a character, prop or set; every drawing, every sheet and every
// reference image is DERIVED from it and none is hand-edited. That is the only
// idea worth borrowing from model-based definition in CAD, and it is the whole
// reason this file exists: `master_assets.tech_pack_text` is prose, and prose
// cannot be drawn, projected or checked.
//
// THE MODEL NEVER WRITES A COORDINATE. Measured: on raw SVG path geometry a
// frontier model scores ~10-13% against a 10% chance baseline, and giving it a
// code interpreter helps by +40 points only when it EVALUATES a known formula —
// when it has to invent the algorithm the same tool makes it WORSE (-12.5 on
// pathfinding). So the model supplies structure and proportion; geometry.ts
// computes every number. Sizes are in HEAD-UNITS and attach points are
// normalized 0..1 on a face, so there is no absolute coordinate to get wrong.
//
// SCHEMA SHAPE IS DELIBERATE. Grammar-constrained decoding silently DROPS
// `minimum`/`maximum`/`minLength`/`minItems`, `allOf`, `if/then/else` and
// recursive `$ref` — so those never reach the sampler and referential integrity
// (does this part id exist? is this hex in the palette?) is ours to enforce.
// Hence: flat, shallow, id-referenced rather than nested, with the real rules
// living in validate() below. Deep schemas also fall off a coverage cliff in
// every constrained-decoding engine measured.

export const BLUEPRINT_VERSION = 1;

/** Shapes the kernel knows how to project. Deliberately small: every addition
 *  is a new silhouette routine, and a technical drawing needs primitives, not
 *  a modelling package. */
export const PRIMITIVES = ["box", "plate", "wedge", "cylinder", "capsule", "cone", "sphere"] as const;
export type Primitive = (typeof PRIMITIVES)[number];

export const FACES = ["front", "back", "left", "right", "top", "bottom"] as const;
export type Face = (typeof FACES)[number];

export const AXES = ["x", "y", "z"] as const;

/** hard_surface projects; organic degrades to a proportion scaffold. `mixed` is
 *  the common real case — an organic body carrying hard-surface gear — and
 *  projects the parts that can be projected while scaffolding the rest. */
export const FORMS = ["hard_surface", "organic", "mixed"] as const;
export type Form = (typeof FORMS)[number];

export const KINDS = ["character", "prop", "set"] as const;

// Slug ids: referenced by other rows, so they have to survive JSON round-trips
// and read cleanly in a validator error message.
const ID = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "id must be lowercase letters, digits, '-' or '_' (max 40)");
const LABEL = z.string().min(1).max(80);
const HEX = z.string().regex(/^#[0-9a-f]{6}$/i, "expected #rrggbb");

const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const PartSchema = z.object({
  id: ID,
  name: LABEL,
  primitive: z.enum(PRIMITIVES),
  /** Extent in head-units along each world axis before rotation. */
  size: Vec3,
  /** Parent part id. Omit for the root. Exactly one part may omit it. */
  parent: ID.optional(),
  /** Attach point ON THE PARENT that this part hangs from. Without it the part
   *  sits at the parent's origin. */
  attach: ID.optional(),
  /** Head-unit offset from the attach point (or from the parent origin). */
  offset: Vec3.optional(),
  /** Euler degrees, applied X then Y then Z, before translation. */
  rotate: Vec3.optional(),
  /** Swatch role this part is painted in — never a raw hex, so a palette change
   *  is one edit rather than a search-and-replace. */
  swatch: z.string().max(40).optional(),
  /** "mirror_x" emits a second instance reflected through the YZ plane. One
   *  arm declaration yields two arms that cannot drift apart. */
  symmetry: z.enum(["none", "mirror_x"]).optional(),
});
// Types are written out rather than inferred with z.infer: this project builds
// without strictNullChecks, under which zod widens every inferred property to
// optional and the geometry kernel can no longer trust that a size has an x.
export interface Vec3Lit { x: number; y: number; z: number }

export interface Part {
  id: string;
  name: string;
  primitive: Primitive;
  size: Vec3Lit;
  parent?: string;
  attach?: string;
  offset?: Vec3Lit;
  rotate?: Vec3Lit;
  swatch?: string;
  symmetry?: "none" | "mirror_x";
}

export const AttachPointSchema = z.object({
  id: ID,
  name: LABEL,
  part: ID,
  face: z.enum(FACES),
  /** Normalized position on that face, 0..1 — proportional, never absolute. */
  u: z.number(),
  v: z.number(),
});
export interface AttachPoint {
  id: string;
  name: string;
  part: string;
  face: Face;
  u: number;
  v: number;
}

export const JointSchema = z.object({
  id: ID,
  name: LABEL,
  part: ID,
  /** Attach point the joint pivots about. */
  at: ID,
  axis: z.enum(AXES),
  /** Degrees [min, max]. Drawn as an arc on the sheet when present. */
  range: z.tuple([z.number(), z.number()]).optional(),
});
export interface Joint {
  id: string;
  name: string;
  part: string;
  at: string;
  axis: (typeof AXES)[number];
  range?: [number, number];
}

/** A horizon line at a given height in head-units — eye line, chin, shoulder,
 *  waist, knee. This is how real model sheets handle organic characters: they
 *  do not project anatomy either, they give a construction scaffold. It is also
 *  the only part of the drawing that is fully subject-independent. */
export const LandmarkSchema = z.object({
  id: ID,
  name: LABEL,
  /** Height above the ground plane, in head-units. */
  atHeads: z.number(),
});
export interface Landmark {
  id: string;
  name: string;
  atHeads: number;
}

/** Palette entry. `role` is what parts and costume reference; `hex` is what the
 *  sheet paints and what the ΔE gate scores against. The hex NEVER goes in a
 *  generation prompt — text encoders split "#FF5733" into "#", "FF", "57", "33",
 *  tokens carrying no colour meaning, and numeric colour adherence measures
 *  under 10% for most image models. The same hex rendered as a swatch in the
 *  sheet measured ΔE 0.90 against 11.25 for the prompt string. Put it in pixels. */
export const SwatchSchema = z.object({
  role: z.string().min(1).max(40),
  hex: HEX,
  note: z.string().max(120).optional(),
});
export interface Swatch {
  role: string;
  hex: string;
  note?: string;
}

export const CostumeLayerSchema = z.object({
  id: ID,
  name: LABEL,
  /** Parts this layer covers. */
  covers: z.array(ID).max(40).default([]),
  /** e.g. "travelling cloak, hood down" — costume continuity is its own axis. */
  state: z.string().max(120).optional(),
  swatchRoles: z.array(z.string().max(40)).max(12).default([]),
});
export interface CostumeLayer {
  id: string;
  name: string;
  covers: string[];
  state?: string;
  swatchRoles: string[];
}

/** Scars, asymmetries, which side the hair parts on. Called out separately
 *  because `symmetry: "mirror_x"` would otherwise silently duplicate them onto
 *  both sides — an asymmetric feature is exactly what mirroring destroys. */
export const MarkSchema = z.object({
  name: LABEL,
  part: ID,
  side: z.enum(["left", "right", "center"]),
  description: z.string().max(200),
});
export interface Mark {
  name: string;
  part: string;
  side: "left" | "right" | "center";
  description: string;
}

export const BlueprintSchema = z.object({
  version: z.number().int().default(BLUEPRINT_VERSION),
  kind: z.enum(KINDS),
  form: z.enum(FORMS),
  name: LABEL,
  /** Shape-language in one line ("stacked cylinders, heavy base, no sharp
   *  corners"). Silhouette is the first thing that goes off-model. */
  silhouette: z.string().max(300).default(""),
  /** Total height in head-units — the proportion anchor everything scales to. */
  heightHeads: z.number(),
  absoluteHeight: z.object({
    value: z.number(),
    unit: z.enum(["cm", "m", "in", "ft"]),
  }).optional(),

  parts: z.array(PartSchema).max(60).default([]),
  attachPoints: z.array(AttachPointSchema).max(60).default([]),
  joints: z.array(JointSchema).max(40).default([]),
  landmarks: z.array(LandmarkSchema).max(20).default([]),
  palette: z.array(SwatchSchema).max(16).default([]),
  costume: z.array(CostumeLayerSchema).max(20).default([]),
  marks: z.array(MarkSchema).max(20).default([]),

  /** Descriptive noun phrases ("extra limbs", "palette shift") — never "no X".
   *  Routed to a model's negative-prompt parameter where one exists. */
  negatives: z.array(z.string().max(200)).max(20).default([]),
  /** Construction annotations printed on the sheet. */
  notes: z.array(z.string().max(300)).max(20).default([]),
  /** Effectivity range. A character legitimately has revisions valid over part
   *  of a book — the one genuinely transferable idea from PLM configuration
   *  management, and the reason a blueprint is versioned rather than replaced. */
  validity: z.object({
    fromChapter: z.number().int().optional(),
    toChapter: z.number().int().optional(),
  }).optional(),
});

export interface Blueprint {
  version: number;
  kind: (typeof KINDS)[number];
  form: Form;
  name: string;
  silhouette: string;
  heightHeads: number;
  absoluteHeight?: { value: number; unit: "cm" | "m" | "in" | "ft" };
  parts: Part[];
  attachPoints: AttachPoint[];
  joints: Joint[];
  landmarks: Landmark[];
  palette: Swatch[];
  costume: CostumeLayer[];
  marks: Mark[];
  negatives: string[];
  notes: string[];
  validity?: { fromChapter?: number; toChapter?: number };
}

// ── structural validation ───────────────────────────────────────────────────
//
// Everything the sampler's grammar cannot express. Each problem carries WHERE
// it is, WHAT is wrong, and — the part usually left out — WHICH VALUES WOULD BE
// ACCEPTED. In the measured repair literature that third field is worth 36-40
// of the ~42 points a good error message buys; without it the feedback is
// almost worthless.

export interface BlueprintProblem {
  /** Dotted path into the document, e.g. "parts[3].parent". */
  where: string;
  /** What is wrong, in one sentence. */
  problem: string;
  /** Values that would be accepted here. Empty when the fix isn't a choice. */
  allowed?: string[];
}

const MAX_LIST = 12; // never dump 60 ids into a prompt

function allowList(ids: string[]): string[] {
  return ids.length > MAX_LIST ? [...ids.slice(0, MAX_LIST), `…and ${ids.length - MAX_LIST} more`] : ids;
}

/** Structural checks over an already-parsed blueprint. Pure, deterministic,
 *  and never throws — a validator that throws cannot report the second error. */
export function validateBlueprint(bp: Blueprint): BlueprintProblem[] {
  const problems: BlueprintProblem[] = [];
  const partIds = bp.parts.map((p) => p.id);
  const apIds = bp.attachPoints.map((a) => a.id);
  const roles = bp.palette.map((s) => s.role);

  // ── unique ids ──
  const seen = new Map<string, string>();
  const claim = (id: string, where: string) => {
    const prior = seen.get(id);
    if (prior) {
      problems.push({ where, problem: `id "${id}" is already used by ${prior}. Every id in a blueprint shares one namespace.` });
    } else {
      seen.set(id, where);
    }
  };
  bp.parts.forEach((p, i) => claim(p.id, `parts[${i}]`));
  bp.attachPoints.forEach((a, i) => claim(a.id, `attachPoints[${i}]`));
  bp.joints.forEach((j, i) => claim(j.id, `joints[${i}]`));
  bp.landmarks.forEach((l, i) => claim(l.id, `landmarks[${i}]`));
  bp.costume.forEach((c, i) => claim(c.id, `costume[${i}]`));

  // ── exactly one root, and no cycles ──
  const roots = bp.parts.filter((p) => !p.parent);
  if (bp.parts.length > 0 && roots.length === 0) {
    problems.push({
      where: "parts",
      problem: "no root part — every part declares a parent, so the assembly is a cycle and nothing can be positioned.",
      allowed: allowList(partIds),
    });
  } else if (roots.length > 1) {
    problems.push({
      where: "parts",
      problem: `${roots.length} parts have no parent (${roots.map((r) => r.id).join(", ")}). An assembly has exactly one root; hang the others off it.`,
      allowed: allowList(partIds),
    });
  }

  const byId = new Map(bp.parts.map((p) => [p.id, p]));
  bp.parts.forEach((p, i) => {
    if (p.parent !== undefined && !byId.has(p.parent)) {
      problems.push({
        where: `parts[${i}].parent`,
        problem: `"${p.parent}" is not a declared part.`,
        allowed: allowList(partIds.filter((id) => id !== p.id)),
      });
    }
    if (p.parent === p.id) {
      problems.push({ where: `parts[${i}].parent`, problem: `part "${p.id}" is its own parent.` });
    }
    if (p.attach !== undefined && !apIds.includes(p.attach)) {
      problems.push({
        where: `parts[${i}].attach`,
        problem: `"${p.attach}" is not a declared attach point.`,
        allowed: allowList(apIds),
      });
    }
    if (p.swatch !== undefined && !roles.includes(p.swatch)) {
      problems.push({
        where: `parts[${i}].swatch`,
        problem: `"${p.swatch}" is not a role in the palette.`,
        allowed: allowList(roles),
      });
    }
    for (const [axis, v] of Object.entries(p.size) as Array<[string, number]>) {
      if (!Number.isFinite(v) || v <= 0) {
        problems.push({
          where: `parts[${i}].size.${axis}`,
          problem: `size must be a positive number of head-units; got ${v}. A zero extent collapses the part's projection to a line and blanks the panel.`,
        });
      }
    }
  });

  // Cycle detection over the parent chain — a cycle survives the "one root"
  // check whenever a detached ring coexists with a valid root.
  for (let i = 0; i < bp.parts.length; i++) {
    const start = bp.parts[i];
    const path = new Set<string>([start.id]);
    let cur = start.parent;
    let hops = 0;
    while (cur && hops++ <= bp.parts.length) {
      if (path.has(cur)) {
        problems.push({
          where: `parts[${i}].parent`,
          problem: `part "${start.id}" is in a parent cycle (${[...path].join(" → ")} → ${cur}).`,
        });
        break;
      }
      path.add(cur);
      cur = byId.get(cur)?.parent;
    }
  }

  bp.attachPoints.forEach((a, i) => {
    if (!byId.has(a.part)) {
      problems.push({
        where: `attachPoints[${i}].part`,
        problem: `"${a.part}" is not a declared part.`,
        allowed: allowList(partIds),
      });
    }
    for (const k of ["u", "v"] as const) {
      const v = a[k];
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        problems.push({
          where: `attachPoints[${i}].${k}`,
          problem: `${k} is a normalized position on the face and must be between 0 and 1; got ${v}.`,
        });
      }
    }
  });

  bp.joints.forEach((j, i) => {
    if (!byId.has(j.part)) {
      problems.push({ where: `joints[${i}].part`, problem: `"${j.part}" is not a declared part.`, allowed: allowList(partIds) });
    }
    if (!apIds.includes(j.at)) {
      problems.push({ where: `joints[${i}].at`, problem: `"${j.at}" is not a declared attach point.`, allowed: allowList(apIds) });
    }
    if (j.range && j.range[0] > j.range[1]) {
      problems.push({ where: `joints[${i}].range`, problem: `range is [min, max]; got [${j.range[0]}, ${j.range[1]}].` });
    }
  });

  bp.costume.forEach((c, i) => {
    c.covers.forEach((partId, k) => {
      if (!byId.has(partId)) {
        problems.push({ where: `costume[${i}].covers[${k}]`, problem: `"${partId}" is not a declared part.`, allowed: allowList(partIds) });
      }
    });
    c.swatchRoles.forEach((role, k) => {
      if (!roles.includes(role)) {
        problems.push({ where: `costume[${i}].swatchRoles[${k}]`, problem: `"${role}" is not a role in the palette.`, allowed: allowList(roles) });
      }
    });
  });

  bp.marks.forEach((m, i) => {
    if (!byId.has(m.part)) {
      problems.push({ where: `marks[${i}].part`, problem: `"${m.part}" is not a declared part.`, allowed: allowList(partIds) });
    }
    // A one-sided mark on a mirrored part is the classic turnaround bug: the
    // mirror duplicates the scar onto both cheeks.
    const part = byId.get(m.part);
    if (part?.symmetry === "mirror_x" && m.side !== "center") {
      problems.push({
        where: `marks[${i}]`,
        problem: `"${m.name}" is on the ${m.side} side of part "${m.part}", but that part has symmetry "mirror_x" — mirroring would copy the mark onto both sides.`,
        allowed: ["set the part's symmetry to \"none\" and declare both sides explicitly", "move the mark to a part that is not mirrored", "set side to \"center\""],
      });
    }
  });

  // Duplicate palette roles make `swatch: "accent"` ambiguous.
  const roleSeen = new Set<string>();
  bp.palette.forEach((s, i) => {
    if (roleSeen.has(s.role)) {
      problems.push({ where: `palette[${i}].role`, problem: `role "${s.role}" is declared twice; roles are the key parts reference.` });
    }
    roleSeen.add(s.role);
  });

  if (!Number.isFinite(bp.heightHeads) || bp.heightHeads <= 0) {
    problems.push({
      where: "heightHeads",
      problem: `total height in head-units must be positive; got ${bp.heightHeads}. Everything else scales to it.`,
    });
  }

  bp.landmarks.forEach((l, i) => {
    if (!Number.isFinite(l.atHeads) || l.atHeads < 0 || l.atHeads > bp.heightHeads) {
      problems.push({
        where: `landmarks[${i}].atHeads`,
        problem: `landmark "${l.name}" sits at ${l.atHeads} heads, outside the figure's 0..${bp.heightHeads}.`,
      });
    }
  });

  // An organic blueprint with no landmarks has nothing to draw: its parts are
  // not projected, so the scaffold IS the drawing.
  if ((bp.form === "organic" || bp.form === "mixed") && bp.landmarks.length === 0) {
    problems.push({
      where: "landmarks",
      problem: `form is "${bp.form}", so views are drawn as a proportion scaffold rather than projected solids — but no landmarks are declared, which leaves the panels empty.`,
      allowed: ["eye line", "chin", "shoulder", "waist", "hip", "knee", "ankle"],
    });
  }

  return problems;
}

/** Parse + validate in one step. Returns the blueprint only when it is
 *  structurally sound, so callers can never render a half-valid document. */
export function parseBlueprint(raw: unknown): { ok: true; blueprint: Blueprint } | { ok: false; problems: BlueprintProblem[] } {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch (e) {
      return { ok: false, problems: [{ where: "(document)", problem: `not valid JSON: ${String((e as Error).message).slice(0, 120)}` }] };
    }
  }
  const parsed = BlueprintSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((iss) => ({
        where: iss.path.length ? iss.path.join(".") : "(document)",
        problem: iss.message,
      })),
    };
  }
  const problems = validateBlueprint(parsed.data);
  return problems.length ? { ok: false, problems } : { ok: true, blueprint: parsed.data };
}

/** One line per problem, for a tool result the model reads. Location, then the
 *  violation, then the admissible values. */
export function formatProblems(problems: BlueprintProblem[]): string[] {
  return problems.map((p) => {
    const tail = p.allowed?.length ? ` Valid here: ${p.allowed.join(", ")}.` : "";
    return `${p.where}: ${p.problem}${tail}`;
  });
}
