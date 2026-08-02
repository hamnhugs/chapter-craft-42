import { describe, it, expect } from "vitest";
import {
  checkBlueprintAgainstMaster, checkSceneReferences, checkValidity, formatFindings,
} from "@/lib/blueprint/consistency";
import { BlueprintSchema, type Blueprint } from "@/lib/blueprint/schema";
import { SceneSchema, type Scene } from "@/lib/blueprint/scene";
import type { MasterAssetRow } from "@/lib/masterAssets";

const parseBlueprintDoc = ((v: unknown) => BlueprintSchema.parse(v)) as (v: unknown) => any;
const parseSceneDoc = ((v: unknown) => SceneSchema.parse(v)) as (v: unknown) => any;

function master(over: Partial<MasterAssetRow> = {}): MasterAssetRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "u",
    name: "robot_master",
    hero_image_id: null,
    view_image_ids: [],
    splat_id: null,
    entry_id: null,
    tech_pack_text: "",
    blueprint: null,
    assembly_tag: "the teal-and-white cartoon robot",
    negative_constraints: [],
    banned_traits: [],
    palette: ["#2f8f8f", "#e8e8e8"],
    style_lock: "custom",
    front_azimuth_deg: 0,
    ref_embeddings: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function blueprint(over: Partial<Blueprint> = {}): Blueprint {
  return parseBlueprintDoc({
    kind: "character",
    form: "hard_surface",
    name: "Rustbucket",
    heightHeads: 6,
    palette: [{ role: "shell", hex: "#2f8f8f" }, { role: "trim", hex: "#e8e8e8" }],
    parts: [{ id: "torso", name: "Torso", primitive: "box", size: { x: 2, y: 3, z: 1 }, swatch: "shell" }],
    ...over,
  });
}

describe("blueprint against its master", () => {
  it("passes when the palettes agree", async () => {
    const findings = await checkBlueprintAgainstMaster(blueprint(), master());
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  // The check that earns its keep: a blueprint saved onto a master whose
  // palette it contradicts becomes a second, competing source of truth.
  it("flags a colour that is not in the locked palette", async () => {
    const bp = blueprint({ palette: [{ role: "shell", hex: "#c8452d" }, { role: "trim", hex: "#e8e8e8" }] });
    const findings = await checkBlueprintAgainstMaster(bp, master());
    const conflict = findings.find((f) => f.severity === "error")!;
    expect(conflict.where).toContain("shell");
    expect(conflict.allowed).toContain("#2f8f8f");
    expect(conflict.pair).toBeTruthy();
  });

  it("accepts a colour that differs only imperceptibly", async () => {
    // One step off #2f8f8f — a person would call this the same teal.
    const bp = blueprint({ palette: [{ role: "shell", hex: "#2f9090" }, { role: "trim", hex: "#e8e8e8" }] });
    const findings = await checkBlueprintAgainstMaster(bp, master());
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("warns about a locked colour nothing uses", async () => {
    const bp = blueprint({ palette: [{ role: "shell", hex: "#2f8f8f" }] });
    const findings = await checkBlueprintAgainstMaster(bp, master());
    expect(findings.some((f) => f.severity === "warning" && /nothing in this blueprint uses it/.test(f.problem))).toBe(true);
  });

  it("flags a blueprint that describes a forbidden trait", async () => {
    const bp = blueprint({ notes: ["Chrome finish across the shoulders."] });
    const findings = await checkBlueprintAgainstMaster(bp, master({ banned_traits: ["chrome finish"] }));
    expect(findings.some((f) => f.severity === "error" && /must never have/.test(f.problem))).toBe(true);
  });

  // A false contradiction is worse than a missed one for a check people have
  // to trust, so short negatives are skipped rather than substring-matched.
  it("does not fire on a short negative that appears inside another word", async () => {
    const bp = blueprint({ notes: ["Armoured sleeve over the elbow."] });
    const findings = await checkBlueprintAgainstMaster(bp, master({ banned_traits: ["arm"] }));
    expect(findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("warns when an organic blueprint sits under a vector style lock", async () => {
    const bp = blueprint({ form: "organic", landmarks: [{ id: "eye", name: "Eye line", atHeads: 5.5 }] });
    const findings = await checkBlueprintAgainstMaster(bp, master({ style_lock: "vector" }));
    expect(findings.some((f) => f.where === "form")).toBe(true);
  });

  it("says nothing when the master has no locked palette", async () => {
    const findings = await checkBlueprintAgainstMaster(blueprint(), master({ palette: [] }));
    expect(findings).toEqual([]);
  });

  it("puts conflicts before warnings", async () => {
    const bp = blueprint({ palette: [{ role: "shell", hex: "#c8452d" }] });
    const findings = await checkBlueprintAgainstMaster(bp, master());
    expect(findings[0].severity).toBe("error");
  });
});

describe("effectivity", () => {
  it("says nothing without a validity range", () => {
    expect(checkValidity(blueprint(), 5)).toEqual([]);
  });

  it("says nothing when the chapter is unknown", () => {
    expect(checkValidity(blueprint({ validity: { fromChapter: 4 } }), null)).toEqual([]);
  });

  it("warns when the chapter is before the revision exists", () => {
    const findings = checkValidity(blueprint({ validity: { fromChapter: 10, toChapter: 20 } }), 3);
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toContain("10–20");
  });

  it("warns when the chapter is past the revision", () => {
    expect(checkValidity(blueprint({ validity: { toChapter: 8 } }), 12)).toHaveLength(1);
  });

  it("accepts a chapter inside the range", () => {
    expect(checkValidity(blueprint({ validity: { fromChapter: 4, toChapter: 11 } }), 7)).toEqual([]);
  });
});

describe("scene references", () => {
  function scene(over: Partial<Scene> = {}): Scene {
    return parseSceneDoc({
      name: "The Forge",
      extent: { w: 10, h: 8 },
      blocking: [{ id: "smith", name: "Smith", at: { x: 5, y: 5 }, master: "robot_master" }],
      cameras: [{ id: "a", label: "A", at: { x: 5, y: 1 }, headingDeg: 0, focalMm: 35 }],
      shots: [{ id: "s1", camera: "a", subjects: ["smith"], action: "Smith works." }],
      ...over,
    });
  }
  const resolveOk = async (ref: string) => (ref.replace(/^@/, "") === "robot_master" ? master() : null);

  it("passes when every reference resolves and everything is used", async () => {
    expect(await checkSceneReferences(scene(), resolveOk)).toEqual([]);
  });

  it("flags a reference to a master that does not exist", async () => {
    const s = scene({ blocking: [{ id: "ghost", name: "Ghost", at: { x: 1, y: 1 }, facingDeg: 0, master: "nobody" }], shots: [] });
    const findings = await checkSceneReferences(s, resolveOk, ["robot_master"]);
    const conflict = findings.find((f) => f.severity === "error")!;
    expect(conflict.problem).toContain("does not exist");
    expect(conflict.allowed).toContain("@robot_master");
  });

  it("warns about someone placed on the plan but in no shot", async () => {
    const s = scene({ shots: [] });
    const findings = await checkSceneReferences(s, resolveOk);
    expect(findings.some((f) => /appears in no shot/.test(f.problem))).toBe(true);
  });

  it("warns about a camera nothing uses", async () => {
    const s = scene({ shots: [{ id: "s1", camera: undefined, movement: "static", subjects: ["smith"], action: "x" }] });
    const findings = await checkSceneReferences(s, resolveOk);
    expect(findings.some((f) => /no shot uses it/.test(f.problem))).toBe(true);
  });
});

describe("formatting", () => {
  it("marks conflicts differently from checks", () => {
    const lines = formatFindings([
      { severity: "error", where: "palette", problem: "wrong colour.", allowed: ["#111111"] },
      { severity: "warning", where: "form", problem: "unusual." },
    ]);
    expect(lines[0].startsWith("CONFLICT")).toBe(true);
    expect(lines[0]).toContain("Valid here: #111111.");
    expect(lines[1].startsWith("check")).toBe(true);
  });
});
