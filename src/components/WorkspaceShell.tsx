/**
 * WorkspaceShell — ONE node that never moves, wearing three class strings.
 *
 * ─── The invariant this file exists to hold ───────────────────────────────
 *
 * The workspace hosts `ArtifactFrame`: a `sandbox="allow-scripts"` iframe
 * without `allow-same-origin`. An iframe's document is destroyed by ANY change
 * of DOM position. Measured in Chromium 148 against exactly this frame:
 *
 *   · `appendChild` to a DIFFERENT parent  → document destroyed
 *   · `appendChild` to the SAME parent as a no-op → document destroyed
 *   · `remove()` + re-insert of the IDENTICAL element object → destroyed
 *
 * It is spec-backed rather than a quirk: removing an iframe runs "destroy a
 * child navigable", which destroys the active document with no unload event.
 * React commits every move as `insertBefore`/`appendChild`, so any change of
 * tree position is a teardown. `createPortal` is not an escape — React's own
 * docs say passing a different DOM node during an update recreates the portal
 * content, and swapping between an inline branch and a portal branch is a
 * different element type at the same position anyway.
 *
 * That is not theoretical here. Until this component existed the workspace was
 * rendered at TWO JSX positions in `ChatPanel` — a desktop column and a Radix
 * `Sheet` — chosen by a width-only `useIsMobile()` at 768 px. Crossing 768 px,
 * i.e. ROTATING THE PHONE, swapped branches and RELOADED THE USER'S MINI-APP.
 * `public/artifact-frame.html` latches `written = true` and ignores a second
 * document, so that reload is unrecoverable. Collapsing the two branches into
 * the single node below is the fix, and it is the deeper half of the bug the
 * user reported.
 *
 * So the rules, in order of how badly each breaks things:
 *
 *   1. Exactly ONE `<WorkspacePanel>`, at exactly one JSX position. No ternary
 *      that renders it twice, no portal, no `key` derived from geometry, width
 *      or fullscreen.
 *   2. Geometry is a CLASS SWAP on that node. Fullscreen is a class swap on
 *      that node. Rotation is a class swap on that node. Nothing moves.
 *   3. The class strings are COMPLETE LITERALS in a lookup object. Tailwind's
 *      content scanner reads the `src` tree as plain source TEXT, so a class
 *      name assembled by concatenation is never emitted into the stylesheet
 *      and the overlay silently loses `position: fixed`.
 *
 * The repo already ships this pattern correctly in four places —
 * `MediaFrame.tsx:307`, `LibraryGraph.tsx:271`, `NeuronGraph.tsx:320`,
 * `EntryNeuronGraph.tsx:398` — all `expanded ? "fixed inset-0 z-[100] …"` on
 * the SAME node. `MediaFrame.tsx:9-13` states the rationale verbatim for its
 * WebGL context; ours is a browsing context, and browsing contexts are worse:
 * a lost WebGL context can be restored, a destroyed document cannot.
 *
 * ─── Why the resize handle is a SIBLING, and why that is still safe ────────
 *
 * `WorkspaceResizeHandle` renders `null` in `full` geometry, so the shell
 * root's child list goes from `[handle, panelBox]` to `[panelBox]` and back.
 * That is a removal/insertion of the handle — a PRECEDING SIBLING. React
 * commits it as `removeChild(handle)` / `insertBefore(handle, panelBox)`, and
 * neither operation touches `panelBox`, which is the node the iframe lives
 * under. Only the moved node moves. This is the one structural change in the
 * tree and it is deliberately on the side of the boundary that can afford it.
 *
 * ─── The containing-block trap ────────────────────────────────────────────
 *
 * In `drawer` and `full` this element is `position: fixed` while remaining a
 * CHILD of ChatPanel's flex row — there is no portal, so it is only positioned
 * against the viewport as long as no ancestor is a containing block. Any
 * `transform`, `filter`, `backdrop-filter`, `will-change`, `contain` or
 * `perspective` anywhere on `Index.tsx → ChatPanel.tsx → here` turns fullscreen
 * into "fills its parent" — a visual-only failure with NO console error. The
 * chain is clean today and `src/test/workspaceContainingBlock.test.ts` keeps it
 * that way. Nothing in this file or in `workspace-overlay.css` may add one.
 * (Ancestor `overflow: hidden` is fine: a fixed box whose containing block is
 * the viewport is not clipped by it.)
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import WorkspacePanel from "@/components/WorkspacePanel";
import WorkspaceResizeHandle from "@/components/WorkspaceResizeHandle";
import { useViewport } from "@/hooks/useViewport";
import { useVisualViewportVars } from "@/hooks/useVisualViewportVars";
import {
  DEFAULT_WIDTHS,
  WORKSPACE_WIDTH_KEY,
  readStoredWidths,
  resolveGeometry,
  resolvePanelPx,
  writeStoredWidths,
  type StoredWidths,
  type WorkspaceGeometry,
} from "@/lib/workspaceLayout";

export interface WorkspaceShellProps {
  open: boolean;
  userId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

/**
 * THE THREE GEOMETRIES, as complete literal strings.
 *
 * Do not build these by concatenation, do not interpolate a variable into
 * them, and do not move `z-[100]` into a constant — Tailwind's scanner is a
 * regex over source text and sees none of that.
 *
 *   dock   — a real column in ChatPanel's flex row; the chat is squeezed.
 *   drawer — an overlay pinned to the right edge; the chat is not squeezed,
 *            which is why its width budget reserves only a peek strip.
 *   full   — the whole viewport.
 *
 * `z-[100]` is the repo's "owns the whole screen" layer (`MediaFrame.tsx:307`,
 * `LibraryGraph.tsx:271`), and it sits correctly below `PocketScreen`'s
 * `z-[200]`. The scrim takes `z-[99]`, one below the panel.
 *
 * `min-w-0` is on every one of them. In `dock` today's column has none and is
 * safe only because its single child does; this shell has TWO children (handle
 * + panel), and a flex item's `min-width: auto` would let the pair push the
 * chat column off screen.
 */
const SHELL_CLASS: Record<WorkspaceGeometry, string> = {
  dock: "flex h-full shrink-0 min-w-0",
  drawer:
    "cc-workspace-overlay cc-workspace-drawer fixed inset-y-0 right-0 z-[100] flex min-w-0 overscroll-contain",
  full: "cc-workspace-overlay fixed inset-0 z-[100] flex min-w-0 overscroll-contain",
};

/**
 * The scrim is ALWAYS RENDERED and only changes class, for the same reason the
 * panel is: a conditionally-rendered scrim would be inserted before the shell
 * root, and while inserting a preceding sibling does not move the shell, "no
 * insertions at all" is a cheaper invariant to hold than "only safe ones".
 *
 * Hidden in `dock` (nothing is being covered) and in `full` (the panel covers
 * the viewport, so a scrim would be both invisible and unreachable).
 */
const SCRIM_CLASS: Record<WorkspaceGeometry, string> = {
  dock: "hidden",
  drawer: "fixed inset-0 z-[99] bg-black/50",
  full: "hidden",
};

/**
 * The panel box. It — not the shell root — carries the safe-area insets.
 *
 * That placement is load-bearing and is documented in `workspace-resize.css`:
 * the handle's hit area extends INBOARD into this padding by exactly
 * `env(safe-area-inset-left)` so that a drawer dragged to full extension still
 * has a grabbable strip clear of a landscape display cutout. If the inset moved
 * to the shell root — outboard of the handle — that extension would overlap
 * real panel content and steal its taps, on notched phones in landscape only,
 * which is precisely where nobody would notice.
 */
const PANEL_BOX_CLASS: Record<WorkspaceGeometry, string> = {
  dock: "flex-1 min-w-0 flex",
  drawer: "cc-workspace-inset flex-1 min-w-0 flex",
  full: "cc-workspace-inset flex-1 min-w-0 flex",
};

/**
 * `width` is React-managed; `--cc-ws-w` is NOT. React only ever writes the
 * keys present in this object, so the imperative `setProperty("--cc-ws-w", …)`
 * done here and by the drag handle can never be clobbered by a re-render.
 *
 * Two constants rather than `undefined` in `full`, so React swaps a VALUE and
 * never adds or removes a style key.
 */
const WIDTH_FROM_VAR: React.CSSProperties = { width: "var(--cc-ws-w)" };
/** `full` is `inset-0`; the insets resolve the width and a `width` would fight
 *  them (an over-constrained box drops `right` in LTR). */
const WIDTH_FROM_INSETS: React.CSSProperties = { width: "auto" };

/** Marks the document while an overlay geometry is up. Deliberately NOT
 *  `cc-media-overlay-open`: that class's rule at `src/index.css:779-787` strips
 *  `backdrop-filter` off chat bubbles for an unrelated reason (aurora's glass
 *  bubbles confining MediaFrame's own fullscreen), and reusing it would couple
 *  two features that will drift. */
const OVERLAY_OPEN_CLASS = "cc-workspace-overlay-open";

/** Read both persisted widths. Never throws — a corrupt or absent value is
 *  indistinguishable from a first visit, and both must be silent (R6). */
function readWidths(): StoredWidths {
  let stored: Partial<StoredWidths> | null = null;
  try {
    stored =
      typeof localStorage === "undefined"
        ? null
        : readStoredWidths(localStorage.getItem(WORKSPACE_WIDTH_KEY));
  } catch {
    stored = null;
  }
  return {
    dock: stored?.dock ?? DEFAULT_WIDTHS.dock,
    drawer: stored?.drawer ?? DEFAULT_WIDTHS.drawer,
  };
}

const WorkspaceShell: React.FC<WorkspaceShellProps> = ({
  open,
  userId,
  selectedId,
  onSelect,
  onClose,
}) => {
  const viewport = useViewport();
  const [userFullscreen, setUserFullscreen] = useState(false);

  /** What the device says. */
  const naturalGeometry = resolveGeometry(viewport);
  /** What we render. Fullscreen is a MODE, layered over the geometry — never a
   *  different element and never a different position. */
  const geometry: WorkspaceGeometry = userFullscreen ? "full" : naturalGeometry;

  const shellRef = useRef<HTMLDivElement>(null);
  /** The element whose `clientWidth` is the width BUDGET, which is not the
   *  parent in every mode: `dock` shares a flex row with the chat, `drawer`
   *  floats above the app and is budgeted against the viewport. */
  const containerRef = useRef<HTMLElement | null>(null);
  /** A BUTTON ref by construction (WorkspacePanel puts it on its header
   *  button). Nothing in this feature may focus an input or a textarea —
   *  Android Chrome opens the soft keyboard on ANY programmatic focus once the
   *  session has seen a gesture (`src/lib/focusPolicy.ts`). */
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);

  const panelId = useId();

  const [widths, setWidths] = useState<StoredWidths>(readWidths);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const fraction = geometry === "dock" ? widths.dock : widths.drawer;

  /** Latest-props mirror, so the handlers below can be `useCallback([])` and
   *  the listeners they install never go stale and never need re-binding. */
  const latest = useRef({ geometry, fraction, onClose, userFullscreen });
  latest.current = { geometry, fraction, onClose, userFullscreen };

  // ── width plumbing ──────────────────────────────────────────────────────

  /** Last value WE wrote, and to which element. The element half matters:
   *  closing the workspace destroys the root, so a value-only cache would make
   *  the next open skip its seed and paint nothing. */
  const paintedRef = useRef<{ el: HTMLElement | null; value: string }>({ el: null, value: "" });

  const containerElFor = useCallback((g: WorkspaceGeometry): HTMLElement | null => {
    if (typeof document === "undefined") return null;
    // `dock`: the flex row that holds chat + workspace.
    if (g === "dock") return shellRef.current?.parentElement ?? null;
    // `drawer` / `full`: the layout viewport. Measuring the overlay itself here
    // would cap the drag at roughly its current width — the drawer would refuse
    // to widen and there would be no error to see.
    return document.documentElement;
  }, []);

  const measureContainerPx = useCallback(
    (g: WorkspaceGeometry): number => {
      const el = containerElFor(g);
      const measured = el ? el.clientWidth : 0;
      if (measured > 0) return measured;
      return typeof window !== "undefined" ? window.innerWidth : 0;
    },
    [containerElFor],
  );

  const paintWidth = useCallback((px: number) => {
    const el = shellRef.current;
    if (!el) return;
    const value = `${px}px`;
    const painted = paintedRef.current;
    if (painted.el === el && painted.value === value) return;
    paintedRef.current = { el, value };
    try {
      el.style.setProperty("--cc-ws-w", value);
    } catch {
      /* a detached or hostile element must degrade to "does not move" */
    }
  }, []);

  /**
   * Seed `--cc-ws-w` BEFORE first paint, and re-seed whenever the geometry,
   * the committed fraction or the viewport changes.
   *
   * Every width in this feature goes through `resolvePanelPx`, never through a
   * hand-composed `clampPanelPx`/`fractionToPx` pair: two different bounds are
   * in play (a fraction range applied at commit, a pixel minimum applied at
   * paint) and they disagree on a landscape phone. Clamping the fraction first
   * makes the panel a fixpoint of paint → commit → paint, so a drag that ran to
   * the pixel ceiling does not snap back on release.
   */
  useLayoutEffect(() => {
    containerRef.current = containerElFor(geometry);
    if (!open) return;
    if (!shellRef.current) return;
    const containerPx = measureContainerPx(geometry);
    if (!(containerPx > 0)) return;
    paintWidth(resolvePanelPx(fraction, containerPx, geometry));
  }, [open, geometry, fraction, viewport.width, viewport.height, containerElFor, measureContainerPx, paintWidth]);

  /**
   * Re-clamp when the CONTAINER changes without the window changing — the
   * tablet rail appearing, a devtools dock, a parent panel animating.
   *
   * Every DOM write is deferred out of the observer callback into a frame, and
   * a value that has not changed schedules no frame at all. That is the
   * documented avoidance for "ResizeObserver loop completed with undelivered
   * notifications", which is benign per spec but is dispatched at ERROR
   * severity — it trips catch-all handlers and has been observed to abort
   * in-progress drags. (`src/main.tsx` also filters that exact message,
   * counting occurrences so a genuine runaway loop still surfaces.)
   */
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const apply = (width: number) => {
      const containerPx = width > 0 ? width : container.clientWidth;
      if (!(containerPx > 0)) return;
      const px = resolvePanelPx(latest.current.fraction, containerPx, latest.current.geometry);
      const painted = paintedRef.current;
      // No-op before scheduling, not after: a frame requested on every
      // callback is the loop error waiting to happen.
      if (painted.el === shellRef.current && painted.value === `${px}px`) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        paintWidth(px);
      });
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      apply(entry ? entry.contentRect.width : container.clientWidth);
    });
    ro.observe(container);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [open, geometry, paintWidth]);

  /** Called once per gesture, on release — never during a move. */
  const commitFraction = useCallback((f: number) => {
    const key: keyof StoredWidths = latest.current.geometry === "dock" ? "dock" : "drawer";
    const next: StoredWidths = { ...widthsRef.current, [key]: f };
    widthsRef.current = next;
    try {
      localStorage.setItem(WORKSPACE_WIDTH_KEY, writeStoredWidths(next));
    } catch {
      /* private mode / quota — the width still applies for this session */
    }
    setWidths(next);
  }, []);

  // ── fullscreen ──────────────────────────────────────────────────────────

  const toggleFullscreen = useCallback(() => setUserFullscreen((v) => !v), []);

  /**
   * Offer the toggle only when there is somewhere to come back to.
   *
   * On a portrait phone `resolveGeometry` already returns `full`, so "expand to
   * full screen" would be a lie and "exit full screen" would be a dead control.
   * The second clause keeps the EXIT alive for a user who entered fullscreen in
   * landscape and then rotated — amendment A3 is a promise about getting back
   * out, and it must not be broken by a rotation.
   */
  const showFullscreenToggle = naturalGeometry !== "full" || userFullscreen;

  /** Reopening into a takeover state is hostile: the mode is per-session and
   *  per-open, unlike the width, which persists. */
  useEffect(() => {
    if (!open) setUserFullscreen(false);
  }, [open]);

  /**
   * Move focus to the fullscreen control when the mode flips, so a keyboard
   * user is left on the thing that just changed and a screen reader announces
   * the new label. Enter and exit are the SAME button (WorkspacePanel swaps its
   * label and icon), so one ref covers both directions.
   *
   * Skipped on mount — the first render must not steal focus from the chat.
   */
  const prevFullscreenRef = useRef(userFullscreen);
  useEffect(() => {
    if (prevFullscreenRef.current === userFullscreen) return;
    prevFullscreenRef.current = userFullscreen;
    fullscreenButtonRef.current?.focus();
  }, [userFullscreen]);

  // ── overlay side effects ────────────────────────────────────────────────

  const overlay = open && geometry !== "dock";

  /** Publishes `--cc-vvh` / `--cc-vv-top` on `<html>`. Exactly one instance in
   *  the app, and only while an overlay is up: in `dock` nothing consumes them
   *  and the `:root` defaults are the right answer. */
  useVisualViewportVars(overlay);

  /**
   * Lock background scroll while the overlay is up, mirroring
   * `MediaFrame.tsx:238-247`. A LAYOUT effect, not a passive one: the marker
   * has to land before the overlay's first paint.
   */
  useLayoutEffect(() => {
    if (!overlay) return;
    if (typeof document === "undefined") return;
    const de = document.documentElement;
    const prev = de.style.overflow;
    de.style.overflow = "hidden";
    de.classList.add(OVERLAY_OPEN_CLASS);
    return () => {
      de.style.overflow = prev;
      de.classList.remove(OVERLAY_OPEN_CLASS);
    };
  }, [overlay]);

  /**
   * Escape (R7), and the three answers are all different:
   *
   *   · user-invoked `full` → RESTORE, never close. Closing unmounts the
   *     artifact iframe, which is unrecoverable; "collapse" must never be
   *     spelled "destroy".
   *   · `drawer` / device-`full` → close, the way any overlay does.
   *   · `dock`  → IGNORE. The workspace is a column, not a layer, and a user
   *     typing in the chat must not have it yanked away by an Escape.
   *
   * Bound on `document` in the CAPTURE phase. Not `window`, and that is a
   * contract with the drag handle rather than a preference: the handle binds
   * Escape at WINDOW capture and `stopPropagation`s while a drag is live, so a
   * drag abandoned with Escape does not also close the drawer. Window capture
   * runs before document capture, so this ordering is what makes that work.
   */
  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { geometry: g, userFullscreen: fs, onClose: close } = latest.current;
      if (fs) {
        e.preventDefault();
        e.stopPropagation();
        setUserFullscreen(false);
        return;
      }
      if (g === "dock") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const onScrimClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only a click that landed ON the scrim. A click synthesised for a gesture
    // that began on the resize handle is dispatched to the nearest common
    // ancestor of its down/up targets, never to the scrim — but a drag that
    // ends over the peek strip closing the workspace would destroy the user's
    // running mini-app, so this guard is worth its one line.
    if (e.target !== e.currentTarget) return;
    latest.current.onClose();
  }, []);

  // Every hook above runs unconditionally; only the OUTPUT is conditional.
  // `open: false` unmounts, exactly as it does today.
  if (!open) return null;

  return (
    <>
      <div
        className={SCRIM_CLASS[geometry]}
        onClick={onScrimClick}
        aria-hidden="true"
        data-cc-workspace-scrim
      />
      <div
        ref={shellRef}
        data-cc-workspace-shell
        data-cc-geometry={geometry}
        className={SHELL_CLASS[geometry]}
        style={geometry === "full" ? WIDTH_FROM_INSETS : WIDTH_FROM_VAR}
      >
        {/* A sibling BEFORE the panel: the splitter marks the panel's inboard
            edge, and in `drawer` it is the only thing standing between the
            handle and a landscape display cutout. It renders `null` in `full`,
            where there is nothing left to resize — the one place this subtree's
            shape changes, and deliberately on the side that can afford it. */}
        <WorkspaceResizeHandle
          targetRef={shellRef}
          containerRef={containerRef}
          fraction={fraction}
          onCommit={commitFraction}
          controlsId={panelId}
          geometry={geometry}
          disabled={geometry === "full"}
        />
        <div id={panelId} role="region" aria-label="Workspace" className={PANEL_BOX_CLASS[geometry]}>
          <WorkspacePanel
            userId={userId}
            onClose={onClose}
            selectedId={selectedId}
            onSelect={onSelect}
            fullscreen={geometry === "full"}
            onToggleFullscreen={showFullscreenToggle ? toggleFullscreen : undefined}
            fullscreenButtonRef={fullscreenButtonRef}
          />
        </div>
      </div>
    </>
  );
};

export default WorkspaceShell;
export { WorkspaceShell };
