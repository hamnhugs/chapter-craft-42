import { describe, expect, it } from "vitest";
import { PHI, guideSummary, pageGuides, placeBox, snapSpan, typeScale, unevenGaps } from "../../scripts/local-ai/design-proportion.mjs";

// What the chat moves by hand on a DesignCraft page lands on a designer's
// guides and stays on the page (the user, 2026-10-14: "trouble with visual
// appeal when moving things", "unaware of the page size", text cut off).

const LETTER = { bounds: [0, 0, 612, 792], content: { left: 36, top: 36, right: 576, bottom: 756 } };
// The back of a side-by-side spread: same size, offset along x.
const BACK = { bounds: [612, 0, 1224, 792], content: { left: 648, top: 36, right: 1188, bottom: 756 } };

describe("page guides", () => {
  it("puts golden-section, thirds and centre lines across the safe box", () => {
    const g = pageGuides(LETTER);
    const at = (list: any[], kind: string) => list.filter((l) => l.kind === kind).map((l) => l.at);
    expect(at(g.x, "golden")).toEqual([+(36 + 540 / PHI ** 2).toFixed(1), +(36 + 540 / PHI).toFixed(1)]);
    expect(at(g.y, "thirds")).toEqual([276, 516]);
    expect(at(g.x, "centre")).toEqual([306]);
    expect(at(g.y, "margin")).toEqual([36, 756]);
  });

  it("tells the model the page size in points and inches, and where it starts", () => {
    const s = guideSummary(BACK);
    expect(s.size).toBe("612 × 792 pt (8.5 × 11 in), top-left at x 612, y 0");
    expect(s.safe_box).toEqual({ left: 648, top: 36, right: 1188, bottom: 756 });
  });

  it("scales type by the golden ratio from 14 pt", () => {
    expect(typeScale(14, 540)).toEqual([14, 23, 37, 59, 96]);
    expect(Math.min(...typeScale(14, 100))).toBe(14);
  });
});

describe("placing a moved part", () => {
  it("snaps an edge that lands near a guide onto it", () => {
    const r = placeBox([42, 300, 300, 360], LETTER);
    expect(r.box[0]).toBe(36);
    expect(r.snapped[0]).toMatch(/left edge to the margin/);
  });

  it("puts a near-golden headline on the golden line", () => {
    const r = placeBox([100, 470, 512, 540], LETTER); // top 470, golden y ≈ 481
    expect(r.box[1]).toBeCloseTo(36 + 720 / PHI, 0);
  });

  it("never snaps a box's middle onto a margin", () => {
    const r = placeBox([36, 700, 336, 820], LETTER);
    expect(r.snapped.join(" ")).not.toMatch(/middle to the margin/);
    expect(r.box[3]).toBe(756); // kept on the page instead
    expect(r.clamped).toBe(true);
  });

  it("keeps text inside the safe box, and lets a picture bleed", () => {
    expect(placeBox([-40, 100, 300, 200], LETTER).box[0]).toBe(36);
    expect(placeBox([600, 100, 900, 200], LETTER).box[2]).toBe(576);
    expect(placeBox([-9, -9, 621, 400], LETTER, { isText: false, bleed: 9 }).box).toEqual([-9, -9, 621, 400]);
    // Wider than the page: it fits the safe box.
    const wide = placeBox([0, 100, 700, 200], LETTER).box;
    expect([wide[0], wide[2]]).toEqual([36, 576]);
  });

  it("lines up with the same part on the other page of a spread", () => {
    const front = [98.5, 206.7, 513.5, 492.7];
    const match = [front[0] + 612, front[1], front[2] + 612, front[3]];
    const r = placeBox([612 + 104, 211, 612 + 516, 495], BACK, { matches: [match] });
    expect(r.box[0]).toBeCloseTo(612 + 98.5, 1);
    expect(r.box[1]).toBeCloseTo(206.7, 1);
  });

  it("sets the gap under the part above from the spacing scale", () => {
    const above = { bounds: [36, 100, 576, 200] };
    const r = placeBox([36, 219, 576, 300], LETTER, { others: [above] });
    expect(r.box[1]).toBe(221); // 200 + 21
  });

  it("leaves a part alone when nothing is near", () => {
    const r = placeBox([150, 150, 200, 170], LETTER, { tol: 2 });
    expect(r.box).toEqual([150, 150, 200, 170]);
    expect(r.snapped).toEqual([]);
  });
});

describe("spacing", () => {
  it("picks the deciding edge, closest line first, stronger kind on a tie", () => {
    const s = snapSpan(40, 100, [{ at: 36, kind: "margin" }, { at: 37, kind: "thirds" }], 10);
    expect(s?.line.kind).toBe("margin");
  });

  it("finds the one uneven gap in a stack", () => {
    const items = [
      { id: 1, bounds: [36, 36, 576, 100] }, { id: 2, bounds: [36, 121, 576, 200] },
      { id: 3, bounds: [36, 221, 576, 300] }, { id: 4, bounds: [36, 352, 576, 400] },
    ];
    expect(unevenGaps(items)).toEqual([{ above: 3, below: 4, gap: 52, usual: 21, scale: 55 }]);
  });
});
