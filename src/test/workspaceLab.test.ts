import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveGeometry, type WorkspaceGeometry } from "@/lib/workspaceLayout";

/**
 * WS-G — the dev-only Workspace Lab route.
 *
 * Two kinds of test live here, and the split is deliberate.
 *
 * The FIRST kind is a source scan, because the properties that matter about
 * `src/App.tsx` are compile-time properties: whether the route is gated on
 * `import.meta.env.DEV` (so the page cannot ship to production) and whether it
 * escapes `ProtectedRoute` (so it can run without a session). Neither is
 * observable at runtime under vitest — `import.meta.env.DEV` is *true* here, so
 * a runtime assertion would pass in exactly the environment where the answer
 * does not matter.
 *
 * The SECOND kind actually EXECUTES the lab's html fixture. That fixture is the
 * single most important instrument in this ship: it is the only way to observe
 * whether the user's mini-app was destroyed and rebuilt, because the artifact
 * frame is opaque-origin and `contentWindow` is unreachable. A source scan for
 * the string "postMessage" would not notice that the script throws on line one,
 * or posts the wrong shape, or mints a new id on every tick. So the script is
 * pulled out of the source and run against injected `window` / `self` /
 * `setInterval` stubs, which makes every claim about it checkable and needs no
 * timer mocking at all.
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const APP = read("src/App.tsx");
const LAB = read("src/pages/WorkspaceLab.tsx");

// ---------------------------------------------------------------------------
// The production gate
// ---------------------------------------------------------------------------

describe("App.tsx — the lab route is dev-only", () => {
  it("binds the lazy import to import.meta.env.DEV, so production folds it to null", () => {
    // The exact shape matters: `import.meta.env.DEV` is statically replaced by
    // Vite, so `DEV ? lazy(() => import(...)) : null` becomes `null` and Rollup
    // drops the dynamic import from the module graph. Moving the check anywhere
    // else — a runtime `if` inside the element, a `&&` on the <Route> alone —
    // leaves the chunk in `dist/`.
    expect(APP).toMatch(
      /const\s+WorkspaceLab\s*=\s*import\.meta\.env\.DEV\s*\?\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["'`]\.\/pages\/WorkspaceLab["'`]\s*\)\s*\)\s*:\s*null\s*;/,
    );
  });

  it("imports the lab exactly once, and only through that gate", () => {
    const hits = APP.match(/import\(\s*["'`]\.\/pages\/WorkspaceLab["'`]\s*\)/g) ?? [];
    expect(hits).toHaveLength(1);
    // A bare static import would defeat the gate entirely.
    expect(APP).not.toMatch(/^\s*import\s+WorkspaceLab\s+from/m);
  });

  it("registers #/workspace-lab and renders it only when the gate passed", () => {
    expect(APP).toContain('path="/workspace-lab"');
    expect(APP).toMatch(/\{\s*WorkspaceLab\s*&&\s*<Route\s+path="\/workspace-lab"/);
  });

  it("does NOT wrap the lab route in ProtectedRoute", () => {
    // The whole point of the route is that it runs with no session, so grepping
    // the whole file is useless — it legitimately mentions ProtectedRoute all
    // over. Slice from this route's start to the NEXT route's start: a wrapper
    // lives inside `element={…}`, so it would necessarily fall in that window.
    // (Slicing to the first "/>" does not work: `<WorkspaceLab />` owns it.)
    const at = APP.indexOf('path="/workspace-lab"');
    expect(at, "the lab route is not registered at all").toBeGreaterThan(-1);
    const next = APP.indexOf("<Route", at);
    const region = APP.slice(at, next > at ? next : APP.length);

    expect(region).toContain("<WorkspaceLab />");
    expect(region).not.toContain("ProtectedRoute");
  });

  it("…while the routes that SHOULD be guarded still are", () => {
    // Positive control for the test above: if `ProtectedRoute` were renamed or
    // deleted, the assertion that the lab escapes it would pass vacuously.
    for (const path of ["/", "/models", "/memory-guide"]) {
      const at = APP.indexOf(`path="${path}"`);
      expect(at, `route ${path} disappeared`).toBeGreaterThan(-1);
      const next = APP.indexOf("<Route", at);
      expect(APP.slice(at, next > at ? next : APP.length), `route ${path} lost its auth guard`).toContain(
        "ProtectedRoute",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// What the lab mounts
// ---------------------------------------------------------------------------

describe("WorkspaceLab.tsx — mounts the real thing", () => {
  it("mounts WorkspaceShell, not WorkspacePanel or a hand-rolled copy", () => {
    expect(LAB).toContain('from "@/components/WorkspaceShell"');
    expect(LAB).toContain("<WorkspaceShell");
    // Reaching past the shell to the panel would skip every geometry, width and
    // fullscreen decision this page exists to measure.
    expect(LAB).not.toContain("@/components/WorkspacePanel");
    expect(LAB).not.toContain("<WorkspacePanel");
  });

  it("seeds through the real store seam", () => {
    expect(LAB).toContain("workspaceStore.addFile");
  });

  it("seeds one fixture of every workspace kind", () => {
    for (const kind of ["html", "svg", "research", "code", "text", "data", "tool"]) {
      expect(LAB, `missing a ${kind} fixture`).toContain(`kind: "${kind}"`);
    }
  });

  it("files them with userId: null, which is the path that needs no session", () => {
    // `workspaceStore.serverUpsert` returns early on a null userId, so seeding
    // touches IndexedDB and memory only. A lab that seeded a signed-in item
    // would fail against the auth wall the route exists to avoid.
    expect(LAB).toMatch(/userId:\s*null/);
    expect(read("src/lib/workspaceStore.ts")).toMatch(
      /async function serverUpsert[\s\S]{0,120}if \(!item\.userId\) return;/,
    );
  });

  it("the code fixture really is >=300 lines (A2 item 3), not just claimed to be", () => {
    // Executed, not eyeballed: the fixture is built by a loop, so an edited
    // bound silently shrinks it below the gutter threshold it exists to probe.
    const at = LAB.indexOf("function buildCodeFixture()");
    expect(at, "the code fixture builder was renamed").toBeGreaterThan(-1);
    const end = LAB.indexOf("\n}\n", at);
    expect(end).toBeGreaterThan(at);
    // Strip the two TS annotations so the body is plain JS. If either moves,
    // `new Function` throws a SyntaxError and this test fails loudly rather
    // than measuring the wrong thing.
    const src = LAB.slice(at, end + 2)
      .replace("function buildCodeFixture(): string {", "function buildCodeFixture() {")
      .replace("const body: string[] = [];", "const body = [];");
    const build = new Function(`${src}\nreturn buildCodeFixture();`) as () => string;

    const out = build();
    expect(typeof out).toBe("string");
    expect(out.split("\n").length, "A2 item 3 asks for a code fixture of at least 300 lines").toBeGreaterThanOrEqual(
      300,
    );
    // …and deterministic, so re-seeding dedupes on fingerprint instead of
    // stacking a new copy every time the effect runs.
    expect(build()).toBe(out);
  });

  it("the research fixture is long enough for a 78ch cap to be visible", () => {
    const at = LAB.indexOf("const LAB_RESEARCH_FIXTURE = [");
    expect(at).toBeGreaterThan(-1);
    const body = LAB.slice(at, LAB.indexOf("\n].join(", at));
    // Several paragraphs, a table and a code block — enough that "capped" and
    // "uncapped" look obviously different at a 900px panel.
    expect(body.length).toBeGreaterThan(2500);
    expect(body).toContain("| Thing | Grows with the drag |");
    expect(body).toContain("```ts");
  });

  it("mirrors ChatPanel's REAL flex row, so the dock width budget is exercised for real", () => {
    // Not a self-grep: the same string is asserted against ChatPanel's own
    // source. If ChatPanel's chat column changes shape and the lab does not,
    // the lab starts measuring a layout that no longer ships — silently, since
    // the page would still render perfectly well.
    const CHAT_COLUMN = "flex flex-col h-full flex-1 min-w-0 relative";
    const chat = read("src/components/ChatPanel.tsx");
    expect(
      chat,
      "ChatPanel's chat column changed shape — update WorkspaceLab's filler to match, or the lab measures the wrong layout",
    ).toContain(CHAT_COLUMN);
    expect(LAB, "WorkspaceLab's filler no longer mirrors ChatPanel's chat column").toContain(CHAT_COLUMN);
    expect(LAB).toContain("data-lab-filler");
  });

  it("does not import anything from the test tree", () => {
    const imports = LAB.match(/from\s+["'][^"']+["']/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) {
      expect(imp).not.toMatch(/\/test\//);
      expect(imp).not.toMatch(/\.test\b/);
    }
  });

  it("never programmatically focuses anything (Android soft-keyboard rule)", () => {
    expect(LAB).not.toContain(".focus(");
    expect(LAB).not.toContain("focusComposer");
  });
});

describe("WorkspaceLab.tsx — the instruments the probes depend on", () => {
  it("records pointer events at window level in the CAPTURE phase", () => {
    // Probe 2's only evidence. Bubble-phase listeners would miss anything the
    // shield swallowed, which is exactly the failure being looked for.
    expect(LAB).toMatch(/window\.addEventListener\(\s*type\s*,\s*fn\s*,\s*true\s*\)/);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
      expect(LAB, `capture log is missing ${type}`).toContain(`"${type}"`);
    }
  });

  it("recognises the handle by the role WS-B actually renders", () => {
    // Cross-file, on purpose. The lab only scores a gesture as a drag if the
    // pointerdown started on the handle; if the two halves of that agreement
    // drift, the page reports "(no drag yet)" forever — which reads exactly
    // like a reviewer who has not tried yet, not like a broken instrument.
    const handleSrc = read("src/components/WorkspaceResizeHandle.tsx");
    expect(handleSrc, "WS-B's handle no longer carries role=separator").toContain('role="separator"');
    expect(LAB).toContain("HANDLE_SELECTOR");
    expect(LAB).toContain('[role="separator"]');
  });

  it("logs every window pointer event, but only SCORES gestures from the handle", () => {
    // Clicking any button on this page is one pointerdown and one pointerup
    // with zero moves — scored as a drag, that is a permanent red FAIL for no
    // reason. The raw log must still see it, so the push has to happen BEFORE
    // the handle gate; assert the ordering, not just the presence.
    const at = LAB.indexOf("const startedOnHandle");
    expect(at, "the handle gate was removed").toBeGreaterThan(-1);
    const end = LAB.indexOf("window.addEventListener(type, fn, true)", at);
    expect(end).toBeGreaterThan(at);
    const body = LAB.slice(at, end);

    const push = body.indexOf("log.push(");
    const gate = body.indexOf("if (!startedOnHandle(e))");
    expect(push, "the raw pointer log is gone").toBeGreaterThan(-1);
    expect(gate, "gesture scoring is no longer scoped to the handle").toBeGreaterThan(-1);
    expect(push, "the handle gate now skips the raw log, which probe 2 depends on").toBeLessThan(gate);
  });

  it("does not call a tap on the handle a failed drag", () => {
    // Zero pointermove is the signature of the bug ONLY if the pointer was
    // held. Double-tap-to-reset is a real gesture and must not read as FAIL.
    expect(LAB).toContain("TAP_MS");
    expect(LAB).toContain("INCONCLUSIVE");
    expect(LAB).toMatch(/wasATap = lg\.move === 0 && durationMs < TAP_MS/);
  });

  it("counts the drag shield by the attribute dragShield.ts actually sets", () => {
    // Kept in sync by reading the real constant rather than trusting a literal.
    const shieldSrc = read("src/lib/dragShield.ts");
    const attr = /DRAG_SHIELD_ATTR\s*=\s*"([^"]+)"/.exec(shieldSrc)?.[1];
    expect(attr).toBeTruthy();
    expect(LAB).toContain(`[${attr}]`);
  });

  it("reads the width variable, the visual-viewport variable and the shell rect", () => {
    expect(LAB).toContain("--cc-ws-w");
    expect(LAB).toContain("--cc-vvh");
    expect(LAB).toContain("getBoundingClientRect");
  });

  it("inspects the real separator's APG attributes", () => {
    expect(LAB).toContain('[role="separator"]');
    expect(LAB).toContain("aria-orientation");
    expect(LAB).toContain("aria-valuenow");
  });

  it("offers the two diagnostic landscape viewports as one-click presets", () => {
    // 852x393 is the reported bug. 780x360 sits 12px past the old 768px
    // breakpoint and is the single most diagnostic size for this bug class.
    expect(LAB).toMatch(/width:\s*852,\s*height:\s*393/);
    expect(LAB).toMatch(/width:\s*780,\s*height:\s*360/);
  });

  it("ships a positive control for the mount counter", () => {
    // A counter that has never moved is not evidence. The page must be able to
    // force a remount on demand, and must say so until it has been used.
    expect(LAB).toContain("force remount (control)");
    expect(LAB).toContain("controlPresses");
    expect(LAB).toContain("UNVERIFIED");
  });

  it("states what it cannot prove", () => {
    expect(LAB).toContain("What this page CANNOT prove");
  });
});

// ---------------------------------------------------------------------------
// The readout is completely wired
// ---------------------------------------------------------------------------

describe("WorkspaceLab.tsx — the readout has no dead ends", () => {
  const keys = (re: RegExp) => new Set([...LAB.matchAll(re)].map((m) => m[1]));
  const rendered = keys(/\breg\("([^"]+)"\)/g);
  const written = keys(/\bput\(\s*"([^"]+)"/g);

  it("has at least the rows it claims to", () => {
    expect(rendered.size).toBeGreaterThan(20);
    expect(written.size).toBeGreaterThan(20);
  });

  it("every rendered row is written by the readout loop", () => {
    // A row with no writer is a permanent em-dash: it looks like a measurement
    // and reports nothing. The failure mode this catches is renaming one half
    // of the pair, which typechecks perfectly because both are strings.
    expect([...rendered].filter((k) => !written.has(k)).sort()).toEqual([]);
  });

  it("every written value has somewhere to go", () => {
    // The mirror image: a computed verdict that never reaches the DOM. Worse
    // than the above, because the code looks like it is reporting.
    expect([...written].filter((k) => !rendered.has(k)).sort()).toEqual([]);
  });

  it("covers every value amendment A2 item 5 asks for, live", () => {
    const required: [string, string][] = [
      ["vpApp", "innerWidth x innerHeight"],
      ["geoComputed", "the resolved geometry"],
      ["fractionLive", "the current fraction"],
      ["fractionStored", "the committed fraction"],
      ["wsw", "--cc-ws-w as computed"],
      ["vvh", "--cc-vvh"],
      ["shellRect", "the shell's getBoundingClientRect()"],
      ["mountChanges", "mount changes"],
      ["pointerLog", "the capture-phase pointer log"],
    ];
    for (const [key, what] of required) {
      expect(rendered.has(key), `no readout row for ${what}`).toBe(true);
      expect(written.has(key), `nothing ever writes ${what}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The geometry controls, checked against the real kernel
// ---------------------------------------------------------------------------

/** The lab's device table, read out of the source so the assertions below run
 *  against the same numbers the page ships rather than a copy of them. */
function extractPresets(): { label: string; width: number; height: number }[] {
  const at = LAB.indexOf("const PRESETS: Preset[] = [");
  expect(at, "the preset table was renamed").toBeGreaterThan(-1);
  const end = LAB.indexOf("\n];", at);
  expect(end).toBeGreaterThan(at);
  const out: { label: string; width: number; height: number }[] = [];
  const re = /\{\s*label:\s*"([^"]+)",\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g;
  for (const m of LAB.slice(at, end).matchAll(re)) {
    out.push({ label: m[1], width: Number(m[2]), height: Number(m[3]) });
  }
  return out;
}

const PRESETS = extractPresets();
const geo = (p: { width: number; height: number }): WorkspaceGeometry =>
  resolveGeometry({ width: p.width, height: p.height, touchPrimary: false });

describe("WorkspaceLab.tsx — 'force <geometry>' is derived, not asserted", () => {
  it("parsed the table", () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(6);
  });

  it("every geometry is reachable through the REAL resolveGeometry", () => {
    // This is the test that would actually fail if a threshold moved. The
    // buttons pick the first preset the kernel maps to each geometry, so a
    // geometry with no preset renders as "UNREACHABLE" and a whole third of
    // the feature becomes unverifiable in the browser.
    const reached = new Set(PRESETS.map(geo));
    for (const g of ["dock", "drawer", "full"] as const) {
      expect(reached.has(g), `no preset resolves to "${g}" — the "force ${g}" button would be UNREACHABLE`).toBe(true);
    }
  });

  it("ships the two diagnostic landscape phones, and they really do resolve to drawer", () => {
    // 852x393 is the reported bug. 780x360 sits 12px past the old 768px
    // breakpoint and is the most diagnostic size for this bug class. Asserting
    // the DIMENSIONS is a grep; asserting the kernel's answer is a test.
    for (const [w, h] of [
      [852, 393],
      [780, 360],
    ]) {
      const p = PRESETS.find((q) => q.width === w && q.height === h);
      expect(p, `${w}x${h} is missing from the preset table`).toBeTruthy();
      expect(geo(p!), `${w}x${h} must be a drawer — that IS the reported bug`).toBe("drawer");
    }
  });

  it("ships a portrait phone that resolves to full and a laptop that resolves to dock", () => {
    expect(geo(PRESETS.find((p) => p.width === 393 && p.height === 852)!)).toBe("full");
    expect(geo(PRESETS.find((p) => p.width === 1440 && p.height === 900)!)).toBe("dock");
  });

  it("derives the force buttons rather than hard-coding a geometry", () => {
    expect(LAB).toMatch(/const GEOMETRIES: WorkspaceGeometry\[\] = \["dock", "drawer", "full"\]/);
    expect(LAB).toMatch(/function presetForGeometry[\s\S]{0,240}resolveGeometry/);
    expect(LAB).toContain("GEOMETRIES.map");
    expect(LAB).toContain("UNREACHABLE");
  });

  it("ships the other two controls A2 item 6 requires", () => {
    expect(LAB).toContain("toggle fullscreen");
    expect(LAB).toContain("reset stored widths");
    // Cleared through the kernel's constant, not a copy of its value: a
    // hard-coded "cc.workspaceWidth" would keep passing after a rename while
    // the reset button quietly stopped clearing anything.
    expect(LAB).toContain("localStorage.removeItem(WORKSPACE_WIDTH_KEY)");
    expect(LAB).not.toContain('"cc.workspaceWidth"');
  });
});

// ---------------------------------------------------------------------------
// The mount counter's honesty
// ---------------------------------------------------------------------------

describe("WorkspaceLab.tsx — the mount counter tells expected remounts from defects", () => {
  it("treats open/close, selection and the control button as deliberate", () => {
    // Switching files, closing the workspace and the positive control all
    // destroy the frame ON PURPOSE. A counter that cannot say so reports a
    // number nobody can act on, and the first false positive discredits it.
    expect(LAB).toMatch(/\}, \[open, selectedId, remountKey\]\);/);
    expect(LAB).toContain("seamRef");
    expect(LAB).toContain("SEAM_GRACE_MS");
  });

  it("separates explained from unexplained, and headlines the unexplained count", () => {
    expect(LAB).toContain("unexplained");
    expect(LAB).toContain("UNEXPLAINED");
    expect(LAB).toMatch(/a\.unexplained \+= 1/);
    expect(LAB).toMatch(/a\.explained \+= 1/);
  });

  it("refuses to claim PASS until the counter has been observed to fire", () => {
    expect(LAB).toMatch(/const armed = a\.explained > 0/);
    expect(LAB).toContain("INSTRUMENT UNVERIFIED");
    // and the aggregate line must never go green on probes nobody ran
    expect(LAB).toMatch(/It never means "passed"|never means it passed/);
  });

  it("does not read a stale closure for page state", () => {
    // The readout loop is installed once with `[]` deps. Reading `open` or
    // `selectedId` directly there would freeze them at their mount values and
    // silently mis-attribute every remount.
    expect(LAB).toContain("viewRef");
    expect(LAB).toContain("viewRef.current.selectedId");
  });
});

// ---------------------------------------------------------------------------
// The html fixture, executed
// ---------------------------------------------------------------------------

/** Pull the fixture literal out of the source between its markers. It is
 *  written with no backticks and no `${` precisely so this extraction is
 *  exact — assert that, or every test below is measuring the wrong string. */
function extractFixture(): string {
  const start = LAB.indexOf("==LAB-HTML-FIXTURE-START==");
  const end = LAB.indexOf("==LAB-HTML-FIXTURE-END==");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const region = LAB.slice(start, end);
  const first = region.indexOf("`");
  const last = region.lastIndexOf("`");
  expect(first).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(first);
  return region.slice(first + 1, last);
}

const FIXTURE = extractFixture();

interface Posted {
  type?: string;
  mount?: string;
  ticks?: number;
  clicks?: number;
  ageMs?: number;
}

interface Harness {
  posted: Posted[];
  intervals: { fn: () => void; ms: number }[];
  tick: (n?: number) => void;
}

/**
 * Run the fixture's script with injected globals.
 *
 * `setInterval` is a recorder rather than a fake timer: the test then advances
 * the fixture's clock by calling the callback directly, which is exact and
 * needs no timer mocking (jsdom 20 + fake timers interact badly with anything
 * that queues its own tasks).
 */
function runFixture(selfStub: unknown): Harness {
  const script = /<script>([\s\S]*?)<\/script>/.exec(FIXTURE);
  expect(script, "the fixture must contain exactly one inline script").toBeTruthy();

  document.body.innerHTML = FIXTURE;

  const posted: Posted[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];

  const windowStub = {
    parent: {
      postMessage: (data: Posted) => {
        posted.push(data);
      },
    },
  };
  const setIntervalStub = (fn: () => void, ms: number) => {
    intervals.push({ fn, ms });
    return intervals.length;
  };

  const run = new Function("window", "self", "document", "setInterval", script![1]);
  run(windowStub, selfStub, document, setIntervalStub);

  return {
    posted,
    intervals,
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) for (const iv of intervals) iv.fn();
    },
  };
}

describe("the html fixture — the mount-identity instrument", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is extracted verbatim (no interpolation in the literal)", () => {
    expect(FIXTURE).not.toContain("${");
    expect(FIXTURE).toContain("<script>");
    expect(FIXTURE).toContain("</script>");
  });

  it("contains the three things A2 requires of it", () => {
    expect(FIXTURE).toContain("postMessage");
    expect(FIXTURE).toContain("crypto.randomUUID");
    expect(FIXTURE).toContain("setInterval");
  });

  it("mints its mount id from crypto.randomUUID and posts it immediately", () => {
    let minted = 0;
    const h = runFixture({ crypto: { randomUUID: () => `uuid-${++minted}` } });

    expect(minted).toBe(1);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({ type: "lab-artifact", mount: "uuid-1", ticks: 0, clicks: 0 });
    expect(typeof h.posted[0].ageMs).toBe("number");
    // It is rendered in the frame too, so a human can read it without devtools.
    expect(document.getElementById("mount")?.textContent).toBe("uuid-1");
  });

  it("ticks every 250ms, keeps ONE mount id, and reports a rising count", () => {
    const h = runFixture({ crypto: { randomUUID: () => "stable-id" } });

    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].ms).toBe(250);

    h.tick(3);

    const last = h.posted[h.posted.length - 1];
    expect(last.ticks).toBe(3);
    expect(last.mount).toBe("stable-id");
    // Every message in the run carries the same id: a per-tick id would make
    // the page's "mount changes" counter useless noise.
    expect(new Set(h.posted.map((p) => p.mount)).size).toBe(1);
    expect(document.getElementById("ticks")?.textContent).toBe("3");
  });

  it("mints a DIFFERENT id on a second load — which is what a remount looks like", () => {
    // Without this property the counter can never fire, and "mount changes: 0"
    // would be vacuously true forever.
    let n = 0;
    const a = runFixture({ crypto: { randomUUID: () => `uuid-${++n}` } });
    const b = runFixture({ crypto: { randomUUID: () => `uuid-${++n}` } });
    expect(a.posted[0].mount).not.toBe(b.posted[0].mount);
  });

  it("reports in-frame interaction state, so lost state is visible too", () => {
    const h = runFixture({ crypto: { randomUUID: () => "stable-id" } });
    (document.getElementById("bump") as HTMLButtonElement).click();

    const last = h.posted[h.posted.length - 1];
    expect(last.clicks).toBe(1);
    expect(last.mount).toBe("stable-id");
    expect(document.getElementById("clicks")?.textContent).toBe("1");
  });

  it("still mints a unique id when crypto.randomUUID is missing", () => {
    // An opaque-origin frame is a secure context, so randomUUID should exist —
    // but the instrument must never be the thing that fails.
    const a = runFixture({});
    const b = runFixture({});
    expect(a.posted[0].mount).toMatch(/^nouuid-/);
    expect(b.posted[0].mount).toMatch(/^nouuid-/);
    expect(a.posted[0].mount).not.toBe(b.posted[0].mount);
  });

  it("still mints an id when crypto.randomUUID throws", () => {
    const h = runFixture({
      crypto: {
        randomUUID: () => {
          throw new Error("insecure context");
        },
      },
    });
    expect(h.posted[0].mount).toMatch(/^nouuid-/);
  });

  it("survives a parent that refuses the message", () => {
    // `postMessage` is the frame's only channel out; if it throws, the visible
    // in-frame counters must keep running rather than the script dying.
    document.body.innerHTML = FIXTURE;
    const script = /<script>([\s\S]*?)<\/script>/.exec(FIXTURE)!;
    const intervals: (() => void)[] = [];
    const run = new Function("window", "self", "document", "setInterval", script[1]);
    run(
      {
        parent: {
          postMessage: () => {
            throw new Error("blocked");
          },
        },
      },
      { crypto: { randomUUID: () => "stable-id" } },
      document,
      (fn: () => void) => intervals.push(fn),
    );

    expect(() => intervals.forEach((fn) => fn())).not.toThrow();
    expect(document.getElementById("ticks")?.textContent).toBe("1");
  });

  it("posts exactly the shape the page's listener reads", () => {
    // The two halves live in the same file and can drift independently: rename
    // `ticks` in the fixture and the page keeps running, keeps rendering, and
    // silently reports a tick count frozen at zero. Assert the handler actually
    // mentions every key the fixture is observed to post at runtime.
    const h = runFixture({ crypto: { randomUUID: () => "stable-id" } });
    const posted = h.posted[0];
    expect(Object.keys(posted).sort()).toEqual(["ageMs", "clicks", "mount", "ticks", "type"]);

    const start = LAB.indexOf("const onMessage = (e: MessageEvent)");
    expect(start, "the page's message listener was renamed").toBeGreaterThan(-1);
    const handler = LAB.slice(start, LAB.indexOf('window.addEventListener("message"', start));
    expect(handler.length).toBeGreaterThan(200);
    for (const key of Object.keys(posted)) {
      expect(handler, `the page never reads the fixture's "${key}"`).toContain(key);
    }
    // …and the discriminator the handler filters on must be the one posted.
    expect(handler).toContain('"lab-artifact"');
    expect(posted.type).toBe("lab-artifact");
  });

  it("gives the in-frame button a 44px touch target", () => {
    // The fixture is the thing a reviewer taps on a phone to prove state
    // survived a rotation, so it has to be tappable on one.
    expect(FIXTURE).toMatch(/min-height:\s*44px/);
  });
});

// ---------------------------------------------------------------------------
// The viewport-override technique
// ---------------------------------------------------------------------------

describe("simulated viewport — why the lab saves descriptors instead of deleting", () => {
  const saved = Object.getOwnPropertyDescriptor(window, "innerWidth");

  afterEach(() => {
    if (saved) Object.defineProperty(window, "innerWidth", saved);
    else delete (window as unknown as Record<string, unknown>).innerWidth;
  });

  it("an own accessor shadows the real innerWidth and restores exactly", () => {
    const before = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 852 });
    expect(window.innerWidth).toBe(852);

    if (saved) Object.defineProperty(window, "innerWidth", saved);
    else delete (window as unknown as Record<string, unknown>).innerWidth;
    expect(window.innerWidth).toBe(before);
  });

  it("`delete` alone is NOT a safe release — the lab must capture the descriptor", () => {
    // This is the whole reason `setViewportOverride` snapshots the descriptor:
    // whether `innerWidth` is an own property or inherited differs by engine,
    // and where it is an OWN property, deleting it destroys the real value for
    // the rest of the session.
    const ownBefore = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 393 });
    delete (window as unknown as Record<string, unknown>).innerWidth;
    const afterDelete = window.innerWidth;

    if (ownBefore) {
      // jsdom: own property. Deleting it leaves innerWidth undefined — exactly
      // the trap the lab avoids.
      expect(afterDelete).toBeUndefined();
    } else {
      // Chrome: inherited from Window.prototype, so delete happens to work.
      expect(typeof afterDelete).toBe("number");
    }
    expect(readSetViewportOverrideSource()).toContain("restoreDescriptor");
  });
});

/** The lab's release path, as written in source — asserted because the runtime
 *  behaviour above differs between jsdom and Chrome and only the source can be
 *  checked in both. */
function readSetViewportOverrideSource(): string {
  const at = LAB.indexOf("function setViewportOverride");
  expect(at).toBeGreaterThan(-1);
  return LAB.slice(at, at + 1200);
}
