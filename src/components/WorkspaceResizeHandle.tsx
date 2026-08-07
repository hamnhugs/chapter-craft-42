/**
 * WorkspaceResizeHandle — the splitter that resizes the workspace viewer.
 *
 * ─── What it has to survive ───────────────────────────────────────────────
 *
 * The panel behind this handle hosts `ArtifactFrame`: a `sandbox="allow-scripts"`
 * iframe WITHOUT `allow-same-origin`, i.e. an opaque origin, which since
 * Chromium 127 lives in a separate renderer process. Two consequences shape
 * every line below.
 *
 *   1. `setPointerCapture` alone is not enough. Measured twice in Chromium 148
 *      against exactly this configuration: once the pointer crossed into the
 *      frame, only `pointerdown` was ever delivered — no `pointermove`, no
 *      `pointerup`, no `lostpointercapture` — and the drag stuck forever. The
 *      fix is the transparent full-viewport shield in `@/lib/dragShield`,
 *      mounted on `pointerdown` BEFORE anything else can go wrong. Capture is
 *      still requested (it is free and it helps where it works), but the
 *      shield plus window-level listeners are what actually carry the drag.
 *
 *   2. Nothing here may cause a React re-render of the panel during the drag.
 *      `ArtifactFrame` rebuilds its document string in the render body over
 *      content capped at 400 000 characters; `react-markdown` v10 memoises
 *      nothing. A `setState` per `pointermove` would mean a 400 KB allocation
 *      and a full markdown re-parse per pointer event. So the drag writes
 *      `--cc-ws-w` straight to the DOM, rAF-coalesced, and calls `onCommit`
 *      exactly once, on release. THIS FILE DELIBERATELY CONTAINS NO
 *      `useState` — the shell owns the committed value; the handle owns only
 *      the in-flight gesture, in refs.
 *
 * ─── The one thing that must never happen ─────────────────────────────────
 *
 * A shield that outlives its drag is an invisible click-blocker over the whole
 * application. Every exit from a drag therefore funnels through `endDrag`,
 * whose teardown runs from a `finally` and starts with `hideDragShield()`;
 * `hideDragShield` is itself idempotent and non-throwing. On top of the normal
 * `pointerup` there are six other exits: `pointercancel`, `lostpointercapture`,
 * window `blur`, `visibilitychange`, the `buttons === 0` watchdog on
 * `pointermove`, and `Escape`. Unmount and a mid-drag `disabled` flip cancel
 * too, and `dragShield` arms its own independent hatches as a second layer.
 *
 * `pointerleave` is NOT among them, on purpose: Firefox fires it spuriously
 * during a capture (react-resizable-panels#514) and it would abort live drags.
 *
 * ─── Geometry ─────────────────────────────────────────────────────────────
 *
 * The handle is live in `dock` AND in `drawer`. `drawer` is the landscape
 * phone — the mode the whole feature exists for — and a splitter that went
 * dead there would answer half the request. It is disabled only in `full`,
 * where there is nothing left to resize.
 *
 * `geometry` is a required prop because the width budget genuinely differs:
 * `dock` shares a flex row and must leave `CHAT_MIN_PX` for the chat column,
 * while `drawer` floats above the app and reserves only `DRAWER_PEEK_PX`. On
 * an 852 px landscape phone that is the difference between a 452 px ceiling
 * and a 724 px one — i.e. between a drawer that can nearly fill the screen and
 * one that cannot. Defaulting it would be silently wrong in exactly the case
 * the user complained about.
 *
 * `containerRef` is the width BUDGET, which is not always the parent:
 *   - `dock`   → the flex row that holds chat + workspace,
 *   - `drawer` → the viewport (the drawer is an overlay; the row underneath is
 *                not being squeezed).
 * The shell passes the right one; this component honours what it is given and
 * only falls back to `window.innerWidth` when the ref is empty or unlaid-out.
 */

import React, { useCallback, useEffect, useRef } from "react";

import { hideDragShield, showDragShield } from "@/lib/dragShield";
import { isTouchPrimary } from "@/lib/focusPolicy";
import {
  clampFraction,
  defaultFractionFor,
  dragDeltaPx,
  fractionBounds,
  hitAreaPx,
  isDoubleTap,
  keyStepFraction,
  pxToFraction,
  resolvePanelPx,
  type WorkspaceGeometry,
} from "@/lib/workspaceLayout";

export interface WorkspaceResizeHandleProps {
  /** Element carrying the `--cc-ws-w` custom property (the shell root). */
  targetRef: React.RefObject<HTMLElement>;
  /** Element whose `clientWidth` is the width budget for this geometry. */
  containerRef: React.RefObject<HTMLElement>;
  /** Committed fraction. Drives `aria-valuenow` and seeds each drag. */
  fraction: number;
  /** Called once per gesture, on release — never during a move. */
  onCommit: (fraction: number) => void;
  /** Id of the panel this separator resizes → `aria-controls`. */
  controlsId: string;
  /** Which width budget applies. Required: see the header note. */
  geometry: WorkspaceGeometry;
  /** True only in `full` geometry, where there is nothing to resize. */
  disabled?: boolean;
}

/**
 * `aria-valuenow` and friends are integer percentages (APG).
 *
 * Geometry-aware, and that is not a detail: the two modes have genuinely
 * different draggable ranges (dock 0.15–0.85, drawer 0.30–0.96). A dock-only
 * `pct` would pin `aria-valuenow` at 85 while the drawer sat at 96 % — the
 * separator would report a position it was not in, to the one class of user
 * who cannot see where it is.
 */
const pct = (fraction: number, geometry: WorkspaceGeometry): number =>
  Math.round(clampFraction(fraction, geometry) * 100);

const DRAGGING_ATTR = "data-cc-dragging";

interface DragSession {
  /** The element that owns capture and the dragging attribute. */
  el: HTMLElement;
  pointerId: number | undefined;
  captured: boolean;
  startX: number;
  /** Panel width in px at `pointerdown` — the drag is a delta from here. */
  basePx: number;
  baseFraction: number;
  containerPx: number;
  geometry: WorkspaceGeometry;
  dir: "ltr" | "rtl";
  /** Live, normalised fraction. The single source of truth during the drag. */
  fraction: number;
}

/**
 * Layout direction, for `dragDeltaPx`. The `dir` ATTRIBUTE is checked first
 * because it is the authoritative author signal and is readable in every
 * environment; computed style is the fallback for direction set purely in CSS.
 * (We are not adding RTL layout support — this is cheap insurance against the
 * class of bug behind Firefox 1312687, where a mirrored layout silently
 * reverses a splitter.)
 */
function readDirection(el: Element | null): "ltr" | "rtl" {
  try {
    const attr = el?.closest?.("[dir]")?.getAttribute("dir")?.toLowerCase();
    if (attr === "rtl" || attr === "ltr") return attr;
  } catch {
    /* fall through to computed style */
  }
  try {
    if (el && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const d = window.getComputedStyle(el).direction;
      if (d === "rtl") return "rtl";
    }
  } catch {
    /* fall through to the default */
  }
  return "ltr";
}

/** Same pointer, tolerating environments that do not populate `pointerId`. */
const samePointer = (s: DragSession, id: number | undefined): boolean =>
  s.pointerId === undefined || id === undefined || s.pointerId === id;

const WorkspaceResizeHandle = ({
  targetRef,
  containerRef,
  fraction,
  onCommit,
  controlsId,
  geometry,
  disabled = false,
}: WorkspaceResizeHandleProps) => {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const rafRef = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  /** Last `pointerdown` {t, x}, for the synthesised double-tap reset. */
  const lastDownRef = useRef<{ t: number; x: number } | null>(null);
  /** APG `Enter` toggle: the width to restore after a collapse-to-min. */
  const restoreRef = useRef<number | null>(null);

  // Latest-props mirror. Every handler below is `useCallback([])` and reads
  // through this, so the window listeners attached for one gesture never go
  // stale and never need re-binding mid-drag.
  const latest = useRef({ targetRef, containerRef, fraction, onCommit, geometry, disabled });
  latest.current = { targetRef, containerRef, fraction, onCommit, geometry, disabled };

  // ── measurement ─────────────────────────────────────────────────────────

  const measureContainer = useCallback((): number => {
    const el = latest.current.containerRef?.current ?? null;
    const measured = el ? el.clientWidth : 0;
    const viewport = typeof window !== "undefined" ? window.innerWidth : 0;
    const containerPx = measured > 0 ? measured : viewport;

    if (import.meta.env.DEV && latest.current.geometry === "drawer" && viewport > 0) {
      // In `drawer` the budget is the VIEWPORT, not the panel. Passing the
      // overlay itself here would cap the drag at roughly its current width —
      // the drawer would refuse to widen and there would be no error to see.
      if (containerPx < viewport * 0.9) {
        console.warn(
          `[WorkspaceResizeHandle] drawer container measures ${containerPx}px against a ${viewport}px viewport. ` +
            "In drawer geometry containerRef must measure the viewport, not the panel.",
        );
      }
    }
    return containerPx;
  }, []);

  // ── painting (no React state — see the header note) ──────────────────────

  const paint = useCallback((f: number, containerPx: number, g: WorkspaceGeometry) => {
    const px = resolvePanelPx(f, containerPx, g);
    // Both writes are guarded independently. `paint` runs inside the rAF and
    // inside `endDrag`'s try — a target that has been detached, or whose
    // `style` is unreachable, must degrade to "the panel does not move", never
    // to "an exception escapes and the gesture bookkeeping is skipped".
    try {
      const target = latest.current.targetRef?.current ?? null;
      if (target) target.style.setProperty("--cc-ws-w", `${px}px`);
    } catch {
      /* noop */
    }
    try {
      const el = handleRef.current;
      if (el) el.setAttribute("aria-valuenow", String(pct(f, g)));
    } catch {
      /* noop */
    }
    return px;
  }, []);

  /**
   * Normalise a raw pixel width into the fraction that will be both painted
   * and committed. The round trip px → fraction → px → fraction is what makes
   * the panel a FIXPOINT of paint → commit → paint: two different bounds are
   * in play (the fraction range, applied at commit, and the geometry's pixel
   * minimums, applied at paint) and they do not agree. Without this, a drag on
   * an 852 px landscape phone would paint 796 px and then snap back to 724 px
   * on release; and in `dock` the handle would detach from the pointer inside
   * a dead zone above the pixel ceiling.
   */
  const normalize = useCallback((rawPx: number, containerPx: number, g: WorkspaceGeometry): number => {
    const px = resolvePanelPx(pxToFraction(rawPx, containerPx, g), containerPx, g);
    return pxToFraction(px, containerPx, g);
  }, []);

  const cancelFrame = useCallback(() => {
    if (!rafRef.current) return;
    try {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafRef.current);
    } catch {
      /* noop */
    }
    rafRef.current = 0;
  }, []);

  // ── teardown ─────────────────────────────────────────────────────────────

  const detachListeners = useCallback(() => {
    const fn = detachRef.current;
    detachRef.current = null;
    try {
      fn?.();
    } catch {
      /* never throw out of teardown */
    }
  }, []);

  /**
   * End the gesture. Idempotent. `commit: false` reverts to the width the
   * drag started from (Escape); `commit: true` keeps what the user sees.
   *
   * Teardown runs from `finally` and its first act is `hideDragShield()`, so
   * no failure anywhere above can leave an invisible full-screen click-blocker
   * over the app.
   */
  const endDrag = useCallback(
    (commit: boolean) => {
      const s = dragRef.current;
      if (!s) {
        // Nothing in flight, but a shield may still exist if a previous
        // gesture died in an unusual way. Reaping is free.
        hideDragShield();
        detachListeners();
        return;
      }
      dragRef.current = null;
      try {
        cancelFrame();
        const f = commit ? s.fraction : s.baseFraction;
        paint(f, s.containerPx, s.geometry);
        if (commit && Math.abs(f - s.baseFraction) > 1e-6) {
          restoreRef.current = null;
          latest.current.onCommit(f);
        }
      } finally {
        try {
          hideDragShield();
        } catch {
          /* noop */
        }
        detachListeners();
        try {
          if (s.captured && typeof s.pointerId === "number") s.el.releasePointerCapture(s.pointerId);
        } catch {
          /* the pointer is already gone — that is the normal case here */
        }
        try {
          s.el.removeAttribute(DRAGGING_ATTR);
        } catch {
          /* noop */
        }
      }
    },
    [cancelFrame, detachListeners, paint],
  );

  // ── the move path ────────────────────────────────────────────────────────

  const flush = useCallback(() => {
    rafRef.current = 0;
    const s = dragRef.current;
    if (!s) return;
    paint(s.fraction, s.containerPx, s.geometry);
  }, [paint]);

  const flushSafely = useCallback(() => {
    try {
      flush();
    } catch {
      // A throw while painting must not strand the shield.
      endDrag(false);
    }
  }, [endDrag, flush]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current) return;
    if (typeof requestAnimationFrame !== "function") {
      flushSafely();
      return;
    }
    rafRef.current = requestAnimationFrame(flushSafely);
  }, [flushSafely]);

  const onWindowMove = useCallback(
    (e: PointerEvent) => {
      try {
        const s = dragRef.current;
        if (!s || !samePointer(s, e.pointerId)) return;
        // Watchdog: the button came up somewhere we never heard about (a
        // native drag, an alert, a devtools break). Not `pointerleave` —
        // Firefox fires that spuriously during capture and it would abort
        // live drags (react-resizable-panels#514).
        if (e.buttons === 0) {
          endDrag(true);
          return;
        }
        const raw = s.basePx + dragDeltaPx(s.startX, e.clientX, s.dir);
        // STORE only; the rAF does the DOM write. One write per frame no
        // matter how many pointer events arrive.
        s.fraction = normalize(raw, s.containerPx, s.geometry);
        scheduleFlush();
      } catch {
        endDrag(false);
      }
    },
    [endDrag, normalize, scheduleFlush],
  );

  const onWindowUp = useCallback(
    (e: PointerEvent) => {
      try {
        const s = dragRef.current;
        if (!s || !samePointer(s, e.pointerId)) return;
        const raw = s.basePx + dragDeltaPx(s.startX, e.clientX, s.dir);
        s.fraction = normalize(raw, s.containerPx, s.geometry);
      } finally {
        endDrag(true);
      }
    },
    [endDrag, normalize],
  );

  /**
   * The gesture was taken away from us. Keep what the user last saw rather
   * than snapping the panel back — a surprise revert reads as a bug.
   */
  const onWindowAbort = useCallback(() => endDrag(true), [endDrag]);

  const onVisibility = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) endDrag(true);
  }, [endDrag]);

  /**
   * Escape cancels the drag and reverts. Bound at WINDOW in the CAPTURE phase
   * and stopped there, which is what keeps the shell's own capture-phase
   * Escape handler (on `document`) from closing the drawer out from under a
   * drag that was only meant to be abandoned.
   */
  const onWindowKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    },
    [endDrag],
  );

  // ── pointerdown ──────────────────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const { disabled: isDisabled, geometry: g, fraction: current } = latest.current;
      if (isDisabled) return;
      // Secondary mouse buttons open context menus; they are not drags.
      if (e.pointerType === "mouse" && e.button !== 0) return;

      const el = handleRef.current ?? (e.currentTarget as HTMLElement);
      const containerPx = measureContainer();

      // Double-tap-to-reset is synthesised from `pointerdown` timestamps
      // rather than listening for `dblclick`, because calling
      // `setPointerCapture` on `pointerdown` suppresses the synthetic click in
      // Chrome — and capturing early is non-negotiable here (see the header).
      const tap = { t: Date.now(), x: e.clientX };
      const reset = isDoubleTap(lastDownRef.current, tap);
      lastDownRef.current = reset ? null : tap;

      e.preventDefault();

      // Before anything paints. Without a measurable container there is no
      // meaningful width, and painting against a zero budget would collapse the
      // panel to 0 px — including on the double-tap path, which is why this
      // guard sits above the reset branch rather than below it.
      if (!(containerPx > 0)) return;

      // Unconditional, and it runs for the reset path too: `endDrag` is
      // idempotent and cheap with nothing in flight, and routing every new
      // gesture through it makes "no shield from a previous gesture can survive
      // into this one" structural rather than a case we remembered to handle.
      // `false` — a superseded drag reverts; committing here would fire a state
      // change in the middle of a pointerdown.
      endDrag(false);

      if (reset) {
        const f = defaultFractionFor(g);
        restoreRef.current = null;
        paint(f, containerPx, g);
        latest.current.onCommit(f);
        return;
      }

      // FIRST. Before capture, before listeners, before any measurement that
      // could throw: if the pointer reaches the artifact frame without this,
      // the drag is dead and unrecoverable.
      showDragShield("col-resize");

      let captured = false;
      try {
        el.setPointerCapture(e.pointerId);
        captured = true;
      } catch {
        // Not available (jsdom) or refused. The shield plus window listeners
        // carry the drag on their own; capture is an optimisation here.
      }

      const basePx = resolvePanelPx(current, containerPx, g);
      const baseFraction = pxToFraction(basePx, containerPx, g);

      dragRef.current = {
        el,
        pointerId: typeof e.pointerId === "number" ? e.pointerId : undefined,
        captured,
        startX: e.clientX,
        basePx,
        baseFraction,
        containerPx,
        geometry: g,
        dir: readDirection(el),
        fraction: baseFraction,
      };

      try {
        el.setAttribute(DRAGGING_ATTR, "true");
      } catch {
        /* noop */
      }

      // Capture phase at window: nothing in the app can stopPropagation these
      // away, and they run before the shield's own bubble-phase hatches, so
      // the width is committed before the shield disappears.
      const opts = { capture: true } as const;
      window.addEventListener("pointermove", onWindowMove, opts);
      window.addEventListener("pointerup", onWindowUp, opts);
      window.addEventListener("pointercancel", onWindowAbort, opts);
      window.addEventListener("blur", onWindowAbort);
      window.addEventListener("keydown", onWindowKeyDown, opts);
      document.addEventListener("visibilitychange", onVisibility);
      el.addEventListener("lostpointercapture", onWindowAbort);

      detachRef.current = () => {
        window.removeEventListener("pointermove", onWindowMove, opts);
        window.removeEventListener("pointerup", onWindowUp, opts);
        window.removeEventListener("pointercancel", onWindowAbort, opts);
        window.removeEventListener("blur", onWindowAbort);
        window.removeEventListener("keydown", onWindowKeyDown, opts);
        document.removeEventListener("visibilitychange", onVisibility);
        el.removeEventListener("lostpointercapture", onWindowAbort);
      };
    },
    [
      endDrag,
      measureContainer,
      onVisibility,
      onWindowAbort,
      onWindowKeyDown,
      onWindowMove,
      onWindowUp,
      paint,
    ],
  );

  // ── keyboard (APG separator contract, D12) ───────────────────────────────

  const applyFraction = useCallback(
    (f: number, containerPx: number, g: WorkspaceGeometry) => {
      const next = normalize(resolvePanelPx(f, containerPx, g), containerPx, g);
      paint(next, containerPx, g);
      latest.current.onCommit(next);
    },
    [normalize, paint],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const { disabled: isDisabled, geometry: g, fraction: current } = latest.current;
      if (isDisabled) return;
      const containerPx = measureContainer();
      if (!(containerPx > 0)) return;

      // APG: "collapses the pane… if collapsed, restores splitter to previous
      // position". Collapsed means the MINIMUM width, never closed — closing
      // unmounts the artifact iframe, which is unrecoverable.
      //
      // The minimum is this GEOMETRY's minimum. A dock-only floor here would
      // make Enter a no-op in the drawer, whose floor is 0.30, not 0.15.
      if (e.key === "Enter") {
        e.preventDefault();
        // The floor that is actually REACHABLE, not the nominal fraction bound.
        // These are different numbers whenever the pixel minimum binds first:
        // on a 1440 px container the dock's nominal 0.15 is 216 px, below
        // PANEL_MIN_PX, so the panel stops at 320 px — a fraction of 0.222.
        // Comparing `current` against 0.15 therefore NEVER reported "collapsed",
        // and the restore half of the APG toggle was unreachable: Enter
        // collapsed, and every Enter after it collapsed again.
        const floor = normalize(resolvePanelPx(fractionBounds(g).min, containerPx, g), containerPx, g);
        const atMin = clampFraction(current, g) <= floor + 1e-6;
        if (atMin) {
          const restore = restoreRef.current ?? defaultFractionFor(g);
          restoreRef.current = null;
          applyFraction(restore, containerPx, g);
        } else {
          restoreRef.current = clampFraction(current, g);
          applyFraction(floor, containerPx, g);
        }
        return;
      }

      const next = keyStepFraction(e.key, e.shiftKey, current, g);
      if (next === null) return;
      e.preventDefault();
      restoreRef.current = null;
      applyFraction(next, containerPx, g);
    },
    [applyFraction, measureContainer, normalize],
  );

  // ── lifecycle guards ─────────────────────────────────────────────────────

  // Going disabled mid-drag (a rotation into `full`, say) removes this element
  // from the tree without any pointer event ever arriving. Without this the
  // shield would outlive the gesture.
  useEffect(() => {
    if (disabled) endDrag(false);
  }, [disabled, endDrag]);

  // Unmount. `hideDragShield` again, unconditionally, after `endDrag` has
  // already done it: two cheap calls are worth more than one clever one.
  useEffect(
    () => () => {
      endDrag(false);
      hideDragShield();
    },
    [endDrag],
  );

  if (disabled) return null;

  const style = { "--cc-ws-hit": `${hitAreaPx(isTouchPrimary())}px` } as React.CSSProperties;
  // The PANEL's bounds, not the separator's x-position, and they differ per
  // geometry — the drawer floats above the app, so it may legitimately reach
  // 96 % where the dock stops at 85 % to keep the chat column usable.
  const bounds = fractionBounds(geometry);

  return (
    <div
      ref={handleRef}
      // `separator` is a widget role ONLY when focusable, so tabIndex is
      // mandatory — and its implicit orientation is HORIZONTAL, so a vertical
      // divider must say so explicitly. The value describes the DIVIDER's own
      // axis, not the axis it splits.
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize workspace"
      aria-controls={controlsId}
      aria-valuemin={pct(bounds.min, geometry)}
      aria-valuemax={pct(bounds.max, geometry)}
      aria-valuenow={pct(fraction, geometry)}
      title="Drag to resize · double-click to reset · arrow keys adjust · Enter collapses"
      className="cc-ws-resize-handle"
      // Drives the safe-area hit-area extension in `workspace-resize.css`:
      // only the drawer can push this handle under a landscape display cutout.
      data-cc-geometry={geometry}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
};

export default WorkspaceResizeHandle;
export { WorkspaceResizeHandle };
