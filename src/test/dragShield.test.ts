import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_DRAG_CURSOR,
  DRAG_SHIELD_ATTR,
  DRAG_SHIELD_STYLE_ATTR,
  DRAG_SHIELD_Z,
  hideDragShield,
  isDragShieldMounted,
  normalizeCursor,
  showDragShield,
} from "@/lib/dragShield";

/**
 * The shield is the reason a drag survives crossing an artifact iframe:
 * `setPointerCapture` alone delivers only `pointerdown` over an opaque-origin
 * sandboxed frame (measured, Chromium 148), so the drag would stick forever.
 *
 * The counterpart risk is a shield that OUTLIVES its drag — an invisible
 * click-blocker over the whole app, with no console error to explain it. Most
 * of what follows is about that second failure.
 */

const shields = () => document.querySelectorAll(`[${DRAG_SHIELD_ATTR}]`);
const styles = () => document.querySelectorAll(`[${DRAG_SHIELD_STYLE_ATTR}]`);

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  hideDragShield();
});

describe("drag shield — mounting", () => {
  it("mounts exactly one shield and one style element, however often it is shown", () => {
    showDragShield("col-resize");
    showDragShield("col-resize");
    showDragShield("col-resize");

    expect(shields().length).toBe(1);
    expect(styles().length).toBe(1);
    expect(isDragShieldMounted()).toBe(true);
  });

  it("covers the whole viewport, above every toast, and never eats a scroll gesture", () => {
    showDragShield("col-resize");
    const el = shields()[0] as HTMLElement;

    expect(el.style.position).toBe("fixed");
    // jsdom serialises a zero length back as "0px".
    expect(el.style.top).toBe("0px");
    expect(el.style.right).toBe("0px");
    expect(el.style.bottom).toBe("0px");
    expect(el.style.left).toBe("0px");
    // Above sonner's 999999999 — a toast arriving mid-drag would otherwise
    // sit on top of the shield and swallow the pointer.
    expect(Number(el.style.zIndex)).toBe(DRAG_SHIELD_Z);
    expect(Number(el.style.zIndex)).toBeGreaterThan(999999999);
    expect(el.style.touchAction).toBe("none");
    expect(el.style.cursor).toBe("col-resize");
    // Transparent: the user must not see it appear.
    expect(el.style.background).toBe("transparent");
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("forces the drag cursor globally, hover rules included", () => {
    showDragShield("col-resize");
    const css = (styles()[0] as HTMLStyleElement).textContent ?? "";

    expect(css).toContain("!important");
    expect(css).toContain("col-resize");
    // Without `*:hover`, any hover rule in the app out-specifies a bare `*`
    // and the pointer cursor flickers back mid-drag.
    expect(css).toContain("*:hover");
  });

  it("retargets an existing shield instead of stacking a second one", () => {
    showDragShield("col-resize");
    showDragShield("row-resize");

    expect(shields().length).toBe(1);
    expect((shields()[0] as HTMLElement).style.cursor).toBe("row-resize");
    expect((styles()[0] as HTMLStyleElement).textContent).toContain("row-resize");
  });
});

describe("drag shield — the cursor is not an injection seam", () => {
  it("rejects anything that is not a bare CSS cursor keyword", () => {
    expect(normalizeCursor("col-resize")).toBe("col-resize");
    expect(normalizeCursor("grabbing")).toBe("grabbing");
    expect(normalizeCursor("")).toBe(DEFAULT_DRAG_CURSOR);
    expect(normalizeCursor("col-resize; }")).toBe(DEFAULT_DRAG_CURSOR);
    expect(normalizeCursor("url(https://evil.example/x.png)")).toBe(DEFAULT_DRAG_CURSOR);
    expect(normalizeCursor(undefined as unknown as string)).toBe(DEFAULT_DRAG_CURSOR);
    expect(normalizeCursor(123 as unknown as string)).toBe(DEFAULT_DRAG_CURSOR);
  });

  it("never lets a hostile cursor close the rule and append CSS", () => {
    showDragShield("col-resize } body { display: none } * {");
    const css = (styles()[0] as HTMLStyleElement).textContent ?? "";

    expect(css).not.toContain("display: none");
    expect(css).not.toContain("body {");
    expect(css).toContain(DEFAULT_DRAG_CURSOR);
  });
});

describe("drag shield — teardown can never be skipped", () => {
  it("removes both nodes and is safe to call repeatedly", () => {
    showDragShield("col-resize");
    hideDragShield();
    hideDragShield();
    hideDragShield();

    expect(shields().length).toBe(0);
    expect(styles().length).toBe(0);
    expect(isDragShieldMounted()).toBe(false);
  });

  it("does not throw when it was never shown", () => {
    expect(() => hideDragShield()).not.toThrow();
    expect(shields().length).toBe(0);
  });

  it("reaps a stray shield it did not create", () => {
    // The disaster case: a shield orphaned by a hot reload, a duplicated
    // module instance, or an exception between create and assign. Teardown
    // must be driven by the DOM, not by a module-held reference.
    const orphan = document.createElement("div");
    orphan.setAttribute(DRAG_SHIELD_ATTR, "");
    document.body.appendChild(orphan);
    const orphanStyle = document.createElement("style");
    orphanStyle.setAttribute(DRAG_SHIELD_STYLE_ATTR, "");
    document.head.appendChild(orphanStyle);

    hideDragShield();

    expect(shields().length).toBe(0);
    expect(styles().length).toBe(0);
  });

  it("re-shows cleanly after a teardown", () => {
    showDragShield("col-resize");
    hideDragShield();
    showDragShield("col-resize");

    expect(shields().length).toBe(1);
    expect(styles().length).toBe(1);
  });
});

describe("drag shield — its own escape hatches", () => {
  // These duplicate what WorkspaceResizeHandle does on purpose. If the
  // component's teardown path is ever broken, the shield still dies at the
  // end of the gesture rather than blocking every click in the app.

  it("removes itself on pointerup", () => {
    showDragShield("col-resize");
    window.dispatchEvent(new Event("pointerup"));
    expect(isDragShieldMounted()).toBe(false);
  });

  it("removes itself on pointercancel", () => {
    showDragShield("col-resize");
    window.dispatchEvent(new Event("pointercancel"));
    expect(isDragShieldMounted()).toBe(false);
  });

  it("removes itself when the window loses focus", () => {
    showDragShield("col-resize");
    window.dispatchEvent(new Event("blur"));
    expect(isDragShieldMounted()).toBe(false);
  });

  it("removes itself when the tab is hidden, and stays put when it is not", () => {
    const hidden = { value: false, configurable: true };
    Object.defineProperty(document, "hidden", hidden);

    showDragShield("col-resize");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isDragShieldMounted()).toBe(true);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isDragShieldMounted()).toBe(false);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("unbinds its hatches on hide, so a later pointerup costs nothing", () => {
    showDragShield("col-resize");
    hideDragShield();

    // Re-show, then fire an event that should belong to the NEW session only.
    showDragShield("col-resize");
    expect(isDragShieldMounted()).toBe(true);

    hideDragShield();
    expect(() => window.dispatchEvent(new Event("pointerup"))).not.toThrow();
    expect(isDragShieldMounted()).toBe(false);
  });
});

describe("drag shield — source invariants", () => {
  const src = readFileSync(resolve(process.cwd(), "src/lib/dragShield.ts"), "utf8");

  it("never programmatically focuses anything (Android soft-keyboard rule)", () => {
    expect(src).not.toContain(".focus(");
  });

  it("reaps by selector, not by a stored reference", () => {
    // A `let shieldEl` that hideDragShield trusted would strand orphans.
    expect(src).toContain("querySelectorAll");
  });
});
