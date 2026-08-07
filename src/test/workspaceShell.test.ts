import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import WorkspaceShell from "@/components/WorkspaceShell";
import { WORKSPACE_WIDTH_KEY } from "@/lib/workspaceLayout";
import { workspaceStore } from "@/lib/workspaceStore";

/**
 * WS-C — the workspace shell.
 *
 * ONE thing here matters more than everything else combined: the artifact
 * iframe's document is destroyed by any change of DOM position, and the app has
 * no way to notice. `public/artifact-frame.html` latches `written = true` and
 * ignores a second document, so a remount is unrecoverable — the user's running
 * mini-app simply starts over, with no error anywhere. That is why the shell
 * exists at all, and why the centrepiece of this file is not a class-name check
 * but an IDENTITY check: the same DOM node objects, before and after a
 * rotation, a fullscreen round trip and a window resize, with a
 * MutationObserver watching for a removal that never comes.
 *
 * A source scan cannot prove that, so most of what follows renders the real
 * component. The source scans that remain are the ones with NO runtime
 * signature: you cannot observe "there is no second `<WorkspacePanel>` in a
 * branch this test never took", and you cannot observe a Tailwind class that
 * was purged out of a stylesheet the test environment never builds.
 *
 * Every absence scan runs on COMMENT-STRIPPED source. The shell's header
 * comment explains at length why `createPortal` and `appendChild` are
 * forbidden; a naive `not.toContain("createPortal")` fails on the very
 * paragraph documenting the rule, and a test that punishes you for writing
 * down the reason gets deleted.
 */

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SHELL_SRC = src("src/components/WorkspaceShell.tsx");
const SHELL_CODE = code(SHELL_SRC);
const OVERLAY_CSS = src("src/styles/workspace-overlay.css");

/**
 * The three geometry class strings, repeated here on purpose rather than
 * imported. Importing them would make this test agree with the source by
 * construction; typing them out means a typo in either place is a failure, and
 * it is a typo that Tailwind's scanner would answer by silently omitting
 * `position: fixed` from the stylesheet.
 */
const DOCK_CLASS = "flex h-full shrink-0 min-w-0";
const DRAWER_CLASS =
  "cc-workspace-overlay cc-workspace-drawer fixed inset-y-0 right-0 z-[100] flex min-w-0 overscroll-contain";
const FULL_CLASS = "cc-workspace-overlay fixed inset-0 z-[100] flex min-w-0 overscroll-contain";

// ── jsdom 20 harness ───────────────────────────────────────────────────────
// PointerEvent, ResizeObserver and visualViewport are all undefined here and
// matchMedia is stubbed to `matches: false` forever. Everything below is
// installed per-file so `src/test/setup.ts` stays frozen.

type RoEntry = { contentRect: { width: number } };
type RoCallback = (entries: RoEntry[], observer: unknown) => void;

let observed: Array<{ cb: RoCallback; el: Element }> = [];
let rafMap = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
let realRaf: typeof globalThis.requestAnimationFrame | undefined;
let realCancelRaf: typeof globalThis.cancelAnimationFrame | undefined;
let realInnerWidth: PropertyDescriptor | undefined;
let realInnerHeight: PropertyDescriptor | undefined;

class FakeResizeObserver {
  private cb: RoCallback;
  constructor(cb: RoCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    observed.push({ cb: this.cb, el });
  }
  unobserve(el: Element) {
    observed = observed.filter((o) => !(o.cb === this.cb && o.el === el));
  }
  disconnect() {
    observed = observed.filter((o) => o.cb !== this.cb);
  }
}

/** Report a width to the observers watching ONE element. Scoped, because
 *  `WorkspacePanel` runs its own ResizeObserver on its own root and a global
 *  broadcast would make "did the shell schedule a frame?" unanswerable. */
function fireResize(el: Element, width: number) {
  act(() => {
    for (const o of observed.filter((o) => o.el === el)) o.cb([{ contentRect: { width } }], null);
  });
}

const pendingFrames = () => rafMap.size;

/** Run whatever was deferred into a frame. Twice by default: a flushed frame
 *  can legitimately schedule the next one (useViewport re-samples, the panel's
 *  density observer settles). */
function flushFrames(times = 2) {
  for (let i = 0; i < times; i++) {
    act(() => {
      const queued = [...rafMap.values()];
      rafMap.clear();
      for (const cb of queued) cb(1);
    });
  }
}

function setWindowSize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

/** A rotation, as the app sees one: new dimensions, then a `resize`, then the
 *  frame `useViewport` coalesces into. */
function rotateTo(width: number, height: number) {
  setWindowSize(width, height);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  flushFrames();
}

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // workspaceStore.subscribe() kicks off a one-shot IndexedDB hydration that
  // REPLACES the item array when its promise settles, from outside React's
  // batching. Drain it once so no test races it.
  const off = workspaceStore.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 0));
  off();
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  observed = [];
  rafMap = new Map();
  rafSeq = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;

  realRaf = globalThis.requestAnimationFrame;
  realCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafMap.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafMap.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  realInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  realInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
  setWindowSize(1440, 900);

  localStorage.clear();
  document.documentElement.style.overflow = "";
  document.documentElement.classList.remove("cc-workspace-overlay-open");

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  if (realCancelRaf) globalThis.cancelAnimationFrame = realCancelRaf;
  if (realInnerWidth) Object.defineProperty(window, "innerWidth", realInnerWidth);
  if (realInnerHeight) Object.defineProperty(window, "innerHeight", realInnerHeight);
  document.documentElement.style.overflow = "";
  document.documentElement.classList.remove("cc-workspace-overlay-open");
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

interface MountOpts {
  open?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onClose?: () => void;
}

function mountShell(opts: MountOpts = {}) {
  act(() => {
    root.render(
      createElement(WorkspaceShell, {
        open: opts.open ?? true,
        userId: null,
        selectedId: opts.selectedId ?? null,
        onSelect: opts.onSelect ?? (() => {}),
        onClose: opts.onClose ?? (() => {}),
      }),
    );
  });
  flushFrames();
}

const shellEl = () => document.querySelector<HTMLElement>("[data-cc-workspace-shell]");
const scrimEl = () => document.querySelector<HTMLElement>("[data-cc-workspace-scrim]");
const handleEl = () => document.querySelector<HTMLElement>('[role="separator"]');
const panelBoxEl = () => {
  const id = handleEl()?.getAttribute("aria-controls");
  return id ? document.getElementById(id) : (host.querySelector<HTMLElement>('[role="region"]') ?? null);
};
/**
 * `WorkspacePanel`'s own root, i.e. the first node INSIDE the shell's wrapper.
 *
 * Tracked separately from the wrapper on purpose: a `key` on `<WorkspacePanel>`
 * would remount everything under it — the artifact iframe included — while
 * leaving the wrapper perfectly intact. Watching only the wrapper would call
 * that a pass.
 */
const panelRootEl = () => panelBoxEl()?.firstElementChild ?? null;
const wsw = () => shellEl()?.style.getPropertyValue("--cc-ws-w") ?? "";
const fsButton = () =>
  Array.from(host.querySelectorAll("button")).find((b) =>
    (b.getAttribute("aria-label") ?? "").toLowerCase().includes("full screen"),
  ) ?? null;

function pressEscape(from: Element) {
  act(() => {
    from.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — invariants with no runtime signature", () => {
  it("renders <WorkspacePanel> at exactly one JSX position", () => {
    expect((SHELL_CODE.match(/<WorkspacePanel/g) ?? []).length).toBe(1);
  });

  it("never reparents: no portal and no manual DOM insertion", () => {
    for (const forbidden of [
      "createPortal",
      "appendChild",
      "insertBefore",
      "moveBefore",
      "<Sheet",
      "SheetContent",
    ]) {
      expect(SHELL_CODE, `${forbidden} would destroy the artifact iframe`).not.toContain(forbidden);
    }
  });

  it("puts no `key` on or near the panel — a geometry-derived key is a remount", () => {
    const idx = SHELL_CODE.indexOf("<WorkspacePanel");
    expect(idx).toBeGreaterThan(-1);
    const end = SHELL_CODE.indexOf("/>", idx);
    expect(end).toBeGreaterThan(idx);
    const window_ = SHELL_CODE.slice(Math.max(0, idx - 200), end + 2);
    expect(window_).not.toContain("key=");
  });

  it("carries the three geometry class strings as complete literals", () => {
    // Tailwind's scanner is a regex over source text: a class name built by
    // concatenation is never emitted, and the overlay loses `position: fixed`
    // with no error anywhere.
    for (const literal of [DOCK_CLASS, DRAWER_CLASS, FULL_CLASS]) {
      expect(SHELL_SRC).toContain(literal);
    }
    expect(SHELL_SRC).toContain("fixed inset-0 z-[100]");
    expect(SHELL_SRC).toContain("fixed inset-y-0 right-0 z-[100]");
    expect(SHELL_SRC).toContain("shrink-0");
  });

  it("focuses only *ButtonRef and never imports focusComposer", () => {
    const calls = SHELL_CODE.match(/[\w.?]*\.focus\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/\w+ButtonRef\.current\??\.focus\($/);
    }
    expect(SHELL_CODE).not.toContain("focusComposer");
  });

  it("binds Escape on document in the capture phase", () => {
    // Capture on `document`, NOT `window`: the drag handle binds Escape at
    // window capture and stops it there while a drag is live, so an abandoned
    // drag must not also close the drawer. Window capture runs first.
    expect(SHELL_CODE).toMatch(/document\.addEventListener\(\s*"keydown",\s*\w+,\s*true\s*\)/);
    expect(SHELL_CODE).toMatch(/document\.removeEventListener\(\s*"keydown",\s*\w+,\s*true\s*\)/);
  });

  it("uses the new overlay-open class, not the media one", () => {
    expect(SHELL_CODE).toContain("cc-workspace-overlay-open");
    expect(SHELL_CODE).not.toContain("cc-media-overlay-open");
    expect(OVERLAY_CSS).toContain("html.cc-workspace-overlay-open");
  });

  it("defers its ResizeObserver work into a frame", () => {
    expect(SHELL_CODE).toContain("new ResizeObserver");
    expect(SHELL_CODE).toContain("requestAnimationFrame");
  });

  it("consumes --cc-ws-w as a width in dock and drawer, and lets the insets size `full`", () => {
    // This one is a source scan for an environment reason, not a lazy one.
    // jsdom's CSSOM SILENTLY DROPS `width: var(--cc-ws-w)` — `cssstyle`
    // validates `width` against a grammar that predates custom properties — so
    // the live declaration reads back as "" here and cannot be asserted on the
    // rendered node. Verified by probe: assigning `var(--cc-ws-w)` leaves
    // `style.width === ""` and no style attribute at all, while `auto` and the
    // custom property itself both round-trip. The BRANCH is still asserted
    // behaviourally below (`full` gets `auto`, the other two do not).
    expect(SHELL_CODE).toMatch(
      /WIDTH_FROM_VAR:\s*React\.CSSProperties\s*=\s*\{\s*width:\s*"var\(--cc-ws-w\)"\s*\}/,
    );
    expect(SHELL_CODE).toMatch(
      /WIDTH_FROM_INSETS:\s*React\.CSSProperties\s*=\s*\{\s*width:\s*"auto"\s*\}/,
    );
    expect(SHELL_CODE).toMatch(
      /style=\{geometry === "full" \? WIDTH_FROM_INSETS : WIDTH_FROM_VAR\}/,
    );
  });

  it("the comment stripper still sees real code (guard against vacuous scans)", () => {
    // Every absence assertion above is worthless if `code()` eats the file.
    expect(SHELL_CODE).toContain("const SHELL_CLASS");
    expect(SHELL_CODE).toContain("WorkspaceResizeHandle");
    expect(SHELL_CODE).toContain("resolvePanelPx");
    // …and it really does strip: these appear only in prose.
    expect(SHELL_SRC).toContain("createPortal");
    expect(SHELL_SRC).toContain("appendChild");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — geometry is a class swap", () => {
  it("dock: the literal dock classes, width from the variable", () => {
    mountShell();
    const el = shellEl();
    expect(el).not.toBeNull();
    expect(el!.className).toBe(DOCK_CLASS);
    // jsdom drops `width: var(…)` (see the source-scan test above), so what is
    // observable here is that this is NOT the insets branch, and that the
    // imperative seed really landed on this element.
    expect(el!.style.width).not.toBe("auto");
    expect(el!.getAttribute("style")).toContain("--cc-ws-w");
    expect(scrimEl()!.className).toBe("hidden");
  });

  it("drawer at 852x393 (iPhone 16 landscape): overlay classes, handle still live", () => {
    setWindowSize(852, 393);
    mountShell();
    expect(shellEl()!.className).toBe(DRAWER_CLASS);
    // WS-B escalation 2: `--cc-ws-w` must drive the drawer too, or the drag
    // paints a variable nobody consumes and the landscape half does nothing.
    expect(shellEl()!.style.width).not.toBe("auto");
    expect(shellEl()!.getAttribute("style")).toContain("--cc-ws-w");
    // Amendment A1: the drawer IS the landscape phone, and a splitter that goes
    // dead there answers half the request.
    expect(handleEl()).not.toBeNull();
    expect(scrimEl()!.className).toContain("z-[99]");
  });

  it("full at 393x852 (portrait): fills the viewport, no handle, no scrim", () => {
    setWindowSize(393, 852);
    mountShell();
    expect(shellEl()!.className).toBe(FULL_CLASS);
    // `inset-0` resolves the width; a `width` would fight it.
    expect(shellEl()!.style.width).toBe("auto");
    expect(handleEl()).toBeNull();
    expect(scrimEl()!.className).toBe("hidden");
  });

  it("open: false renders nothing and leaves the document alone", () => {
    setWindowSize(852, 393);
    mountShell({ open: false });
    expect(shellEl()).toBeNull();
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(false);
  });

  it("wires aria-controls to the panel region", () => {
    mountShell();
    const id = handleEl()!.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    const region = document.getElementById(id!);
    expect(region).not.toBeNull();
    expect(region!.getAttribute("role")).toBe("region");
    expect(region!.contains(host.querySelector(".material-symbols-outlined"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — the node never moves", () => {
  /**
   * THE test. Everything else in this file is supporting evidence.
   *
   * A MutationObserver over the whole subtree records every insertion and
   * removal across a full rotation cycle and a fullscreen round trip. The panel
   * box — the node the artifact iframe lives under — must never appear in a
   * `removedNodes` list, and must still be the same object at the end.
   *
   * The handle IS expected to come and go (it renders `null` in `full`), and
   * that doubles as the positive control: if the observer records nothing at
   * all, it is broken, and a green "no removals" would mean nothing.
   */
  function track(): { records: MutationRecord[]; drain: () => void; stop: () => void } {
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((recs) => records.push(...recs));
    mo.observe(host, { childList: true, subtree: true });
    return {
      records,
      drain: () => records.push(...mo.takeRecords()),
      stop: () => mo.disconnect(),
    };
  }

  const removed = (records: MutationRecord[]) =>
    records.flatMap((r) => Array.from(r.removedNodes));

  it("survives drawer -> full -> drawer -> dock without the panel ever being removed", () => {
    setWindowSize(852, 393);
    mountShell();

    const shell0 = shellEl()!;
    const panel0 = panelBoxEl()!;
    const inner0 = panelRootEl()!;
    const handle0 = handleEl()!;
    expect(shell0).toBeTruthy();
    expect(panel0).toBeTruthy();
    expect(inner0).toBeTruthy();

    const t = track();

    rotateTo(393, 852); // -> full
    expect(shellEl()!.className).toBe(FULL_CLASS);
    expect(shellEl()).toBe(shell0);
    expect(panelBoxEl()).toBe(panel0);
    expect(panelRootEl()).toBe(inner0);

    rotateTo(852, 393); // -> drawer
    expect(shellEl()!.className).toBe(DRAWER_CLASS);
    expect(shellEl()).toBe(shell0);
    expect(panelBoxEl()).toBe(panel0);
    expect(panelRootEl()).toBe(inner0);

    rotateTo(1440, 900); // -> dock
    expect(shellEl()!.className).toBe(DOCK_CLASS);
    expect(shellEl()).toBe(shell0);
    expect(panelBoxEl()).toBe(panel0);
    expect(panelRootEl()).toBe(inner0);

    t.drain();
    t.stop();

    const gone = removed(t.records);
    expect(gone).not.toContain(panel0);
    expect(gone).not.toContain(shell0);
    expect(gone).not.toContain(inner0);
    // Positive control: the observer really is recording. The handle is the one
    // node in this subtree that is allowed to disappear, and it did, in `full`.
    expect(gone).toContain(handle0);
  });

  it("survives a fullscreen round trip without the panel ever being removed", () => {
    mountShell();
    const shell0 = shellEl()!;
    const panel0 = panelBoxEl()!;
    const inner0 = panelRootEl()!;

    const t = track();

    act(() => fsButton()!.click());
    flushFrames();
    expect(shellEl()!.className).toBe(FULL_CLASS);
    expect(shellEl()).toBe(shell0);
    expect(panelBoxEl()).toBe(panel0);
    expect(panelRootEl()).toBe(inner0);

    act(() => fsButton()!.click());
    flushFrames();
    expect(shellEl()!.className).toBe(DOCK_CLASS);
    expect(shellEl()).toBe(shell0);
    expect(panelBoxEl()).toBe(panel0);
    expect(panelRootEl()).toBe(inner0);

    t.drain();
    t.stop();
    expect(removed(t.records)).not.toContain(panel0);
    expect(removed(t.records)).not.toContain(shell0);
    expect(removed(t.records)).not.toContain(inner0);
  });

  it("survives a plain window resize inside one geometry", () => {
    mountShell();
    const shell0 = shellEl()!;
    const panel0 = panelBoxEl()!;
    const inner0 = panelRootEl()!;
    const t = track();

    rotateTo(1600, 1000);
    rotateTo(1200, 800);

    t.drain();
    t.stop();
    expect(shellEl()).toBe(shell0);
    expect(panelBoxEl()).toBe(panel0);
    expect(panelRootEl()).toBe(inner0);
    expect(removed(t.records)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — width", () => {
  it("seeds --cc-ws-w from the dock default before first paint", () => {
    mountShell();
    // 0.38 x 1440 = 547.2 -> 547, inside [320, 1440-400].
    expect(wsw()).toBe("547px");
  });

  it("resolves the width through the CURRENT geometry's bounds", () => {
    // 0.9 and 0.96 are both above the dock ceiling but only one is above the
    // drawer's, so a shell that used the wrong bound would paint a visibly
    // different number rather than the same one.
    localStorage.setItem(WORKSPACE_WIDTH_KEY, JSON.stringify({ dock: 0.9, drawer: 0.96 }));

    mountShell();
    // dock: clamped to FRACTION_MAX 0.85 -> 1224px, then to container-CHAT_MIN_PX = 1040.
    // (A drawer-bounded shell would have painted 1296px here.)
    expect(wsw()).toBe("1040px");

    rotateTo(852, 393);
    // drawer: 0.96 x 852 = 818, then to container-DRAWER_PEEK_PX = 796.
    // (A dock-bounded shell would have painted 452px here — half the screen.)
    expect(wsw()).toBe("796px");
  });

  it("falls back silently when the stored value is garbage", () => {
    localStorage.setItem(WORKSPACE_WIDTH_KEY, "{not json at all");
    mountShell();
    expect(wsw()).toBe("547px");
  });

  it("accepts the legacy single-value payload", () => {
    localStorage.setItem(WORKSPACE_WIDTH_KEY, JSON.stringify({ fraction: 0.5 }));
    mountShell();
    expect(wsw()).toBe("720px");
  });

  it("re-clamps on a container resize, deferring every write into a frame", () => {
    mountShell();
    expect(wsw()).toBe("547px");
    expect(pendingFrames()).toBe(0);

    fireResize(host, 1000);
    // Nothing painted yet — the observer callback itself must not write, or
    // "ResizeObserver loop completed with undelivered notifications" is thrown
    // at ERROR severity and has been observed to abort in-progress drags.
    expect(wsw()).toBe("547px");
    expect(pendingFrames()).toBe(1);

    flushFrames();
    // 0.38 x 1000 = 380, inside [320, 1000-400=600].
    expect(wsw()).toBe("380px");
  });

  it("schedules no frame at all when the resize changes nothing", () => {
    mountShell();
    fireResize(host, 1000);
    flushFrames();
    expect(wsw()).toBe("380px");
    expect(pendingFrames()).toBe(0);

    fireResize(host, 1000);
    expect(pendingFrames()).toBe(0);
  });

  it("commits a keyboard resize to storage and repaints the same number", () => {
    mountShell();
    const handle = handleEl()!;
    // APG: ArrowLeft widens, because the panel is right-anchored.
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
    });
    flushFrames();

    // 0.38 + 0.05 = 0.43 -> 619.2px -> 619px.
    expect(wsw()).toBe("619px");

    const stored = JSON.parse(localStorage.getItem(WORKSPACE_WIDTH_KEY)!);
    expect(stored.dock).toBeCloseTo(0.43, 2);
    // The other geometry must survive untouched — one shared key, two widths.
    expect(stored.drawer).toBeCloseTo(0.86, 5);

    // THE FIXPOINT. The commit re-renders the shell, which re-seeds the width
    // from the committed fraction. If paint and commit disagreed, the panel
    // would visibly snap on release; here it must land on the same px.
    expect(wsw()).toBe("619px");
  });

  it("keeps the two geometries' widths independent", () => {
    setWindowSize(852, 393);
    mountShell();
    act(() => {
      handleEl()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    flushFrames();

    const stored = JSON.parse(localStorage.getItem(WORKSPACE_WIDTH_KEY)!);
    // ArrowRight narrows: 0.86 - 0.05 = 0.81.
    expect(stored.drawer).toBeCloseTo(0.81, 2);
    expect(stored.dock).toBeCloseTo(0.38, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — overlay side effects", () => {
  it("locks the document only while an overlay geometry is up", () => {
    document.documentElement.style.overflow = "scroll";
    mountShell();
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("scroll");

    rotateTo(852, 393);
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");

    rotateTo(1440, 900);
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("scroll");
  });

  it("restores the document when the workspace closes while overlaid", () => {
    setWindowSize(852, 393);
    mountShell();
    expect(document.documentElement.style.overflow).toBe("hidden");

    mountShell({ open: false });
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("restores the document on unmount", () => {
    setWindowSize(852, 393);
    mountShell();
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(true);
    act(() => root.unmount());
    expect(document.documentElement.classList.contains("cc-workspace-overlay-open")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
    // afterEach unmounts again; React tolerates that.
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — Escape (R7)", () => {
  it("is ignored in dock — the workspace is a column, not a layer", () => {
    const onClose = vi.fn();
    mountShell({ onClose });
    pressEscape(panelBoxEl()!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the drawer", () => {
    const onClose = vi.fn();
    setWindowSize(852, 393);
    mountShell({ onClose });
    pressEscape(panelBoxEl()!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores from user fullscreen instead of closing — closing is unrecoverable", () => {
    const onClose = vi.fn();
    mountShell({ onClose });
    act(() => fsButton()!.click());
    flushFrames();
    expect(shellEl()!.className).toBe(FULL_CLASS);

    pressEscape(panelBoxEl()!);
    flushFrames();
    expect(onClose).not.toHaveBeenCalled();
    expect(shellEl()!.className).toBe(DOCK_CLASS);
  });

  it("closes device-driven full, where there is no mode to restore to", () => {
    const onClose = vi.fn();
    setWindowSize(393, 852);
    mountShell({ onClose });
    expect(shellEl()!.className).toBe(FULL_CLASS);
    pressEscape(panelBoxEl()!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — fullscreen affordance (A3)", () => {
  it("offers an expand control in dock and a labelled 44px exit in full", () => {
    mountShell();
    const enter = fsButton()!;
    expect(enter.getAttribute("aria-label")).toBe("Expand workspace to full screen");
    expect(enter.getAttribute("aria-pressed")).toBe("false");

    act(() => enter.click());
    flushFrames();

    const exit = fsButton()!;
    expect(exit.getAttribute("aria-label")).toBe("Exit full screen");
    expect(exit.getAttribute("aria-pressed")).toBe("true");
    // Escape does not exist on a phone; the way out must be a visible tap
    // target, and WS-F sizes it at the 44px platform floor.
    expect(exit.className).toContain("min-h-[44px]");
    expect(exit.textContent).toContain("Exit full screen");
  });

  it("moves focus to the toggle when the mode flips, in both directions", () => {
    mountShell();
    // jsdom's .click() does not focus, so this observes the shell's own effect.
    expect(document.activeElement).not.toBe(fsButton());

    act(() => fsButton()!.click());
    flushFrames();
    expect(document.activeElement).toBe(fsButton());
    expect(document.activeElement!.tagName).toBe("BUTTON");

    act(() => (document.activeElement as HTMLElement).blur());
    act(() => fsButton()!.click());
    flushFrames();
    expect(document.activeElement).toBe(fsButton());
  });

  it("does not steal focus on mount", () => {
    mountShell();
    expect(document.activeElement).toBe(document.body);
  });

  it("offers no toggle when the device is already full and the user did not ask", () => {
    setWindowSize(393, 852);
    mountShell();
    expect(shellEl()!.className).toBe(FULL_CLASS);
    expect(fsButton()).toBeNull();
  });

  it("keeps the exit alive if the user entered fullscreen and then rotated", () => {
    // A3 is a promise about getting back out; a rotation must not break it.
    setWindowSize(852, 393);
    mountShell();
    act(() => fsButton()!.click());
    flushFrames();

    rotateTo(393, 852); // portrait: naturally full, but userFullscreen is set
    const exit = fsButton();
    expect(exit).not.toBeNull();
    expect(exit!.getAttribute("aria-label")).toBe("Exit full screen");
  });

  it("does not reopen into a takeover state", () => {
    mountShell();
    act(() => fsButton()!.click());
    flushFrames();
    expect(shellEl()!.className).toBe(FULL_CLASS);

    mountShell({ open: false });
    mountShell({ open: true });
    expect(shellEl()!.className).toBe(DOCK_CLASS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("WorkspaceShell — scrim", () => {
  it("dismisses the drawer when tapped, and only when tapped directly", () => {
    const onClose = vi.fn();
    setWindowSize(852, 393);
    mountShell({ onClose });
    const scrim = scrimEl()!;

    act(() => {
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // A click whose target is elsewhere must not reach it — a drag released
    // over the peek strip would otherwise destroy the running mini-app.
    onClose.mockClear();
    act(() => {
      panelBoxEl()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
