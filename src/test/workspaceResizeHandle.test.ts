import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import WorkspaceResizeHandle from "@/components/WorkspaceResizeHandle";
import { DRAG_SHIELD_ATTR, DRAG_SHIELD_STYLE_ATTR, hideDragShield } from "@/lib/dragShield";
import {
  DEFAULT_FRACTION_DOCK,
  DEFAULT_FRACTION_DRAWER,
  resolvePanelPx,
  type WorkspaceGeometry,
} from "@/lib/workspaceLayout";

/**
 * WorkspaceResizeHandle.
 *
 * The plan specified this file as a source scan. It is mostly not one: a test
 * that greps for the string `setPointerCapture` passes just as happily when the
 * drag is broken, and the two properties that actually matter here — "the panel
 * follows the pointer by the right amount in the right direction" and "the
 * shield never outlives its gesture" — are both observable in jsdom once the
 * handful of missing globals are installed. So the DOM is asserted wherever it
 * can be, and source scanning is kept for the three invariants that genuinely
 * have no runtime signature (no `.focus(`, no `useState`, no `pointerleave`).
 *
 * jsdom 20 supplies neither `PointerEvent` nor `setPointerCapture`, and
 * `src/test/setup.ts` is frozen, so both are installed per-test below and
 * removed afterwards. `requestAnimationFrame` is replaced with a queue we drive
 * by hand — the drag is deliberately rAF-coalesced, and a test that could not
 * control the frame boundary could not tell coalescing from a dropped write.
 *
 * Rendering goes through `react-dom/client` + `React.act` directly rather than
 * `@testing-library/react`: RTL v16 is present but its required peer
 * `@testing-library/dom` is not installed, and this ship adds no dependencies.
 * The harness below is the ~20 lines of RTL we actually need.
 */

// ── environment ───────────────────────────────────────────────────────────

interface PointerInit extends MouseEventInit {
  pointerId?: number;
  pointerType?: string;
}

/** jsdom 20 has no PointerEvent. React only reads these fields off it. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerId = init.pointerId ?? 7;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

type Mutable = Record<string, unknown>;

let rafSeq = 0;
let rafQueue = new Map<number, FrameRequestCallback>();
/** Pointer ids passed to setPointerCapture, in call order. */
let captured: number[] = [];
/** Was the shield already mounted at the moment capture was requested? */
let captureSawShield: boolean[] = [];

const originals = {
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
  innerWidth: window.innerWidth,
};

const shieldMounted = () => !!document.querySelector(`[${DRAG_SHIELD_ATTR}]`);
const flushRaf = () => {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  pending.forEach((cb) => cb(0));
};

/** React 18.3 ships `React.act`; without this flag it warns on every call. */
const act = React.act as (cb: () => void) => void;
/** Every root opened in a test, so `afterEach` can always close them. */
let openRoots: Array<{ root: Root; host: HTMLElement }> = [];

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  rafSeq = 0;
  rafQueue = new Map();
  captured = [];
  captureSawShield = [];
  openRoots = [];
  (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT = true;

  (globalThis as unknown as Mutable).PointerEvent = TestPointerEvent;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.set(rafSeq, cb);
    return rafSeq;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  (Element.prototype as unknown as Mutable).setPointerCapture = function (this: Element, id: number) {
    captured.push(id);
    // Order proof: the shield must already exist. If capture were requested
    // first and then something threw, the drag would be live over an iframe
    // with no shield — the exact unrecoverable state this design avoids.
    captureSawShield.push(shieldMounted());
  };
  (Element.prototype as unknown as Mutable).releasePointerCapture = function () {};
});

afterEach(() => {
  for (const { root } of openRoots.splice(0)) {
    try {
      act(() => root.unmount());
    } catch {
      /* the test may already have unmounted it */
    }
  }
  hideDragShield();
  delete (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT;
  globalThis.requestAnimationFrame = originals.raf;
  globalThis.cancelAnimationFrame = originals.caf;
  delete (globalThis as unknown as Mutable).PointerEvent;
  delete (Element.prototype as unknown as Mutable).setPointerCapture;
  delete (Element.prototype as unknown as Mutable).releasePointerCapture;
  Object.defineProperty(window, "innerWidth", {
    value: originals.innerWidth,
    configurable: true,
    writable: true,
  });
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

// ── harness ───────────────────────────────────────────────────────────────

interface MountOpts {
  geometry?: WorkspaceGeometry;
  fraction?: number;
  containerPx?: number;
  disabled?: boolean;
  /** Swap in a target whose style writes throw, to test degradation. */
  hostileTarget?: boolean;
}

function mount(opts: MountOpts = {}) {
  const geometry = opts.geometry ?? "dock";
  const containerPx = opts.containerPx ?? 1440;
  const fraction =
    opts.fraction ?? (geometry === "dock" ? DEFAULT_FRACTION_DOCK : DEFAULT_FRACTION_DRAWER);

  const target = document.createElement("div");
  if (opts.hostileTarget) {
    Object.defineProperty(target, "style", {
      configurable: true,
      get() {
        return {
          setProperty() {
            throw new Error("target is detached");
          },
        };
      },
    });
  }
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: containerPx, configurable: true });
  document.body.append(container, target);

  // The drawer's budget IS the viewport; keeping them equal both models
  // reality and keeps the component's DEV mismatch warning quiet.
  Object.defineProperty(window, "innerWidth", {
    value: containerPx,
    configurable: true,
    writable: true,
  });

  const onCommit = vi.fn<(f: number) => void>();
  const props = {
    targetRef: { current: target },
    containerRef: { current: container },
    fraction,
    onCommit,
    controlsId: "cc-ws-panel",
    geometry,
    disabled: opts.disabled,
  };

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  openRoots.push({ root, host });
  act(() => root.render(React.createElement(WorkspaceResizeHandle, props)));

  let live = true;

  return {
    onCommit,
    target,
    container,
    containerPx,
    geometry,
    /** Scoped to this root's host, so parallel mounts cannot cross-talk. */
    query(): HTMLElement | null {
      return host.querySelector<HTMLElement>('[role="separator"]');
    },
    get handle(): HTMLElement {
      const el = host.querySelector<HTMLElement>('[role="separator"]');
      if (!el) throw new Error("handle is not rendered");
      return el;
    },
    /** The painted width, in px, read back off `--cc-ws-w`. */
    width(): number {
      return parseFloat(target.style.getPropertyValue("--cc-ws-w"));
    },
    painted(): boolean {
      return target.style.getPropertyValue("--cc-ws-w") !== "";
    },
    setProps(patch: Partial<typeof props>) {
      act(() => root.render(React.createElement(WorkspaceResizeHandle, { ...props, ...patch })));
    },
    unmount() {
      if (!live) return;
      live = false;
      act(() => root.unmount());
      host.remove();
    },
  };
}

const down = (el: Element, clientX: number, init: PointerInit = {}) =>
  el.dispatchEvent(new TestPointerEvent("pointerdown", { clientX, button: 0, buttons: 1, ...init }));
const move = (clientX: number, init: PointerInit = {}) =>
  window.dispatchEvent(new TestPointerEvent("pointermove", { clientX, buttons: 1, ...init }));
const up = (clientX: number) =>
  window.dispatchEvent(new TestPointerEvent("pointerup", { clientX, buttons: 0 }));
const key = (el: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

/** Run a complete drag and return the harness. */
function drag(h: ReturnType<typeof mount>, fromX: number, toX: number) {
  down(h.handle, fromX);
  move(toX);
  flushRaf();
  up(toX);
}

// ── the drag path ─────────────────────────────────────────────────────────

describe("WorkspaceResizeHandle — the drag paints pixels, not React state", () => {
  it("writes nothing until the frame boundary, then writes --cc-ws-w on the target", () => {
    const h = mount();

    down(h.handle, 1000);
    expect(h.painted()).toBe(false);

    move(1000);
    // Still nothing: the move stores, the rAF writes.
    expect(h.painted()).toBe(false);

    flushRaf();
    expect(h.width()).toBe(547); // 0.38 x 1440, clamped and rounded
  });

  it("dragging LEFT widens the panel by exactly the pointer travel", () => {
    // The panel is right-anchored, so LTR delta is `startX - clientX` and a
    // positive delta means WIDER. Getting this backwards is the single most
    // likely silent defect in a splitter, and it looks fine in a screenshot.
    const h = mount();

    down(h.handle, 1000);
    move(1000);
    flushRaf();
    const before = h.width();

    move(900); // 100 px to the left
    flushRaf();
    expect(h.width()).toBe(before + 100);
  });

  it("dragging RIGHT narrows the panel by exactly the pointer travel", () => {
    const h = mount();

    down(h.handle, 1000);
    move(1000);
    flushRaf();
    const before = h.width();

    move(1080);
    flushRaf();
    expect(h.width()).toBe(before - 80);
  });

  it("coalesces a burst of moves into a single frame", () => {
    // ArtifactFrame rebuilds a document string up to 400 KB per render and
    // react-markdown memoises nothing, so one DOM write per frame is a
    // correctness requirement, not a micro-optimisation.
    const h = mount();
    down(h.handle, 1000);

    for (const x of [990, 980, 970, 960, 950]) move(x);
    expect(rafQueue.size).toBe(1);

    flushRaf();
    expect(h.width()).toBe(597); // 547 + 50, i.e. only the LAST move survived
  });

  it("never commits during a move, and commits exactly once on release", () => {
    const h = mount();

    down(h.handle, 1000);
    move(980);
    move(960);
    move(940);
    flushRaf();
    expect(h.onCommit).not.toHaveBeenCalled();

    up(940);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit a drag that never moved", () => {
    const h = mount();
    drag(h, 1000, 1000);
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it("ignores secondary mouse buttons", () => {
    const h = mount();
    down(h.handle, 1000, { button: 2 });
    expect(shieldMounted()).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

// ── the shield ────────────────────────────────────────────────────────────

describe("WorkspaceResizeHandle — the shield, which is what makes the drag survive", () => {
  it("mounts the shield on pointerdown, BEFORE requesting pointer capture", () => {
    // `setPointerCapture` alone delivers only `pointerdown` over an
    // opaque-origin sandboxed iframe (measured, Chromium 148) — the drag then
    // sticks forever. The shield is the fix, so it must be up first.
    const h = mount();
    down(h.handle, 1000);

    expect(shieldMounted()).toBe(true);
    expect(document.querySelectorAll(`[${DRAG_SHIELD_STYLE_ATTR}]`)).toHaveLength(1);
    expect(captured).toEqual([7]);
    expect(captureSawShield).toEqual([true]);
  });

  it("tears the shield down on a normal release", () => {
    const h = mount();
    drag(h, 1000, 900);
    expect(shieldMounted()).toBe(false);
    expect(document.querySelectorAll(`[${DRAG_SHIELD_STYLE_ATTR}]`)).toHaveLength(0);
  });

  // A shield that outlives its gesture is an invisible click-blocker over the
  // whole application, with no console error to explain it. That is strictly
  // worse than a broken drag, so every exit is enumerated.
  const exits: Array<[string, () => void]> = [
    ["pointercancel", () => window.dispatchEvent(new TestPointerEvent("pointercancel", { clientX: 900 }))],
    ["window blur", () => window.dispatchEvent(new Event("blur"))],
    ["the buttons===0 watchdog on pointermove", () => move(900, { buttons: 0 })],
    ["Escape", () => key(window, "Escape")],
    [
      "visibilitychange while hidden",
      () => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "hidden", { value: false, configurable: true });
      },
    ],
  ];

  it.each(exits)("removes the shield on %s", (_label, fire) => {
    const h = mount();
    down(h.handle, 1000);
    expect(shieldMounted()).toBe(true);

    fire();

    expect(shieldMounted()).toBe(false);
    expect(document.querySelectorAll(`[${DRAG_SHIELD_STYLE_ATTR}]`)).toHaveLength(0);
  });

  it("removes the shield when the handle unmounts mid-drag", () => {
    const h = mount();
    down(h.handle, 1000);
    expect(shieldMounted()).toBe(true);

    h.unmount();
    expect(shieldMounted()).toBe(false);
  });

  it("removes the shield when geometry flips to full mid-drag", () => {
    // Rotating into `full` disables the handle while the finger is still down;
    // no pointer event ever arrives to end the gesture.
    const h = mount();
    down(h.handle, 1000);
    expect(shieldMounted()).toBe(true);

    h.setProps({ disabled: true });
    expect(shieldMounted()).toBe(false);
  });

  it("survives a target whose style writes throw, without stranding the shield", () => {
    const h = mount({ hostileTarget: true });

    expect(() => {
      down(h.handle, 1000);
      move(900);
      flushRaf();
      up(900);
    }).not.toThrow();

    expect(shieldMounted()).toBe(false);
    // The gesture bookkeeping is independent of the DOM write, so the commit
    // still lands — a detached target must not lose the user's drag.
    expect(h.onCommit).toHaveBeenCalledTimes(1);
  });

  it("leaves no shield when a double-tap lands while a drag is still in flight", () => {
    const h = mount();
    down(h.handle, 1000); // no matching pointerup
    down(h.handle, 1000); // reset path

    expect(shieldMounted()).toBe(false);
    expect(h.onCommit).toHaveBeenLastCalledWith(DEFAULT_FRACTION_DOCK);
  });

  it("does not stack shields across repeated gestures", () => {
    const h = mount();
    // Start each gesture well clear of the last, or the second press is a
    // double-tap (same spot, inside DOUBLE_TAP_MS) and takes the reset path.
    for (const startX of [1000, 900, 800]) {
      down(h.handle, startX);
      expect(document.querySelectorAll(`[${DRAG_SHIELD_ATTR}]`)).toHaveLength(1);
      move(startX - 50);
      flushRaf();
      up(startX - 50);
    }
    expect(shieldMounted()).toBe(false);
  });
});

// ── geometry: the landscape phone ─────────────────────────────────────────

describe("WorkspaceResizeHandle — geometry decides how far the drawer opens", () => {
  // 852x393 is an iPhone 16 in landscape: the viewport in the user's report.
  const PHONE = 852;

  it("lets the drawer open much wider than a dock would on the same viewport", () => {
    const dock = mount({ geometry: "dock", containerPx: PHONE });
    down(dock.handle, 800);
    move(-400); // far past any ceiling
    flushRaf();
    // dock must leave CHAT_MIN_PX (400) for the chat column.
    expect(dock.width()).toBe(452);
    up(-400);
    dock.unmount();

    const drawer = mount({ geometry: "drawer", containerPx: PHONE });
    down(drawer.handle, 800);
    move(-400);
    flushRaf();
    // drawer is an overlay: only DRAWER_PEEK_PX (56) is reserved.
    expect(drawer.width()).toBe(796);
  });

  it("reports the panel's real bounds through ARIA, per geometry", () => {
    const dock = mount({ geometry: "dock" });
    expect(dock.handle.getAttribute("aria-valuemin")).toBe("15");
    expect(dock.handle.getAttribute("aria-valuemax")).toBe("85");
    expect(dock.handle.getAttribute("aria-valuenow")).toBe("38");
    dock.unmount();

    const drawer = mount({ geometry: "drawer" });
    expect(drawer.handle.getAttribute("aria-valuemin")).toBe("30");
    expect(drawer.handle.getAttribute("aria-valuemax")).toBe("96");
    // A dock-only clamp would pin this at 85 while the drawer sat at 86.
    expect(drawer.handle.getAttribute("aria-valuenow")).toBe("86");
  });

  it("lets the drawer's arrow keys pass the dock's 0.85 ceiling", () => {
    const h = mount({ geometry: "drawer", containerPx: PHONE });
    key(h.handle, "ArrowLeft");

    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onCommit.mock.calls[0][0]).toBeGreaterThan(0.85);
  });

  it("keeps the handle live in drawer geometry", () => {
    // The whole point of amendment A1: `drawer` IS the landscape phone, and a
    // splitter that went dead there would answer half the user's request.
    const h = mount({ geometry: "drawer", containerPx: PHONE });
    expect(h.query()).not.toBeNull();

    down(h.handle, 700);
    move(600);
    flushRaf();
    up(600);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
  });

  it("tags itself with its geometry, which is what gates the safe-area hit area", () => {
    const h = mount({ geometry: "drawer" });
    expect(h.handle.getAttribute("data-cc-geometry")).toBe("drawer");
  });
});

// ── the fixpoint: paint and commit must agree ─────────────────────────────

describe("WorkspaceResizeHandle — the committed width is the painted width", () => {
  // Two different bounds are in play: a fraction bound applied at commit and a
  // pixel bound applied at paint. Compose them in the wrong order and the panel
  // runs to one number under the finger and SNAPS BACK to another on release.
  // This is the regression guard for that, and it fails the moment `geometry`
  // stops being threaded through any one of the three kernel calls.
  const cases: Array<[WorkspaceGeometry, number, string]> = [
    ["dock", 1440, "drag to the wide extreme"],
    ["dock", 852, "drag to the wide extreme"],
    ["drawer", 852, "drag to the wide extreme"],
    ["drawer", 780, "drag to the wide extreme"],
  ];

  it.each(cases)("%s @ %ipx — %s", (geometry, containerPx) => {
    const h = mount({ geometry, containerPx });
    down(h.handle, 700);
    move(-2000);
    flushRaf();
    const painted = h.width();
    up(-2000);

    const committed = h.onCommit.mock.calls.at(-1)?.[0];
    expect(committed).toBeTypeOf("number");
    // Re-painting the committed fraction must land on the very same pixel.
    expect(resolvePanelPx(committed as number, containerPx, geometry)).toBe(painted);
  });

  it.each(cases)("%s @ %ipx — narrow extreme", (geometry, containerPx) => {
    const h = mount({ geometry, containerPx });
    down(h.handle, 700);
    move(2000);
    flushRaf();
    const painted = h.width();
    up(2000);

    const committed = h.onCommit.mock.calls.at(-1)?.[0];
    expect(resolvePanelPx(committed as number, containerPx, geometry)).toBe(painted);
  });

  it("keyboard commits are fixpoints too", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      const h = mount({ geometry: "drawer", containerPx: 852 });
      key(h.handle, k);
      const committed = h.onCommit.mock.calls.at(-1)?.[0] as number;
      expect(resolvePanelPx(committed, 852, "drawer")).toBe(h.width());
      h.unmount();
    }
  });
});

// ── keyboard (APG separator contract, D12) ────────────────────────────────

describe("WorkspaceResizeHandle — keyboard", () => {
  it("ArrowLeft widens and ArrowRight narrows", () => {
    const wide = mount();
    key(wide.handle, "ArrowLeft");
    expect(wide.onCommit.mock.calls[0][0]).toBeGreaterThan(DEFAULT_FRACTION_DOCK);
    wide.unmount();

    const narrow = mount();
    key(narrow.handle, "ArrowRight");
    expect(narrow.onCommit.mock.calls[0][0]).toBeLessThan(DEFAULT_FRACTION_DOCK);
  });

  it("Shift makes the step finer", () => {
    const coarse = mount();
    key(coarse.handle, "ArrowLeft");
    const coarseDelta = coarse.onCommit.mock.calls[0][0] - DEFAULT_FRACTION_DOCK;
    coarse.unmount();

    const fine = mount();
    key(fine.handle, "ArrowLeft", { shiftKey: true });
    const fineDelta = fine.onCommit.mock.calls[0][0] - DEFAULT_FRACTION_DOCK;

    expect(fineDelta).toBeGreaterThan(0);
    expect(fineDelta).toBeLessThan(coarseDelta);
  });

  it("Home gives the narrowest panel and End the widest", () => {
    const home = mount();
    key(home.handle, "Home");
    const atHome = home.width();
    home.unmount();

    const end = mount();
    key(end.handle, "End");
    expect(end.width()).toBeGreaterThan(atHome);
  });

  it("Enter collapses to the floor and a second Enter restores", () => {
    // APG's collapse/restore. Collapsed means MINIMUM WIDTH, never closed —
    // closing unmounts the artifact iframe, which is unrecoverable.
    const h = mount();
    key(h.handle, "Enter");
    const collapsed = h.onCommit.mock.calls[0][0] as number;
    expect(collapsed).toBeLessThan(DEFAULT_FRACTION_DOCK);

    h.setProps({ fraction: collapsed });
    key(h.handle, "Enter");
    const restored = h.onCommit.mock.calls[1][0] as number;
    expect(restored).toBeGreaterThan(collapsed);
  });

  it("ignores keys it does not handle", () => {
    const h = mount();
    const evt = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    h.handle.dispatchEvent(evt);

    expect(h.onCommit).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  it("does nothing at all when disabled", () => {
    const h = mount({ geometry: "drawer" });
    h.setProps({ disabled: true });
    expect(h.query()).toBeNull();
  });
});

// ── double-tap reset ──────────────────────────────────────────────────────

describe("WorkspaceResizeHandle — double-tap resets the current geometry", () => {
  it("resets the dock to its own default", () => {
    const h = mount({ geometry: "dock", fraction: 0.7 });
    down(h.handle, 1000);
    up(1000);
    down(h.handle, 1000);

    expect(h.onCommit).toHaveBeenLastCalledWith(DEFAULT_FRACTION_DOCK);
  });

  it("resets the drawer to ITS default, not the dock's", () => {
    const h = mount({ geometry: "drawer", containerPx: 852, fraction: 0.4 });
    down(h.handle, 700);
    up(700);
    down(h.handle, 700);

    expect(h.onCommit).toHaveBeenLastCalledWith(DEFAULT_FRACTION_DRAWER);
  });

  it("does not fire for two taps far apart in space", () => {
    const h = mount();
    down(h.handle, 1000);
    up(1000);
    down(h.handle, 1040); // > DOUBLE_TAP_PX

    expect(h.onCommit).not.toHaveBeenCalled();
  });
});

// ── ARIA / a11y (D12) ─────────────────────────────────────────────────────

describe("WorkspaceResizeHandle — the APG separator contract", () => {
  it("is a focusable, explicitly vertical separator wired to its panel", () => {
    const h = mount();
    const el = h.handle;

    // `separator` is a widget role ONLY when focusable.
    expect(el.getAttribute("tabindex")).toBe("0");
    // Its implicit orientation is HORIZONTAL; a side-panel divider is vertical
    // and must say so, describing its own axis rather than the split axis.
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-controls")).toBe("cc-ws-panel");
    expect(el.getAttribute("aria-label")).toBeTruthy();
  });

  it("keeps aria-valuenow in step with the pointer during the drag", () => {
    const h = mount();
    expect(h.handle.getAttribute("aria-valuenow")).toBe("38");

    down(h.handle, 1000);
    move(700); // +300 px -> 847/1440 ~= 59 %
    flushRaf();

    expect(h.handle.getAttribute("aria-valuenow")).toBe("59");
  });

  it("renders nothing when disabled", () => {
    // `disabled` is true only in `full` geometry, where there is nothing left
    // to resize. It stays LIVE in `drawer` — see the geometry suite above.
    const h = mount({ disabled: true });
    expect(h.query()).toBeNull();
  });
});

// ── source invariants (only what the DOM cannot show) ─────────────────────

describe("WorkspaceResizeHandle — source invariants", () => {
  const raw = readFileSync(resolve(process.cwd(), "src/components/WorkspaceResizeHandle.tsx"), "utf8");
  const css = readFileSync(resolve(process.cwd(), "src/styles/workspace-resize.css"), "utf8");

  /**
   * These invariants are about CODE, not prose. The file documents at length
   * why it avoids `useState` and why `pointerleave` is not an exit, so a naive
   * substring scan fails on the very comments that explain the rule.
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("strips comments before scanning, so the scans mean something", () => {
    // Guard for the guards: if this stops removing the header block, the three
    // tests below start passing vacuously... or failing spuriously.
    expect(raw).toContain("pointerleave");
    expect(src).not.toContain("Firefox");
    expect(src).toContain("setPointerCapture");
  });

  it("never programmatically focuses anything (Android soft-keyboard rule)", () => {
    // focusPolicy.ts exists because Android Chrome opens the soft keyboard on
    // ANY programmatic focus() once a gesture has happened in the session.
    expect(src).not.toContain(".focus(");
    expect(src).not.toContain("focusComposer");
  });

  it("holds no React state, so a move can never trigger a re-render", () => {
    // The runtime proof is the "never commits during a move" test; this is the
    // structural one. A `useState` here would re-render the panel — and with it
    // ArtifactFrame's 400 KB document rebuild — on every pointer event.
    expect(src).not.toContain("useState");
  });

  it("never treats pointerleave as an exit", () => {
    // Firefox fires it spuriously during a capture, aborting live drags
    // (react-resizable-panels#514).
    expect(src).not.toContain("pointerleave");
  });

  it("styles the handle without creating a containing block", () => {
    // A `transform`/`filter`/`contain` anywhere on this subtree would silently
    // turn the fullscreen overlay into a parent-filling box, with no error.
    expect(css).not.toMatch(/^\s*(transform|filter|backdrop-filter|perspective|contain)\s*:/m);
  });

  it("suppresses browser scroll claiming on the handle", () => {
    // Per spec, viewport manipulation "cannot be suppressed by canceling a
    // pointer event" — only touch-action stops it. Without this the handle is
    // undraggable by thumb, killing the landscape-phone half of the feature.
    expect(css).toContain("touch-action: none");
  });

  it("sizes the hit area up on coarse pointers", () => {
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("--cc-ws-hit: 24px");
  });

  it("extends the hit area past a landscape display cutout, in drawer only", () => {
    // At full extension the drawer's handle sits 56 px from the viewport edge,
    // inside a ~59 px `safe-area-inset-left` on a notched phone in landscape.
    expect(css).toContain('.cc-ws-resize-handle[data-cc-geometry="drawer"]::before');
    expect(css).toContain("env(safe-area-inset-left, 0px)");
    // The extension is worthless if it does not hit-test.
    expect(css).not.toMatch(/data-cc-geometry="drawer"\]::before\s*\{[^}]*pointer-events:\s*none/);
  });
});
