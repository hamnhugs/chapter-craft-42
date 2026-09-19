import { describe, it, expect } from "vitest";
import {
  SceneSchema, preserveShotNumbers, numberShots, validateScene, shotOrdinal,
  type Scene, type Shot,
} from "@/lib/blueprint/scene";

// preserveShotNumbers is the merge that makes shot numbers behave like a real
// production's: a shot keeps its number for life, an insert takes a gap number
// instead of renumbering everything downstream, and under lock a cut shot
// leaves a tombstone rather than a silent hole. Renumbering-on-revision is the
// failure that makes people abandon the document, so every case here defends
// the numbers, not the array.

// The project builds without strictNullChecks, so zod's inferred output widens
// every property to optional; the cast keeps the fixtures usable as Scene.
const parseSceneDoc = ((v: unknown) => SceneSchema.parse(v)) as (v: unknown) => any;

function stage(shots: Array<Record<string, unknown>>): Scene {
  return parseSceneDoc({
    name: "The Forge",
    slug: "INT. FORGE — NIGHT",
    unit: "m",
    extent: { w: 12, h: 9 },
    designator: { show: "CHP", episode: "101", sequence: "FRG", scene: "004" },
    blocking: [
      { id: "smith", name: "Smith", at: { x: 6, y: 6 }, facingDeg: 180, height: 1.8 },
    ],
    cameras: [
      { id: "a", label: "A", at: { x: 6, y: 1 }, headingDeg: 0, focalMm: 35, sensorId: "super35_4perf", throwDistance: 12 },
    ],
    shots,
  });
}

const shot = (id: string, over: Record<string, unknown> = {}) => ({
  id, camera: "a", movement: "static", subjects: ["smith"], action: `${id} action`, durationS: 4, ...over,
});

const ordinals = (s: Scene) => s.shots.map((x) => shotOrdinal(x.number));

describe("preserveShotNumbers", () => {
  it("matched ids keep their numbers when the revision reorders and rewords", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2")])); // 0010, 0020
    const incoming = stage([
      shot("s2", { action: "Completely rewritten." }),
      shot("s1", { action: "Also rewritten." }),
    ]);
    const merged = preserveShotNumbers(saved, incoming);
    // Order follows the revision; numbers follow the shot, for life.
    expect(merged.shots.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(merged.shots[0].number).toBe("CHP_101_FRG_004_0020");
    expect(merged.shots[1].number).toBe("CHP_101_FRG_004_0010");
    expect(merged.shots[0].action).toBe("Completely rewritten.");
    expect(validateScene(merged)).toEqual([]);
  });

  it("a shot inserted between 0010 and 0020 becomes 0015", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2")]));
    const incoming = stage([shot("s1"), shot("cutaway"), shot("s2")]);
    const merged = preserveShotNumbers(saved, incoming);
    expect(merged.shots[1].number).toBe("CHP_101_FRG_004_0015");
    // The neighbours are untouched — that is the entire point of the gap.
    expect(ordinals(merged)).toEqual([10, 15, 20]);
    expect(validateScene(merged)).toEqual([]);
  });

  it("two inserts into one gap take distinct numbers", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2")]));
    const incoming = stage([shot("s1"), shot("ins_a"), shot("ins_b"), shot("s2")]);
    const merged = preserveShotNumbers(saved, incoming);
    const [a, b] = [merged.shots[1], merged.shots[2]].map((s) => shotOrdinal(s.number));
    expect(a).not.toBe(b);
    // Both land strictly inside the gap, in placement order.
    expect(a).toBeGreaterThan(10);
    expect(b).toBeGreaterThan(a!);
    expect(b).toBeLessThan(20);
    expect(new Set(ordinals(merged)).size).toBe(4);
    expect(validateScene(merged)).toEqual([]);
  });

  it("a shot appended at the end takes the next multiple of ten", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2")]));
    const incoming = stage([shot("s1"), shot("s2"), shot("tail")]);
    const merged = preserveShotNumbers(saved, incoming);
    expect(merged.shots[2].number).toBe("CHP_101_FRG_004_0030");
  });

  it("an exhausted gap falls to a fresh multiple of ten instead of colliding", () => {
    // 0010 and 0011 leave no room; a duplicate number is worse than an honest
    // out-of-sequence one, so the insert takes the next free multiple of ten.
    const saved = stage([shot("s1"), shot("s2")]);
    saved.shots[0].number = "CHP_101_FRG_004_0010";
    saved.shots[1].number = "CHP_101_FRG_004_0011";
    const incoming = stage([shot("s1"), shot("wedge"), shot("s2")]);
    const merged = preserveShotNumbers(saved, incoming);
    const inserted = shotOrdinal(merged.shots.find((s) => s.id === "wedge")!.number);
    expect(inserted! % 10).toBe(0);
    const all = ordinals(merged);
    expect(new Set(all).size).toBe(all.length);
    // No duplicate-number problem, which is what validateScene polices.
    expect(validateScene(merged)).toEqual([]);
  });

  it("under lock, a dropped shot survives as an omitted tombstone in ordinal order", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2"), shot("s3")])); // 0010..0030
    const incoming = stage([shot("s1"), shot("s3")]); // the revision cut s2
    const merged = preserveShotNumbers(saved, incoming, { locked: true });
    expect(merged.shots.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    const tombstone = merged.shots[1] as Shot;
    expect(tombstone.omitted).toBe(true);
    // The number is never reused — the hole in the sequence is information.
    expect(tombstone.number).toBe("CHP_101_FRG_004_0020");
    expect(validateScene(merged)).toEqual([]);
  });

  it("without lock, a dropped shot simply vanishes", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2"), shot("s3")]));
    const incoming = stage([shot("s1"), shot("s3")]);
    const merged = preserveShotNumbers(saved, incoming, { locked: false });
    expect(merged.shots.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(merged.shots.some((s) => s.omitted)).toBe(false);
  });

  it("a same-revision cut-and-insert cannot reuse the tombstone's number", () => {
    // The adversarial-review case: drop 0020 and insert between 0010 and 0030
    // in ONE locked save. The naive order assigned the newcomer the midpoint
    // (20) before the tombstone rejoined the list — two shots numbered 0020,
    // permanently. Tombstone ordinals are reserved before gap assignment.
    const saved = numberShots(stage([shot("s1"), shot("s2"), shot("s3")])); // 0010..0030
    const incoming = stage([shot("s1"), shot("wedge"), shot("s3")]);
    const merged = preserveShotNumbers(saved, incoming, { locked: true });
    const all = ordinals(merged);
    expect(new Set(all).size).toBe(all.length); // every number unique
    expect(merged.shots.find((s) => s.id === "s2")!.omitted).toBe(true);
    expect(merged.shots.find((s) => s.id === "s2")!.number).toBe("CHP_101_FRG_004_0020");
    expect(shotOrdinal(merged.shots.find((s) => s.id === "wedge")!.number)).not.toBe(20);
    expect(validateScene(merged)).toEqual([]);
  });

  it("under lock, echoing a tombstone's id without the flag does not resurrect it", () => {
    const saved = numberShots(stage([shot("s1"), shot("s2")]));
    const locked1 = preserveShotNumbers(saved, stage([shot("s1")]), { locked: true }); // s2 tombstoned
    // A later revision echoes s2's id (e.g. the model round-tripped the full
    // shot list) without an explicit omitted field — it must stay cut.
    const echo = stage([shot("s1"), shot("s2")]);
    const merged = preserveShotNumbers(locked1, echo, { locked: true });
    expect(merged.shots.find((s) => s.id === "s2")!.omitted).toBe(true);
    // Explicit reinstatement is still possible, on the record.
    const reinstate = stage([shot("s1"), shot("s2", { omitted: false })]);
    const merged2 = preserveShotNumbers(locked1, reinstate, { locked: true });
    expect(merged2.shots.find((s) => s.id === "s2")!.omitted).toBe(false);
  });
});
