import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import WorkspaceShell from "@/components/WorkspaceShell";
import { useWorkspaceItems, workspaceStore } from "@/lib/workspaceStore";
import type { WorkspaceItemKind } from "@/lib/workspaceFiles";
import { readViewport } from "@/hooks/useViewport";
import {
  DEFAULT_WIDTHS,
  WORKSPACE_WIDTH_KEY,
  readStoredWidths,
  resolveGeometry,
  type WorkspaceGeometry,
} from "@/lib/workspaceLayout";

/**
 * ============================================================================
 *  WORKSPACE LAB — a dev-only measuring instrument for the resizable /
 *  landscape-aware Workspace viewer.  Route: #/workspace-lab
 * ============================================================================
 *
 * WHY IT EXISTS
 * Every other surface in this app sits behind an auth wall, so the layout
 * changes in this ship (drag-to-resize, three geometries, fullscreen) could
 * only be reviewed by reading the diff. That is not verification. This page
 * mounts the REAL `WorkspaceShell` — not a copy — with no session required,
 * seeds one fixture of every workspace kind, and turns the four invariants
 * that are otherwise INVISIBLE into numbers you can read at a glance:
 *
 *   1. THE MINI-APP MUST NEVER RELOAD.  A sandboxed artifact iframe is
 *      opaque-origin, so `contentWindow` is unreachable and a remount leaves
 *      no trace in the console — the mini-app simply starts over. The `html`
 *      fixture therefore mints a UUID on load and postMessages it up with a
 *      tick count; this page counts how many times that id has CHANGED.
 *      "mount changes: 0" across a drag, a resize, a rotation and a
 *      fullscreen round-trip is the whole ballgame.
 *
 *   2. THE DRAG MUST SURVIVE CROSSING THE ARTIFACT.  Pointer capture alone
 *      does not work over an opaque-origin sandboxed frame (measured: only
 *      `pointerdown` is ever delivered), which is why the drag mounts a
 *      transparent full-viewport shield. The only way to SEE that working is
 *      a window-level capture-phase recorder, which is the second panel here.
 *
 *   3. FULLSCREEN MUST FILL THE VIEWPORT, not some ancestor that quietly
 *      gained a `transform`/`filter`/`contain` and became a containing block.
 *      That failure is visual-only with no console error, so this page
 *      compares the shell's rect against the layout viewport every frame.
 *
 *   4. WIDENING MUST IMPROVE THE CONTENT, not just grow margins. The prose
 *      measure is reported as a live pixel width next to the panel width.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not re-implement anything. Geometry comes from `resolveGeometry`,
 * the viewport from `readViewport`, the fixtures from `workspaceStore.addFile`
 * — the same functions production uses. An instrument that computes its own
 * answer cannot disagree with the code under test, and disagreeing is the
 * single most useful thing it can do (see the "geometry cross-check" row).
 *
 * IT ALSO DOES NOT PERTURB WHAT IT MEASURES. Every live value is written to
 * the DOM imperatively from ONE rAF loop. There is no React state behind the
 * readout, because a `setState` per pointer event is exactly the cost this
 * ship exists to avoid, and a re-render of this page re-renders the shell —
 * which is the thing under test.
 *
 * PRODUCTION SAFETY
 * `src/App.tsx` registers this route inside `import.meta.env.DEV`, which Vite
 * statically replaces, so the ternary folds to `null` in a production build
 * and the dynamic import is dropped from the module graph. The route is not
 * merely unreachable in production; the chunk is not emitted. (Verify:
 * `npm run build` then grep `dist/` for "WorkspaceLab" and "workspace-lab".)
 * Nothing here imports from a test file.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * THE MOUNT-IDENTITY INSTRUMENT.
 *
 * This is the `html` fixture's body markup. `buildArtifactDoc` wraps it in the
 * locked-down artifact CSP and `public/artifact-frame.html` writes it into an
 * opaque-origin `sandbox="allow-scripts"` frame. That frame can reach exactly
 * one thing outside itself — `window.parent.postMessage` — so that is the only
 * channel, and this page never tries to read INTO the frame.
 *
 * Contract with the page: every 250 ms it posts
 *   { type: "lab-artifact", mount, ticks, clicks, ageMs }
 * `mount` is minted once per document. If the iframe is destroyed and
 * recreated — by a reparent, a changed `key`, a moved JSX position — the new
 * document mints a NEW id and every counter restarts at zero. That is the
 * signal. There is no other way to observe it.
 *
 * Kept free of backticks and of `${` on purpose: `src/test/workspaceLab.test.ts`
 * extracts this literal from the source between the markers below and actually
 * EXECUTES its script, so the extraction has to be exact.
 */
// ==LAB-HTML-FIXTURE-START==
const LAB_HTML_FIXTURE = `
<div id="lab">
  <h1>Mount-identity instrument</h1>
  <p class="lead">
    Everything below is minted once, when this document loads. If any of it
    resets, the iframe was destroyed and rebuilt — which is the failure this
    whole ship is designed to prevent.
  </p>
  <dl>
    <dt>mount id</dt><dd id="mount" class="mono">(minting…)</dd>
    <dt>ticks (250&#8202;ms)</dt><dd id="ticks" class="mono">0</dd>
    <dt>alive for</dt><dd id="age" class="mono">0.0 s</dd>
    <dt>clicks</dt><dd id="clicks" class="mono">0</dd>
  </dl>
  <button id="bump" type="button">Click me — this counter is in-frame state</button>
  <div class="bar"><div id="fill"></div></div>
  <p class="note">
    Interact with this box (click a few times, let the bar sweep), then drag the
    workspace edge, rotate, and toggle fullscreen. If the click count and the
    mount id are unchanged afterwards, the mini-app was never reloaded.
  </p>
</div>
<style>
  #lab { font: 14px/1.5 system-ui, sans-serif; color: #0f172a; }
  h1 { font-size: 15px; margin: 0 0 6px; }
  .lead, .note { font-size: 12px; color: #475569; margin: 0 0 10px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 10px; }
  dt { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
  dd { margin: 0; font-weight: 600; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
  button { font: inherit; padding: 6px 12px; border: 1px solid #cbd5e1; border-radius: 8px;
           background: #f8fafc; cursor: pointer; min-height: 44px; }
  .bar { height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 10px 0; }
  #fill { height: 100%; width: 0; background: #0ea5e9; transition: width .2s linear; }
</style>
<script>
(function () {
  "use strict";
  function newMountId() {
    try {
      if (self.crypto && typeof self.crypto.randomUUID === "function") {
        return self.crypto.randomUUID();
      }
    } catch (e) { /* opaque origins are still secure contexts, but never assume */ }
    return "nouuid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  var mount = newMountId();
  var ticks = 0;
  var clicks = 0;
  var born = Date.now();

  function el(id) { return document.getElementById(id); }
  function set(id, text) { var n = el(id); if (n) n.textContent = text; }

  set("mount", mount);

  var bump = el("bump");
  if (bump) {
    bump.addEventListener("click", function () {
      clicks = clicks + 1;
      set("clicks", String(clicks));
      report();
    });
  }

  function report() {
    try {
      window.parent.postMessage({
        type: "lab-artifact",
        mount: mount,
        ticks: ticks,
        clicks: clicks,
        ageMs: Date.now() - born
      }, "*");
    } catch (e) { /* nothing else to try — this is the only channel out */ }
  }

  setInterval(function () {
    ticks = ticks + 1;
    set("ticks", String(ticks));
    set("age", ((Date.now() - born) / 1000).toFixed(1) + " s");
    var fill = el("fill");
    if (fill) fill.style.width = String((ticks % 40) * 2.5) + "%";
    report();
  }, 250);

  report();
})();
</script>
`;
// ==LAB-HTML-FIXTURE-END==

/** A 1000-unit sheet. At a 900 px panel this renders 2.5x life size, which is
 *  the case that made `SvgArtifactViewer`'s 100 % zoom FLOOR a bug — there was
 *  no way to zoom out. Keep the viewBox large so that stays testable. */
const LAB_SVG_FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="1000" height="700">
  <rect x="0" y="0" width="1000" height="700" fill="#0b1220"/>
  <g stroke="#1e293b" stroke-width="1">
    ${Array.from({ length: 19 }, (_, i) => `<line x1="${(i + 1) * 50}" y1="0" x2="${(i + 1) * 50}" y2="700"/>`).join("")}
    ${Array.from({ length: 13 }, (_, i) => `<line x1="0" y1="${(i + 1) * 50}" x2="1000" y2="${(i + 1) * 50}"/>`).join("")}
  </g>
  <rect x="60" y="60" width="880" height="580" fill="none" stroke="#38bdf8" stroke-width="3"/>
  <text x="80" y="110" fill="#e2e8f0" font-family="monospace" font-size="34">LAB SHEET — 1000 x 700 units</text>
  <text x="80" y="150" fill="#94a3b8" font-family="monospace" font-size="20">zoom floor probe: at a 900px panel this is 2.5x life size</text>
  <circle cx="500" cy="400" r="150" fill="none" stroke="#f472b6" stroke-width="4"/>
  <text x="500" y="408" fill="#f472b6" font-family="monospace" font-size="24" text-anchor="middle">50% must exist</text>
</svg>`;

const LAB_RESEARCH_FIXTURE = [
  "# Line length, and why a wider panel is not automatically a better panel",
  "",
  "The single most-filed complaint about resizable side panels is not that the drag is janky. It is that dragging the panel wider produces nothing but a wider expanse of empty margin on either side of a text column that never changes, so the user pays a gesture and receives no information. This fixture exists to make that failure visible: if the measure cap is working, the paragraph you are reading now stops growing at roughly seventy-eight characters and centres itself, and the readout on the left reports a prose width that is smaller than the panel width. If the cap lost its specificity fight, this paragraph will run the entire width of the panel and the two numbers will be equal.",
  "",
  "## What good looks like",
  "",
  "Typographic research has converged on a measure of somewhere between sixty and eighty characters per line for sustained reading. Below that, the eye returns too often and the rhythm of the paragraph breaks down. Above it, the return sweep starts to miss, and the reader loses their place at the start of the next line often enough to be tiring rather than merely inelegant. Seventy-eight characters sits at the comfortable end of that range and leaves room for the occasional long identifier or URL without forcing a break.",
  "",
  "## The three widths involved",
  "",
  "| Thing | Grows with the drag | Should it? |",
  "|---|---|---|",
  "| Panel width | yes | yes — it is what you dragged |",
  "| Prose column | up to the cap | yes, then no |",
  "| Code / table / image | yes | yes — these are the reason to widen |",
  "",
  "The distinction matters. A research report is mostly prose, and prose wants a cap. But the same report often carries a wide table or a long code sample, and those want every pixel you can give them. Capping the container would ruin them, which is why the cap belongs on the text flow and not on the panel.",
  "",
  "## A code sample, which should use the full width",
  "",
  "```ts",
  "export function resolvePanelPx(fraction: number, containerPx: number, geometry: WorkspaceGeometry): number {",
  "  return clampPanelPx(fractionToPx(clampFraction(fraction), containerPx), containerPx, geometry);",
  "}",
  "```",
  "",
  "## Checklist for the reviewer",
  "",
  "1. Drag the panel from its narrowest to its widest and watch the reported prose width.",
  "2. Confirm the prose width stops climbing while the panel width keeps climbing.",
  "3. Confirm the table above and the code block above still use the full panel width.",
  "4. Confirm the headings reflow rather than truncate.",
  "5. Rotate to landscape and confirm the drawer is usable rather than a sliver.",
  "",
  "If any of those fail, the fix is not in this document — it is in the stylesheet that defines the measure, and most likely in whether its selector is specific enough to beat the theme rule it is competing with.",
].join("\n");

/** ~340 lines, deterministic (no clock, no randomness) so the store's
 *  content fingerprint is stable and re-seeding dedupes instead of stacking. */
function buildCodeFixture(): string {
  const head = [
    "// lab/pipeline.ts — gutter stress fixture for the Workspace viewer.",
    "//",
    "// Deliberately long: the inert file viewer drops its line-number gutter",
    "// past 2000 lines, and memoises the gutter string below that. This file",
    "// sits in the memoised range so a re-render that is NOT memoised shows up",
    "// as jank you can feel while dragging.",
    "",
    "export interface Stage<I, O> {",
    "  name: string;",
    "  run(input: I): Promise<O>;",
    "}",
    "",
  ];
  const body: string[] = [];
  for (let i = 0; i < 40; i++) {
    body.push(
      `export class Stage${i} implements Stage<Input${i}, Output${i}> {`,
      `  readonly name = "stage-${i}";`,
      `  private retries = ${i % 5};`,
      "",
      `  async run(input: Input${i}): Promise<Output${i}> {`,
      `    const started = performance.now();`,
      `    const value = normalize${i}(input);`,
      `    if (!value) throw new Error("stage-${i}: refusing to emit an empty record");`,
      `    return { value, elapsedMs: performance.now() - started };`,
      "  }",
      "}",
      "",
    );
  }
  const tail = [
    "export const PIPELINE = [",
    ...Array.from({ length: 40 }, (_, i) => `  new Stage${i}(),`),
    "];",
    "",
    "export async function runPipeline(input: unknown): Promise<unknown> {",
    "  let carry: unknown = input;",
    "  for (const stage of PIPELINE) {",
    "    carry = await stage.run(carry as never);",
    "  }",
    "  return carry;",
    "}",
  ];
  return [...head, ...body, ...tail].join("\n");
}

const LAB_CODE_FIXTURE = buildCodeFixture();

const LAB_DATA_FIXTURE = JSON.stringify(
  {
    probe: "workspace-lab",
    viewports: [
      { label: "iPhone 16 portrait", width: 393, height: 852, expect: "full" },
      { label: "iPhone 16 landscape", width: 852, height: 393, expect: "drawer" },
      { label: "Galaxy S24 landscape", width: 780, height: 360, expect: "drawer" },
      { label: "iPhone 16 Pro Max landscape", width: 956, height: 440, expect: "drawer" },
      { label: "iPad portrait", width: 768, height: 1024, expect: "drawer" },
      { label: "Laptop", width: 1440, height: 900, expect: "dock" },
      { label: "WCAG 1.4.10 horizontal floor", width: 1280, height: 256, expect: "drawer" },
    ],
    invariants: ["iframe never remounts", "shield keeps the drag alive", "fullscreen fills the viewport"],
  },
  null,
  2,
);

const LAB_TEXT_FIXTURE = [
  "WORKSPACE LAB — running order",
  "=============================",
  "",
  "Probe 1 — the mini-app must never reload",
  "  a. Open the HTML fixture. Click its button three or four times.",
  "  b. Press 'force remount (control)' ONCE. 'mount changes' must go to",
  "     '0 unexplained / 1 total' and the verdict must stop saying UNVERIFIED.",
  "     Until you have done this, a reading of 0 proves nothing — it may just",
  "     mean the instrument is broken.",
  "  c. Now do the real thing, and touch NOTHING else: drag the edge, resize",
  "     the window across 900px, enter and exit fullscreen, rotate. The",
  "     UNEXPLAINED count must stay at 0, and the in-frame click count must",
  "     still show the clicks you made in step (a).",
  "  Note: opening/closing the workspace and switching files destroy the frame",
  "  on purpose. Those are counted as EXPECTED and listed as such in the",
  "  history. Do not do them mid-probe or you lose the click count.",
  "",
  "Probe 2 — the drag must survive crossing the artifact",
  "  Press and hold on the resize handle, sweep the pointer deep into the",
  "  artifact, and release. The gesture summary must show at least two",
  "  pointermove events and one pointerup. Zero moves means the shield is not",
  "  mounting and the drag is dying at the iframe boundary.",
  "",
  "Probe 4 — fullscreen must fill the viewport",
  "  Enter fullscreen. The 'fullscreen rect' row must read PASS. A FAIL means",
  "  an ancestor gained transform / filter / contain and became the containing",
  "  block — a silent, visual-only failure with no console error.",
  "",
  "Probe 5 — rotation",
  "  Use the viewport buttons for a fast read, then repeat with the browser's",
  "  device toolbar. The buttons only fake what JavaScript reads; CSS units and",
  "  media queries still see the real window.",
  "",
  "Probe 6 — widening must improve the content",
  "  Open the research fixture and drag wider. 'prose width' must stop climbing",
  "  while 'panel width' keeps climbing.",
].join("\n");

const LAB_TOOL_FIXTURE = [
  "// A forged tool's source, as the Foundry stores it.",
  "// Present here only so the Workspace list has one item of every kind.",
  "async function run(args, caps) {",
  "  const { width, height } = args;",
  "  if (typeof width !== 'number' || typeof height !== 'number') {",
  "    throw new Error('width and height must be numbers');",
  "  }",
  "  const geometry =",
  "    width < 600 ? 'full' : width >= 900 && height >= 480 ? 'dock' : 'drawer';",
  "  return { geometry, width, height };",
  "}",
].join("\n");

interface LabFixture {
  key: string;
  title: string;
  kind: WorkspaceItemKind;
  language?: string;
  content: string;
  meta?: { source?: string; query?: string; citations?: { title?: string; url: string }[] };
}

const LAB_FIXTURES: LabFixture[] = [
  { key: "html", title: "Mount-identity instrument (probe 1)", kind: "html", content: LAB_HTML_FIXTURE },
  { key: "svg", title: "Lab sheet 1000x700 (zoom-floor probe)", kind: "svg", content: LAB_SVG_FIXTURE },
  {
    key: "research",
    title: "Line length and the measure cap (probe 6)",
    kind: "research",
    content: LAB_RESEARCH_FIXTURE,
    meta: {
      source: "Workspace Lab",
      query: "measure cap",
      citations: [
        { title: "WCAG 2.2 — Reflow (1.4.10)", url: "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html" },
        { title: "WAI-ARIA APG — Window Splitter", url: "https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/" },
      ],
    },
  },
  { key: "code", title: "pipeline.ts (gutter stress, 340 lines)", kind: "code", language: "ts", content: LAB_CODE_FIXTURE },
  { key: "text", title: "Running order for the probes", kind: "text", language: "text", content: LAB_TEXT_FIXTURE },
  { key: "data", title: "Device matrix (json)", kind: "data", language: "json", content: LAB_DATA_FIXTURE },
  { key: "tool", title: "resolve_geometry (tool source)", kind: "tool", language: "js", content: LAB_TOOL_FIXTURE },
];

/** A deleted fixture is re-seeded at most this many times, so the panel's own
 *  delete button stays testable instead of fighting a self-healing loop. */
const MAX_SEED_ATTEMPTS = 4;

/**
 * How long after a deliberate change (open/close, selection, control button) a
 * new mount id is still ATTRIBUTABLE to it rather than being a defect.
 *
 * This constant is the difference between an instrument and a rumour. Selecting
 * a different file, closing the workspace, or pressing the positive control all
 * destroy the frame on purpose — a counter that cannot tell those apart from an
 * accidental reparent reports a number nobody can act on. So every mount change
 * is stamped with the last deliberate action and how long ago it happened, and
 * only the ones with no such explanation are counted against the ship.
 *
 * 2.5 s is generous on purpose: an artifact frame has to load `artifact-frame.html`
 * and take one `postMessage` handshake before the fixture's own script runs, and
 * a false "UNEXPLAINED" would be worse than a slightly wide window. The actual
 * delay is printed on every history line, so the judgement stays auditable.
 */
const SEAM_GRACE_MS = 2500;

// ---------------------------------------------------------------------------
// Simulated viewport
// ---------------------------------------------------------------------------

interface Preset {
  label: string;
  width: number;
  height: number;
}

const PRESETS: Preset[] = [
  { label: "1440x900 laptop", width: 1440, height: 900 },
  { label: "852x393 iPhone 16 landscape", width: 852, height: 393 },
  { label: "780x360 Galaxy S24 landscape", width: 780, height: 360 },
  { label: "393x852 iPhone 16 portrait", width: 393, height: 852 },
  { label: "956x440 Pro Max landscape", width: 956, height: 440 },
  { label: "768x1024 iPad portrait", width: 768, height: 1024 },
  { label: "1280x256 WCAG floor", width: 1280, height: 256 },
  { label: "320x568 narrowest", width: 320, height: 568 },
];

const GEOMETRIES: WorkspaceGeometry[] = ["dock", "drawer", "full"];

/**
 * "Force dock / drawer / full" is asked for by name (amendment A2 item 6), but
 * a button that SETS the geometry directly would be testing the lab, not the
 * app. So each one is derived: it picks the first real device preset that
 * `resolveGeometry` — the actual shipping kernel — maps to that geometry, and
 * drives the app through the same viewport path a real rotation would.
 *
 * The derivation is also a live assertion. If a threshold moves and no preset
 * lands in some geometry any more, the corresponding button reports itself as
 * unreachable instead of quietly doing the wrong thing.
 */
function presetForGeometry(g: WorkspaceGeometry): Preset | undefined {
  return PRESETS.find((p) => resolveGeometry({ width: p.width, height: p.height, touchPrimary: false }) === g);
}

/**
 * Shadow `window.innerWidth` / `innerHeight` with own accessors, then fire a
 * `resize` so `useViewport` re-samples. This drives the REAL geometry path —
 * `readViewport` -> `resolveGeometry` -> the shell's class swap — without
 * touching the OS window.
 *
 * ITS LIMIT IS THE POINT AND IS PRINTED ON THE PAGE: CSS never sees this. `vw`,
 * `vh`, `svh`, `@media`, and `env(safe-area-inset-*)` all still resolve against
 * the real window. So a simulated 852x393 proves the JS geometry decision and
 * NOTHING about how the drawer actually looks on a landscape phone. Use the
 * browser's device toolbar for that.
 *
 * The original property descriptors are captured before the first override and
 * restored exactly on release, because `delete window.innerWidth` is only
 * correct if the property was inherited — which differs between engines.
 */
let overrideActive = false;
let savedWidthDesc: PropertyDescriptor | undefined;
let savedHeightDesc: PropertyDescriptor | undefined;

function restoreDescriptor(name: "innerWidth" | "innerHeight", saved: PropertyDescriptor | undefined) {
  if (saved) Object.defineProperty(window, name, saved);
  else delete (window as unknown as Record<string, unknown>)[name];
}

function setViewportOverride(next: Preset | null): void {
  if (typeof window === "undefined") return;
  if (next) {
    if (!overrideActive) {
      savedWidthDesc = Object.getOwnPropertyDescriptor(window, "innerWidth");
      savedHeightDesc = Object.getOwnPropertyDescriptor(window, "innerHeight");
      overrideActive = true;
    }
    Object.defineProperty(window, "innerWidth", { configurable: true, get: () => next.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => next.height });
  } else if (overrideActive) {
    restoreDescriptor("innerWidth", savedWidthDesc);
    restoreDescriptor("innerHeight", savedHeightDesc);
    overrideActive = false;
    savedWidthDesc = undefined;
    savedHeightDesc = undefined;
  }
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("orientationchange"));
}

/** The layout viewport, which an override cannot fake. This is what a
 *  `position: fixed; inset: 0` element is sized against, so it — not
 *  `window.innerWidth`, which includes the scrollbar — is the correct
 *  comparison for the fullscreen rect check. */
function layoutViewport(): { w: number; h: number } {
  const de = document.documentElement;
  return { w: de.clientWidth, h: de.clientHeight };
}

// ---------------------------------------------------------------------------
// Small readout helpers
// ---------------------------------------------------------------------------

const TONE = {
  pass: "#7fd67f",
  fail: "#ff8080",
  warn: "#e8c46a",
  dim: "#8a94a6",
  plain: "#dce3ee",
} as const;

type Tone = keyof typeof TONE;

/** `n/a` means the probe has not been run. It never means "passed". */
type Verdict = "pass" | "fail" | "unverified" | "n/a";

/** The headline is red if ANY probe failed, amber if any that ran is only
 *  unverified, grey until something has actually been exercised. It is never
 *  green on the strength of probes nobody ran. */
function summarize(v: Record<string, Verdict>): Tone {
  const all = Object.values(v);
  if (all.includes("fail")) return "fail";
  if (all.includes("unverified")) return "warn";
  if (all.includes("pass")) return all.includes("n/a") ? "warn" : "pass";
  return "dim";
}

const round = (n: number, dp = 1): string => (Number.isFinite(n) ? n.toFixed(dp) : "—");

function rectText(r: DOMRect | null): string {
  if (!r) return "—";
  return `x ${round(r.left)}  y ${round(r.top)}  w ${round(r.width)}  h ${round(r.height)}`;
}

/** Which of the three geometry class strings the shell root is actually
 *  wearing. Read from the DOM so it can DISAGREE with what the lab computes —
 *  a mismatch means the shell's lookup table is wrong, and is the one bug a
 *  self-consistent instrument would never find. */
function observedGeometry(el: Element | null): WorkspaceGeometry | "unknown" | "absent" {
  if (!el) return "absent";
  const c = el.classList;
  if (c.contains("fixed") && c.contains("inset-0")) return "full";
  if (c.contains("fixed") && c.contains("inset-y-0")) return "drawer";
  if (c.contains("shrink-0")) return "dock";
  return "unknown";
}

const POINTER_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
] as const;

/**
 * The selectors that identify the resize handle, taken from the frozen D12
 * ARIA contract rather than invented for this page. Only gestures that BEGIN on
 * the handle are judged as drags — otherwise every ordinary button click on
 * this page (one pointerdown, zero moves, one pointerup) would score as a
 * dead drag and paint the verdict red for no reason.
 */
const HANDLE_SELECTOR = '[role="separator"], [aria-label="Resize workspace"]';

/** Below this, a press with no movement is a TAP, not a drag that died. The
 *  distinction matters: a drag killed at the iframe boundary leaves the pointer
 *  down for as long as the user keeps sweeping, so a long press with zero moves
 *  is the real signature of the bug, and a short one is just a click. */
const TAP_MS = 250;

interface Gesture {
  active: boolean;
  down: number;
  move: number;
  up: number;
  cancel: number;
  got: number;
  lost: number;
  frames: number;
  styleWrites: number;
  shieldMax: number;
  startedAt: number;
  endedAt: number;
}

const emptyGesture = (): Gesture => ({
  active: false,
  down: 0,
  move: 0,
  up: 0,
  cancel: 0,
  got: 0,
  lost: 0,
  frames: 0,
  styleWrites: 0,
  shieldMax: 0,
  startedAt: 0,
  endedAt: 0,
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const WorkspaceLab: React.FC = () => {
  const items = useWorkspaceItems();

  // React state is reserved for things that genuinely change the tree. Every
  // measured value below goes through refs + one rAF loop instead, so reading
  // the instrument never re-renders the thing being measured.
  const [open, setOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remountKey, setRemountKey] = useState(0);
  const [presetLabel, setPresetLabel] = useState<string>("auto");
  const [hAppWarning, setHAppWarning] = useState<string>("");

  const rowRef = useRef<HTMLDivElement | null>(null);
  const seedRef = useRef<Record<string, string>>({});
  const attemptsRef = useRef(0);

  // Artifact telemetry (probe 1)
  const artRef = useRef({
    mount: "",
    ticks: 0,
    clicks: 0,
    ageMs: 0,
    /** Every observed change of mount id. */
    changes: 0,
    /** Changes that followed a deliberate action within SEAM_GRACE_MS. */
    explained: 0,
    /** Changes that did not. THIS is the number the ship is judged on. */
    unexplained: 0,
    lastAt: 0,
    history: [] as string[],
    controlPresses: 0,
  });

  /**
   * The last deliberate action that is ALLOWED to destroy the frame, and when.
   * Without this the counter cannot distinguish "the user picked a different
   * file" from "the layout code reparented the iframe", and a probe that cannot
   * make that distinction produces a number no one can act on.
   */
  const seamRef = useRef<{ at: number; what: string }>({ at: Date.now(), what: "initial mount" });

  /** Page state mirrored into a ref, because the readout loop is installed once
   *  with `[]` deps and would otherwise read a stale closure. Seeded from the
   *  live values rather than repeated literals, so changing an initial state
   *  above cannot desynchronise it and manufacture a phantom first seam. */
  const viewRef = useRef({ open, selectedId, remountKey });

  // Pointer telemetry (probe 2)
  const logRef = useRef<{ type: string; n: number }[]>([]);
  const gestureRef = useRef<Gesture>(emptyGesture());
  const lastGestureRef = useRef<Gesture | null>(null);

  // Style-write telemetry (probe 7)
  const moRef = useRef<{ observer: MutationObserver | null; target: Element | null }>({
    observer: null,
    target: null,
  });

  const cellsRef = useRef<Record<string, HTMLElement | null>>({});
  const regCacheRef = useRef<Record<string, (el: HTMLElement | null) => void>>({});
  const reg = useCallback((key: string) => {
    const cache = regCacheRef.current;
    if (!cache[key]) {
      cache[key] = (el: HTMLElement | null) => {
        cellsRef.current[key] = el;
      };
    }
    return cache[key];
  }, []);

  // ---- fixtures ----------------------------------------------------------
  useEffect(() => {
    if (attemptsRef.current >= MAX_SEED_ATTEMPTS) return;
    const present = new Set(items.map((i) => i.id));
    const idx = { ...seedRef.current };
    let added = 0;
    for (const f of LAB_FIXTURES) {
      const known = idx[f.key];
      if (known && present.has(known)) continue;
      const res = workspaceStore.addFile({
        userId: null,
        title: f.title,
        kind: f.kind,
        language: f.language,
        content: f.content,
        meta: f.meta,
      });
      idx[f.key] = res.item.id;
      if (res.created) added += 1;
    }
    seedRef.current = idx;
    if (added > 0) attemptsRef.current += 1;
  }, [items]);

  const reseed = useCallback(() => {
    attemptsRef.current = 0;
    seedRef.current = {};
    for (const f of LAB_FIXTURES) {
      const res = workspaceStore.addFile({
        userId: null,
        title: f.title,
        kind: f.kind,
        language: f.language,
        content: f.content,
        meta: f.meta,
      });
      seedRef.current[f.key] = res.item.id;
    }
  }, []);

  const selectFixture = useCallback((key: string) => {
    const id = seedRef.current[key];
    if (id) setSelectedId(id);
  }, []);

  /**
   * Record the deliberate actions that MAY destroy the frame. Anything else
   * that changes the mount id is a defect, and the readout says so by name.
   *
   * The first run is a no-op: `viewRef` is seeded with the same values the
   * component starts with, so mounting the page does not manufacture a seam.
   */
  useEffect(() => {
    const prev = viewRef.current;
    const reasons: string[] = [];
    if (prev.remountKey !== remountKey) reasons.push("control button (React key replaced)");
    if (prev.open !== open) reasons.push(open ? "workspace opened" : "workspace closed");
    if (prev.selectedId !== selectedId) reasons.push("selection changed");
    viewRef.current = { open, selectedId, remountKey };
    if (reasons.length) seamRef.current = { at: Date.now(), what: reasons.join(" + ") };
  }, [open, selectedId, remountKey]);

  // ---- artifact messages (probe 1) ---------------------------------------
  useEffect(() => {
    const clock = () => new Date().toLocaleTimeString();
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; mount?: string; ticks?: number; clicks?: number; ageMs?: number } | null;
      if (!d || d.type !== "lab-artifact" || typeof d.mount !== "string") return;
      const a = artRef.current;
      if (!a.mount) {
        a.history.push(`${clock()}  ${d.mount.slice(0, 8)}  first mount`);
      } else if (a.mount !== d.mount) {
        const seam = seamRef.current;
        const dt = Date.now() - seam.at;
        const explained = dt <= SEAM_GRACE_MS;
        a.changes += 1;
        if (explained) a.explained += 1;
        else a.unexplained += 1;
        a.history.push(
          explained
            ? `${clock()}  ${d.mount.slice(0, 8)}  EXPECTED — ${seam.what}, ${dt}ms earlier`
            : `${clock()}  ${d.mount.slice(0, 8)}  *** UNEXPLAINED *** — last deliberate action was "${
                seam.what
              }" ${(dt / 1000).toFixed(1)}s ago`,
        );
      }
      if (a.history.length > 8) a.history.shift();
      a.mount = d.mount;
      a.ticks = typeof d.ticks === "number" ? d.ticks : a.ticks;
      a.clicks = typeof d.clicks === "number" ? d.clicks : a.clicks;
      a.ageMs = typeof d.ageMs === "number" ? d.ageMs : a.ageMs;
      a.lastAt = Date.now();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ---- capture-phase pointer recorder (probe 2) --------------------------
  useEffect(() => {
    const startedOnHandle = (e: Event): boolean => {
      const t = e.target;
      return t instanceof Element && !!t.closest(HANDLE_SELECTOR);
    };

    const handlers: [string, EventListener][] = POINTER_EVENTS.map((type) => {
      const fn: EventListener = (e) => {
        // The raw log is deliberately unfiltered: it is the record of what the
        // window actually saw, including events the shield swallowed.
        const log = logRef.current;
        const last = log[log.length - 1];
        if (last && last.type === type) last.n += 1;
        else {
          log.push({ type, n: 1 });
          if (log.length > 12) log.shift();
        }

        const g = gestureRef.current;
        if (type === "pointerdown") {
          // Gesture ACCOUNTING, unlike the log, is scoped to the handle. A
          // pointerdown anywhere else is someone pressing a button on this
          // page, and scoring it as a drag would make the verdict noise.
          if (!startedOnHandle(e)) {
            // A second pointer landing elsewhere mid-drag (a stray finger on a
            // phone) ends the record rather than discarding it — losing the
            // evidence would be worse than reporting an interrupted gesture.
            if (g.active) {
              g.active = false;
              g.endedAt = Date.now();
              lastGestureRef.current = { ...g };
            }
            return;
          }
          const fresh = emptyGesture();
          fresh.active = true;
          fresh.startedAt = Date.now();
          fresh.down = 1;
          gestureRef.current = fresh;
          return;
        }
        if (!g.active) return;
        if (type === "pointermove") g.move += 1;
        else if (type === "gotpointercapture") g.got += 1;
        else if (type === "lostpointercapture") g.lost += 1;
        else if (type === "pointercancel") {
          g.cancel += 1;
          g.active = false;
          g.endedAt = Date.now();
          lastGestureRef.current = { ...g };
        } else if (type === "pointerup") {
          g.up += 1;
          g.active = false;
          g.endedAt = Date.now();
          lastGestureRef.current = { ...g };
        }
      };
      // Capture phase, on `window`: the only vantage point that sees an event
      // the shield swallowed and an event the shell's own handler stopped.
      window.addEventListener(type, fn, true);
      return [type, fn];
    });
    return () => {
      for (const [type, fn] of handlers) window.removeEventListener(type, fn, true);
    };
  }, []);

  // ---- `.h-app` sanity check --------------------------------------------
  // The page's own height authority comes from a stylesheet another workstream
  // owns. If that import has not landed, `.h-app` emits nothing, the flex row
  // collapses to zero, and this page would silently show an empty screen — the
  // worst possible failure for an instrument. Detect it and say so.
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    const target = layoutViewport().h;
    if (target > 0 && h < target * 0.5) {
      el.style.height = "100vh";
      setHAppWarning(
        `.h-app resolved to ${Math.round(h)}px against a ${Math.round(target)}px viewport — ` +
          "src/styles/workspace-viewport.css is probably not imported in main.tsx. " +
          "Fell back to an inline height: 100vh so this page still works; the app itself will NOT have that fallback.",
      );
    }
  }, []);

  // ---- the one rAF readout loop ------------------------------------------
  useEffect(() => {
    let raf = 0;
    let lastPaint = 0;
    // Captured once: the holder OBJECT is never replaced, only its fields are
    // mutated, so this is the same thing `moRef.current` would read at cleanup
    // time — and it satisfies the exhaustive-deps ref-in-cleanup rule honestly
    // rather than by silencing it.
    const mo = moRef.current;

    const put = (key: string, text: string, tone: Tone = "plain") => {
      const el = cellsRef.current[key];
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      const color = TONE[tone];
      if (el.style.color !== color) el.style.color = color;
    };

    const findShellRoot = (): { el: HTMLElement | null; how: string } => {
      const row = rowRef.current;
      if (!row) return { el: null, how: "row not mounted" };
      // Exact, if WS-C chose to mark its root. The heuristic below is a
      // fallback and says so, because guessing wrong makes every rect, class
      // and width reading on this page silently refer to the wrong element.
      const tagged = row.querySelector<HTMLElement>("[data-cc-workspace-shell]");
      if (tagged) return { el: tagged, how: "by [data-cc-workspace-shell] (exact)" };
      const kids = Array.from(row.children).filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement && !c.hasAttribute("data-lab-filler") && !c.classList.contains("z-[99]"),
      );
      if (kids.length === 0) return { el: null, how: "no shell element (open=false, or the shell rendered null)" };
      const withVar = kids.find((k) => k.style.getPropertyValue("--cc-ws-w") !== "");
      if (withVar) return { el: withVar, how: `by inline --cc-ws-w (${kids.length} candidate${kids.length === 1 ? "" : "s"})` };
      const byGeometry = kids.filter((k) => observedGeometry(k) !== "unknown");
      if (byGeometry.length === 1) return { el: byGeometry[0], how: "by geometry class" };
      return { el: kids[kids.length - 1], how: `fallback: last of ${kids.length} children (AMBIGUOUS)` };
    };

    const tick = (now: number) => {
      raf = window.requestAnimationFrame(tick);

      const g = gestureRef.current;
      if (g.active) g.frames += 1;

      // Sample the shield every frame — it exists only inside a gesture.
      const shields = document.querySelectorAll("[data-cc-drag-shield]").length;
      if (g.active && shields > g.shieldMax) g.shieldMax = shields;

      // ~8 Hz for everything that forces layout. Enough to read, cheap enough
      // that the instrument does not become the jank it is measuring.
      if (now - lastPaint < 120) return;
      lastPaint = now;

      const { el: shell, how } = findShellRoot();
      const rect = shell ? shell.getBoundingClientRect() : null;
      const lv = layoutViewport();
      const vp = readViewport();
      const computed = resolveGeometry(vp);
      const observed = observedGeometry(shell);

      // Keep the style-attribute observer pointed at the live shell root.
      if (mo.target !== shell) {
        mo.observer?.disconnect();
        mo.observer = null;
        mo.target = shell;
        if (shell) {
          const observer = new MutationObserver((records) => {
            const gg = gestureRef.current;
            if (gg.active) gg.styleWrites += records.length;
          });
          observer.observe(shell, { attributes: true, attributeFilter: ["style"] });
          mo.observer = observer;
        }
      }

      /**
       * The four things this page exists to decide, collapsed into one line at
       * the top. Everything below is the working; this is the answer. Each is
       * filled in by the section that owns it, and any left as "n/a" means the
       * probe has not been run yet — never that it passed.
       */
      const verdicts: Record<"remount" | "drag" | "fullscreen" | "geometry", Verdict> = {
        remount: "n/a",
        drag: "n/a",
        fullscreen: "n/a",
        geometry: "n/a",
      };

      // ---- viewport -------------------------------------------------------
      put("vpApp", `${vp.width} x ${vp.height}${overrideActive ? "   (SIMULATED)" : ""}`, overrideActive ? "warn" : "plain");
      put("vpReal", `${lv.w} x ${lv.h}   (documentElement — cannot be faked)`, "dim");
      put("touch", vp.touchPrimary ? "coarse (touch primary) — handle should be 24px" : "fine — handle should be 12px", "dim");

      // ---- geometry -------------------------------------------------------
      put("geoComputed", computed);
      /**
       * `resolveGeometry` is a function of the VIEWPORT only, but the shell
       * renders `userFullscreen ? "full" : resolveGeometry(vp)` — fullscreen is
       * a deliberate override, not a geometry. Comparing the two directly made
       * this verdict read FAIL for the whole time the user was in fullscreen on
       * anything smaller than a desktop, which is the one state where a
       * disagreement is CORRECT.
       *
       * A verdict that cries wolf is worse than one that stays grey: the page's
       * own rule is that grey never means passed, and the corollary is that red
       * has to mean broken. So expected = "full" whenever the panel's own header
       * says we are in fullscreen (the glyph is the shell's state, not ours).
       */
      const inUserFullscreen = shell
        ? Array.from(shell.querySelectorAll("button")).some((b) =>
            (b.textContent || "").includes("close_fullscreen"),
          )
        : false;
      const expected: WorkspaceGeometry = inUserFullscreen ? "full" : computed;
      const geoAgrees = observed === expected;
      verdicts.geometry = observed === "absent" ? "n/a" : geoAgrees ? "pass" : "fail";
      put(
        "geoObserved",
        observed === "absent"
          ? "absent (workspace closed)"
          : `${observed}${
              geoAgrees
                ? inUserFullscreen
                  ? "   AGREES (fullscreen override active — expected full, not " + computed + ")"
                  : "   AGREES"
                : `   MISMATCH — expected ${expected}, the shell is wearing ${observed}`
            }`,
        observed === "absent" ? "dim" : geoAgrees ? "pass" : "fail",
      );
      put("shellHow", how, shell ? "dim" : "warn");

      // ---- width ----------------------------------------------------------
      const wsw = shell ? getComputedStyle(shell).getPropertyValue("--cc-ws-w").trim() : "";
      put("wsw", wsw || "(unset)", wsw ? "plain" : "dim");

      const containerPx = computed === "dock" ? rowRef.current?.clientWidth ?? 0 : lv.w;
      const painted = parseFloat(wsw);
      const liveFraction = Number.isFinite(painted) && containerPx > 0 ? painted / containerPx : NaN;
      put(
        "fractionLive",
        Number.isFinite(liveFraction)
          ? `${liveFraction.toFixed(4)}   (${round(painted, 0)}px of ${containerPx}px)`
          : "— (no --cc-ws-w painted)",
        Number.isFinite(liveFraction) ? "plain" : "dim",
      );

      let storedText = "unset — the shell should be using the defaults";
      let storedTone: Tone = "dim";
      try {
        const stored = readStoredWidths(localStorage.getItem(WORKSPACE_WIDTH_KEY));
        if (stored) {
          storedText = `dock ${stored.dock ?? `${DEFAULT_WIDTHS.dock} (default)`}   drawer ${
            stored.drawer ?? `${DEFAULT_WIDTHS.drawer} (default)`
          }`;
          storedTone = "plain";
        }
      } catch {
        storedText = "localStorage unreadable";
        storedTone = "warn";
      }
      put("fractionStored", storedText, storedTone);

      put("shellRect", rectText(rect));
      put("panelWidth", rect ? `${round(rect.width, 0)}px` : "—");

      // ---- probe 1: mount identity ---------------------------------------
      const a = artRef.current;
      const htmlId = seedRef.current.html;
      const htmlOnScreen = viewRef.current.open && !!htmlId && viewRef.current.selectedId === htmlId;
      // Only meaningful while the fixture is supposed to be on screen; silence
      // is the correct state everywhere else and must not read as a failure.
      const stale = htmlOnScreen && a.lastAt > 0 && Date.now() - a.lastAt > 1500;

      if (!a.mount) {
        put("mountId", htmlOnScreen ? "selected, but no message yet — the frame may still be loading" : "no message yet — open the html fixture", htmlOnScreen ? "warn" : "dim");
        verdicts.remount = "unverified";
        put(
          "mountChanges",
          a.controlPresses > 0
            ? `0 unexplained — but the control was pressed ${a.controlPresses}x with no artifact reporting, so it proved nothing. Open the html fixture and press it again.`
            : "0 unexplained   (nothing observed yet — open the html fixture)",
          "warn",
        );
        put("mountTicks", "—", "dim");
      } else {
        put("mountId", `${a.mount}${stale ? "   (STALE — no message for >1.5s while selected)" : ""}`, stale ? "fail" : "plain");
        // The instrument is only trustworthy once it has been SEEN to fire.
        // A counter stuck at zero because it is broken looks exactly like a
        // counter at zero because the code is correct.
        const armed = a.explained > 0;
        verdicts.remount = !armed ? "unverified" : a.unexplained === 0 ? "pass" : "fail";
        put(
          "mountChanges",
          !armed
            ? `${a.unexplained} unexplained / ${a.changes} total — INSTRUMENT UNVERIFIED. Press "force remount (control)" once with this fixture on screen; the counter must go to 1 total / 0 unexplained.`
            : a.unexplained === 0
              ? `0 unexplained / ${a.changes} total   PASS — every remount so far was one you asked for`
              : `${a.unexplained} UNEXPLAINED / ${a.changes} total   FAIL — the iframe was destroyed by something other than a deliberate action`,
          !armed ? "warn" : a.unexplained === 0 ? "pass" : "fail",
        );
        put("mountTicks", `ticks ${a.ticks}   clicks ${a.clicks}   alive ${(a.ageMs / 1000).toFixed(1)}s`, "plain");
      }
      put(
        "mountHistory",
        a.history.length
          ? a.history.join("\n")
          : "(no mounts observed yet — select the html fixture)",
        "dim",
      );

      // The separator, looked up once: the drag readout needs it to explain a
      // missing gesture, and the A1 section below reports on it in detail.
      const handle = shell ? shell.querySelector(HANDLE_SELECTOR) : null;

      // ---- probe 2: pointer log ------------------------------------------
      const log = logRef.current;
      put(
        "pointerLog",
        log.length ? log.map((e) => (e.n > 1 ? `${e.type} x${e.n}` : e.type)).join("\n") : "(no pointer events yet)",
        log.length ? "plain" : "dim",
      );

      const lg = gestureRef.current.active ? gestureRef.current : lastGestureRef.current;
      if (!lg || (!lg.active && lg.down === 0)) {
        put(
          "gesture",
          handle
            ? "(no drag yet — press and HOLD the resize handle, sweep deep into the artifact, release)"
            : "(no resize handle on screen to drag)",
          "dim",
        );
        put("gestureVerdict", "—", "dim");
        put("styleWrites", "—", "dim");
        put(
          "shield",
          shields === 0
            ? "0 shield nodes — correct outside a drag"
            : `${shields} shield node(s) present with NO drag in flight — FAIL, an invisible layer is swallowing every click`,
          shields === 0 ? "dim" : "fail",
        );
      } else {
        put(
          "gesture",
          `${lg.active ? "IN PROGRESS" : "complete"}   down ${lg.down}   move ${lg.move}   up ${lg.up}   ` +
            `cancel ${lg.cancel}   gotcapture ${lg.got}   lostcapture ${lg.lost}   ` +
            `${lg.endedAt ? `${lg.endedAt - lg.startedAt}ms` : `${Date.now() - lg.startedAt}ms`}`,
        );
        const durationMs = (lg.endedAt || Date.now()) - lg.startedAt;
        const survived = lg.move >= 2 && (lg.up >= 1 || lg.active);
        // A press with no movement is only evidence if it was HELD. A quick tap
        // on the handle also produces zero moves, and calling that a failure
        // would make the verdict cry wolf on the double-tap-to-reset gesture.
        const wasATap = lg.move === 0 && durationMs < TAP_MS;
        verdicts.drag = lg.active || wasATap ? "unverified" : survived ? "pass" : "fail";
        put(
          "gestureVerdict",
          lg.active
            ? "in progress…"
            : survived
              ? `PASS — the drag survived (${lg.move} moves, clean release after ${durationMs}ms)`
              : wasATap
                ? `INCONCLUSIVE — that was a ${durationMs}ms tap, not a drag. Press and HOLD, sweep deep into the artifact, then release.`
                : lg.move === 0
                  ? `FAIL — held for ${durationMs}ms with ZERO pointermove: the shield is not mounting and the drag is dying at the iframe boundary`
                  : `FAIL — the gesture did not complete cleanly (${lg.move} moves, ${lg.up} up, ${lg.cancel} cancel)`,
          lg.active || wasATap ? "warn" : survived ? "pass" : "fail",
        );
        const rate = lg.frames > 0 ? lg.styleWrites / lg.frames : NaN;
        put(
          "styleWrites",
          Number.isFinite(rate)
            ? `${lg.styleWrites} writes / ${lg.frames} frames = ${rate.toFixed(2)} per frame  ${
                rate <= 1.05 ? "PASS" : "FAIL — more than one style write per frame; the rAF throttle is not working"
              }`
            : "—",
          Number.isFinite(rate) ? (rate <= 1.05 ? "pass" : "fail") : "dim",
        );
        put(
          "shield",
          `now ${shields}   peak during gesture ${lg.shieldMax}   ${
            shields > 0 && !lg.active
              ? "FAIL — a shield outlived the gesture and is now blocking every click"
              : lg.shieldMax === 0 && lg.move > 0
                ? "no shield seen — either it is not mounting, or it does not carry data-cc-drag-shield"
                : "OK"
          }`,
          shields > 0 && !lg.active ? "fail" : lg.shieldMax === 0 && lg.move > 0 ? "warn" : "pass",
        );
      }

      // ---- probe 4: fullscreen fills the viewport -------------------------
      if (observed === "full" && rect) {
        const off = Math.max(
          Math.abs(rect.left),
          Math.abs(rect.top),
          Math.abs(rect.width - lv.w),
          Math.abs(rect.height - lv.h),
        );
        verdicts.fullscreen = off <= 1 ? "pass" : "fail";
        put(
          "fullRect",
          off <= 1
            ? `PASS — fills the layout viewport (worst edge off by ${round(off, 2)}px)`
            : `FAIL — off by ${round(off, 2)}px. An ancestor has transform/filter/contain and is acting as the containing block.`,
          off <= 1 ? "pass" : "fail",
        );
      } else {
        put("fullRect", "not in fullscreen", "dim");
      }

      // ---- A1: the handle stays live in drawer ----------------------------
      if (!handle) {
        put(
          "handle",
          observed === "full"
            ? "absent — correct, there is nothing left to resize in fullscreen"
            : observed === "absent"
              ? "—"
              : `ABSENT in ${observed} geometry` +
                (observed === "drawer"
                  ? " — amendment A1 requires the handle to stay live on a landscape phone"
                  : ""),
          observed === "full" || observed === "absent" ? "dim" : "fail",
        );
      } else {
        const hr = handle.getBoundingClientRect();
        const orient = handle.getAttribute("aria-orientation");
        const now = handle.getAttribute("aria-valuenow");
        const min = handle.getAttribute("aria-valuemin");
        const max = handle.getAttribute("aria-valuemax");
        const tab = handle.getAttribute("tabindex");
        const ok = orient === "vertical" && tab === "0" && now != null && min != null && max != null;
        put(
          "handle",
          `present   ${round(hr.width)}x${round(hr.height)}px   aria-orientation=${orient ?? "(missing)"}   ` +
            `value ${min ?? "?"}/${now ?? "?"}/${max ?? "?"}   tabindex=${tab ?? "(missing)"}   ${
              ok ? "APG contract OK" : "APG contract INCOMPLETE"
            }`,
          ok ? "pass" : "fail",
        );
      }

      // ---- A3: fullscreen needs a touch-reachable exit ---------------------
      // Reported in EVERY geometry, not just `full`. The lab drives fullscreen
      // by clicking this button, so if it is missing the toggle silently does
      // nothing and probe 4 would read "not in fullscreen" forever — which
      // looks like a passing state and is not one.
      const fsBtn = shell
        ? Array.from(shell.querySelectorAll("button")).find((b) => {
            const t = b.textContent || "";
            return t.includes("open_in_full") || t.includes("close_fullscreen");
          })
        : null;
      if (!shell) {
        put("exitControl", "—", "dim");
      } else if (!fsBtn) {
        put(
          "exitControl",
          "ABSENT — no open_in_full / close_fullscreen button in the panel header. " +
            "The 'toggle fullscreen' button on this page cannot work, and amendment A3 is unmet.",
          "fail",
        );
        if (observed === "full") verdicts.fullscreen = "fail";
      } else {
        const er = fsBtn.getBoundingClientRect();
        const side = Math.min(er.width, er.height);
        const glyph = (fsBtn.textContent || "").includes("close_fullscreen") ? "close_fullscreen" : "open_in_full";
        if (observed === "full") {
          // A3 is a rule about the EXIT: one obvious tap, >=44px, on a phone.
          const ok = glyph === "close_fullscreen" && side >= 44;
          put(
            "exitControl",
            `${glyph}   ${round(er.width)}x${round(er.height)}px   ` +
              (glyph !== "close_fullscreen"
                ? "FAIL — in fullscreen the control must read close_fullscreen"
                : side >= 44
                  ? "PASS — >=44px exit target (A3)"
                  : "FAIL — under the 44px exit target A3 requires"),
            ok ? "pass" : "fail",
          );
          if (!ok) verdicts.fullscreen = "fail";
        } else {
          put(
            "exitControl",
            `${glyph}   ${round(er.width)}x${round(er.height)}px   (A3's >=44px rule is checked once you are in fullscreen)`,
            "plain",
          );
        }
      }

      // ---- probe 6: the measure ------------------------------------------
      const measure = shell ? (shell.querySelector(".cc-measure") as HTMLElement | null) : null;
      const prose = measure ?? (shell ? (shell.querySelector(".prose") as HTMLElement | null) : null);
      if (!prose) {
        put("measure", "no prose element on screen — open the research fixture", "dim");
      } else {
        const pw = prose.getBoundingClientRect().width;
        const cap = getComputedStyle(prose).maxWidth;
        const capped = cap !== "none" && rect != null && pw < rect.width - 8;
        put(
          "measure",
          `prose ${round(pw, 0)}px of a ${rect ? round(rect.width, 0) : "?"}px panel   max-width: ${cap}   ` +
            `${measure ? "(.cc-measure)" : "(.prose — .cc-measure NOT found)"}   ${
              capped ? "capped" : "UNCAPPED — widening only grows margins"
            }`,
          capped ? "pass" : "warn",
        );
      }

      // ---- probe 10: visual viewport --------------------------------------
      const rootStyle = getComputedStyle(document.documentElement);
      const vvh = rootStyle.getPropertyValue("--cc-vvh").trim();
      const vvTop = rootStyle.getPropertyValue("--cc-vv-top").trim();
      const vv = window.visualViewport;
      put(
        "vvh",
        `--cc-vvh: ${vvh || "(unset)"}   --cc-vv-top: ${vvTop || "(unset)"}   visualViewport: ${
          vv ? `${round(vv.width, 0)}x${round(vv.height, 0)} @ top ${round(vv.offsetTop, 0)}` : "(unsupported)"
        }`,
        vvh ? "plain" : "dim",
      );
      if (vv && rect && (observed === "drawer" || observed === "full")) {
        const overflow = rect.height - vv.height;
        put(
          "vvFit",
          overflow <= 1
            ? `PASS — the overlay fits the visual viewport (${round(overflow, 1)}px)`
            : `FAIL — the overlay is ${round(overflow, 1)}px taller than the visual viewport (keyboard open?)`,
          overflow <= 1 ? "pass" : "fail",
        );
      } else {
        put("vvFit", "—", "dim");
      }

      // ---- fixtures --------------------------------------------------------
      const all = workspaceStore.getAll();
      const ids = new Set(all.map((i) => i.id));
      const have = LAB_FIXTURES.filter((f) => {
        const id = seedRef.current[f.key];
        return !!id && ids.has(id);
      }).length;
      put(
        "fixtures",
        `${have}/${LAB_FIXTURES.length} present   (seed attempts ${attemptsRef.current}/${MAX_SEED_ATTEMPTS})`,
        have === LAB_FIXTURES.length ? "pass" : "warn",
      );

      // ---- the answer ------------------------------------------------------
      const label: Record<Verdict, string> = { pass: "PASS", fail: "FAIL", unverified: "UNVERIFIED", "n/a": "not run" };
      put(
        "headline",
        `no remount ${label[verdicts.remount]}   ·   drag survives ${label[verdicts.drag]}   ·   ` +
          `fullscreen rect ${label[verdicts.fullscreen]}   ·   geometry agrees ${label[verdicts.geometry]}`,
        summarize(verdicts),
      );
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      mo.observer?.disconnect();
      mo.observer = null;
      mo.target = null;
    };
  }, []);

  // Always release the viewport override, however this page is left.
  useEffect(() => () => setViewportOverride(null), []);

  // ---- controls ----------------------------------------------------------
  const applyPreset = useCallback((p: Preset | null) => {
    setViewportOverride(p);
    setPresetLabel(p ? p.label : "auto");
  }, []);

  const forceRemount = useCallback(() => {
    artRef.current.controlPresses += 1;
    setRemountKey((k) => k + 1);
  }, []);

  const resetWidths = useCallback(() => {
    try {
      localStorage.removeItem(WORKSPACE_WIDTH_KEY);
    } catch {
      /* private mode — nothing to clear */
    }
    // The shell seeds `--cc-ws-w` from storage in a layout effect, so clearing
    // the key only takes effect on a fresh mount — which is also, deliberately,
    // a second positive control for the mount counter.
    artRef.current.controlPresses += 1;
    setRemountKey((k) => k + 1);
  }, []);

  /**
   * Fullscreen lives inside the shell (there is no prop for it in the frozen
   * `WorkspaceShellProps`), so drive the real control the way a user does:
   * click the header button. Material Symbols render the glyph NAME as text,
   * which is what makes the button findable without a test id.
   */
  const toggleFullscreen = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const btn = Array.from(row.querySelectorAll("button")).find((b) => {
      // Never this page's own controls — only the shell's header.
      if (b.closest("[data-lab-filler]")) return false;
      const t = b.textContent || "";
      return t.includes("open_in_full") || t.includes("close_fullscreen");
    });
    if (btn) btn.click();
    else
      console.warn(
        "[workspace-lab] no open_in_full / close_fullscreen button found in the panel header — WS-F item 8 may not have landed. " +
          'The "fullscreen exit control" row on the page says the same thing.',
      );
  }, []);

  const clearLog = useCallback(() => {
    logRef.current = [];
    lastGestureRef.current = null;
    gestureRef.current = emptyGesture();
  }, []);

  // ---- render -------------------------------------------------------------
  const btn =
    "px-2 py-1 rounded border border-[#2b3444] bg-[#161b25] text-[#cfd8e6] hover:bg-[#222a38] " +
    "text-[11px] leading-tight min-h-[32px] transition-colors";

  return (
    <div ref={rowRef} className="h-app flex overflow-hidden bg-[#0b0e14]">
      {/*
        Stand-in for the chat column. Mirrors ChatPanel's real child exactly —
        `flex flex-col h-full flex-1 min-w-0 relative` — so the dock's width
        budget, and the `min-w-0` that keeps a second flex child from pushing
        this one off screen, are exercised for real rather than approximated.
      */}
      <div data-lab-filler className="flex flex-col h-full flex-1 min-w-0 relative overflow-auto">
        <div className="p-3 font-mono text-[11px] leading-[1.55] text-[#dce3ee] space-y-3">
          <div>
            <div className="text-[13px] font-bold text-[#7dd3fc]">Workspace Lab</div>
            <div className="text-[#8a94a6]">
              dev-only route · mounts the real WorkspaceShell · no session required
            </div>
          </div>

          {hAppWarning && (
            <div className="rounded border border-[#e8c46a] bg-[#2a2410] p-2 text-[#e8c46a]">{hAppWarning}</div>
          )}

          {presetLabel !== "auto" && (
            <div className="rounded border border-[#e8c46a] bg-[#2a2410] p-2 text-[#e8c46a]">
              SIMULATED VIEWPORT: {presetLabel}. Only JavaScript sees this. CSS units (vw / vh / svh),
              media queries and env(safe-area-inset-*) still resolve against the real window, so this
              proves the geometry DECISION and nothing about how the result looks. Use the browser's
              device toolbar for a true rotation test.
            </div>
          )}

          <Section title="Verdict">
            <div ref={reg("headline")} className="break-words text-[12px] font-bold leading-snug">
              —
            </div>
            <div className="mt-1 text-[#8a94a6]">
              Grey means the probe has not been run. It never means it passed.
            </div>
          </Section>

          <Section title="Controls">
            <div className="flex flex-wrap gap-1">
              <button className={btn} onClick={() => setOpen((o) => !o)}>
                {open ? "close workspace" : "open workspace"}
              </button>
              <button className={btn} onClick={toggleFullscreen}>
                toggle fullscreen
              </button>
              <button className={btn} onClick={forceRemount}>
                force remount (control)
              </button>
              <button className={btn} onClick={resetWidths}>
                reset stored widths (remounts)
              </button>
              <button className={btn} onClick={reseed}>
                re-seed fixtures
              </button>
              <button className={btn} onClick={clearLog}>
                clear pointer log
              </button>
            </div>
            <div className="mt-1 text-[#8a94a6]">
              "force remount" and "reset stored widths" replace the shell's React key on purpose —
              they are the POSITIVE CONTROL for the mount counter. Each adds 1 to the TOTAL and 0 to
              UNEXPLAINED. Until one of them has been seen to fire with the html fixture on screen,
              the counter reports itself as UNVERIFIED, because a counter that has never moved is
              indistinguishable from a broken one.
            </div>
          </Section>

          <Section title="Force a geometry (JavaScript only — see the banner above)">
            <div className="flex flex-wrap gap-1">
              {GEOMETRIES.map((g) => {
                const p = presetForGeometry(g);
                return (
                  <button
                    key={g}
                    className={btn}
                    disabled={!p}
                    onClick={() => p && applyPreset(p)}
                    title={p ? `applies ${p.label}` : "no preset in the table resolves to this geometry"}
                  >
                    force {g}
                    {p ? ` (${p.width}x${p.height})` : " — UNREACHABLE"}
                  </button>
                );
              })}
              <button className={btn} onClick={() => applyPreset(null)}>
                auto (real window)
              </button>
            </div>
            <div className="mt-1 text-[#8a94a6]">
              Each button is DERIVED: it applies the first preset below that the real `resolveGeometry`
              maps to that geometry, so it drives the shipping code path rather than setting the mode
              directly. "UNREACHABLE" means a threshold moved and no device in the table lands there
              any more.
            </div>
          </Section>

          <Section title="Device presets">
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button key={p.label} className={btn} onClick={() => applyPreset(p)}>
                  {p.label} → {resolveGeometry({ width: p.width, height: p.height, touchPrimary: false })}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Open a fixture">
            <div className="flex flex-wrap gap-1">
              {LAB_FIXTURES.map((f) => (
                <button key={f.key} className={btn} onClick={() => selectFixture(f.key)}>
                  {f.key}
                </button>
              ))}
              <button className={btn} onClick={() => setSelectedId(null)}>
                back to list
              </button>
            </div>
          </Section>

          <Section title="Probe 1 — the mini-app must never reload">
            <Row label="mount id" reg={reg("mountId")} />
            <Row label="mount changes" reg={reg("mountChanges")} />
            <Row label="in-frame counters" reg={reg("mountTicks")} />
            <Block label="mount history (each change stamped with the deliberate action, if any, that explains it)" reg={reg("mountHistory")} />
            <div className="text-[#8a94a6]">
              Opening, closing and switching files destroy the frame ON PURPOSE. So does the positive
              control. Those are counted as EXPECTED. During a probe, change nothing but the thing you
              are probing — then any change at all is UNEXPLAINED, and that is the failure.
            </div>
          </Section>

          <Section title="Probe 2 — the drag must survive crossing the artifact">
            <Row label="last gesture" reg={reg("gesture")} />
            <Row label="verdict" reg={reg("gestureVerdict")} />
            <Row label="drag shield" reg={reg("shield")} />
            <Row label="style writes (probe 7)" reg={reg("styleWrites")} />
            <Block
              label="window capture-phase log (newest last; consecutive repeats collapse to 'type xN')"
              reg={reg("pointerLog")}
            />
            <div className="text-[#8a94a6]">
              The log records every pointer event the window sees. The VERDICT only scores gestures
              that begin on the resize handle, so clicking the buttons on this page cannot turn it
              red. Press and HOLD the handle, sweep deep into the artifact, then release — a quick tap
              reads as INCONCLUSIVE, because a tap and a drag that died both show zero moves.
            </div>
          </Section>

          <Section title="Geometry">
            <Row label="viewport (as the app reads it)" reg={reg("vpApp")} />
            <Row label="viewport (layout, unfakeable)" reg={reg("vpReal")} />
            <Row label="pointer" reg={reg("touch")} />
            <Row label="resolveGeometry says" reg={reg("geoComputed")} />
            <Row label="the shell is wearing" reg={reg("geoObserved")} />
            <Row label="shell element found" reg={reg("shellHow")} />
          </Section>

          <Section title="Width">
            <Row label="--cc-ws-w (computed)" reg={reg("wsw")} />
            <Row label="live fraction" reg={reg("fractionLive")} />
            <Row label="committed (localStorage)" reg={reg("fractionStored")} />
            <Row label="panel width" reg={reg("panelWidth")} />
            <Row label="shell rect" reg={reg("shellRect")} />
            <Row label="resize handle" reg={reg("handle")} />
          </Section>

          <Section title="Overlay modes">
            <Row label="fullscreen rect (probe 4)" reg={reg("fullRect")} />
            <Row label="fullscreen exit control (A3)" reg={reg("exitControl")} />
            <Row label="visual viewport (probe 10)" reg={reg("vvh")} />
            <Row label="overlay fits it" reg={reg("vvFit")} />
            <Row label="prose measure (probe 6)" reg={reg("measure")} />
            <Row label="fixtures" reg={reg("fixtures")} />
          </Section>

          <Section title="What this page CANNOT prove">
            <ul className="list-disc pl-4 space-y-1 text-[#8a94a6]">
              <li>
                Anything about CSS at a simulated size. The viewport buttons move only what
                JavaScript reads. Real rotation, safe-area insets and `svh` need the device toolbar
                or a real phone.
              </li>
              <li>
                Anything inside the artifact frame beyond what the fixture chooses to post. The
                frame is opaque-origin; `contentWindow` is unreachable by design.
              </li>
              <li>
                That "mount changes: 0" means anything at all, until the positive control has been
                pressed once in this session. An instrument that has never moved is not evidence.
              </li>
              <li>
                That this route is absent from a production build — that is a build-time fact, and it
                has been measured separately: a production build emits no WorkspaceLab chunk and
                contains zero occurrences of "workspace-lab" or "lab-artifact", while the same build
                with NODE_ENV=development emits `assets/WorkspaceLab-*.js` and all of those strings.
                Re-check with `npm run build` then grep `dist/`. (`vite build --mode development` is
                not a control: `vite build` pins NODE_ENV=production, so the gate stays closed and
                the string is absent for the wrong reason.)
              </li>
              <li>
                Screen-reader behaviour. The ARIA attributes are checked structurally above; the APG
                publishes no working example for this pattern, so real NVDA/VoiceOver time is still
                required.
              </li>
            </ul>
          </Section>
        </div>
      </div>

      {/*
        THE REAL SHELL. `key` moves only when a control button demands it, which
        is the deliberate positive control for the mount counter — every other
        interaction on this page must leave the key alone, or the whole probe is
        worthless.
      */}
      <WorkspaceShell
        key={remountKey}
        open={open}
        userId={null}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setOpen(false)}
      />
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded border border-[#222a38] bg-[#11151d] p-2">
    <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#7dd3fc]">{title}</div>
    {children}
  </div>
);

const Row: React.FC<{ label: string; reg: (el: HTMLElement | null) => void }> = ({ label, reg }) => (
  <div className="flex gap-2 py-[1px]">
    <span className="w-[168px] shrink-0 text-[#8a94a6]">{label}</span>
    <span ref={reg} className="min-w-0 flex-1 break-words">
      —
    </span>
  </div>
);

const Block: React.FC<{ label: string; reg: (el: HTMLElement | null) => void }> = ({ label, reg }) => (
  <div className="py-[1px]">
    <div className="text-[#8a94a6]">{label}</div>
    <pre ref={reg} className="whitespace-pre-wrap break-words">
      —
    </pre>
  </div>
);

export default WorkspaceLab;
