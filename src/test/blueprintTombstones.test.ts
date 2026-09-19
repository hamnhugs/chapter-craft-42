import { describe, it, expect } from "vitest";
import { SceneSchema, numberShots, type Scene } from "@/lib/blueprint/scene";
import { renderPlanSheet } from "@/lib/blueprint/planSheet";
import { validateSheetSvg } from "@/lib/blueprint/sheetValidate";

// An omitted shot is a tombstone: the film-set convention where a cut shot
// keeps its row and its number — the hole in the sequence is information — but
// is struck through and drops out of everything computed. These tests pin the
// three "drops out" rules: no coverage warning, no screen time, no strip cell.

const parseSceneDoc = ((v: unknown) => SceneSchema.parse(v)) as (v: unknown) => any;

function forgeWithTombstone(over: Partial<Scene> = {}): Scene {
  return parseSceneDoc({
    name: "The Forge",
    slug: "INT. FORGE — NIGHT",
    unit: "m",
    extent: { w: 12, h: 9 },
    designator: { show: "CHP", episode: "101", sequence: "FRG", scene: "004" },
    walls: [
      { id: "w_n", from: { x: 0, y: 9 }, to: { x: 12, y: 9 }, kind: "wall" },
    ],
    blocking: [
      { id: "smith", name: "Smith", at: { x: 6, y: 6 }, facingDeg: 180, height: 1.8 },
      { id: "boy", name: "Apprentice", at: { x: 8.5, y: 6 }, facingDeg: 200, height: 1.4 },
    ],
    cameras: [
      { id: "a", label: "A", at: { x: 6, y: 1 }, headingDeg: 0, focalMm: 35, sensorId: "super35_4perf", throwDistance: 12 },
      // A 300mm from the corner cannot possibly hold both people — if the cut
      // shot below were still live, this camera would raise coverage warnings.
      { id: "b", label: "B", at: { x: 1, y: 1 }, headingDeg: 0, focalMm: 300, sensorId: "super35_4perf", throwDistance: 12 },
    ],
    shots: [
      { id: "s1", camera: "a", movement: "static", subjects: ["smith"], action: "Smith works the bar.", durationS: 6 },
      { id: "s2", camera: "b", movement: "dolly", subjects: ["smith", "boy"], action: "Cut in the revision.", durationS: 4, omitted: true },
    ],
    ...over,
  });
}

describe("tombstones on the stage plan", () => {
  const plan = renderPlanSheet(numberShots(forgeWithTombstone()));

  it("marks the cut shot's row OMITTED", () => {
    expect(plan.svg).toContain("OMITTED");
  });

  it("still prints the cut shot's number — the hole in the sequence is information", () => {
    expect(plan.svg).toContain("CHP_101_FRG_004_0020");
  });

  it("still passes the sheet validator", () => {
    expect(validateSheetSvg(plan.svg)).toEqual([]);
  });

  it("raises no coverage warning for a shot that no longer exists", () => {
    // Camera B genuinely misses the apprentice; a cut shot cannot miss anybody.
    expect(plan.coverageWarnings).toEqual([]);
  });

  it("excludes the tombstone from the sequence total", () => {
    // 6s live + 4s omitted: only the live shot has screen time.
    expect(plan.svg).toContain("SEQUENCE · 6.0s");
    expect(plan.svg).not.toContain("SEQUENCE · 10.0s");
  });

  it("draws no timeline strip at all when only the tombstone is timed", () => {
    const scene = forgeWithTombstone();
    scene.shots[0].durationS = undefined;
    const silent = renderPlanSheet(numberShots(scene));
    // With no live timed shot there is nothing to sequence — an empty strip
    // labelled with the cut shot's tail would be the bug.
    expect(silent.svg).not.toContain("SEQUENCE");
    expect(validateSheetSvg(silent.svg)).toEqual([]);
  });

  it("a live shot with the same camera still warns — omission is per shot, not per camera", () => {
    const scene = forgeWithTombstone();
    scene.shots[1].omitted = false;
    const live = renderPlanSheet(numberShots(scene));
    expect(live.coverageWarnings.length).toBeGreaterThan(0);
    expect(live.coverageWarnings[0]).toContain("does not cover");
  });
});
