import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  CHAT_MIN_PX,
  COMPACT_WIDTH_MAX,
  DEFAULT_FRACTION_DOCK,
  DEFAULT_FRACTION_DRAWER,
  DEFAULT_WIDTHS,
  DOCK_MIN_WIDTH,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
  DRAWER_FRACTION_MAX,
  DRAWER_FRACTION_MIN,
  DRAWER_PEEK_PX,
  FRACTION_MAX,
  FRACTION_MIN,
  PANEL_MIN_PX,
  SHORT_VIEWPORT_MAX_HEIGHT,
  WORKSPACE_WIDTH_KEY,
  clampFraction,
  clampPanelPx,
  defaultFractionFor,
  dragDeltaPx,
  fractionBounds,
  fractionToPx,
  hitAreaPx,
  isDoubleTap,
  keyStepFraction,
  pxToFraction,
  readStoredWidths,
  resolveGeometry,
  resolvePanelPx,
  writeStoredWidths,
  type StoredWidths,
  type Viewport,
  type WorkspaceGeometry,
} from "@/lib/workspaceLayout";
import { useViewport } from "@/hooks/useViewport";

/**
 * The geometry kernel behind the resizable / landscape-aware Workspace.
 *
 * The bug this file exists to keep dead: `useIsMobile()` compared width to 768
 * and nothing else, so an iPhone 16 rotated to landscape (852×393) reported
 * "desktop", kept the docked 360 px column, and rendered it inside a 393 px
 * tall viewport. Every assertion about 852×393, 780×360 and 956×440 below is
 * that bug's tombstone. The first-render assertions are a second tombstone:
 * the old hook seeded `undefined` and coerced to `false`, so EVERY device
 * claimed "desktop" for one frame.
 */

const vp = (width: number, height: number, touchPrimary = false): Viewport => ({
  width,
  height,
  touchPrimary,
});

// ──────────────────────────────────────────────────────────────────────────
// resolveGeometry
// ──────────────────────────────────────────────────────────────────────────

describe("resolveGeometry — device matrix", () => {
  const cases: Array<[string, number, number, WorkspaceGeometry]> = [
    ["iPhone 16 portrait", 393, 852, "full"],
    ["iPhone 16 LANDSCAPE (the reported bug)", 852, 393, "drawer"],
    ["Galaxy S24 landscape", 780, 360, "drawer"],
    ["iPhone 16 Pro Max landscape (width passes, height fails)", 956, 440, "drawer"],
    ["iPhone 16 Pro Max portrait", 440, 956, "full"],
    ["iPad portrait", 768, 1024, "drawer"],
    ["iPad landscape", 1024, 768, "dock"],
    ["laptop", 1440, 900, "dock"],
    ["WCAG 1.4.10 horizontal floor", 1280, 256, "drawer"],
    ["iPhone SE portrait", 320, 568, "full"],
    ["one px below the compact-width line", 599, 900, "full"],
    ["exactly the compact-width line", 600, 900, "drawer"],
    ["dock width, one px below the short-height line", 900, 479, "drawer"],
    ["dock width, exactly the short-height line", 900, 480, "dock"],
  ];

  for (const [name, w, h, expected] of cases) {
    it(`${name} (${w}x${h}) -> ${expected}`, () => {
      expect(resolveGeometry(vp(w, h))).toBe(expected);
    });
  }

  it("never returns dock one px below either threshold", () => {
    expect(resolveGeometry(vp(DOCK_MIN_WIDTH - 1, 1200))).toBe("drawer");
    expect(resolveGeometry(vp(1600, SHORT_VIEWPORT_MAX_HEIGHT - 1))).toBe("drawer");
    expect(resolveGeometry(vp(DOCK_MIN_WIDTH, SHORT_VIEWPORT_MAX_HEIGHT))).toBe("dock");
  });

  it("is width-first: a tall compact viewport is still full, not drawer", () => {
    expect(resolveGeometry(vp(COMPACT_WIDTH_MAX - 1, 4000))).toBe("full");
  });

  it("ignores touchPrimary entirely — capability drives affordance, not mode", () => {
    for (const [, w, h] of cases) {
      expect(resolveGeometry(vp(w, h, true))).toBe(resolveGeometry(vp(w, h, false)));
    }
  });

  it("treats an unmeasurable viewport as compact, never as a desktop", () => {
    expect(resolveGeometry(vp(NaN, NaN))).toBe("full");
    expect(resolveGeometry(vp(0, 0))).toBe("full");
    expect(resolveGeometry(vp(-1200, -800))).toBe("full");
    expect(resolveGeometry(vp(Infinity, Infinity))).toBe("full");
    expect(resolveGeometry(undefined as unknown as Viewport)).toBe("full");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// hitAreaPx
// ──────────────────────────────────────────────────────────────────────────

describe("hitAreaPx", () => {
  it("gives coarse pointers a WCAG 2.5.8-sized target and fine pointers 12", () => {
    expect(hitAreaPx(true)).toBe(24);
    expect(hitAreaPx(false)).toBe(12);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// fraction <-> px
// ──────────────────────────────────────────────────────────────────────────

describe("fractionToPx / pxToFraction", () => {
  const widths = [700, 780, 852, 900, 1280, 2560];
  const fractions = [FRACTION_MIN, 0.38, FRACTION_MAX];

  for (const w of widths) {
    for (const f of fractions) {
      it(`round-trips ${f} at ${w}px`, () => {
        expect(pxToFraction(fractionToPx(f, w), w, "dock")).toBeCloseTo(f, 10);
      });
    }
  }

  it("keeps pxToFraction inside the draggable range whatever it is handed", () => {
    for (const [px, w] of [[-9999, 1440], [0, 1440], [1e9, 1440], [1440, 1440], [10, 1440]] as const) {
      const f = pxToFraction(px, w, "dock");
      expect(f).toBeGreaterThanOrEqual(FRACTION_MIN);
      expect(f).toBeLessThanOrEqual(FRACTION_MAX);
    }
  });

  it("falls back rather than dividing by a degenerate container", () => {
    for (const bad of [0, -100, NaN, Infinity, undefined as unknown as number]) {
      const f = pxToFraction(500, bad, "dock");
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBe(DEFAULT_FRACTION_DOCK);
    }
  });

  it("never lets fractionToPx exceed the container or go negative", () => {
    expect(fractionToPx(5, 1000)).toBe(1000);
    expect(fractionToPx(-5, 1000)).toBe(0);
    expect(fractionToPx(NaN, 1000)).toBeCloseTo(DEFAULT_FRACTION_DOCK * 1000, 6);
    expect(fractionToPx(0.5, NaN)).toBe(0);
    expect(fractionToPx(0.5, -20)).toBe(0);
  });

  it("accepts the drawer default even though it sits above FRACTION_MAX", () => {
    // DEFAULT_FRACTION_DRAWER (0.86) is a seed value, not a drag target: the
    // px clamp is what bounds it in drawer mode. It must survive conversion.
    expect(fractionToPx(DEFAULT_FRACTION_DRAWER, 852)).toBeCloseTo(732.72, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// clampPanelPx — geometry aware (amendment A1)
// ──────────────────────────────────────────────────────────────────────────

describe("clampPanelPx", () => {
  it("dock reserves CHAT_MIN_PX for the chat column", () => {
    expect(clampPanelPx(1e6, 1440, "dock")).toBe(1440 - CHAT_MIN_PX);
    expect(1440 - clampPanelPx(1e6, 1440, "dock")).toBeGreaterThanOrEqual(CHAT_MIN_PX);
  });

  it("drawer is an overlay, so it only reserves DRAWER_PEEK_PX", () => {
    expect(clampPanelPx(1e6, 852, "drawer")).toBe(852 - DRAWER_PEEK_PX);
    expect(852 - clampPanelPx(1e6, 852, "drawer")).toBeGreaterThanOrEqual(DRAWER_PEEK_PX);
    expect(780 - clampPanelPx(1e6, 780, "drawer")).toBeGreaterThanOrEqual(DRAWER_PEEK_PX);
  });

  it("lets the landscape phone drawer go far wider than the dock would allow", () => {
    // The whole point of amendment A1: on 852x393 the user drags the drawer
    // toward full width. Dock rules would have capped it 344px earlier.
    expect(clampPanelPx(1e6, 852, "drawer")).toBeGreaterThan(clampPanelPx(1e6, 852, "dock"));
  });

  it("full has nothing to reserve", () => {
    expect(clampPanelPx(1e6, 852, "full")).toBe(852);
  });

  it("never goes below PANEL_MIN_PX when the container can afford it", () => {
    expect(clampPanelPx(0, 1440, "dock")).toBe(PANEL_MIN_PX);
    expect(clampPanelPx(-500, 1440, "drawer")).toBe(PANEL_MIN_PX);
    expect(clampPanelPx(NaN, 1440, "dock")).toBe(PANEL_MIN_PX);
  });

  it("passes a legal width straight through, rounded", () => {
    expect(clampPanelPx(600, 1440, "dock")).toBe(600);
    expect(clampPanelPx(600.4, 1440, "dock")).toBe(600);
    expect(clampPanelPx(600.6, 1440, "dock")).toBe(601);
  });

  it("degrades gracefully when both minimums cannot fit", () => {
    // dock at 700px: PANEL_MIN 320 + CHAT_MIN 400 = 720 > 700. No legal answer
    // exists, so we split in proportion to the two minimums.
    const at700 = clampPanelPx(1e6, 700, "dock");
    expect(Number.isFinite(at700)).toBe(true);
    expect(at700).toBe(Math.round((700 * PANEL_MIN_PX) / (PANEL_MIN_PX + CHAT_MIN_PX)));
    expect(at700).toBeGreaterThanOrEqual(0);
    expect(at700).toBeLessThanOrEqual(700);
  });

  it("is continuous across the point where the minimums stop fitting", () => {
    const boundary = PANEL_MIN_PX + CHAT_MIN_PX; // 720
    expect(clampPanelPx(1e6, boundary, "dock")).toBe(PANEL_MIN_PX);
    expect(Math.abs(clampPanelPx(1e6, boundary - 1, "dock") - PANEL_MIN_PX)).toBeLessThanOrEqual(1);
    expect(Math.abs(clampPanelPx(1e6, boundary + 1, "dock") - (PANEL_MIN_PX + 1))).toBeLessThanOrEqual(1);
  });

  it("returns a finite value inside [0, containerPx] for every container, in every geometry", () => {
    const geometries: WorkspaceGeometry[] = ["dock", "drawer", "full"];
    const containers = [0, 1, 50, 100, 200, 256, 320, 375, 500, 599, 700, 719, 720, 721, 852, 900, 1280, 2560];
    for (const g of geometries) {
      for (const c of containers) {
        for (const want of [-1e6, 0, 100, 1e6, NaN, Infinity]) {
          const out = clampPanelPx(want, c, g);
          expect(Number.isFinite(out), `${g} c=${c} want=${want}`).toBe(true);
          expect(out, `${g} c=${c} want=${want}`).toBeGreaterThanOrEqual(0);
          expect(out, `${g} c=${c} want=${want}`).toBeLessThanOrEqual(c);
        }
      }
    }
  });

  it("survives a garbage container without producing NaN or a negative", () => {
    for (const bad of [NaN, -1, -1e9, undefined as unknown as number, Infinity]) {
      for (const g of ["dock", "drawer", "full"] as WorkspaceGeometry[]) {
        const out = clampPanelPx(500, bad, g);
        expect(Number.isFinite(out)).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is monotonic in the container width — a wider window never shrinks the max panel", () => {
    for (const g of ["dock", "drawer"] as WorkspaceGeometry[]) {
      let prev = -1;
      for (let c = 0; c <= 2000; c += 7) {
        const out = clampPanelPx(1e6, c, g);
        expect(out, `${g} at ${c}`).toBeGreaterThanOrEqual(prev);
        prev = out;
      }
    }
  });

  it("never snaps back on release: what it paints survives a commit round-trip", () => {
    // The bug this guards. Two different bounds are in play: `clampPanelPx`
    // bounds PIXELS (852 - DRAWER_PEEK_PX = 796) and `pxToFraction` bounds
    // FRACTIONS (FRACTION_MAX * 852 = 724). Paint from one, commit through the
    // other, and the panel lands 72px from where the finger left it.
    //
    // The out-of-range fractions here are not hypothetical: DEFAULT_FRACTION_DRAWER
    // is 0.86, above FRACTION_MAX, so it is the value the drawer OPENS at.
    const fractions = [0.05, FRACTION_MIN, 0.38, FRACTION_MAX, DEFAULT_FRACTION_DRAWER, 0.95, 1, 1.4];
    for (const g of ["dock", "drawer"] as WorkspaceGeometry[]) {
      for (const w of [700, 780, 852, 1280, 2560]) {
        for (const f of fractions) {
          const painted = resolvePanelPx(f, w, g);
          const committed = pxToFraction(painted, w, g); // what a pointerup would store
          const repainted = resolvePanelPx(committed, w, g);
          expect(repainted, `${g} w=${w} f=${f}`).toBe(painted);
        }
      }
    }
  });

  it("opens the drawer at the same width it will settle at after one drag", () => {
    // Concretely: the landscape-phone seed must not be 9px wider than any width
    // the user can actually commit to.
    const seeded = resolvePanelPx(DEFAULT_FRACTION_DRAWER, 852, "drawer");
    const afterOneCommit = resolvePanelPx(pxToFraction(seeded, 852, "drawer"), 852, "drawer");
    expect(afterOneCommit).toBe(seeded);
  });

  it("the recommended drag path is stable at every pointer position", () => {
    for (const g of ["dock", "drawer"] as WorkspaceGeometry[]) {
      for (const w of [700, 780, 852, 1280, 2560]) {
        for (let px = 0; px <= w + 200; px += 13) {
          const live = resolvePanelPx(pxToFraction(px, w, g), w, g);
          const committed = resolvePanelPx(pxToFraction(live, w, g), w, g);
          expect(committed, `${g} w=${w} px=${px}`).toBe(live);
        }
      }
    }
  });

  it("resolvePanelPx honours the geometry minimums, not just the fraction bounds", () => {
    // The fraction range is blind to pixels: FRACTION_MIN of a 1440px row is
    // 216px, well under PANEL_MIN_PX, and FRACTION_MAX of a 700px row leaves the
    // chat column 105px. Both bounds have to be applied, not just the cheap one.
    expect(resolvePanelPx(FRACTION_MIN, 1440, "dock")).toBe(PANEL_MIN_PX);
    expect(resolvePanelPx(DRAWER_FRACTION_MIN, 1440, "drawer")).toBeGreaterThanOrEqual(PANEL_MIN_PX);
    expect(resolvePanelPx(FRACTION_MAX, 700, "dock")).toBe(
      Math.round((700 * PANEL_MIN_PX) / (PANEL_MIN_PX + CHAT_MIN_PX)),
    );
    expect(1440 - resolvePanelPx(FRACTION_MAX, 1440, "dock")).toBeGreaterThanOrEqual(CHAT_MIN_PX);
    expect(852 - resolvePanelPx(FRACTION_MAX, 852, "drawer")).toBeGreaterThanOrEqual(DRAWER_PEEK_PX);
    // ...and it must actually carry the geometry through: on a landscape phone
    // the drawer is allowed far more width than a dock would be.
    expect(resolvePanelPx(FRACTION_MAX, 852, "drawer")).toBeGreaterThan(
      resolvePanelPx(FRACTION_MAX, 852, "dock"),
    );
  });

  it("resolvePanelPx keeps every seed inside the container", () => {
    for (const g of ["dock", "drawer", "full"] as WorkspaceGeometry[]) {
      for (const w of [0, 320, 700, 852, 1440]) {
        for (const f of [DEFAULT_FRACTION_DOCK, DEFAULT_FRACTION_DRAWER, 0, 1, 9, NaN]) {
          const out = resolvePanelPx(f, w, g);
          expect(Number.isFinite(out), `${g} ${w} ${f}`).toBe(true);
          expect(out).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it("reaches a fixpoint: clamp -> fraction -> clamp is stable", () => {
    for (const g of ["dock", "drawer"] as WorkspaceGeometry[]) {
      for (const w of [700, 852, 900, 1280, 2560]) {
        for (const f of [0.1, FRACTION_MIN, 0.38, FRACTION_MAX, DEFAULT_FRACTION_DRAWER, 0.99]) {
          const px1 = clampPanelPx(fractionToPx(f, w), w, g);
          const px2 = clampPanelPx(fractionToPx(pxToFraction(px1, w, g), w), w, g);
          const px3 = clampPanelPx(fractionToPx(pxToFraction(px2, w, g), w), w, g);
          expect(px3, `${g} ${w} ${f}`).toBe(px2);
        }
      }
    }
  });
});

describe("drawer bounds — amendment A4", () => {
  // The lead's first cut shared one fraction range across both geometries, with
  // DEFAULT_FRACTION_DRAWER (0.86) sitting ABOVE FRACTION_MAX (0.85). Two things
  // were wrong and neither was visible from the constants alone: the drawer
  // opened at a width the user could never reach by dragging, and DRAWER_PEEK_PX
  // — the bound we actually reasoned about — never bound on any real phone
  // because the fraction ceiling always fired first.
  it("opens at a width the user can also reach by dragging", () => {
    const { min, max } = fractionBounds("drawer");
    expect(DEFAULT_FRACTION_DRAWER).toBeGreaterThanOrEqual(min);
    expect(DEFAULT_FRACTION_DRAWER).toBeLessThanOrEqual(max);
    expect(clampFraction(DEFAULT_FRACTION_DRAWER, "drawer")).toBe(DEFAULT_FRACTION_DRAWER);
  });

  it("lets the peek strip be the thing that stops the drag on a landscape phone", () => {
    // 852x393 iPhone 16 landscape, 780x360 Galaxy S24 landscape.
    for (const w of [780, 852, 915, 932, 956]) {
      const widest = resolvePanelPx(1, w, "drawer");
      expect(w - widest, `peek at ${w}`).toBe(DRAWER_PEEK_PX);
    }
  });

  it("keeps the dock ceiling where it was — the chat still gets CHAT_MIN_PX", () => {
    expect(fractionBounds("dock")).toEqual({ min: FRACTION_MIN, max: FRACTION_MAX });
    for (const w of [1280, 1440, 2560]) {
      expect(w - resolvePanelPx(1, w, "dock"), `chat at ${w}`).toBeGreaterThanOrEqual(CHAT_MIN_PX);
    }
  });

  it("End reaches the widest drawer, Home the narrowest, per geometry", () => {
    expect(keyStepFraction("End", false, 0.5, "drawer")).toBe(DRAWER_FRACTION_MAX);
    expect(keyStepFraction("Home", false, 0.5, "drawer")).toBe(DRAWER_FRACTION_MIN);
    expect(keyStepFraction("End", false, 0.5, "dock")).toBe(FRACTION_MAX);
    expect(keyStepFraction("Home", false, 0.5, "dock")).toBe(FRACTION_MIN);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// storage
// ──────────────────────────────────────────────────────────────────────────

describe("readStoredWidths", () => {
  it("returns null for every malformed payload, and never throws", () => {
    const garbage: Array<string | null> = [
      null,
      "",
      "{}",
      "[]",
      "NaN",
      "undefined",
      "not json at all",
      "0.5",
      '"0.5"',
      "[0.5]",
      "true",
      "null",
      '{"fraction":"0.5"}',
      '{"fraction":5}',
      '{"fraction":-1}',
      '{"fraction":null}',
      '{"fraction":0}',
      '{"fraction":1}',
      '{"dock":true}',
      '{"dock":"0.4","drawer":"0.9"}',
      '{"dock":0,"drawer":1}',
      '{"dock":[0.4]}',
      '{"width":420}',
      "{",
      '{"dock":',
      " ",
      "🙂",
    ];
    for (const raw of garbage) {
      expect(() => readStoredWidths(raw)).not.toThrow();
      expect(readStoredWidths(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("never throws on non-string input either", () => {
    for (const raw of [undefined, 42, {}, []] as unknown as Array<string | null>) {
      expect(() => readStoredWidths(raw)).not.toThrow();
      expect(readStoredWidths(raw)).toBeNull();
    }
  });

  it("reads a well-formed payload", () => {
    expect(readStoredWidths('{"dock":0.38,"drawer":0.86}')).toEqual({ dock: 0.38, drawer: 0.86 });
  });

  it("salvages a valid half when the other half is corrupt", () => {
    expect(readStoredWidths('{"dock":0.4,"drawer":"x"}')).toEqual({ dock: 0.4 });
    expect(readStoredWidths('{"dock":null,"drawer":0.9}')).toEqual({ drawer: 0.9 });
    expect(readStoredWidths('{"dock":0.4,"drawer":42}')).toEqual({ dock: 0.4 });
  });

  it("accepts the legacy single-fraction payload as the dock width", () => {
    expect(readStoredWidths('{"fraction":0.5}')).toEqual({ dock: 0.5 });
    // An explicit dock key wins over the legacy alias.
    expect(readStoredWidths('{"fraction":0.5,"dock":0.6}')).toEqual({ dock: 0.6 });
    expect(readStoredWidths('{"fraction":0.5,"drawer":0.9}')).toEqual({ dock: 0.5, drawer: 0.9 });
  });

  it("accepts values outside the drag range — bounds are applied in pixels", () => {
    // The reader must not reject our own DEFAULT_FRACTION_DRAWER (0.86 > FRACTION_MAX),
    // or a drawer width would silently reset on every single page load.
    expect(readStoredWidths(`{"drawer":${DEFAULT_FRACTION_DRAWER}}`)).toEqual({
      drawer: DEFAULT_FRACTION_DRAWER,
    });
    expect(readStoredWidths('{"dock":0.02}')).toEqual({ dock: 0.02 });
  });

  it("does not pollute Object.prototype via a __proto__ payload", () => {
    expect(readStoredWidths('{"__proto__":{"ccPolluted":true}}')).toBeNull();
    expect(({} as Record<string, unknown>).ccPolluted).toBeUndefined();
  });
});

describe("writeStoredWidths", () => {
  it("emits the documented payload shape", () => {
    expect(writeStoredWidths({ dock: 0.38, drawer: 0.86 })).toBe('{"dock":0.38,"drawer":0.86}');
  });

  it("strips float noise so storage stays readable", () => {
    expect(writeStoredWidths({ dock: 0.1 + 0.2, drawer: 0.5 })).toBe('{"dock":0.3,"drawer":0.5}');
  });

  it("substitutes the per-geometry default for a corrupt half", () => {
    const out = readStoredWidths(
      writeStoredWidths({ dock: NaN, drawer: Infinity } as unknown as StoredWidths),
    );
    expect(out).toEqual({ dock: DEFAULT_FRACTION_DOCK, drawer: DEFAULT_FRACTION_DRAWER });
  });

  it("round-trips through readStoredWidths, including at the extremes", () => {
    const samples: StoredWidths[] = [
      { dock: 0.38, drawer: 0.86 },
      { dock: FRACTION_MIN, drawer: FRACTION_MAX },
      { dock: 0.000000001, drawer: 0.999999999 },
      { dock: 0.1234567, drawer: 0.7654321 },
    ];
    for (const w of samples) {
      const back = readStoredWidths(writeStoredWidths(w));
      expect(back, JSON.stringify(w)).not.toBeNull();
      expect(back!.dock).toBeGreaterThan(0);
      expect(back!.dock).toBeLessThan(1);
      expect(back!.drawer).toBeGreaterThan(0);
      expect(back!.drawer).toBeLessThan(1);
    }
    // Values that survive 4dp rounding come back exactly.
    expect(readStoredWidths(writeStoredWidths({ dock: 0.38, drawer: 0.86 }))).toEqual({
      dock: 0.38,
      drawer: 0.86,
    });
  });

  it("never throws on a missing or malformed object", () => {
    expect(() => writeStoredWidths(undefined as unknown as StoredWidths)).not.toThrow();
    expect(readStoredWidths(writeStoredWidths(undefined as unknown as StoredWidths))).toEqual(
      DEFAULT_WIDTHS,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// drag + keyboard
// ──────────────────────────────────────────────────────────────────────────

describe("dragDeltaPx", () => {
  it("widens the right-anchored panel when the pointer moves left (LTR)", () => {
    expect(dragDeltaPx(1000, 940, "ltr")).toBe(60);
    expect(dragDeltaPx(1000, 1060, "ltr")).toBe(-60);
  });

  it("inverts for RTL", () => {
    expect(dragDeltaPx(1000, 940, "rtl")).toBe(-60);
    expect(dragDeltaPx(1000, 1060, "rtl")).toBe(60);
  });

  it("is exactly antisymmetric between the two directions", () => {
    for (const [a, b] of [[0, 0], [10, 500], [500, 10], [-40, 40]] as const) {
      expect(dragDeltaPx(a, b, "ltr") + dragDeltaPx(a, b, "rtl")).toBe(0);
    }
  });

  it("reports no movement, rather than a jump to one edge, for a garbage coordinate", () => {
    for (const [a, b] of [[NaN, 100], [100, NaN], [NaN, NaN], [Infinity, 100]] as const) {
      for (const dir of ["ltr", "rtl"] as const) {
        expect(dragDeltaPx(a, b, dir)).toBe(0);
      }
    }
    expect(dragDeltaPx(undefined as unknown as number, 100, "ltr")).toBe(0);
  });
});

describe("keyStepFraction", () => {
  it("steps 5% with the arrows and 1% with shift", () => {
    expect(keyStepFraction("ArrowLeft", false, 0.4)).toBeCloseTo(0.45, 10);
    expect(keyStepFraction("ArrowRight", false, 0.4)).toBeCloseTo(0.35, 10);
    expect(keyStepFraction("ArrowLeft", true, 0.4)).toBeCloseTo(0.41, 10);
    expect(keyStepFraction("ArrowRight", true, 0.4)).toBeCloseTo(0.39, 10);
  });

  it("moves the same way the pointer does — left widens the right-anchored panel", () => {
    const widerByKey = keyStepFraction("ArrowLeft", false, 0.4)! > 0.4;
    const widerByDrag = dragDeltaPx(1000, 940, "ltr") > 0;
    expect(widerByKey).toBe(widerByDrag);
  });

  it("maps Home/End to the aria-valuemin / aria-valuemax bounds", () => {
    expect(keyStepFraction("Home", false, 0.4)).toBe(FRACTION_MIN);
    expect(keyStepFraction("End", false, 0.4)).toBe(FRACTION_MAX);
    expect(keyStepFraction("Home", true, 0.4)).toBe(FRACTION_MIN);
  });

  it("clamps instead of running past the bounds", () => {
    expect(keyStepFraction("ArrowLeft", false, 0.84)).toBe(FRACTION_MAX);
    expect(keyStepFraction("ArrowRight", false, 0.16)).toBe(FRACTION_MIN);
    expect(keyStepFraction("ArrowLeft", false, 99)).toBe(FRACTION_MAX);
    expect(keyStepFraction("ArrowRight", false, -99)).toBe(FRACTION_MIN);
    expect(keyStepFraction("ArrowLeft", false, NaN)).toBeCloseTo(DEFAULT_FRACTION_DOCK + 0.05, 10);
  });

  it("returns null for keys it does not handle, including Enter", () => {
    // Enter is APG's collapse/restore toggle: it needs the caller's memory of
    // the last user width, so it cannot be a pure function of the current one.
    for (const key of ["Enter", " ", "Escape", "ArrowUp", "ArrowDown", "PageUp", "a", "", "arrowleft"]) {
      expect(keyStepFraction(key, false, 0.4), key).toBeNull();
    }
  });
});

describe("isDoubleTap", () => {
  it("accepts a second tap just inside both windows", () => {
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1399, x: 503 })).toBe(true);
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1000, x: 500 })).toBe(true);
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1100, x: 503.9 })).toBe(true);
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1100, x: 496.1 })).toBe(true);
  });

  it("rejects a second tap outside either window", () => {
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1401, x: 500 })).toBe(false);
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1100, x: 504.1 })).toBe(false);
    expect(isDoubleTap({ t: 1000, x: 500 }, { t: 1100, x: 495.9 })).toBe(false);
  });

  it("treats the constants themselves as outside the window", () => {
    expect(isDoubleTap({ t: 0, x: 0 }, { t: DOUBLE_TAP_MS, x: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0 }, { t: 10, x: DOUBLE_TAP_PX })).toBe(false);
  });

  it("rejects a missing or time-travelling previous tap", () => {
    expect(isDoubleTap(null, { t: 1000, x: 500 })).toBe(false);
    expect(isDoubleTap({ t: 2000, x: 500 }, { t: 1000, x: 500 })).toBe(false);
    expect(isDoubleTap({ t: NaN, x: 500 }, { t: 1000, x: 500 })).toBe(false);
    expect(isDoubleTap({ t: 1000, x: NaN }, { t: 1000, x: 500 })).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// constants + helpers other workstreams code against
// ──────────────────────────────────────────────────────────────────────────

describe("frozen contract", () => {
  it("pins the values WS-B and WS-C are coding against", () => {
    expect(COMPACT_WIDTH_MAX).toBe(600);
    expect(DOCK_MIN_WIDTH).toBe(900);
    expect(SHORT_VIEWPORT_MAX_HEIGHT).toBe(480);
    expect(PANEL_MIN_PX).toBe(320);
    expect(CHAT_MIN_PX).toBe(400);
    expect(DRAWER_PEEK_PX).toBe(56);
    expect(DEFAULT_FRACTION_DOCK).toBe(0.38);
    expect(DEFAULT_FRACTION_DRAWER).toBe(0.86);
    expect(FRACTION_MIN).toBe(0.15);
    expect(FRACTION_MAX).toBe(0.85);
    expect(WORKSPACE_WIDTH_KEY).toBe("cc.workspaceWidth");
    expect(DOUBLE_TAP_MS).toBe(400);
    expect(DOUBLE_TAP_PX).toBe(4);
  });

  it("DOCK_MIN_WIDTH can actually hold both minimums plus the tablet rail", () => {
    expect(DOCK_MIN_WIDTH).toBeGreaterThanOrEqual(PANEL_MIN_PX + CHAT_MIN_PX + 80);
  });

  it("exposes DEFAULT_WIDTHS as a frozen object so a consumer cannot mutate the shared default", () => {
    expect(DEFAULT_WIDTHS).toEqual({ dock: DEFAULT_FRACTION_DOCK, drawer: DEFAULT_FRACTION_DRAWER });
    expect(Object.isFrozen(DEFAULT_WIDTHS)).toBe(true);
  });

  it("defaultFractionFor picks the current geometry's reset target", () => {
    expect(defaultFractionFor("dock")).toBe(DEFAULT_FRACTION_DOCK);
    expect(defaultFractionFor("drawer")).toBe(DEFAULT_FRACTION_DRAWER);
    expect(defaultFractionFor("full")).toBe(DEFAULT_FRACTION_DRAWER);
  });

  it("clampFraction bounds anything into the draggable range", () => {
    expect(clampFraction(0.5)).toBe(0.5);
    expect(clampFraction(0)).toBe(FRACTION_MIN);
    expect(clampFraction(9)).toBe(FRACTION_MAX);
    expect(clampFraction(NaN)).toBe(DEFAULT_FRACTION_DOCK);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// useViewport — the hook the old useIsMobile lied in
// ──────────────────────────────────────────────────────────────────────────

describe("useViewport", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let frames: FrameRequestCallback[] = [];
  let scheduled = 0;
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");

  const setSize = (width: number, height: number) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  };

  /** Run every rAF callback the hook has queued, inside act(). */
  const flushFrames = () => {
    const queued = frames;
    frames = [];
    act(() => {
      for (const cb of queued) cb(performance.now());
    });
  };

  const renders: Viewport[] = [];
  const Probe = () => {
    renders.push(useViewport());
    return null;
  };

  const mount = () => {
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Probe));
    });
  };

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    scheduled = 0;
    renders.length = 0;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb);
      return ++scheduled;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {
      frames = [];
    }) as typeof window.cancelAnimationFrame;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancel;
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
    if (originalHeight) Object.defineProperty(window, "innerHeight", originalHeight);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("is correct on the FIRST render — no undefined, no desktop lie", () => {
    setSize(852, 393); // iPhone 16 landscape
    mount();

    expect(renders.length).toBe(1);
    expect(renders[0]).toEqual({ width: 852, height: 393, touchPrimary: false });
    // The whole point: the very first frame already resolves to a landscape mode.
    expect(resolveGeometry(renders[0])).toBe("drawer");
  });

  it("does not re-render after mounting when nothing has changed", () => {
    setSize(1440, 900);
    mount();
    expect(renders.length).toBe(1);

    flushFrames(); // the post-mount confirmation sample
    expect(renders.length).toBe(1);
    expect(resolveGeometry(renders[0])).toBe("dock");
  });

  it("follows a rotation from portrait to landscape", () => {
    setSize(393, 852);
    mount();
    flushFrames();
    expect(resolveGeometry(renders[renders.length - 1])).toBe("full");

    setSize(852, 393);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    flushFrames();

    expect(renders[renders.length - 1]).toEqual({ width: 852, height: 393, touchPrimary: false });
    expect(resolveGeometry(renders[renders.length - 1])).toBe("drawer");
  });

  it("coalesces a burst of resize events into a single frame", () => {
    setSize(1440, 900);
    mount();
    flushFrames();
    const before = renders.length;

    scheduled = 0;
    setSize(1200, 800);
    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("resize"));
    });
    expect(scheduled).toBe(1); // 20 events, one rAF

    flushFrames();
    expect(renders.length).toBe(before + 1); // and exactly one re-render
    expect(renders[renders.length - 1].width).toBe(1200);
  });

  it("ignores a resize that did not change either dimension", () => {
    setSize(1440, 900);
    mount();
    flushFrames();
    const before = renders.length;

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    flushFrames();

    expect(renders.length).toBe(before);
  });

  it("responds to orientationchange as well as resize", () => {
    setSize(852, 393);
    mount();
    flushFrames();

    setSize(393, 852);
    act(() => {
      window.dispatchEvent(new Event("orientationchange"));
    });
    flushFrames();

    expect(renders[renders.length - 1]).toEqual({ width: 393, height: 852, touchPrimary: false });
  });

  it("re-samples after orientationchange settles, when the engine reported stale dimensions", () => {
    // Fake ONLY the timeout pair. Vitest's default fake-timer set also replaces
    // requestAnimationFrame, which would swallow the rAF stub this suite uses to
    // control flushing — and would make this test pass whether or not the settle
    // re-sample exists.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      setSize(393, 852);
      mount();
      flushFrames();

      // iOS fires orientationchange before layout settles: the immediate sample
      // still sees the OLD size, and no resize event follows.
      act(() => {
        window.dispatchEvent(new Event("orientationchange"));
      });
      flushFrames();
      expect(renders[renders.length - 1].width).toBe(393);

      setSize(852, 393);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      flushFrames();

      expect(renders[renders.length - 1]).toEqual({ width: 852, height: 393, touchPrimary: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops listening after unmount", () => {
    setSize(1440, 900);
    mount();
    flushFrames();

    act(() => root!.unmount());
    root = null;

    scheduled = 0;
    setSize(400, 800);
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));

    expect(scheduled).toBe(0);
    expect(frames.length).toBe(0);
  });
});
