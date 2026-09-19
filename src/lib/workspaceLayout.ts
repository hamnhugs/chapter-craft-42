/**
 * Workspace layout kernel — every geometry decision in the resizable,
 * landscape-aware Workspace viewer reduces to one of the pure functions here.
 * Nothing in this file imports React, touches the DOM, or reads a global; the
 * only I/O is `readStoredWidths`, which is handed a string it never fetches.
 *
 * Why a kernel instead of the old boolean. `useIsMobile()` was a single width
 * comparison at 768 px and it was wrong in three separate ways:
 *
 *   1. It silently re-declared Tailwind's `md` breakpoint with no shared
 *      constant, so the JS answer and the CSS answer could drift apart.
 *   2. It LIED ON FIRST RENDER — `useState<boolean|undefined>(undefined)` plus
 *      `return !!isMobile` means every first paint says "desktop", so a phone
 *      that remembered `counsel_workspace_open === "1"` painted a 360 px
 *      desktop column for a frame before correcting itself.
 *   3. It had no height axis. An iPhone 16 rotated to landscape is 852×393:
 *      wider than 768, so the boolean said "desktop", so the app rendered a
 *      360 px docked column inside a 393 px-tall viewport. That is the bug the
 *      user reported. Geometry is two-dimensional; a width boolean cannot
 *      express it.
 *
 * So: a pure function over {width, height, touchPrimary}. Geometry decides the
 * MODE (dock / drawer / full); pointer capability decides only the AFFORDANCE
 * (`hitAreaPx`). `touchPrimary` is deliberately absent from `resolveGeometry`
 * — a touchscreen laptop is not a phone, and a mouse plugged into a tablet
 * does not make its 393 px-tall landscape viewport able to host a dock.
 *
 * We never call `screen.orientation.lock()` and never ship a "please rotate
 * your device" interstitial: `lock()` is unimplemented in Safari and throws on
 * desktop Chrome, and WCAG 2.2 SC 1.3.4 forbids restricting operation to a
 * single orientation outside a short essential list (bank checks, piano apps,
 * projector slides, VR). We also do not use the `orientation` media query as a
 * phone signal — it tests the viewport, and opening the soft keyboard can make
 * the viewport wider than it is tall.
 */

export type WorkspaceGeometry = "dock" | "drawer" | "full";

export interface Viewport {
  width: number;
  height: number;
  /** From `isTouchPrimary()` in `@/lib/focusPolicy` — `(pointer: coarse)`. */
  touchPrimary: boolean;
}

/** Persisted panel width per geometry, as a fraction of that geometry's container. */
export interface StoredWidths {
  dock: number;
  drawer: number;
}

// ── Geometry thresholds ───────────────────────────────────────────────────
// 600 is Material's compact-width line; 480 is Material's compact-height line,
// annotated by Google as covering "99.78% of phones in landscape".
// DOCK_MIN_WIDTH is derived rather than copied:
//   CHAT_MIN_PX 400 + PANEL_MIN_PX 320 + tablet rail 80 + gutters ~= 860 -> 900.

/** Below this width there is no room for anything but a full-screen takeover. */
export const COMPACT_WIDTH_MAX = 600;
/** At or above this width a side-by-side dock can hold both minimums. */
export const DOCK_MIN_WIDTH = 900;
/** Below this height a docked column is unusable no matter how wide the viewport is. */
export const SHORT_VIEWPORT_MAX_HEIGHT = 480;

// ── Width budget ──────────────────────────────────────────────────────────

/** The workspace panel is never usefully narrower than this. */
export const PANEL_MIN_PX = 320;
/** In `dock`, the chat column keeps at least this much — it is a peer, not a gutter. */
export const CHAT_MIN_PX = 400;
/**
 * In `drawer` the panel is an OVERLAY, so the app underneath is not being
 * squeezed — we only reserve enough for the scrim to read as "there is
 * something behind this, tap here to dismiss".
 */
export const DRAWER_PEEK_PX = 56;

// ── Fractions ─────────────────────────────────────────────────────────────
// A fraction, not a pixel count, so a width chosen on a 2560 px monitor still
// means something on a 1280 px laptop.

export const DEFAULT_FRACTION_DOCK = 0.38;
/** Landscape phone: nearly full, keeps a peek strip so the app is still there. */
export const DEFAULT_FRACTION_DRAWER = 0.86;

export const DEFAULT_WIDTHS: StoredWidths = Object.freeze({
  dock: DEFAULT_FRACTION_DOCK,
  drawer: DEFAULT_FRACTION_DRAWER,
});

export const FRACTION_MIN = 0.15;
export const FRACTION_MAX = 0.85;

/**
 * The drawer gets its OWN, wider range.
 *
 * `dock` shares the row with the chat, so 0.85 is a real ceiling — past it the
 * chat column stops being usable. `drawer` floats above the app, so nothing is
 * being squeezed and the only thing that should stop the drag is the peek
 * strip. With a single shared 0.85 the landscape drawer topped out at 724 px of
 * an 852 px phone, `DEFAULT_FRACTION_DRAWER` (0.86) was a width the user could
 * never reach by dragging, and `DRAWER_PEEK_PX` was inert on every real device
 * — the pixel bound never got a chance to bind. Widening the ceiling to 0.96
 * hands control back to `DRAWER_PEEK_PX`, which is the bound we actually
 * reasoned about: 0.96 × 852 = 818 px, clamped by the peek to 796 px.
 *
 * This is what makes "drag the drawer toward full screen" true on a phone.
 */
export const DRAWER_FRACTION_MIN = 0.3;
export const DRAWER_FRACTION_MAX = 0.96;

/** The draggable range for a geometry. `full` is not resizable; it borrows the
 *  drawer's range so callers never have to special-case it. */
export function fractionBounds(geometry: WorkspaceGeometry): { min: number; max: number } {
  return geometry === "dock"
    ? { min: FRACTION_MIN, max: FRACTION_MAX }
    : { min: DRAWER_FRACTION_MIN, max: DRAWER_FRACTION_MAX };
}

/**
 * localStorage key. Payload `{"dock":0.38,"drawer":0.86}`. Follows the repo's
 * only other drag-size precedent, `cc.mediaFrameSize.<kind>`: dotted `cc.`
 * namespace, JSON body, clamped on read, silent on failure.
 */
export const WORKSPACE_WIDTH_KEY = "cc.workspaceWidth";

// ── Double-tap-to-reset ───────────────────────────────────────────────────
// Synthesised from `pointerdown` timestamps rather than listening for `click`
// or `dblclick`: we call setPointerCapture on pointerdown (mandatory — a
// transparent shield plus early capture is the only thing that keeps pointer
// events flowing across our opaque-origin sandboxed artifact iframes), and
// capturing on pointerdown suppresses the synthetic `click` in Chrome.

export const DOUBLE_TAP_MS = 400;
export const DOUBLE_TAP_PX = 4;

// ── internals ─────────────────────────────────────────────────────────────

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const RESERVE_PX: Record<WorkspaceGeometry, number> = {
  dock: CHAT_MIN_PX,
  drawer: DRAWER_PEEK_PX,
  // Nothing to reserve: `full` is the whole viewport and is not resizable.
  full: 0,
};

/** A stored fraction is anything strictly inside (0, 1) — bounds are applied
 *  later, in pixels, where they can account for the actual container. */
const isFractionLike = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;

// ── public API ────────────────────────────────────────────────────────────

/**
 * The one place that decides how the workspace is laid out.
 *
 * | Device                      | Viewport | Result   |
 * |-----------------------------|----------|----------|
 * | iPhone 16 portrait          | 393×852  | `full`   |
 * | iPhone 16 landscape         | 852×393  | `drawer` |
 * | Galaxy S24 landscape        | 780×360  | `drawer` |
 * | iPhone 16 Pro Max landscape | 956×440  | `drawer` (width passes, height fails) |
 * | iPad portrait               | 768×1024 | `drawer` |
 * | Laptop                      | 1440×900 | `dock`   |
 * | WCAG 1.4.10 floor           | 1280×256 | `drawer` |
 *
 * A non-finite dimension is read as 0, which lands in `full` — the compact
 * case. That is deliberate: if we cannot measure the viewport, the safe
 * assumption is that it is small, not that it is a desktop.
 */
export function resolveGeometry(v: Viewport): WorkspaceGeometry {
  const width = Math.max(0, num(v?.width, 0));
  const height = Math.max(0, num(v?.height, 0));
  if (width < COMPACT_WIDTH_MAX) return "full";
  if (width >= DOCK_MIN_WIDTH && height >= SHORT_VIEWPORT_MAX_HEIGHT) return "dock";
  return "drawer";
}

/**
 * Hit area for the resize handle, in CSS px, centred on the 2 px visible line.
 *
 * 24 on coarse pointers satisfies WCAG 2.2 SC 2.5.8 outright instead of
 * leaning on the spacing exception; 12 on fine pointers is above VS Code's
 * effective 4 px target, which is the single most-complained-about number in
 * this pattern's bug trackers.
 */
export function hitAreaPx(touchPrimary: boolean): number {
  return touchPrimary ? 24 : 12;
}

/**
 * Clamp a proposed panel width against the container, honouring both minimums.
 *
 * Geometry-aware because the two modes are budgeting different things: `dock`
 * shares a flex row with the chat column and must leave it `CHAT_MIN_PX`;
 * `drawer` floats above the app and only leaves `DRAWER_PEEK_PX`.
 *
 * Degradation: when the container cannot hold `PANEL_MIN_PX` plus the reserve
 * — a 700 px window in dock, or any absurd/zero/NaN container — the two bounds
 * cross and there is no valid answer. Rather than return `NaN`, a negative, or
 * silently starve one side, we split the container in proportion to the two
 * minimums. The result is always finite and always inside `[0, containerPx]`.
 */
export function clampPanelPx(px: number, containerPx: number, geometry: WorkspaceGeometry): number {
  const container = Math.max(0, num(containerPx, 0));
  const reserve = RESERVE_PX[geometry] ?? 0;

  const lo = Math.min(PANEL_MIN_PX, container);
  const hi = container - reserve;

  if (!(hi > lo)) {
    // Both minimums cannot be satisfied. Share out what exists.
    const share = PANEL_MIN_PX + reserve;
    const split = share > 0 ? (container * PANEL_MIN_PX) / share : container;
    return Math.round(Math.min(Math.max(split, 0), container));
  }

  const want = num(px, lo);
  return Math.round(Math.min(Math.max(want, lo), hi));
}

/**
 * Fraction → px. Bounded to `[0, containerPx]` so a corrupt fraction can never
 * produce a width wider than the thing containing it; the geometry-aware
 * minimums are `clampPanelPx`'s job, not this one's.
 */
export function fractionToPx(f: number, containerPx: number): number {
  const container = Math.max(0, num(containerPx, 0));
  const fraction = num(f, DEFAULT_FRACTION_DOCK);
  return Math.min(Math.max(fraction * container, 0), container);
}

/**
 * px → fraction, always inside `[FRACTION_MIN, FRACTION_MAX]`.
 *
 * A degenerate container (0, negative, NaN — e.g. the element was measured
 * while detached) has no answer, so we return the dock default rather than
 * `Infinity`. Callers on the commit path should refuse to commit at all when
 * `containerPx <= 0`; this is the backstop, not the guard.
 */
export function pxToFraction(px: number, containerPx: number, geometry: WorkspaceGeometry): number {
  const container = num(containerPx, 0);
  if (!(container > 0)) return defaultFractionFor(geometry);
  return clampFraction(num(px, 0) / container, geometry);
}

/** Bound a fraction into the geometry's draggable range. Non-finite → that
 *  geometry's default. Defaults to `dock`, which is the historical behaviour. */
export function clampFraction(f: number, geometry: WorkspaceGeometry = "dock"): number {
  const { min, max } = fractionBounds(geometry);
  return Math.min(Math.max(num(f, defaultFractionFor(geometry)), min), max);
}

/** The reset target for a geometry — double-tap, and the storage fallback. */
export function defaultFractionFor(geometry: WorkspaceGeometry): number {
  return geometry === "dock" ? DEFAULT_FRACTION_DOCK : DEFAULT_FRACTION_DRAWER;
}

/**
 * THE width resolver: given a fraction, a container and a geometry, the number
 * of px the panel should actually be. Use this everywhere a width is painted —
 * the live `--cc-ws-w` write during a drag, the seed before first paint, the
 * re-clamp on window resize.
 *
 * Why it exists rather than callers composing the three primitives themselves:
 * there are two different bounds in play — a fraction bound
 * (`FRACTION_MIN`..`FRACTION_MAX`, applied at commit) and a pixel bound (the
 * geometry's minimums, applied at paint) — and they do not agree. On an 852 px
 * landscape phone the pixel bound permits 796 px while the fraction bound
 * permits 724 px. A drag that painted from the pixel bound and committed
 * through the fraction bound would run to 796 and then SNAP BACK to 724 on
 * release. Clamping the fraction FIRST makes both paths land on the same
 * number, so the panel is a fixpoint of paint -> commit -> paint.
 */
export function resolvePanelPx(fraction: number, containerPx: number, geometry: WorkspaceGeometry): number {
  return clampPanelPx(fractionToPx(clampFraction(fraction, geometry), containerPx), containerPx, geometry);
}

/**
 * Parse the `cc.workspaceWidth` payload. Never throws, for any input.
 *
 * Returns `null` when nothing usable is present, and a PARTIAL object when
 * only one half survives — a user who has dragged the dock but never the
 * drawer stores `{dock}` only, and one corrupt half must not discard the
 * other. The caller fills the gaps from `DEFAULT_WIDTHS`.
 *
 * Legacy `{"fraction":n}` (the pre-amendment single-value payload) maps to
 * `{ dock: n }`. An explicit `dock` key wins over it.
 *
 * Note the accepted range is the open interval (0, 1), NOT
 * `[FRACTION_MIN, FRACTION_MAX]`: `DEFAULT_FRACTION_DRAWER` is 0.86, above
 * `FRACTION_MAX`, and a reader that rejected our own default would silently
 * reset the drawer on every load. Range enforcement happens in pixels.
 */
export function readStoredWidths(raw: string | null): Partial<StoredWidths> | null {
  if (typeof raw !== "string" || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const src = parsed as Record<string, unknown>;
  const out: Partial<StoredWidths> = {};

  if (isFractionLike(src.fraction)) out.dock = src.fraction;
  if (isFractionLike(src.dock)) out.dock = src.dock;
  if (isFractionLike(src.drawer)) out.drawer = src.drawer;

  return out.dock === undefined && out.drawer === undefined ? null : out;
}

/**
 * Serialise both widths. Sanitises each half (a non-finite or out-of-range
 * value falls back to that geometry's default) and rounds to 4 dp so float
 * noise like `0.3800000000000001` never reaches storage — and so that what we
 * write always parses back through `readStoredWidths`.
 */
export function writeStoredWidths(w: StoredWidths): string {
  const safe = (v: unknown, fallback: number): number => {
    const n = isFractionLike(v) ? v : fallback;
    const rounded = Math.round(n * 10000) / 10000;
    // Rounding can only escape (0,1) at the extremes; keep it parseable.
    return Math.min(Math.max(rounded, 0.0001), 0.9999);
  };
  return JSON.stringify({
    dock: safe(w?.dock, DEFAULT_FRACTION_DOCK),
    drawer: safe(w?.drawer, DEFAULT_FRACTION_DRAWER),
  });
}

/**
 * Pointer travel → panel width delta.
 *
 * The panel is right-anchored, so in LTR dragging the handle LEFT makes it
 * WIDER: `startX - clientX`. RTL inverts. (We are not adding RTL layout
 * support — this is cheap insurance against the class of bug behind Firefox
 * 1312687, where a mirrored layout silently reverses a splitter.)
 */
export function dragDeltaPx(startX: number, clientX: number, dir: "ltr" | "rtl"): number {
  const a = num(startX, NaN);
  const b = num(clientX, NaN);
  // A non-finite coordinate means "we do not know where the pointer is". The
  // safe reading is that it has not moved — never a jump to one edge.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return dir === "rtl" ? b - a : a - b;
}

/**
 * Keyboard resize, per the APG separator contract.
 *
 * Directions match the pointer: the panel is right-anchored, so ArrowLeft
 * moves the separator left and therefore WIDENS the panel. `Home`/`End` map to
 * `aria-valuemin`/`aria-valuemax`, which are the PANEL's bounds — so `Home` is
 * the narrowest panel, `End` the widest.
 *
 * Returns `null` for any key we do not handle, including `Enter`: APG's
 * collapse/restore toggle needs the caller's "last user width" memory, so it
 * cannot be expressed as a pure function of the current value.
 */
export function keyStepFraction(
  key: string,
  shiftKey: boolean,
  current: number,
  geometry: WorkspaceGeometry = "dock",
): number | null {
  const base = clampFraction(current, geometry);
  const step = shiftKey ? 0.01 : 0.05;
  const { min, max } = fractionBounds(geometry);
  switch (key) {
    case "ArrowLeft":
      return clampFraction(base + step, geometry);
    case "ArrowRight":
      return clampFraction(base - step, geometry);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/**
 * Two `pointerdown`s close enough in time and space to mean "reset".
 *
 * Strict `<` on both bounds, so `DOUBLE_TAP_MS` and `DOUBLE_TAP_PX` are the
 * first values that are NOT a double tap. A negative interval (a stale or
 * replayed sample) is never a double tap.
 */
export function isDoubleTap(
  prev: { t: number; x: number } | null,
  next: { t: number; x: number },
): boolean {
  if (!prev || !next) return false;
  const dt = num(next.t, NaN) - num(prev.t, NaN);
  const dx = num(next.x, NaN) - num(prev.x, NaN);
  if (!Number.isFinite(dt) || !Number.isFinite(dx)) return false;
  return dt >= 0 && dt < DOUBLE_TAP_MS && Math.abs(dx) < DOUBLE_TAP_PX;
}
