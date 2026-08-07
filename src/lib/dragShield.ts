/**
 * Drag shield — the transparent, full-viewport overlay that keeps a pointer
 * drag alive while the pointer travels over an artifact iframe.
 *
 * WHY THIS IS LOAD-BEARING, NOT DEFENSIVE POLISH.
 *
 * `setPointerCapture` ALONE DOES NOT WORK over our artifact frames. Measured
 * twice in Chromium 148 against exactly the `ArtifactFrame` configuration
 * (`sandbox="allow-scripts"` WITHOUT `allow-same-origin`, i.e. an opaque
 * origin): only `pointerdown` was ever delivered — no `pointermove`, no
 * `pointerup`, and no `lostpointercapture` — leaving the drag permanently
 * stuck with the panel frozen mid-resize. The control case, a same-origin
 * non-sandboxed frame, delivered everything. Cause: since Chromium 127
 * opaque-origin sandboxed frames run in a SEPARATE RENDERER PROCESS, and
 * pointer routing does not cross that boundary the way capture assumes.
 *
 * Adding this shield restored `pointerup` and `lostpointercapture`. So the
 * shield is mounted on `pointerdown`, before anything else can go wrong, and
 * the drag reads its events off the shield (which lives in OUR document)
 * rather than off a frame we cannot reach.
 *
 * THE FAILURE MODE THIS MODULE MUST NEVER HAVE.
 *
 * A stuck shield is an invisible click-blocker over the entire application —
 * every button dead, no console error, nothing visible to explain it. That is
 * strictly worse than a broken drag. So `hideDragShield()` is:
 *
 *   - idempotent (safe to call any number of times, including never-shown),
 *   - DOM-driven, not state-driven: it reaps every node carrying the marker
 *     attributes, so a shield orphaned by a hot reload, a duplicated module
 *     instance or a swallowed exception still dies,
 *   - non-throwing, so it can be called from a `finally` that must not be
 *     derailed by a second failure.
 *
 * On top of that, `showDragShield()` arms its own escape hatches
 * (`pointerup` / `pointercancel` / window `blur` / `visibilitychange`). The
 * component that owns the drag tears the shield down too — this is deliberate
 * duplication. If the component's teardown path is ever broken, the shield
 * still removes itself at the end of the gesture.
 *
 * The global `*{cursor:… !important}` rule is legal under the app's production
 * CSP (`style-src 'self' 'unsafe-inline'`, `vite.config.ts`), and CSSOM
 * insertion is not CSP-gated at all. The cursor keyword is nevertheless
 * validated before it reaches a stylesheet — see `normalizeCursor`.
 */

/** Marker on the shield element. Also the reaping selector for teardown. */
export const DRAG_SHIELD_ATTR = "data-cc-drag-shield";
/** Marker on the injected global-cursor <style>. */
export const DRAG_SHIELD_STYLE_ATTR = "data-cc-drag-cursor";

/**
 * Above `sonner`'s 999999999 (`node_modules/sonner/dist/styles.css`): a toast
 * appearing mid-drag would otherwise sit on top of the shield and swallow the
 * pointer, which is the exact failure the shield exists to prevent. It is
 * transparent and lives only for the duration of one gesture.
 */
export const DRAG_SHIELD_Z = 2147483000;

export const DEFAULT_DRAG_CURSOR = "col-resize";

/** CSS `cursor` keywords are `ident`s. Anything else is not a cursor. */
const CURSOR_RE = /^[a-z][a-z-]{0,31}$/;

/**
 * The cursor keyword is interpolated into a stylesheet, so it is validated
 * rather than trusted. A value carrying `}` or `;` could otherwise close the
 * rule and append arbitrary CSS — a real injection seam even though today's
 * only caller passes a literal.
 */
export function normalizeCursor(cursor: string): string {
  return typeof cursor === "string" && CURSOR_RE.test(cursor) ? cursor : DEFAULT_DRAG_CURSOR;
}

/** Detaches the shield's own escape hatches. `null` when none are armed. */
let disarm: (() => void) | null = null;

const hasDom = (): boolean => typeof document !== "undefined" && !!document.body;

function ensureShield(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${DRAG_SHIELD_ATTR}]`);
  if (existing) return existing;

  const el = document.createElement("div");
  el.setAttribute(DRAG_SHIELD_ATTR, "");
  el.setAttribute("aria-hidden", "true");
  const s = el.style;
  s.position = "fixed";
  s.top = "0";
  s.right = "0";
  s.bottom = "0";
  s.left = "0";
  s.zIndex = String(DRAG_SHIELD_Z);
  s.background = "transparent";
  // Without this the browser may claim the gesture for scrolling; the spec is
  // explicit that viewport manipulation "cannot be suppressed by canceling a
  // pointer event", so only touch-action can stop it.
  s.touchAction = "none";
  s.userSelect = "none";
  (s as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "none";
  s.pointerEvents = "auto";
  document.body.appendChild(el);
  return el;
}

function ensureStyle(): HTMLStyleElement {
  const existing = document.querySelector<HTMLStyleElement>(`[${DRAG_SHIELD_STYLE_ATTR}]`);
  if (existing) return existing;

  const el = document.createElement("style");
  el.setAttribute(DRAG_SHIELD_STYLE_ATTR, "");
  (document.head ?? document.body).appendChild(el);
  return el;
}

function armEscapeHatches(): void {
  if (disarm) return;
  if (typeof window === "undefined") return;

  const onEnd = () => hideDragShield();
  const onVisibility = () => {
    if (document.hidden) hideDragShield();
  };

  // Bubble phase on purpose: the drag owner listens in the CAPTURE phase at
  // the same target, so it always runs first and gets to commit the width
  // before the shield disappears from under it.
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  window.addEventListener("blur", onEnd);
  document.addEventListener("visibilitychange", onVisibility);

  disarm = () => {
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    window.removeEventListener("blur", onEnd);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Mount the shield (or retarget an existing one to a new cursor). Idempotent:
 * calling it twice leaves exactly one shield element and one <style> element.
 */
export function showDragShield(cursor: string): void {
  if (!hasDom()) return;
  const c = normalizeCursor(cursor);
  try {
    ensureShield().style.cursor = c;
    // `*:hover` is included because a hover rule elsewhere in the app would
    // otherwise out-specify a bare `*` and restore the pointer cursor while
    // the drag is in flight.
    ensureStyle().textContent = `*, *::before, *::after, *:hover { cursor: ${c} !important; }`;
    armEscapeHatches();
  } catch {
    // Anything at all went wrong while mounting: do not leave half a shield.
    hideDragShield();
  }
}

/**
 * Remove the shield and the global cursor rule. Idempotent, unconditional,
 * and non-throwing — this is the function that must never be skippable.
 *
 * It reaps by SELECTOR rather than by a module-held reference, so a shield
 * left behind by a previous module instance (hot reload, duplicated bundle)
 * or by an exception between create and assign is still removed.
 */
export function hideDragShield(): void {
  try {
    disarm?.();
  } catch {
    /* a listener store that cannot be unwound must not block the removal */
  }
  disarm = null;

  if (typeof document === "undefined") return;
  try {
    const stale = document.querySelectorAll(`[${DRAG_SHIELD_ATTR}], [${DRAG_SHIELD_STYLE_ATTR}]`);
    for (let i = stale.length - 1; i >= 0; i -= 1) stale[i].remove();
  } catch {
    /* nothing left to do — never throw out of a teardown path */
  }
}

/** Test/debug probe: is a shield currently mounted in this document? */
export function isDragShieldMounted(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(`[${DRAG_SHIELD_ATTR}]`);
}
