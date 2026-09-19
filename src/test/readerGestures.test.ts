import { describe, it, expect } from "vitest";
import { classifySwipe, swipeDistanceFor, swipeProgress, SWIPE, type SwipeSample } from "@/lib/readerGestures";

// A clean, deliberate swipe left on a 390px phone.
const base: SwipeSample = {
  dx: -140,
  dy: 10,
  durationMs: 250,
  startX: 300,
  viewportWidth: 390,
  maxPointers: 1,
  selecting: false,
  scrolled: false,
  canPanLeft: false,
  canPanRight: false,
};

describe("classifySwipe", () => {
  it("turns forward on a deliberate left swipe and back on a right swipe", () => {
    expect(classifySwipe(base)).toBe("next");
    expect(classifySwipe({ ...base, dx: 140, startX: 90 })).toBe("prev");
  });

  it("ignores the short drags that used to flip pages (old rule: 50px)", () => {
    expect(classifySwipe({ ...base, dx: -55, durationMs: 250 })).toBeNull();
    expect(classifySwipe({ ...base, dx: -80, durationMs: 400 })).toBeNull();
  });

  it("accepts a short but fast flick", () => {
    expect(classifySwipe({ ...base, dx: -70, durationMs: 90 })).toBe("next");
  });

  it("ignores diagonal drags that are mostly scrolling", () => {
    expect(classifySwipe({ ...base, dx: -140, dy: 70 })).toBeNull();
  });

  it("ignores pinch, selection, scrolling and slow drags", () => {
    expect(classifySwipe({ ...base, maxPointers: 2 })).toBeNull();
    expect(classifySwipe({ ...base, selecting: true })).toBeNull();
    expect(classifySwipe({ ...base, scrolled: true })).toBeNull();
    expect(classifySwipe({ ...base, durationMs: SWIPE.maxDurationMs + 1 })).toBeNull();
  });

  it("leaves the screen edges to Android's back gesture", () => {
    expect(classifySwipe({ ...base, dx: 140, startX: 10 })).toBeNull();
    expect(classifySwipe({ ...base, startX: 385 })).toBeNull();
  });

  it("pans a zoomed page instead of turning it until it reaches the edge", () => {
    expect(classifySwipe({ ...base, canPanRight: true })).toBeNull();
    expect(classifySwipe({ ...base, dx: 140, startX: 90, canPanLeft: true })).toBeNull();
    // At the right edge, a left swipe turns even if it could still pan left.
    expect(classifySwipe({ ...base, canPanLeft: true })).toBe("next");
  });
});

describe("swipe distance and progress", () => {
  it("scales with the screen but stays within bounds", () => {
    expect(swipeDistanceFor(280)).toBe(SWIPE.minDistancePx);
    expect(swipeDistanceFor(390)).toBeCloseTo(117);
    expect(swipeDistanceFor(1400)).toBe(SWIPE.maxDistancePx);
  });

  it("reports progress only for horizontal drags", () => {
    expect(swipeProgress(-58.5, 0, 390)).toBeCloseTo(0.5);
    expect(swipeProgress(-300, 0, 390)).toBe(1);
    expect(swipeProgress(-60, 60, 390)).toBe(0);
  });
});
