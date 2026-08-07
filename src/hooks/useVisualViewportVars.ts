import { useEffect } from "react";
import {
  computeViewportVars,
  shouldResetVars,
  VV_FALLBACK,
  type VvSample,
} from "@/lib/visualViewport";

/**
 * Publishes the live visual viewport as two custom properties on
 * `<html>` — `--cc-vvh` (visible height) and `--cc-vv-top` (how far the
 * visual viewport has scrolled inside the layout viewport).
 *
 * CONTRACT, in order of how easy each is to get wrong:
 *
 * 1. IT IS A NO-OP WITHOUT `window.visualViewport`. jsdom 20 has no such
 *    object, and neither does Safari before 13. Everything below the guard is
 *    unreachable there, and `:root` in `src/styles/workspace-viewport.css`
 *    already declares working defaults, so consumers are correct before this
 *    hook ever runs — and stay correct if it never does.
 *
 * 2. IT NEVER TOUCHES LAYOUT. No element is measured, no class is toggled, no
 *    style is set on anything but `documentElement`'s two custom properties.
 *    Which element consumes them is entirely CSS's business (today: the
 *    drawer/full overlay's `max-height`).
 *
 * 3. ONE WRITE PER FRAME, AND ONLY WHEN THE VALUE CHANGED. `visualViewport`
 *    fires `resize`/`scroll` continuously through a keyboard animation and a
 *    pinch-zoom. A custom-property write on `<html>` invalidates style for the
 *    whole document, so the handler coalesces into a single rAF and the rAF
 *    diffs before writing.
 *
 * 4. IT CLEANS UP AFTER ITSELF. Unmounting — or passing `active: false` —
 *    removes both properties, so the `:root` defaults take over again.
 *
 * 5. "NO OPINION" IS EXPRESSED BY REMOVING, NOT BY WRITING THE FALLBACK. When
 *    `computeViewportVars` distrusts a sample it returns `100%`, which is the
 *    BASE `:root` declaration — but the stylesheet upgrades that base to the
 *    small-viewport unit inside an @supports block, and an inline `100%` on
 *    <html> would shadow the upgrade and reinstate the toolbar bleed. So a
 *    fallback height clears the inline value and lets CSS decide.
 *
 * The hook is written to be used ONCE, by the workspace shell. Two live
 * instances would not corrupt anything (both write identical values), but the
 * first to unmount would clear the properties out from under the second.
 */

/** How long to wait after a reset before re-sampling. iOS's keyboard-dismiss
 *  animation runs ~250 ms, and the sample taken before it finishes is the
 *  stale one we are resetting to escape. */
const RESET_SETTLE_MS = 300;

const VVH_VAR = "--cc-vvh";
const VV_TOP_VAR = "--cc-vv-top";

export function useVisualViewportVars(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    // THE GUARD. Absent in jsdom and in Safari < 13; every listener below is
    // installed on it, so this must come first and must return, not throw.
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv || !root) return;

    let frame = 0;
    let settle = 0;
    // `null` means "no inline value published", which is both the initial state
    // and the state a distrusted sample returns us to.
    let lastVvh: string | null = null;
    let lastTop: string | null = null;

    const apply = () => {
      frame = 0;
      const sample: VvSample = {
        height: vv.height,
        offsetTop: vv.offsetTop,
        layoutHeight: window.innerHeight,
      };
      const { vvh, vvTop } = computeViewportVars(sample);

      // A trustworthy height is always `<n>px`; `100%` is the sentinel for
      // "this sample told us nothing". Publish measurements, withdraw the
      // sentinel — see note 5 above.
      const nextVvh = vvh === VV_FALLBACK.vvh ? null : vvh;
      if (nextVvh !== lastVvh) {
        if (nextVvh === null) root.style.removeProperty(VVH_VAR);
        else root.style.setProperty(VVH_VAR, nextVvh);
        lastVvh = nextVvh;
      }

      // `0px` is a legitimate measurement here (keyboard closed, nothing
      // scrolled), not a sentinel, so this half is written unconditionally —
      // and it is identical to the `:root` default anyway.
      if (vvTop !== lastTop) {
        root.style.setProperty(VV_TOP_VAR, vvTop);
        lastTop = vvTop;
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };

    const clearVars = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      root.style.removeProperty(VVH_VAR);
      root.style.removeProperty(VV_TOP_VAR);
      lastVvh = null;
      lastTop = null;
    };

    const onReset = (event: Event) => {
      if (!shouldResetVars(event.type)) return;
      // Clear synchronously — the point of a force reset is that the very next
      // paint must not use the stale value. Then re-sample once, so a reset
      // fired for the wrong reason (focus moving into the artifact iframe
      // fires `blur` on some engines) heals itself instead of pinning the
      // overlay to the fallback for the rest of the session.
      clearVars();
      window.clearTimeout(settle);
      settle = window.setTimeout(schedule, RESET_SETTLE_MS);
    };

    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    // `focusout` bubbles (`blur` does not), so document-level is enough to see
    // every field in the app losing focus. The `blur` binding is the window's
    // own, non-capture, i.e. app-switch only.
    document.addEventListener("focusout", onReset);
    window.addEventListener("blur", onReset);

    // Seed. The keyboard can already be open when the workspace opens.
    schedule();

    return () => {
      window.clearTimeout(settle);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      document.removeEventListener("focusout", onReset);
      window.removeEventListener("blur", onReset);
      clearVars();
    };
  }, [active]);
}
