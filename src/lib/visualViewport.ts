/**
 * Visual-viewport arithmetic — the pure half of WS-D.
 *
 * WHY THIS EXISTS. When the soft keyboard opens, the *visual* viewport shrinks
 * but the *layout* viewport does not. A `position: fixed` overlay is sized and
 * positioned against the layout viewport, so on a landscape phone — 852×393,
 * the exact viewport in the bug report — the keyboard covers roughly half the
 * workspace drawer and nothing in CSS notices. `window.visualViewport` is the
 * only cross-engine signal for this: `interactive-widget=resizes-content` is
 * Chrome/Firefox-only (WebKit bug 259770), so iOS needs a JS path regardless,
 * and adding the meta tag would change composer behaviour on two engines for
 * no iOS benefit. Hence: read the visual viewport, publish two custom
 * properties, and let CSS decide what to do with them.
 *
 * WHY IT IS PURE. jsdom 20 has no `visualViewport` at all, so every piece of
 * judgement lives here where it can be tested as a table, and the hook that
 * owns the listeners stays thin enough to read in one screen.
 *
 * THE SAFETY RULE THAT SHAPES EVERY BRANCH: the fallback values returned here
 * — `100%` and `0px` — are *exactly* what `:root` declares in
 * `src/styles/workspace-viewport.css`, which is exactly today's behaviour. So
 * a sample we do not trust degrades to "as if this feature had never shipped",
 * never to a broken layout. That is why nonsense returns a fallback rather
 * than a clamped guess.
 */

export interface VvSample {
  /** `visualViewport.height` — CSS px actually visible to the user. */
  height: number;
  /** `visualViewport.offsetTop` — how far the visual viewport has scrolled
   *  down inside the layout viewport (non-zero when iOS scrolls a focused
   *  field into view above the keyboard). */
  offsetTop: number;
  /** `window.innerHeight` — the layout viewport, i.e. the containing block a
   *  `position: fixed` overlay is measured against. */
  layoutHeight: number;
}

export interface ViewportVars {
  /** Value for `--cc-vvh`. A CSS length, or `100%`. */
  vvh: string;
  /** Value for `--cc-vv-top`. A CSS length. */
  vvTop: string;
}

/** The values `:root` already declares. Returned whenever a sample is absent
 *  or nonsensical, so the JS path can never be worse than no JS path. */
export const VV_FALLBACK: Readonly<ViewportVars> = Object.freeze({
  vvh: "100%",
  vvTop: "0px",
});

/** No phone, tablet or monitor has a 100 000 px viewport. A number past this
 *  is a broken sample (a unit mix-up, a mocked global, a device-pixel value
 *  leaking in), not a very large screen. */
const MAX_SANE_PX = 100_000;

const isFiniteNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Turn one visual-viewport sample into the two custom-property values.
 *
 * Height rounds DOWN: `--cc-vvh` is consumed as a `max-height`, and claiming
 * a fraction of a pixel more than exists is the one direction that can put
 * content under the keyboard.
 *
 * Offset is clamped to `[0, layoutHeight - height]`. The upper bound is the
 * load-bearing one: iOS 26 has been observed leaving `offsetTop` non-zero
 * after the keyboard closes, and an unbounded offset translates the overlay
 * clean off the bottom of the screen — an invisible workspace, which is worse
 * than the bug we are fixing. When `layoutHeight` is unusable we cannot
 * compute that bound at all, so the offset degrades to `0px` (today's
 * behaviour) rather than to an unverifiable number.
 *
 * Accepts `null`/`undefined` deliberately: callers sample a browser global
 * that may vanish between a listener firing and the frame running.
 */
export function computeViewportVars(s: VvSample | null | undefined): ViewportVars {
  if (!s) return { ...VV_FALLBACK };

  const { height, offsetTop, layoutHeight } = s;

  if (!isFiniteNumber(height)) return { ...VV_FALLBACK };
  const h = Math.floor(height);
  // `h < 1` catches 0, negatives and sub-pixel garbage in one comparison. A
  // zero-height overlay is indistinguishable from a broken one, so it is not
  // a value we are ever willing to publish.
  if (h < 1 || h > MAX_SANE_PX) return { ...VV_FALLBACK };

  const boundable =
    isFiniteNumber(layoutHeight) && layoutHeight > 0 && layoutHeight <= MAX_SANE_PX;

  let top = 0;
  if (boundable && isFiniteNumber(offsetTop) && offsetTop > 0) {
    // `Math.max(0, …)` covers the pinched-out case where the visual viewport
    // is TALLER than the layout viewport: the ceiling goes negative, and the
    // only correct offset is zero.
    top = Math.min(offsetTop, Math.max(0, layoutHeight - height));
  }

  return { vvh: `${h}px`, vvTop: `${Math.round(top)}px` };
}

/**
 * Events after which the published variables must be thrown away rather than
 * recomputed.
 *
 * `focusout` is the keyboard-dismissed signal, and it is a *force* reset for a
 * reason: the sample taken at dismissal time is the one we least trust (iOS 26
 * reports a stale `offsetTop`), so we clear to the CSS defaults and re-sample
 * once the animation has settled. `blur` is the app-switch case — same
 * reasoning, and it self-heals through the same re-sample.
 */
const RESET_EVENTS: ReadonlySet<string> = new Set(["focusout", "blur"]);

export function shouldResetVars(eventType: string): boolean {
  return typeof eventType === "string" && RESET_EVENTS.has(eventType);
}
