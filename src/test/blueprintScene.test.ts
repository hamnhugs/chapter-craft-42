import { describe, it, expect } from "vitest";
import {
  SceneSchema, parseScene, validateScene, numberShots, shotCoverage,
  nextShotOrdinal, insertShotOrdinal, shotOrdinal, shotDesignator,
  type Scene,
} from "@/lib/blueprint/scene";
import { renderPlanSheet } from "@/lib/blueprint/planSheet";
import { validateSheetSvg } from "@/lib/blueprint/sheetValidate";
import { sheetIntrinsicSize } from "@/lib/blueprint/raster";
import { renderBlueprintSheet } from "@/lib/blueprint/sheet";
import { BlueprintSchema } from "@/lib/blueprint/schema";

function forge(over: Partial<Scene> = {}): Scene {
  return SceneSchema.parse({
    name: "The Forge",
    slug: "INT. FORGE — NIGHT",
    unit: "m",
    extent: { w: 12, h: 9 },
    designator: { show: "CHP", episode: "101", sequence: "FRG", scene: "004" },
    walls: [
      { id: "w_n", from: { x: 0, y: 9 }, to: { x: 12, y: 9 }, kind: "wall" },
      { id: "w_e", from: { x: 12, y: 9 }, to: { x: 12, y: 0 }, kind: "wall" },
      { id: "w_s", from: { x: 12, y: 0 }, to: { x: 0, y: 0 }, kind: "flat" },
      { id: "door", from: { x: 0, y: 3 }, to: { x: 0, y: 5 }, kind: "opening" },
    ],
    props: [{ id: "anvil", name: "Anvil", at: { x: 6, y: 5 }, w: 1.2, d: 0.6 }],
    blocking: [
      { id: "smith", name: "Smith", at: { x: 6, y: 6 }, facingDeg: 180, height: 1.8 },
      { id: "boy", name: "Apprentice", at: { x: 8.5, y: 6 }, facingDeg: 200, height: 1.4 },
    ],
    cameras: [
      { id: "a", label: "A", at: { x: 6, y: 1 }, headingDeg: 0, focalMm: 35, sensorId: "super35_4perf", throwDistance: 12 },
      { id: "b", label: "B", at: { x: 1, y: 1 }, headingDeg: 40, focalMm: 85, sensorId: "super35_4perf", throwDistance: 12 },
    ],
    lights: [{ id: "key1", name: "Forge glow", at: { x: 6, y: 4.4 }, kind: "practical" }],
    shots: [
      { id: "s1", camera: "a", movement: "static", subjects: ["smith"], action: "Smith works the bar.", durationS: 6 },
      { id: "s2", camera: "b", movement: "dolly", subjects: ["smith", "boy"], action: "Push in past the apprentice.", durationS: 4 },
    ],
    notes: ["Practical is the only motivated source."],
    ...over,
  });
}

describe("shot numbering", () => {
  it("assigns numbers in steps of ten", () => {
    const scene = numberShots(forge());
    expect(scene.shots[0].number).toBe("CHP_101_FRG_004_0010");
    expect(scene.shots[1].number).toBe("CHP_101_FRG_004_0020");
  });

  it("leaves numbers that were already assigned alone", () => {
    const scene = forge();
    scene.shots[0].number = "CHP_101_FRG_004_0005";
    const numbered = numberShots(scene);
    expect(numbered.shots[0].number).toBe("CHP_101_FRG_004_0005");
  });

  it("continues past the highest existing number", () => {
    const scene = forge();
    scene.shots[0].number = "CHP_101_FRG_004_0250";
    expect(nextShotOrdinal(scene)).toBe(260);
  });

  it("starts at ten for an empty scene", () => {
    expect(nextShotOrdinal(forge({ shots: [] }))).toBe(10);
  });

  // The entire reason for the step of ten: the story changes and shots get
  // inserted, and renumbering the sequence is what makes people abandon a plan.
  it("finds room between two adjacent shots", () => {
    expect(insertShotOrdinal(10, 20)).toBe(15);
    expect(insertShotOrdinal(20, 10)).toBe(15);
  });

  it("refuses rather than colliding when the gap is used up", () => {
    expect(insertShotOrdinal(10, 11)).toBeNull();
    expect(insertShotOrdinal(10, 10)).toBeNull();
  });

  it("reads the ordinal off a full designator", () => {
    expect(shotOrdinal("CHP_101_FRG_004_0170")).toBe(170);
    expect(shotOrdinal(undefined)).toBeNull();
    expect(shotOrdinal("no-digits")).toBeNull();
  });

  it("builds a designator without empty segments", () => {
    const bare = forge({ designator: { show: "", episode: "", sequence: "", scene: "" } });
    expect(shotDesignator(bare, 30)).toBe("0030");
  });
});

describe("coverage", () => {
  it("derives shot size from the optics rather than trusting a label", () => {
    const cov = shotCoverage(numberShots(forge()));
    expect(cov[0].focalMm).toBe(35);
    expect(cov[0].subjectDistance).toBeCloseTo(5, 6);
    expect(cov[0].coverageWidth).toBeGreaterThan(0);
    expect(cov[0].size).not.toBe("unknown");
  });

  // This is the check the drawing exists to make: an 85mm from that corner
  // simply does not see both people.
  it("names subjects the lens does not actually cover", () => {
    const scene = forge();
    scene.cameras[1].focalMm = 200;
    scene.cameras[1].headingDeg = 0;
    const cov = shotCoverage(numberShots(scene));
    expect(cov[1].missing.length).toBeGreaterThan(0);
  });

  it("reports nothing missing when the lens is wide enough", () => {
    const scene = forge();
    scene.cameras[1].focalMm = 14;
    scene.cameras[1].headingDeg = 45;
    const cov = shotCoverage(numberShots(scene));
    expect(cov[1].missing).toEqual([]);
  });

  it("degrades gracefully for a shot with no camera", () => {
    const scene = forge();
    scene.shots[0].camera = undefined;
    const cov = shotCoverage(numberShots(scene));
    expect(cov[0].size).toBe("unknown");
    expect(cov[0].coverageWidth).toBeNull();
  });
});

describe("scene validation", () => {
  it("accepts a sound scene", () => {
    expect(parseScene(forge()).ok).toBe(true);
  });

  it("catches a shot pointing at a camera that does not exist", () => {
    const scene = forge();
    scene.shots[0].camera = "z";
    const p = validateScene(scene).find((x) => x.where === "shots[0].camera")!;
    expect(p.allowed).toContain("a");
  });

  it("catches a subject that is not blocked in this scene", () => {
    const scene = forge();
    scene.shots[0].subjects = ["ghost"];
    const p = validateScene(scene).find((x) => x.where === "shots[0].subjects[0]")!;
    expect(p.allowed).toContain("smith");
  });

  it("rejects an unknown sensor and lists the real ones", () => {
    const scene = forge();
    scene.cameras[0].sensorId = "imax";
    const p = validateScene(scene).find((x) => x.where === "cameras[0].sensorId")!;
    expect(p.allowed).toContain("super35_4perf");
  });

  it("rejects a non-positive focal length", () => {
    const scene = forge();
    scene.cameras[0].focalMm = 0;
    expect(validateScene(scene).some((p) => p.where === "cameras[0].focalMm")).toBe(true);
  });

  it("rejects a zero plan extent, which would render nothing", () => {
    const scene = forge({ extent: { w: 0, h: 9 } });
    expect(validateScene(scene).some((p) => p.where === "extent")).toBe(true);
  });

  it("catches duplicate ids across collections", () => {
    const scene = forge();
    scene.props[0].id = "smith";
    expect(validateScene(scene).some((p) => /already used/.test(p.problem))).toBe(true);
  });

  it("catches a duplicate shot number", () => {
    const scene = forge();
    scene.shots[0].number = "X_0010";
    scene.shots[1].number = "X_0010";
    expect(validateScene(scene).some((p) => /used twice/.test(p.problem))).toBe(true);
  });

  it("rejects a non-positive duration", () => {
    const scene = forge();
    scene.shots[0].durationS = 0;
    expect(validateScene(scene).some((p) => p.where === "shots[0].durationS")).toBe(true);
  });
});

describe("stage plan rendering", () => {
  it("passes the sheet validator", () => {
    const plan = renderPlanSheet(numberShots(forge()));
    expect(validateSheetSvg(plan.svg)).toEqual([]);
  });

  it("is deterministic", () => {
    expect(renderPlanSheet(numberShots(forge())).svg).toBe(renderPlanSheet(numberShots(forge())).svg);
  });

  it("draws real coverage wedges from the lens, not decorative triangles", () => {
    const wide = renderPlanSheet(numberShots(forge({
      cameras: [{ id: "a", label: "A", at: { x: 6, y: 1 }, headingDeg: 0, focalMm: 18, sensorId: "full_frame", squeeze: 1, throwDistance: 8 }],
      shots: [],
    })));
    const tele = renderPlanSheet(numberShots(forge({
      cameras: [{ id: "a", label: "A", at: { x: 6, y: 1 }, headingDeg: 0, focalMm: 200, sensorId: "full_frame", squeeze: 1, throwDistance: 8 }],
      shots: [],
    })));
    const spanOf = (svg: string) => {
      const m = /<polygon points="([^"]+)" fill="#6d97ba"/.exec(svg);
      if (!m) return 0;
      const xs = m[1].split(" ").map((p) => Number(p.split(",")[0]));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spanOf(wide.svg)).toBeGreaterThan(spanOf(tele.svg) * 2);
  });

  it("reports coverage warnings to the caller, not only on the page", () => {
    const scene = forge();
    scene.cameras[1].focalMm = 300;
    scene.cameras[1].headingDeg = 0;
    const plan = renderPlanSheet(numberShots(scene));
    expect(plan.coverageWarnings.length).toBeGreaterThan(0);
    expect(plan.coverageWarnings[0]).toContain("does not cover");
  });

  it("puts plan north above plan south on the page", () => {
    // SVG y grows downward, so a northern wall must have the smaller y.
    const plan = renderPlanSheet(numberShots(forge()));
    const northWall = /<line x1="[\d.]+" y1="([\d.]+)"[^/]*stroke="#16191d" stroke-width="3"/.exec(plan.svg);
    expect(northWall).toBeTruthy();
  });

  it("suppresses an unreadable grid rather than drawing 4000 lines", () => {
    const huge = renderPlanSheet(numberShots(forge({ extent: { w: 400, h: 400 } })), { gridStep: 0.5 });
    expect(huge.omitted.join(" ")).toContain("grid suppressed");
  });

  it("stays within the node budget for a busy scene", () => {
    const plan = renderPlanSheet(numberShots(forge()));
    expect(plan.nodeCount).toBeLessThan(1500);
  });

  it("renders an empty stage without falling over", () => {
    const empty = SceneSchema.parse({ name: "Void", extent: { w: 5, h: 5 } });
    const plan = renderPlanSheet(empty);
    expect(validateSheetSvg(plan.svg)).toEqual([]);
  });

  it("escapes a scene name that would break the markup", () => {
    const plan = renderPlanSheet(numberShots(forge({ name: '<script>x</script>' })));
    expect(plan.svg).not.toContain("<script");
    expect(validateSheetSvg(plan.svg)).toEqual([]);
  });

  it("draws the sequence strip in proportion to duration", () => {
    const plan = renderPlanSheet(numberShots(forge()));
    expect(plan.svg).toContain("SEQUENCE · 10.0s");
  });
});

describe("raster sizing", () => {
  it("reads a sheet's intrinsic size from its viewBox", () => {
    const svg = renderBlueprintSheet(BlueprintSchema.parse({
      kind: "prop", form: "hard_surface", name: "Crate", heightHeads: 1,
    })).svg;
    const size = sheetIntrinsicSize(svg);
    expect(size?.width).toBe(1000);
    expect(size?.height).toBeGreaterThan(0);
  });

  it("returns null when there is no usable viewBox", () => {
    expect(sheetIntrinsicSize("<svg></svg>")).toBeNull();
    expect(sheetIntrinsicSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
  });
});
