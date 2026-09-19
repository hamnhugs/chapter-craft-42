/**
 * Page-turn swipe classification for the Read tab. Pure (no DOM) so the rules
 * are unit-tested; `usePageSwipe` feeds it samples from real pointer events.
 *
 * A turn needs a deliberate, clearly horizontal, single-finger gesture that
 * didn't start in the system back-gesture strip, didn't select text, didn't
 * scroll the page, and began with the page already at its horizontal edge
 * (so panning a zoomed page never flips it).
 */

export interface SwipeSample {
  dx: number;
  dy: number;
  durationMs: number;
  startX: number;
  viewportWidth: number;
  /** Most fingers down at once during the gesture (2+ = pinch). */
  maxPointers: number;
  /** A non-empty text selection exists at release. */
  selecting: boolean;
  /** The scroller moved during the gesture (it was a scroll/pan). */
  scrolled: boolean;
  /** At gesture start, could the content still pan in each direction? */
  canPanLeft: boolean;
  canPanRight: boolean;
}

export type SwipeDirection = "next" | "prev";

export const SWIPE = {
  /** Android's system back gesture owns ~20dp at each edge; keep clear of it. */
  edgeGuardPx: 28,
  /** A slow drag must cover this share of the viewport width… */
  distanceRatio: 0.3,
  minDistancePx: 90,
  maxDistancePx: 180,
  /** …or be a quick flick of at least this far and fast. */
  flickMinDistancePx: 60,
  flickMinVelocity: 0.65, // px per ms
  /** Horizontal travel must dominate vertical by this factor (~22°). */
  axisRatio: 2.5,
  /** Longer than this is reading/panning, not a swipe. */
  maxDurationMs: 700,
} as const;

/** Distance a slow drag needs on this viewport. */
export function swipeDistanceFor(viewportWidth: number): number {
  return Math.min(SWIPE.maxDistancePx, Math.max(SWIPE.minDistancePx, viewportWidth * SWIPE.distanceRatio));
}

export function classifySwipe(s: SwipeSample): SwipeDirection | null {
  if (s.maxPointers > 1 || s.selecting || s.scrolled) return null;
  if (s.startX < SWIPE.edgeGuardPx || s.startX > s.viewportWidth - SWIPE.edgeGuardPx) return null;
  if (s.durationMs > SWIPE.maxDurationMs) return null;
  const ax = Math.abs(s.dx);
  if (ax < Math.abs(s.dy) * SWIPE.axisRatio) return null;
  const velocity = ax / Math.max(1, s.durationMs);
  const far = ax >= swipeDistanceFor(s.viewportWidth);
  const flick = ax >= SWIPE.flickMinDistancePx && velocity >= SWIPE.flickMinVelocity;
  if (!far && !flick) return null;
  // Finger moves left → content should move left → next page.
  const dir: SwipeDirection = s.dx < 0 ? "next" : "prev";
  if (dir === "next" && s.canPanRight) return null;
  if (dir === "prev" && s.canPanLeft) return null;
  return dir;
}

/** 0‥1 progress toward a turn, for the drag hint (not a promise it turns). */
export function swipeProgress(dx: number, dy: number, viewportWidth: number): number {
  const ax = Math.abs(dx);
  if (ax < Math.abs(dy) * SWIPE.axisRatio) return 0;
  return Math.min(1, ax / swipeDistanceFor(viewportWidth));
}
