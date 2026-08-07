import { useEffect, useState } from "react";
import { isTouchPrimary } from "@/lib/focusPolicy";
import type { Viewport } from "@/lib/workspaceLayout";

/**
 * The live viewport, as the layout kernel wants it.
 *
 * Three properties this hook is required to have, each replacing a specific
 * defect in the `useIsMobile()` it retires:
 *
 * 1. THE FIRST RENDER IS TRUE. The seed comes from a lazy `useState`
 *    initializer, which runs before the first paint. The old hook started at
 *    `undefined` and coerced to `false`, so every device claimed "desktop" for
 *    one frame — on a phone with the workspace remembered open, that frame
 *    painted a 360 px docked column. There is no `undefined` state here and no
 *    effect-seeded first value.
 *
 * 2. IT HAS A HEIGHT AXIS. Rotation changes height, not just width, and the
 *    reported bug lives entirely in the height axis (852×393).
 *
 * 3. IT DOES NOT SPAM RENDERS. `resize` fires continuously during a window
 *    drag; the handler is rAF-throttled, and the state update returns the
 *    previous object when nothing moved, so React bails out of re-rendering
 *    the whole chat tree.
 *
 * `touchPrimary` reuses `isTouchPrimary()` from `@/lib/focusPolicy` — the
 * repo's single `(pointer: coarse)` probe. There is deliberately no second
 * matchMedia call anywhere in this feature.
 */

/**
 * iOS fires `orientationchange` before layout settles, and has historically
 * reported stale `innerWidth`/`innerHeight` for a frame or two afterwards.
 * Every engine also fires `resize` on rotation, so this delayed re-sample is
 * belt-and-braces — but rotation IS the reported bug, and one extra sample is
 * cheaper than shipping the bug again.
 */
const ORIENTATION_SETTLE_MS = 250;

export function readViewport(): Viewport {
  if (typeof window === "undefined") {
    return { width: 0, height: 0, touchPrimary: false };
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    touchPrimary: isTouchPrimary(),
  };
}

const same = (a: Viewport, b: Viewport): boolean =>
  a.width === b.width && a.height === b.height && a.touchPrimary === b.touchPrimary;

export function useViewport(): Viewport {
  // Lazy initializer: correct on the very first render, before paint.
  const [viewport, setViewport] = useState<Viewport>(readViewport);

  useEffect(() => {
    let frame = 0;
    let settle = 0;

    const sample = () => {
      frame = 0;
      const next = readViewport();
      // Bail when nothing moved: returning the identical object makes React
      // skip the re-render entirely.
      setViewport((prev) => (same(prev, next) ? prev : next));
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(sample);
    };

    const onOrientation = () => {
      schedule();
      window.clearTimeout(settle);
      settle = window.setTimeout(schedule, ORIENTATION_SETTLE_MS);
    };

    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", onOrientation);

    // The viewport can change between the lazy seed and this effect (a rotation
    // mid-mount, a devtools dock). One sample closes that window; it bails
    // without a render when, as usual, nothing changed.
    schedule();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", onOrientation);
    };
  }, []);

  return viewport;
}
