import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  computeViewportVars,
  shouldResetVars,
  VV_FALLBACK,
  type VvSample,
} from "@/lib/visualViewport";
import { useVisualViewportVars } from "@/hooks/useVisualViewportVars";

/**
 * WS-D. Two halves, tested two different ways.
 *
 * The arithmetic is a pure table. The hook is tested for REAL — mounted with
 * react-dom, driven by a fake `window.visualViewport`, with `requestAnimation-
 * Frame` replaced by a queue this file controls. jsdom 20 ships none of those
 * globals, so every one of them is installed in `beforeEach` and torn down in
 * `afterEach` inside this file (`src/test/setup.ts` is frozen).
 *
 * `@testing-library/react` is deliberately NOT used: its peer
 * `@testing-library/dom` is not installed in this repo, and this workstream may
 * not add dependencies. `React.act` (18.3+) plus `createRoot` is the same
 * guarantee with nothing new in package.json.
 */

const s = (height: number, offsetTop: number, layoutHeight: number): VvSample => ({
  height,
  offsetTop,
  layoutHeight,
});

// ---------------------------------------------------------------------------
// computeViewportVars — the arithmetic
// ---------------------------------------------------------------------------

describe("computeViewportVars: trustworthy samples", () => {
  it("publishes the visible height verbatim when the keyboard is closed", () => {
    // iPhone 16 landscape, nothing covering it.
    expect(computeViewportVars(s(393, 0, 393))).toEqual({ vvh: "393px", vvTop: "0px" });
  });

  it("shrinks to the keyboard-open height", () => {
    // Same device, soft keyboard up: 220 px of the 393 are gone.
    expect(computeViewportVars(s(173, 0, 393))).toEqual({ vvh: "173px", vvTop: "0px" });
  });

  it("keeps a legitimate offset — iOS scrolling a focused field above the keyboard", () => {
    // Ceiling is layoutHeight - height = 220, so 120 passes through untouched.
    expect(computeViewportVars(s(173, 120, 393))).toEqual({ vvh: "173px", vvTop: "120px" });
  });

  it("passes the offset through exactly at the ceiling", () => {
    expect(computeViewportVars(s(173, 220, 393)).vvTop).toBe("220px");
  });

  it("rounds the height DOWN, never up", () => {
    // --cc-vvh is consumed as a max-height. Over-claiming by a fraction of a
    // pixel is the one direction that can put content under the keyboard.
    expect(computeViewportVars(s(393.99, 0, 852)).vvh).toBe("393px");
  });

  it("is pure: same input, same output, and the input is not mutated", () => {
    const sample = s(173, 120, 393);
    const frozen = { ...sample };
    const a = computeViewportVars(sample);
    const b = computeViewportVars(sample);
    expect(a).toEqual(b);
    expect(sample).toEqual(frozen);
  });
});

describe("computeViewportVars: the iOS 26 stale-offset guard", () => {
  it("clamps an offset that outlived the keyboard back to zero", () => {
    // THE BUG THIS EXISTS FOR: iOS 26 has been observed leaving offsetTop
    // non-zero after the keyboard closes. height is back to full, so the
    // ceiling (layoutHeight - height) is 0 and the stale 220 is discarded.
    // Without this clamp the overlay is translated clean off the bottom of the
    // screen — an invisible workspace, worse than the bug being fixed.
    expect(computeViewportVars(s(393, 220, 393))).toEqual({ vvh: "393px", vvTop: "0px" });
  });

  it("clamps any over-large offset to the ceiling", () => {
    expect(computeViewportVars(s(173, 9999, 393)).vvTop).toBe("220px");
  });

  it("refuses to publish an offset it cannot bound", () => {
    // No usable layoutHeight means no ceiling. 0px is today's behaviour;
    // an unbounded guess is an off-screen overlay.
    expect(computeViewportVars(s(393, 200, Number.NaN)).vvTop).toBe("0px");
    expect(computeViewportVars(s(393, 200, 0)).vvTop).toBe("0px");
    expect(computeViewportVars(s(393, 200, -100)).vvTop).toBe("0px");
    // ...and the height half of the sample is still honoured.
    expect(computeViewportVars(s(393, 200, Number.NaN)).vvh).toBe("393px");
  });

  it("zeroes the offset when the visual viewport is TALLER than the layout one", () => {
    // Pinched out: the ceiling goes negative, and the only correct offset is 0.
    expect(computeViewportVars(s(900, 50, 393))).toEqual({ vvh: "900px", vvTop: "0px" });
  });

  it("zeroes a negative or non-finite offset", () => {
    expect(computeViewportVars(s(393, -40, 852)).vvTop).toBe("0px");
    expect(computeViewportVars(s(393, Number.NaN, 852)).vvTop).toBe("0px");
    expect(computeViewportVars(s(393, Number.POSITIVE_INFINITY, 852)).vvTop).toBe("0px");
  });
});

describe("computeViewportVars: nonsense degrades to the CSS defaults", () => {
  const nonsense: Array<[string, VvSample | null | undefined]> = [
    ["null sample", null],
    ["undefined sample", undefined],
    ["zero height", s(0, 0, 852)],
    ["negative height", s(-100, 0, 852)],
    ["NaN height", s(Number.NaN, 0, 852)],
    ["Infinite height", s(Number.POSITIVE_INFINITY, 0, 852)],
    ["sub-pixel height", s(0.4, 0, 852)],
    ["absurd height", s(1e6, 0, 852)],
    ["string height", { height: "393" } as unknown as VvSample],
    ["empty object", {} as unknown as VvSample],
  ];

  for (const [label, sample] of nonsense) {
    it(`falls back for ${label}`, () => {
      // 100% / 0px are exactly what :root declares, i.e. today's behaviour.
      // The JS path is never allowed to be worse than no JS path.
      expect(computeViewportVars(sample)).toEqual({ vvh: "100%", vvTop: "0px" });
    });
  }

  it("hands back a fresh object, never the shared constant", () => {
    const out = computeViewportVars(null);
    expect(out).not.toBe(VV_FALLBACK);
    out.vvh = "666px";
    expect(VV_FALLBACK.vvh).toBe("100%");
    expect(computeViewportVars(null).vvh).toBe("100%");
  });

  it("the fallback constant matches what the stylesheet declares", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/styles/workspace-viewport.css"),
      "utf8",
    );
    expect(css).toContain(`--cc-vvh: ${VV_FALLBACK.vvh}`);
    expect(css).toContain(`--cc-vv-top: ${VV_FALLBACK.vvTop}`);
  });
});

describe("shouldResetVars", () => {
  it("resets on the keyboard-dismissed and app-switch signals", () => {
    expect(shouldResetVars("focusout")).toBe(true);
    expect(shouldResetVars("blur")).toBe(true);
  });

  it("does not reset on the ordinary sampling events", () => {
    expect(shouldResetVars("resize")).toBe(false);
    expect(shouldResetVars("scroll")).toBe(false);
    expect(shouldResetVars("focusin")).toBe(false);
    expect(shouldResetVars("")).toBe(false);
    expect(shouldResetVars("FOCUSOUT")).toBe(false);
    expect(shouldResetVars(undefined as unknown as string)).toBe(false);
    expect(shouldResetVars(null as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useVisualViewportVars — the listener half, mounted for real
// ---------------------------------------------------------------------------

class FakeVisualViewport extends EventTarget {
  height = 393;
  offsetTop = 0;
  emit(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

type MutableWindow = Record<string, unknown>;

const ROOT_STYLE = () => document.documentElement.style;
const vvhVar = () => ROOT_STYLE().getPropertyValue("--cc-vvh");
const vvTopVar = () => ROOT_STYLE().getPropertyValue("--cc-vv-top");

describe("useVisualViewportVars", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let realRaf: typeof window.requestAnimationFrame;
  let realCaf: typeof window.cancelAnimationFrame;
  let realInnerHeight: number;
  let writes: string[];
  let removals: string[];
  let roots: Array<{ unmount: () => void }>;

  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  };

  /** Mounts the real hook in a real React tree. */
  const mount = (active: boolean) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const Probe = (props: { active: boolean }) => {
      useVisualViewportVars(props.active);
      return null;
    };
    const render = (next: boolean) => {
      act(() => {
        root.render(createElement(Probe, { active: next }));
      });
    };
    render(active);
    const handle = {
      rerender: render,
      unmount: () => {
        act(() => {
          root.unmount();
        });
        container.remove();
      },
    };
    roots.push(handle);
    return handle;
  };

  beforeEach(() => {
    (globalThis as MutableWindow).IS_REACT_ACT_ENVIRONMENT = true;

    frames = new Map();
    nextFrameId = 1;
    roots = [];
    writes = [];
    removals = [];

    realRaf = window.requestAnimationFrame;
    realCaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      frames.delete(id);
    }) as typeof window.cancelAnimationFrame;

    realInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 393,
    });

    // Record every custom-property mutation so we can prove the hook touches
    // the two variables and nothing else, that it de-duplicates, and — the
    // distinction that matters — that "no opinion" is expressed as a REMOVAL
    // rather than as an inline `100%` that would shadow the stylesheet.
    const style = ROOT_STYLE();
    const realSetProperty = style.setProperty.bind(style);
    const realRemoveProperty = style.removeProperty.bind(style);
    (style as unknown as MutableWindow).setProperty = ((
      name: string,
      value: string,
    ) => {
      writes.push(`${name}:${value}`);
      realSetProperty(name, value);
    }) as typeof style.setProperty;
    (style as unknown as MutableWindow).removeProperty = ((name: string) => {
      removals.push(name);
      return realRemoveProperty(name);
    }) as typeof style.removeProperty;
  });

  afterEach(() => {
    for (const r of roots) {
      try {
        r.unmount();
      } catch {
        /* already unmounted */
      }
    }
    delete (ROOT_STYLE() as unknown as MutableWindow).setProperty;
    delete (ROOT_STYLE() as unknown as MutableWindow).removeProperty;
    ROOT_STYLE().removeProperty("--cc-vvh");
    ROOT_STYLE().removeProperty("--cc-vv-top");
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: realInnerHeight,
    });
    delete (window as unknown as MutableWindow).visualViewport;
    document.body.innerHTML = "";
  });

  const installVv = (vv: FakeVisualViewport) => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: vv,
    });
    return vv;
  };

  describe("without window.visualViewport (jsdom, Safari < 13)", () => {
    it("is a complete no-op — no throw, no frame, no variable", () => {
      // If the truthiness guard is removed, the hook does
      // `vv.addEventListener(...)` on undefined and this throws.
      expect(() => mount(true)).not.toThrow();
      expect(frames.size).toBe(0);
      expect(writes).toEqual([]);
      expect(removals).toEqual([]);
      expect(vvhVar()).toBe("");
      expect(vvTopVar()).toBe("");
    });

    it("unmounts cleanly", () => {
      const h = mount(true);
      expect(() => h.unmount()).not.toThrow();
    });
  });

  describe("with a visual viewport", () => {
    let vv: FakeVisualViewport;

    beforeEach(() => {
      vv = installVv(new FakeVisualViewport());
    });

    it("seeds both variables on mount — the keyboard may already be open", () => {
      mount(true);
      expect(frames.size).toBe(1); // scheduled, not yet written
      expect(vvhVar()).toBe("");
      flushFrames();
      expect(vvhVar()).toBe("393px");
      expect(vvTopVar()).toBe("0px");
    });

    it("tracks the keyboard opening", () => {
      mount(true);
      flushFrames();
      vv.height = 173;
      vv.emit("resize");
      flushFrames();
      expect(vvhVar()).toBe("173px");
    });

    it("tracks a visual-viewport scroll", () => {
      mount(true);
      flushFrames();
      vv.height = 173;
      vv.offsetTop = 120;
      vv.emit("scroll");
      flushFrames();
      expect(vvTopVar()).toBe("120px");
    });

    it("coalesces a burst of events into ONE frame", () => {
      mount(true);
      flushFrames();
      writes.length = 0;
      for (let i = 0; i < 8; i++) {
        vv.height = 300 - i;
        vv.emit("resize");
      }
      // Eight events, one scheduled frame. Without the rAF gate this would be
      // eight document-wide style invalidations per keyboard animation.
      expect(frames.size).toBe(1);
      flushFrames();
      expect(writes).toEqual(["--cc-vvh:293px"]);
    });

    it("writes nothing when the value has not changed", () => {
      mount(true);
      flushFrames();
      writes.length = 0;
      removals.length = 0;
      vv.emit("resize");
      flushFrames();
      vv.emit("resize");
      flushFrames();
      expect(writes).toEqual([]);
      expect(removals).toEqual([]);
      expect(vvhVar()).toBe("393px");
    });

    it("writes ONLY the two custom properties — it never touches layout", () => {
      mount(true);
      flushFrames();
      vv.height = 173;
      vv.offsetTop = 90;
      vv.emit("resize");
      flushFrames();
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) {
        expect(["--cc-vvh", "--cc-vv-top"]).toContain(w.split(":")[0]);
      }
      for (const r of removals) {
        expect(["--cc-vvh", "--cc-vv-top"]).toContain(r);
      }
      // and nothing inline on <html> beyond those two
      expect(ROOT_STYLE().getPropertyValue("height")).toBe("");
      expect(ROOT_STYLE().getPropertyValue("overflow")).toBe("");
    });

    it("WITHDRAWS --cc-vvh on an untrusted sample instead of inlining the fallback", () => {
      // THE SHADOWING BUG THIS GUARDS. computeViewportVars returns "100%" for
      // a sample it does not trust. `:root` also declares `100%` — but only as
      // a BASE, upgraded to the small-viewport unit inside @supports. An
      // inline `--cc-vvh: 100%` on <html> beats that upgrade (inline style
      // wins over any stylesheet rule), so writing the sentinel back would
      // silently reinstate the large-viewport toolbar bleed on exactly the
      // phones this feature exists for. Removing hands the decision to CSS.
      mount(true);
      flushFrames();
      expect(vvhVar()).toBe("393px");
      writes.length = 0;
      removals.length = 0;

      vv.height = 0; // untrusted
      vv.emit("resize");
      flushFrames();

      expect(vvhVar()).toBe("");
      expect(removals).toEqual(["--cc-vvh"]);
      expect(writes.some((w) => w.startsWith("--cc-vvh:"))).toBe(false);

      // ...and it stays withdrawn without re-removing every frame.
      removals.length = 0;
      vv.emit("resize");
      flushFrames();
      expect(removals).toEqual([]);

      // ...and it comes back the moment there is something real to say.
      vv.height = 173;
      vv.emit("resize");
      flushFrames();
      expect(vvhVar()).toBe("173px");
    });

    it("applies the stale-offset clamp end to end", () => {
      mount(true);
      flushFrames();
      vv.height = 173;
      vv.offsetTop = 120;
      vv.emit("resize");
      flushFrames();
      expect(vvTopVar()).toBe("120px");

      // Keyboard closes, iOS 26 leaves offsetTop behind.
      vv.height = 393;
      vv.emit("resize");
      flushFrames();
      expect(vvTopVar()).toBe("0px");
    });

    it("force-resets to the CSS defaults on focusout, synchronously", () => {
      mount(true);
      flushFrames();
      vv.height = 173;
      vv.emit("resize");
      flushFrames();
      expect(vvhVar()).toBe("173px");

      document.body.dispatchEvent(new Event("focusout", { bubbles: true }));
      // No frame flush: a force reset that waits for the next frame paints the
      // stale value once, which is exactly the artefact being avoided.
      expect(vvhVar()).toBe("");
      expect(vvTopVar()).toBe("");
    });

    it("force-resets on window blur", () => {
      mount(true);
      flushFrames();
      expect(vvhVar()).toBe("393px");
      window.dispatchEvent(new Event("blur"));
      expect(vvhVar()).toBe("");
    });

    it("does not reset on an event shouldResetVars rejects", () => {
      mount(true);
      flushFrames();
      document.body.dispatchEvent(new Event("focusin", { bubbles: true }));
      expect(vvhVar()).toBe("393px");
    });

    it("re-samples after the reset settles, so a spurious reset heals", () => {
      mount(true);
      flushFrames();

      // Stub timers only now, so React's mount work ran on the real ones.
      const realSetTimeout = window.setTimeout;
      const realClearTimeout = window.clearTimeout;
      const pendingTimers = new Map<number, () => void>();
      let nextTimerId = 1;
      window.setTimeout = ((fn: () => void) => {
        const id = nextTimerId++;
        pendingTimers.set(id, fn);
        return id;
      }) as unknown as typeof window.setTimeout;
      window.clearTimeout = ((id: number) => {
        pendingTimers.delete(id);
      }) as unknown as typeof window.clearTimeout;

      try {
        // Focus moving into the artifact iframe fires `blur` on some engines.
        window.dispatchEvent(new Event("blur"));
        expect(vvhVar()).toBe("");
        expect(pendingTimers.size).toBe(1);

        for (const fn of pendingTimers.values()) fn();
        expect(frames.size).toBe(1);
        flushFrames();
        expect(vvhVar()).toBe("393px");
      } finally {
        window.setTimeout = realSetTimeout;
        window.clearTimeout = realClearTimeout;
      }
    });

    it("cancels a pending frame and removes the variables on unmount", () => {
      const h = mount(true);
      flushFrames();
      vv.height = 173;
      vv.emit("resize");
      expect(frames.size).toBe(1);

      h.unmount();
      expect(frames.size).toBe(0); // cancelAnimationFrame ran
      expect(vvhVar()).toBe("");
      expect(vvTopVar()).toBe("");
    });

    it("stops listening after unmount", () => {
      const h = mount(true);
      flushFrames();
      h.unmount();
      vv.height = 100;
      vv.emit("resize");
      vv.emit("scroll");
      document.body.dispatchEvent(new Event("focusout", { bubbles: true }));
      expect(frames.size).toBe(0);
      expect(vvhVar()).toBe("");
    });

    it("does nothing while inactive, and starts and stops on the flag", () => {
      const h = mount(false);
      expect(frames.size).toBe(0);
      expect(vvhVar()).toBe("");

      h.rerender(true);
      expect(frames.size).toBe(1);
      flushFrames();
      expect(vvhVar()).toBe("393px");

      h.rerender(false);
      expect(vvhVar()).toBe("");
      expect(vvTopVar()).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// Source invariants — the things that cannot be observed from inside jsdom
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

/**
 * Source scans assert about CODE, not about prose. A grep that a comment can
 * satisfy — or break — proves nothing, so every scan below runs on the file
 * with its comments removed. (`//` is only stripped when it starts a token, so
 * a `https://` inside a string survives.)
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

describe("src/styles/workspace-viewport.css", () => {
  const raw = read("src/styles/workspace-viewport.css");
  const css = stripComments(raw);

  /** Index of a rule's opening brace, or -1. Deliberately structural: an
   *  assertion that a substring merely EXISTS somewhere in a stylesheet is
   *  satisfied by the declaration sitting in the wrong cascade layer. */
  const ruleIndex = (selector: string, decl: RegExp) => {
    const re = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*${decl.source}`,
    );
    const m = css.match(re);
    return m?.index ?? -1;
  };

  it("declares working defaults for both variables on :root", () => {
    // Unconditional, outside any @supports — a browser that understands
    // nothing new still gets a usable value.
    const bare = css.slice(0, css.indexOf("@supports"));
    expect(bare).toMatch(/:root\s*\{[\s\S]*--cc-vvh:\s*100%/);
    expect(bare).toMatch(/:root\s*\{[\s\S]*--cc-vv-top:\s*0px/);
  });

  it("ships .h-app as 100vh with an @supports upgrade to 100svh", () => {
    const base = ruleIndex(".h-app", /height:\s*100vh/);
    expect(base).toBeGreaterThan(-1);

    // The upgrade must be INSIDE the feature query, not merely somewhere after
    // it: an unguarded `height: 100svh` is dropped wholesale by a browser that
    // cannot parse the unit, collapsing the app shell to `height: auto`.
    const supports = css.match(
      /@supports\s*\(height:\s*100svh\)\s*\{[\s\S]*?\n\}/,
    );
    expect(supports).not.toBeNull();
    expect(supports![0]).toMatch(/\.h-app\s*\{[^}]*height:\s*100svh/);
    // Base first, or the upgrade is overridden by the fallback it upgrades.
    expect(base).toBeLessThan(supports!.index!);
  });

  it("upgrades the --cc-vvh default to the small viewport where it parses", () => {
    // `100%` on a position:fixed overlay resolves against the LARGE viewport,
    // i.e. the toolbar bleed itself. This is the JS-free path agreeing with
    // the JS path instead of disagreeing by the height of the address bar.
    const supports = css.match(
      /@supports\s*\(height:\s*100svh\)\s*\{[\s\S]*?\n\}/,
    );
    expect(supports![0]).toMatch(/:root\s*\{[^}]*--cc-vvh:\s*100svh/);
  });

  it("contains no dynamic or large viewport unit", () => {
    // The dynamic unit is throttled and resizes content mid-scroll — for this
    // feature that means the artifact iframe reflowing under the reader's
    // thumb. The large unit is what `vh` already is, i.e. the bug.
    // Checked against the RAW file: not even a comment may name them.
    expect(raw.includes("dvh")).toBe(false);
    expect(raw.includes("lvh")).toBe(false);
  });

  it("stays inside the CSP: no @import, no remote url(), no @apply", () => {
    expect(css).not.toContain("@import");
    expect(css).not.toContain("@apply");
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
  });
});

describe("src/lib/visualViewport.ts", () => {
  const src = stripComments(read("src/lib/visualViewport.ts"));

  it("is pure — it touches no browser global", () => {
    // Everything environment-dependent lives in the hook, which is why the
    // arithmetic above can be a table test in an environment with no
    // visualViewport at all.
    expect(src).not.toMatch(/\bwindow\./);
    expect(src).not.toMatch(/\bdocument\./);
    expect(src).not.toContain("addEventListener");
  });
});

describe("src/hooks/useVisualViewportVars.ts", () => {
  const src = stripComments(read("src/hooks/useVisualViewportVars.ts"));

  it("guards on window.visualViewport before it ever adds a listener", () => {
    const guard = src.indexOf("window.visualViewport");
    const listener = src.indexOf("addEventListener");
    expect(guard).toBeGreaterThan(-1);
    expect(listener).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(listener);
    expect(src).toMatch(/if\s*\(!vv\b/);
  });

  it("throttles through requestAnimationFrame and handles focusout", () => {
    expect(src).toContain("requestAnimationFrame");
    expect(src).toContain("cancelAnimationFrame");
    expect(src).toContain("focusout");
  });

  it("touches nothing on documentElement but the two custom properties", () => {
    // Every style mutation in the file must name one of the two variables.
    const mutations = [...src.matchAll(/style\.(set|remove)Property\(([^,)]+)/g)];
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(["VVH_VAR", "VV_TOP_VAR"]).toContain(m[2].trim());
    }
    expect(src).toContain("removeProperty(VVH_VAR)");
    expect(src).toContain("removeProperty(VV_TOP_VAR)");
  });

  it("focuses nothing (Android soft-keyboard rule)", () => {
    expect(src).not.toContain(".focus(");
    expect(src).not.toContain("focusComposer");
  });
});

describe("index.html stays frozen", () => {
  const html = read("index.html");

  it("still has viewport-fit=cover and still has no interactive-widget", () => {
    // interactive-widget is Chrome/Firefox-only (WebKit bug 259770): adding it
    // would change composer behaviour on two engines for zero iOS benefit,
    // and the JS path is needed on iOS regardless.
    expect(html).toContain("viewport-fit=cover");
    expect(html).not.toContain("interactive-widget");
  });
});
