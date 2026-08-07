import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * THE CONTAINING-BLOCK INVARIANT — a standing guard, not a one-off check.
 *
 * `WorkspaceShell` goes `position: fixed` in `drawer` and `full` geometry while
 * remaining a CHILD of ChatPanel's flex row. It is not portalled, and it never
 * can be: a portal is a change of DOM position, and any change of DOM position
 * destroys the artifact iframe's document (spec: removing an iframe runs
 * "destroy a child navigable"). So the overlay's correctness rests entirely on
 * a property of code it does not own — that NO ancestor between
 * `documentElement` and the shell is a containing block for fixed positioning.
 *
 * `transform`, `filter`, `backdrop-filter`, `perspective`, `will-change` on any
 * of those, and `contain: layout/paint/strict/content` (which
 * `container-type: inline-size` implies) all create one. When that happens,
 * "fullscreen" quietly fills the chat column instead of the screen. There is no
 * console error, no failed assertion, no thrown exception — the layout is just
 * wrong, and only on the geometries a desktop reviewer never opens.
 *
 * This repo has already lived through exactly this failure once: aurora's
 * `backdrop-filter` glass bubbles confined `MediaFrame`'s fullscreen to a chat
 * bubble, which is why `src/index.css:779-787` exists. The audit for this ship
 * found the chain clean. This file is what keeps it clean — it is the only
 * automated thing standing between a stray `backdrop-blur-xl` on a layout div
 * and a silently broken landscape phone.
 *
 * The chain, verified against the source below:
 *
 *   Index.tsx      <div className="flex flex-col h-app bg-background">
 *     └ Index.tsx  <div className="flex flex-1 overflow-hidden">
 *         └ Index  <div className="flex-1 overflow-hidden pb-20 md:pb-0">
 *             └ ChatPanel <div className="flex h-full overflow-hidden">
 *                 └ WorkspaceShell root
 *
 * `overflow: hidden` on those ancestors is deliberately NOT flagged: a fixed
 * box whose containing block is the viewport is not clipped by an ancestor's
 * overflow. Only the containing-block triggers matter.
 */

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** Strip comments so an ABSENCE scan asserts on code, not on the prose that
 *  explains the rule. Every file here documents why these properties are
 *  forbidden; a naive scan would fail on its own rationale, and a test that
 *  punishes you for writing down the reason gets deleted. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const FILES = {
  "src/pages/Index.tsx": src("src/pages/Index.tsx"),
  "src/components/ChatPanel.tsx": src("src/components/ChatPanel.tsx"),
  "src/components/WorkspaceShell.tsx": src("src/components/WorkspaceShell.tsx"),
  "src/components/WorkspacePanel.tsx": src("src/components/WorkspacePanel.tsx"),
} as const;

const OVERLAY_CSS = src("src/styles/workspace-overlay.css");

/**
 * Tailwind class names that produce a containing block.
 *
 * Matched per TOKEN, never as a substring, because the substring version is
 * wrong in both directions: `overscroll-contain` (which the shell legitimately
 * uses, and which sets `overscroll-behavior`, nothing to do with `contain`)
 * would false-positive, and `filter` hidden inside a longer utility would be
 * missed.
 */
const CB_CLASS_PATTERNS: RegExp[] = [
  /^transform$/,
  /^transform-/,
  /^(translate|rotate|scale|skew)-/,
  /^-?(translate|rotate|scale|skew)-/,
  /^filter$/,
  /^blur(-|$)/,
  /^backdrop-(blur|filter|invert|opacity|saturate|sepia|grayscale|contrast|brightness|hue-rotate)/,
  /^will-change-/,
  /^contain-/,
  /^perspective/,
  /^cc-container$/,
];

/** Raw CSS properties that produce a containing block, matched at a
 *  declaration boundary so `background:` and `padding-block-start:` cannot
 *  trip the `contain` / `filter` entries. */
const CB_DECLARATION =
  /(^|[;{}\s])(transform|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|container-type|will-change)\s*:/;

function tokensOf(classNames: string): string[] {
  return classNames.split(/\s+/).filter(Boolean);
}

function offendingTokens(classNames: string): string[] {
  return tokensOf(classNames).filter((t) => CB_CLASS_PATTERNS.some((re) => re.test(t)));
}

/** The single source line carrying an anchor, or `null`. */
function lineWith(source: string, anchor: RegExp): string | null {
  return source.split("\n").find((l) => anchor.test(l)) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("no containing-block trigger anywhere on the workspace ancestor chain", () => {
  /**
   * Each entry is one element of the chain, found by a stable anchor rather
   * than a line number. If WS-E's edits change one of these, the lookup fails
   * loudly here instead of the invariant quietly going unchecked.
   *
   * The Index root tolerates `h-screen` OR `h-app` on purpose: WS-E swaps that
   * one token, and this test must not become the thing that blocks it.
   */
  const CHAIN: Array<{ file: keyof typeof FILES; anchor: RegExp; label: string }> = [
    {
      file: "src/pages/Index.tsx",
      anchor: /className="flex flex-col h-(?:screen|app) bg-background"/,
      label: "Index app shell",
    },
    {
      file: "src/pages/Index.tsx",
      anchor: /className="flex flex-1 overflow-hidden"/,
      label: "Index tablet-rail row",
    },
    {
      file: "src/pages/Index.tsx",
      anchor: /className="flex-1 overflow-hidden pb-20 md:pb-0"/,
      label: "Index tab content",
    },
    {
      file: "src/components/ChatPanel.tsx",
      anchor: /<div className="flex h-full overflow-hidden">/,
      label: "ChatPanel row (the shell's parent, and the dock width budget)",
    },
  ];

  for (const { file, anchor, label } of CHAIN) {
    it(`${label} still exists and creates no containing block`, () => {
      const line = lineWith(FILES[file], anchor);
      expect(line, `${label} not found in ${file} — the chain moved; re-audit it`).not.toBeNull();

      const classAttr = /className="([^"]*)"/.exec(line!);
      expect(classAttr).not.toBeNull();
      expect(offendingTokens(classAttr![1])).toEqual([]);

      // An inline style on the same element would do it too, and the class
      // scan above would never see it.
      expect(CB_DECLARATION.test(line!)).toBe(false);
    });
  }

  it("the chain is exactly four elements deep and each is a distinct anchor", () => {
    // Guards against an anchor silently matching the same line twice, which
    // would make one of the four assertions above a duplicate of another.
    const found = CHAIN.map(({ file, anchor }) => `${file}::${lineWith(FILES[file], anchor)}`);
    expect(new Set(found).size).toBe(CHAIN.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("no containing-block trigger inside the workspace itself", () => {
  for (const [name, source] of Object.entries(FILES)) {
    it(`${name} declares no container-type / cc-container / will-change`, () => {
      const stripped = code(source);
      for (const token of ["container-type", "cc-container", "will-change"]) {
        expect(stripped, `${token} in ${name} would trap position: fixed`).not.toContain(token);
      }
    });
  }

  it("neither the shell nor the panel puts a blur on a structural element", () => {
    // A `backdrop-blur` on a layout div is the exact shape of the aurora
    // incident: the class looks decorative, and it silently reparents the
    // fullscreen overlay.
    for (const name of [
      "src/components/WorkspaceShell.tsx",
      "src/components/WorkspacePanel.tsx",
    ] as const) {
      const structural = code(FILES[name])
        .split("\n")
        .filter((l) => l.includes("flex-1") || l.includes("h-full"));
      expect(structural.length).toBeGreaterThan(0);
      for (const line of structural) {
        expect(line, `${name}: blur on a structural line`).not.toContain("backdrop-blur");
        expect(offendingTokens(line)).toEqual([]);
      }
    }
  });

  it("every one of the shell's three geometry class strings is trigger-free", () => {
    const shell = code(FILES["src/components/WorkspaceShell.tsx"]);
    const block = /const SHELL_CLASS: Record<WorkspaceGeometry, string> = \{([\s\S]*?)\};/.exec(shell);
    expect(block, "SHELL_CLASS lookup not found — did the geometry table move?").not.toBeNull();

    const literals = [...block![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    // dock, drawer, full — plus the wrapped continuation of the drawer string.
    expect(literals.length).toBeGreaterThanOrEqual(3);

    const all = literals.join(" ");
    expect(offendingTokens(all)).toEqual([]);
    // …and the scan is not vacuous: it really did see the geometry classes.
    expect(tokensOf(all)).toContain("z-[100]");
    expect(tokensOf(all)).toContain("shrink-0");
    // `overscroll-contain` is present and MUST NOT be flagged — it sets
    // overscroll-behavior, which has nothing to do with `contain`.
    expect(tokensOf(all)).toContain("overscroll-contain");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("workspace-overlay.css", () => {
  const stripped = OVERLAY_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

  it("declares no containing-block property", () => {
    const offending = stripped
      .split(/[\n;]/)
      .filter((l) => CB_DECLARATION.test(l))
      .map((l) => l.trim());
    expect(offending).toEqual([]);
  });

  it("the comment stripper is doing real work here", () => {
    // The file argues at length about transform/filter/contain; if stripping
    // ever stopped working the test above would fail for the wrong reason, and
    // if it started eating code the test above would pass vacuously.
    expect(OVERLAY_CSS).toContain("transform");
    expect(stripped).not.toContain("transform");
    expect(stripped).toContain(".cc-workspace-overlay {");
    expect(stripped).toContain("max-height: var(--cc-vvh, 100%)");
  });

  it("contains the overlay, so its `overscroll-contain` class is not inert", () => {
    // `overscroll-behavior` only takes effect on a scroll container. Without
    // `overflow: hidden` here the class on the shell root does nothing and a
    // flick inside the file list rubber-bands the app behind the drawer — and
    // on Android can reach pull-to-refresh, i.e. a reload, which takes the
    // artifact iframe with it.
    expect(stripped).toMatch(/\.cc-workspace-overlay\s*\{[^}]*overflow:\s*hidden/);
  });

  it("consumes WS-D's viewport variables with working fallbacks", () => {
    // If `workspace-viewport.css` is not imported, `--cc-vvh` has no
    // declaration at all — the literal fallbacks here are what stop the
    // landscape drawer from running under the soft keyboard.
    expect(stripped).toContain("var(--cc-vvh, 100%)");
    expect(stripped).toContain("var(--cc-vv-top, 0px)");
  });

  it("guards every safe-area inset and keeps it on the panel box", () => {
    // The handle's hit area grows INBOARD into `padding-inline-start`
    // (workspace-resize.css). If the inset moved to the shell root — outboard
    // of the handle — that extension would start stealing taps from real panel
    // content, on notched phones in landscape only.
    expect(stripped).toMatch(
      /\.cc-workspace-inset\s*\{[^}]*padding-inline-start:\s*max\(0\.5rem,\s*env\(safe-area-inset-left, 0px\)\)/,
    );
    expect(stripped).toMatch(/padding-inline-end:\s*max\(0\.5rem,\s*env\(safe-area-inset-right, 0px\)\)/);
    expect(stripped).toContain("env(safe-area-inset-top, 0px)");
    expect(stripped).toContain("env(safe-area-inset-bottom, 0px)");
    // Every env() carries a fallback, so a browser without safe-area support
    // gets 0 rather than an invalid declaration.
    for (const call of stripped.match(/env\([^)]*\)/g) ?? []) {
      expect(call, `${call} has no fallback`).toContain(", 0px");
    }
  });

  it("imports nothing and fetches nothing (the CSP is frozen)", () => {
    // On the STRIPPED text: the header comment names both of these as things
    // the file must not do, and a scan that cannot survive its own
    // documentation is a scan that gets deleted.
    expect(stripped).not.toContain("@import");
    expect(stripped).not.toContain("url(");
    expect(stripped).not.toContain("@apply");
  });
});
