import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * WS-E — integration.
 *
 * This workstream owns no logic of its own. It owns four seams, and every one
 * of them fails SILENTLY:
 *
 *   · `ChatPanel` used to render the workspace from two sibling branches
 *     (`!isMobile` column / `isMobile` <Sheet>). Crossing 768 px — rotating the
 *     phone — swapped branches, and React commits a branch swap as remove +
 *     insert. Removing an iframe destroys its document with no unload event, so
 *     the user's running mini-app reloaded. Nothing logs.
 *   · `Index.tsx` reads `h-app`. If no loaded stylesheet declares `.h-app`, the
 *     class is inert and the app shell collapses to `height: auto`. Nothing
 *     logs.
 *   · `main.tsx` loads four stylesheets. A missing import means no measure cap,
 *     no safe-area insets, no `--cc-vvh`, no hit area. Nothing logs.
 *   · The `ResizeObserver loop` error is benign per spec but dispatched at
 *     ERROR severity, so it trips catch-all handlers and has been observed to
 *     abort an in-progress drag. Swallowing it wrongly hides real errors.
 *
 * So the tests here are deliberately of two kinds.
 *
 * Where the property is a compile-time / wiring property (which file imports
 * which, which identifier survived a deletion), the test scans source — but it
 * scans COMMENT-STRIPPED source, because both `<Sheet>` and `WorkspacePanel`
 * are named in the comment that explains why they were removed, and a naive
 * grep fails on its own rationale. A meta-test below proves the stripper
 * neither over- nor under-strips.
 *
 * Where behaviour exists, it is EXECUTED. The ResizeObserver filter and the
 * `counsel_workspace_open` write are both pulled out of the real source and run
 * against injected fakes. A grep for `try {` cannot tell you whether the guard
 * wraps the right statement, and a grep for `"ResizeObserver loop"` cannot tell
 * you whether the handler swallows a genuine TypeError too.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const rel = (abs: string) => abs.slice(ROOT.length + 1).replace(/\\/g, "/");

/**
 * Removes block and line comments. The `[^:/\\]` guard in front of a line
 * comment keeps `https://` inside string literals intact; the block-comment
 * match is non-greedy so two adjacent block comments do not merge into one.
 * Validated by the meta-test at the bottom of this file against the real
 * ChatPanel source, in both directions.
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/\\])\/\/[^\n]*/gm, "$1");

const CHAT_PANEL_RAW = read("src/components/ChatPanel.tsx");
const CHAT_PANEL = stripComments(CHAT_PANEL_RAW);
const INDEX_RAW = read("src/pages/Index.tsx");
const INDEX = stripComments(INDEX_RAW);
const MAIN_RAW = read("src/main.tsx");
const MAIN = stripComments(MAIN_RAW);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// 1. ChatPanel — the two-branch layout is gone
// ---------------------------------------------------------------------------

describe("ChatPanel — one workspace, one JSX position", () => {
  it("renders <WorkspaceShell> exactly once", () => {
    expect(count(CHAT_PANEL, "<WorkspaceShell")).toBe(1);
  });

  it("imports the shell, not the panel", () => {
    expect(CHAT_PANEL).toContain('import WorkspaceShell from "@/components/WorkspaceShell";');
    // The panel must be reached only THROUGH the shell. A direct import here
    // would be a second mount point, which is the exact defect being fixed.
    expect(CHAT_PANEL).not.toContain("WorkspacePanel");
  });

  it("passes the shell every prop in the frozen WorkspaceShellProps", () => {
    const tag = CHAT_PANEL.slice(
      CHAT_PANEL.indexOf("<WorkspaceShell"),
      CHAT_PANEL.indexOf("/>", CHAT_PANEL.indexOf("<WorkspaceShell")),
    );
    for (const prop of ["open=", "userId=", "selectedId=", "onSelect=", "onClose="]) {
      expect(tag).toContain(prop);
    }
    expect(tag).toContain("open={workspaceOpen}");
  });

  it("no longer decides geometry for itself: useIsMobile, isMobile and Sheet are all gone", () => {
    expect(CHAT_PANEL).not.toContain("useIsMobile");
    expect(CHAT_PANEL).not.toContain("use-mobile");
    expect(CHAT_PANEL).not.toContain("isMobile");
    // `Sheet`, `SheetContent`, `SheetPortal` — any of them. SheetPortal was the
    // second half of the bug: it mounted the workspace to document.body, a
    // different parent entirely.
    expect(CHAT_PANEL).not.toMatch(/\bSheet[A-Za-z]*\b/);
  });

  it("no longer hardcodes the column width — that is --cc-ws-w's job now", () => {
    expect(CHAT_PANEL).not.toContain("w-[360px]");
    expect(CHAT_PANEL).not.toContain("w-[420px]");
  });

  it("keeps the flex row and the chat column that the dock math measures", () => {
    // WorkspaceShell measures `shellRef.current.parentElement` as the dock
    // width budget, and WorkspaceLab mirrors the chat column's class string to
    // reproduce the layout without a session. Both break silently if these
    // change, so they are pinned here as well as in workspaceLab.test.ts.
    expect(CHAT_PANEL).toContain('<div className="flex h-full overflow-hidden">');
    expect(CHAT_PANEL).toContain('className="flex flex-col h-full flex-1 min-w-0 relative"');
  });

  it("keeps the workspace-open storage contract (R6): same key, same '1'/'0'", () => {
    expect(CHAT_PANEL).toContain('localStorage.getItem("counsel_workspace_open") === "1"');
    expect(CHAT_PANEL).toContain('localStorage.setItem("counsel_workspace_open", workspaceOpen ? "1" : "0")');
  });
});

// ---------------------------------------------------------------------------
// 2. One mount point in the entire application
// ---------------------------------------------------------------------------

/** Every .ts/.tsx under src/, excluding the test directory. */
function appSources(dir = resolve(ROOT, "src"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test") continue;
      appSources(p, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const APP_SOURCES = appSources();

const importersOf = (moduleSpec: string) =>
  APP_SOURCES.filter((f) => {
    const src = stripComments(readFileSync(f, "utf8"));
    return new RegExp(`from\\s*["']${moduleSpec}["']`).test(src) || src.includes(`import("${moduleSpec}")`);
  }).map(rel);

describe("the workspace viewer has exactly one mount point in the app", () => {
  it("only WorkspaceShell imports WorkspacePanel", () => {
    // R1's app-level form. Two importers means two JSX positions somewhere,
    // which means a device or state change can move the artifact iframe.
    expect(importersOf("@/components/WorkspacePanel").sort()).toEqual([
      "src/components/WorkspaceShell.tsx",
    ]);
  });

  it("the shell is mounted by ChatPanel, and otherwise only by the dev-only lab", () => {
    expect(importersOf("@/components/WorkspaceShell").sort()).toEqual([
      "src/components/ChatPanel.tsx",
      "src/pages/WorkspaceLab.tsx",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. use-mobile is deleted, and nothing anywhere still reaches for it
// ---------------------------------------------------------------------------

describe("src/hooks/use-mobile.tsx is gone", () => {
  it("the file does not exist under any extension", () => {
    for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
      expect(existsSync(resolve(ROOT, `src/hooks/use-mobile${ext}`))).toBe(false);
    }
  });

  it("no source file imports it — a dangling import is a build failure, not a warning", () => {
    const offenders = APP_SOURCES.filter((f) =>
      /(?:from|import)\s*\(?\s*["'][^"']*use-mobile["']/.test(stripComments(readFileSync(f, "utf8"))),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it("no source file calls useIsMobile()", () => {
    const offenders = APP_SOURCES.filter((f) =>
      /\buseIsMobile\s*\(/.test(stripComments(readFileSync(f, "utf8"))),
    ).map(rel);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Index.tsx — the app-height authority
// ---------------------------------------------------------------------------

describe("Index.tsx — h-screen → h-app", () => {
  it("the root layout element uses h-app", () => {
    expect(INDEX).toContain('<div className="flex flex-col h-app bg-background">');
  });

  it("h-screen appears nowhere in the file", () => {
    // `100vh` is defined as equal to `100lvh`, which is why the shell bleeds
    // under a mobile toolbar. One stray `h-screen` anywhere in this file would
    // reintroduce that on whichever subtree wore it.
    expect(INDEX).not.toContain("h-screen");
  });

  it("does not touch the tablet rail or the bottom nav (verified correct for landscape phones)", () => {
    // At 852 px wide the rail shows (md:flex lg:hidden — 80 px of 852, on the
    // abundant axis) and the bottom nav stays hidden (md:hidden), so pb-20
    // md:pb-0 correctly resolves to 0. Pinned so a later "landscape fix" does
    // not undo an already-correct behaviour.
    expect(INDEX).toContain("md:flex lg:hidden");
    expect(INDEX).toContain("pb-20 md:pb-0");
  });
});

// ---------------------------------------------------------------------------
// 5. main.tsx — the stylesheets, and whether they resolve
// ---------------------------------------------------------------------------

const SPEC_RE =
  /(?:import|export)\s+(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

const specifiersIn = (src: string): string[] =>
  [...src.matchAll(SPEC_RE)].map((m) => (m[1] ?? m[2]) as string).filter(Boolean);

const RESOLVE_EXT = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/** null = a bare package specifier (node_modules, not our problem). */
function resolveSpec(spec: string, fromFile: string): string | null | { missing: string } {
  const clean = spec.split("?")[0];
  let base: string;
  if (clean.startsWith("@/")) base = resolve(ROOT, "src", clean.slice(2));
  else if (clean.startsWith("./") || clean.startsWith("../")) base = resolve(dirname(fromFile), clean);
  else return null;
  for (const ext of RESOLVE_EXT) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return { missing: base };
}

const WORKSPACE_STYLESHEETS = [
  "./styles/workspace-viewport.css",
  "./styles/workspace-resize.css",
  "./styles/workspace-overlay.css",
  "./styles/workspace-typography.css",
];

describe("main.tsx — the four workspace stylesheets", () => {
  const mainSpecs = specifiersIn(MAIN);

  it.each(WORKSPACE_STYLESHEETS)("imports %s", (sheet) => {
    expect(mainSpecs).toContain(sheet);
  });

  it("every stylesheet it imports exists on disk", () => {
    // `toContain("workspace-overlay.css")` passes on a typo'd directory. This
    // does not.
    for (const sheet of WORKSPACE_STYLESHEETS) {
      const resolved = resolveSpec(sheet, resolve(ROOT, "src/main.tsx"));
      expect(typeof resolved).toBe("string");
    }
  });

  it("loads them after index.css, so they can override Tailwind utilities", () => {
    const idx = mainSpecs.indexOf("./index.css");
    expect(idx).toBeGreaterThanOrEqual(0);
    for (const sheet of WORKSPACE_STYLESHEETS) {
      expect(mainSpecs.indexOf(sheet)).toBeGreaterThan(idx);
    }
  });

  it("adds no remote CSS (R3 — the CSP has no external style-src beyond fonts)", () => {
    for (const sheet of WORKSPACE_STYLESHEETS) {
      const css = readFileSync(resolve(ROOT, "src", sheet.slice(2)), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        " ",
      );
      expect(css).not.toMatch(/@import/);
      expect(css).not.toMatch(/url\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The CSS the app actually loads defines every cc-* class it actually renders
// ---------------------------------------------------------------------------

/** Class-looking `cc-*` tokens inside string literals of the workspace components. */
function ccClassTokens(files: string[]): string[] {
  const tokens = new Set<string>();
  for (const f of files) {
    const src = stripComments(readFileSync(resolve(ROOT, f), "utf8"));
    for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      const literal = m[1] ?? m[2] ?? m[3] ?? "";
      for (const t of literal.split(/[\s{}$]+/)) if (/^cc-[a-z0-9-]+$/.test(t)) tokens.add(t);
    }
  }
  return [...tokens].sort();
}

const WORKSPACE_COMPONENTS = [
  "src/components/WorkspaceShell.tsx",
  "src/components/WorkspaceResizeHandle.tsx",
  "src/components/WorkspacePanel.tsx",
];

/** Only the sheets main.tsx actually imports — that is the point of the test. */
const LOADED_WORKSPACE_CSS = WORKSPACE_STYLESHEETS.map((s) =>
  readFileSync(resolve(ROOT, "src", s.slice(2)), "utf8"),
)
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ");

describe("the loaded stylesheets define what the components render", () => {
  const tokens = ccClassTokens(WORKSPACE_COMPONENTS);

  it("finds the cc-* classes the components use (guards against a vacuous scan)", () => {
    expect(tokens.length).toBeGreaterThanOrEqual(5);
    expect(tokens).toContain("cc-measure");
    expect(tokens).toContain("cc-ws-resize-handle");
    expect(tokens).toContain("cc-workspace-overlay");
  });

  it("every one of them has a selector in a stylesheet main.tsx imports", () => {
    const undefinedTokens = tokens.filter(
      // `(?![-\w])` so `.cc-measure` is not satisfied by `.cc-measure-box`.
      (t) => !new RegExp(`\\.${t}(?![-\\w])`).test(LOADED_WORKSPACE_CSS),
    );
    expect(undefinedTokens).toEqual([]);
  });

  it("declares the custom properties the components and Index depend on", () => {
    for (const v of ["--cc-ws-w", "--cc-vvh", "--cc-vv-top", "--cc-ws-hit"]) {
      expect(LOADED_WORKSPACE_CSS).toMatch(new RegExp(`(^|[;{\\s])${v}\\s*:`, "m"));
    }
  });

  it("defines .h-app, which Index.tsx's root element now depends on", () => {
    // Unconditional base first: `h-app` must produce a height on every engine.
    expect(LOADED_WORKSPACE_CSS).toMatch(/\.h-app\s*\{\s*height:\s*100vh;?\s*\}/);
    // The svh upgrade must sit INSIDE the feature query. An unguarded 100svh is
    // an invalid declaration on ~6% of browsers and the shell collapses to
    // `height: auto` with no error.
    expect(LOADED_WORKSPACE_CSS).toMatch(
      /@supports\s*\(\s*height:\s*100svh\s*\)\s*\{[\s\S]*?\.h-app\s*\{\s*height:\s*100svh;?\s*\}/,
    );
    const beforeFeatureQuery = LOADED_WORKSPACE_CSS.slice(0, LOADED_WORKSPACE_CSS.indexOf("@supports"));
    expect(beforeFeatureQuery).toMatch(/\.h-app/);
    expect(beforeFeatureQuery).not.toMatch(/svh/);
    // dvh is throttled and resizes content mid-scroll (D9).
    expect(LOADED_WORKSPACE_CSS).not.toMatch(/\bdvh\b/);
    expect(LOADED_WORKSPACE_CSS).not.toMatch(/\blvh\b/);
  });
});

// ---------------------------------------------------------------------------
// 7. The whole feature is reachable from the app entry, and nothing dangles
// ---------------------------------------------------------------------------

function importGraphFrom(entry: string) {
  const reached = new Set<string>();
  const unresolved: string[] = [];
  const queue = [resolve(ROOT, entry)];
  while (queue.length) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
    for (const spec of specifiersIn(readFileSync(file, "utf8"))) {
      const r = resolveSpec(spec, file);
      if (r === null) continue;
      if (typeof r === "string") queue.push(r);
      else unresolved.push(`${rel(file)} -> ${spec}`);
    }
  }
  return { reached: new Set([...reached].map(rel)), unresolved };
}

describe("static import graph from src/main.tsx", () => {
  const graph = importGraphFrom("src/main.tsx");

  it("resolves every relative and @/ specifier — a deleted file must not stay imported", () => {
    // This is the test that would have caught deleting use-mobile.tsx while a
    // consumer still referenced it.
    expect(graph.unresolved).toEqual([]);
  });

  it.each([
    "src/components/WorkspaceShell.tsx",
    "src/components/WorkspaceResizeHandle.tsx",
    "src/components/WorkspacePanel.tsx",
    "src/hooks/useViewport.ts",
    "src/hooks/useVisualViewportVars.ts",
    "src/lib/workspaceLayout.ts",
    "src/lib/dragShield.ts",
    "src/lib/visualViewport.ts",
    "src/styles/workspace-viewport.css",
    "src/styles/workspace-resize.css",
    "src/styles/workspace-overlay.css",
    "src/styles/workspace-typography.css",
  ])("reaches %s", (file) => {
    // Six workstreams each verified their own files in isolation. This is the
    // only assertion that any of it is wired into the shipping app at all.
    expect(graph.reached.has(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. The ResizeObserver-loop error filter — EXECUTED, not grepped
// ---------------------------------------------------------------------------

type FakeEvent = { message?: unknown; preventDefault: () => void; stopImmediatePropagation: () => void };
type Registration = { type: string; handler: (e: FakeEvent) => void; capture: unknown };

function loadFilterInstaller(): (
  target: { addEventListener: (t: string, h: (e: FakeEvent) => void, c?: unknown) => void },
  warn: (m: string) => void,
) => () => number {
  const START = "// cc:ro-loop-filter:start";
  const END = "// cc:ro-loop-filter:end";
  const a = MAIN_RAW.indexOf(START);
  const b = MAIN_RAW.indexOf(END);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(
      "main.tsx no longer contains the cc:ro-loop-filter region — the filter was removed or renamed",
    );
  }
  const region = MAIN_RAW.slice(a + START.length, b);
  // The region is deliberately TypeScript-syntax-free so it can run as-is.
  return new Function(`${region}\nreturn installResizeObserverLoopFilter;`)();
}

function harness() {
  const registrations: Registration[] = [];
  const warnings: string[] = [];
  const target = {
    addEventListener(type: string, handler: (e: FakeEvent) => void, capture?: unknown) {
      registrations.push({ type, handler, capture });
    },
  };
  const getCount = loadFilterInstaller()(target, (m) => warnings.push(m));
  /** `omitMessage` builds an event with no `message` property at all, which is
   *  what a hand-constructed ErrorEvent from a library shim looks like. */
  const fire = (message?: unknown, omitMessage = false) => {
    let prevented = 0;
    let stopped = 0;
    const event: FakeEvent = {
      preventDefault: () => { prevented += 1; },
      stopImmediatePropagation: () => { stopped += 1; },
    };
    if (!omitMessage) event.message = message;
    for (const r of registrations) r.handler(event);
    return { prevented, stopped };
  };
  return { registrations, warnings, getCount, fire };
}

const RO_MODERN = "ResizeObserver loop completed with undelivered notifications.";
const RO_LEGACY = "ResizeObserver loop limit exceeded";

describe("main.tsx — the ResizeObserver-loop filter, executed against a fake window", () => {
  it("registers exactly one capture-phase error listener", () => {
    const h = harness();
    expect(h.registrations).toHaveLength(1);
    expect(h.registrations[0].type).toBe("error");
    // Capture, and installed before anything else registers, because
    // stopImmediatePropagation only outranks later listeners.
    expect(h.registrations[0].capture).toBe(true);
  });

  it("swallows the modern Chromium message", () => {
    const h = harness();
    const r = h.fire(RO_MODERN);
    expect(r.prevented).toBe(1);
    expect(r.stopped).toBe(1);
    expect(h.getCount()).toBe(1);
    expect(h.warnings).toEqual([]);
  });

  it("swallows the legacy 'loop limit exceeded' message too", () => {
    const h = harness();
    expect(h.fire(RO_LEGACY).stopped).toBe(1);
    expect(h.getCount()).toBe(1);
  });

  it.each([
    ["a real TypeError", "TypeError: x is not a function", false],
    ["an unrelated ResizeObserver mention", "ResizeObserver is not defined", false],
    ["an empty message", "", false],
    ["a non-string message", 42, false],
    ["a null message", null, false],
    ["no message property at all", undefined, true],
  ])("passes %s straight through", (_label, message, omit) => {
    const h = harness();
    const r = h.fire(message, omit as boolean);
    expect(r.prevented).toBe(0);
    expect(r.stopped).toBe(0);
    expect(h.getCount()).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it("does not throw on a malformed event object", () => {
    const h = harness();
    expect(() => h.registrations[0].handler(null as unknown as FakeEvent)).not.toThrow();
    expect(h.getCount()).toBe(0);
  });

  it("stays silent for the first five, then warns once — a runaway loop is still visible", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.fire(RO_MODERN);
    expect(h.warnings).toEqual([]);
    h.fire(RO_MODERN);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("6");
    expect(h.warnings[0]).toMatch(/ResizeObserver/);
    // …and does not then spam once per frame.
    for (let i = 0; i < 20; i++) h.fire(RO_MODERN);
    expect(h.warnings).toHaveLength(1);
    expect(h.getCount()).toBe(26);
  });

  it("keeps warning sparsely as the count climbs", () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.fire(RO_MODERN);
    expect(h.getCount()).toBe(200);
    // 6, 100, 200.
    expect(h.warnings).toHaveLength(3);
  });

  it("is actually installed on the real window, before React mounts", () => {
    // The extracted region above proves the function is correct. This proves it
    // is called — a filter that is only defined swallows nothing.
    const call = MAIN.indexOf("installResizeObserverLoopFilter(window");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(MAIN.indexOf("createRoot(document.getElementById"));
    expect(MAIN.indexOf("addEventListener")).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// 9. The counsel_workspace_open write — EXECUTED
// ---------------------------------------------------------------------------

function loadWorkspaceOpenEffect(): (
  storage: { setItem: (k: string, v: string) => void },
  workspaceOpen: boolean,
) => void {
  const anchor = CHAT_PANEL_RAW.indexOf('localStorage.setItem("counsel_workspace_open"');
  if (anchor < 0) throw new Error("ChatPanel no longer writes counsel_workspace_open");
  const open = "useEffect(() => {";
  const start = CHAT_PANEL_RAW.lastIndexOf(open, anchor);
  const end = CHAT_PANEL_RAW.indexOf("}, [workspaceOpen]);", anchor);
  if (start < 0 || end < 0) throw new Error("could not delimit the counsel_workspace_open effect");
  const body = CHAT_PANEL_RAW.slice(start + open.length, end);
  return new Function("localStorage", "workspaceOpen", body) as (
    storage: { setItem: (k: string, v: string) => void },
    workspaceOpen: boolean,
  ) => void;
}

describe("ChatPanel — the workspace-open write, executed", () => {
  const runEffect = loadWorkspaceOpenEffect();

  it("writes the unchanged key and values (R6)", () => {
    const calls: string[][] = [];
    const storage = { setItem: (k: string, v: string) => { calls.push([k, v]); } };
    runEffect(storage, true);
    runEffect(storage, false);
    expect(calls).toEqual([
      ["counsel_workspace_open", "1"],
      ["counsel_workspace_open", "0"],
    ]);
  });

  it("survives a throwing localStorage — this was the repo's only unguarded write", () => {
    // Safari private mode and quota exhaustion both throw here, and this runs
    // inside an effect: an unhandled throw unmounts the whole ChatPanel.
    const storage = {
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
    };
    expect(() => runEffect(storage, true)).not.toThrow();
    expect(() => runEffect(storage, false)).not.toThrow();
  });

  it("survives localStorage being absent entirely", () => {
    expect(() => runEffect(undefined as never, true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. Meta — the comment stripper is neither blind nor over-eager
// ---------------------------------------------------------------------------

describe("meta: the comment stripper", () => {
  it("removes commentary, including the comment that names <Sheet> and isMobile", () => {
    // Load-bearing, not decorative: the replacement comment in ChatPanel names
    // both `<Sheet>` and `isMobile` while explaining why they were deleted, so
    // the "they are gone" assertions above would fail on their own rationale if
    // the stripper were a no-op — and would pass vacuously if it ate the file.
    expect(CHAT_PANEL_RAW).toContain("<Sheet>");
    expect(CHAT_PANEL_RAW).toContain("isMobile");
    expect(CHAT_PANEL).not.toContain("<Sheet>");
    expect(CHAT_PANEL).not.toContain("isMobile");
    // `WorkspacePanel` is absent from the raw file too — the shell is now the
    // only thing that names it anywhere outside its own module.
    expect(CHAT_PANEL_RAW).not.toContain("WorkspacePanel");
  });

  it("does not over-strip: real code survives", () => {
    for (const token of [
      "<WorkspaceShell",
      "export default ChatPanel;",
      'className="flex h-full overflow-hidden"',
      "BURPLEXITY_BOT_ASK_URL",
      'localStorage.setItem("counsel_workspace_open"',
    ]) {
      expect(CHAT_PANEL).toContain(token);
    }
    // A stripper that ate half the file would pass every `not.toContain`.
    expect(CHAT_PANEL.length).toBeGreaterThan(CHAT_PANEL_RAW.length * 0.6);
  });

  it("leaves URLs inside string literals alone", () => {
    expect(stripComments('const u = "https://example.com/a";')).toContain("https://example.com/a");
  });
});
