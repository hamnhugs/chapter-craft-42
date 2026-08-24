import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHORT_VIEWPORT_MAX_HEIGHT } from "@/lib/workspaceLayout";

/**
 * THE VAULT'S MOBILE LAYOUT — a standing guard on a bug that was invisible to
 * everyone who only ever opened the Vault on a desktop.
 *
 * ── What happened ────────────────────────────────────────────────────────
 *
 * `.book-grid` was `grid-template-columns: 1fr`. `1fr` is shorthand for
 * `minmax(auto, 1fr)`, and that `auto` floor is the widest grid ITEM's
 * min-content contribution — a floor a `1fr` share can never shrink below. So
 * the single widest card in the library sized EVERY card in the library.
 *
 * Measured on the live app at a 375px viewport, signed in, 54 books: one title
 * imported as a raw filename —
 *
 *   "The Wireless Cookbook_ … -- d5659d01fa25730be5e83fbdc52e192c -- Anna's Archive"
 *
 * — carries a 32-character MD5 with no soft break opportunity. At `text-2xl`
 * that token is 436.61px wide, which made the card's min-content 484.61px,
 * which set the grid track to 484.61px inside a 327px container. All 54 cards
 * rendered 485px wide and the Vault scrolled horizontally to 509px. The other
 * 53 books were blameless and no amount of looking at them would have found it.
 *
 * ── Why these tests are shaped like this ─────────────────────────────────
 *
 * The fix is not "shorten that one title". It is that no single book's
 * metadata may size the grid, which is a property of the stylesheet, so that
 * is what gets pinned. Three independent guards are asserted because the bug
 * cost a full live-measurement session to find and any one of them is
 * sufficient: `minmax(0, …)` tracks, `overflow-wrap: anywhere` on the title,
 * and inline-size containment on the card.
 *
 * The last describe block is the load-bearing one. Every rule here is a CSS
 * class in `index.css` paired with a `className` in a `.tsx` file, and nothing
 * in the type system connects the two: renaming `cc-book-info` in one file and
 * not the other silently reverts the entire fix with a green build, a green
 * typecheck, and a green test suite. So the pairing itself is the property
 * under test.
 */

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const CSS = src("src/index.css");
const LIBRARY = src("src/components/Library.tsx");
const SHELVES = src("src/components/LibraryShelves.tsx");

/** Strip CSS comments so an ABSENCE scan asserts on rules, not on the prose
 *  that explains them — every rule below documents the bug it prevents, and a
 *  test that fails on its own rationale gets deleted. */
const cssCode = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
/** Same, for TSX. */
const tsxCode = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CSS_CODE = cssCode(CSS);

/** Every `grid-template-columns` declaration that styles `.book-grid`. */
function bookGridTracks(): string[] {
  const out: string[] = [];
  const re = /\.book-grid\s*\{([^}]*)\}/g;
  for (const m of CSS_CODE.matchAll(re)) {
    for (const d of m[1].split(";")) {
      const [prop, ...rest] = d.split(":");
      if (prop?.trim() === "grid-template-columns") out.push(rest.join(":").trim());
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("the grid blowout cannot come back", () => {
  it("declares at least one .book-grid track (the rules still exist)", () => {
    expect(bookGridTracks().length).toBeGreaterThanOrEqual(3);
  });

  it("no .book-grid track is a bare `1fr` — every one carries a minmax(0, …) floor", () => {
    for (const track of bookGridTracks()) {
      // Remove the legitimate `1fr`s — the ones already inside a `minmax(0, …)`
      // — and any bare `1fr` still standing is a track with an `auto` floor.
      const bare = track.replace(/minmax\(\s*0[^)]*\)/g, "«ok»");
      expect(
        bare,
        `"grid-template-columns: ${track}" lets the widest book's min-content size every card. ` +
          "Use minmax(0, 1fr) / repeat(N, minmax(0, 1fr)).",
      ).not.toMatch(/\b\d+(?:\.\d+)?fr\b/);
      expect(track).toContain("minmax(0");
    }
  });

  it("the card is an inline-size query container, which zeroes its min-content contribution", () => {
    expect(CSS_CODE).toMatch(/\[data-book-card\]\s*\{[^}]*container-type:\s*inline-size/);
    expect(CSS_CODE).toMatch(/\[data-book-card\]\s*\{[^}]*container-name:\s*bookcard/);
  });

  it("book titles break inside an unbreakable token — `anywhere`, not `break-word`", () => {
    // Only `anywhere` collapses the MIN-CONTENT width, which is the number the
    // grid track and the flex row are sized from. `break-word` wraps visually
    // and leaves the intrinsic size untouched, so it would not have helped.
    expect(CSS_CODE).toMatch(/\.cc-book-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("the real-world title that triggered it would no longer size a track", () => {
    // A regression fixture, not a unit under test: if someone reverts to a bare
    // `1fr` this string is what the failure above is about.
    const title =
      "The Wireless Cookbook_ Build Real Projects and Master Wi-Fi, -- Bill Zimmerman " +
      "-- 1, 2026 -- No Starch Press, Incorporated -- isbn13 9781718504363 " +
      "-- d5659d01fa25730be5e83fbdc52e192c -- Anna's Archive";
    const longestToken = title.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    expect(longestToken).toBe("d5659d01fa25730be5e83fbdc52e192c");
    expect(longestToken.length).toBeGreaterThan(24);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("compact card: the container-query and short-viewport twins agree", () => {
  /** `selector :: declaration` pairs inside an at-rule block. Selectors are
   *  kept deliberately: with them stripped, `font-size: 1rem` on the rename
   *  input and `font-size: 1rem` accidentally moved onto the title would
   *  compare equal while rendering completely differently. */
  function declarationsIn(header: RegExp): string[] {
    const start = CSS_CODE.search(header);
    expect(start, `at-rule not found: ${header}`).toBeGreaterThan(-1);
    // Walk braces from the header to find the block's true end.
    let i = CSS_CODE.indexOf("{", start);
    let depth = 0;
    const from = i;
    for (; i < CSS_CODE.length; i++) {
      if (CSS_CODE[i] === "{") depth++;
      else if (CSS_CODE[i] === "}" && --depth === 0) break;
    }
    const out: string[] = [];
    for (const m of CSS_CODE.slice(from + 1, i).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].replace(/\s+/g, " ").trim();
      for (const d of m[2].split(";")) {
        const decl = d.replace(/\s+/g, " ").trim();
        if (decl.includes(":")) out.push(`${sel} :: ${decl}`);
      }
    }
    return out;
  }

  it("both compact blocks exist", () => {
    expect(CSS_CODE).toMatch(/@container bookcard \(max-width:\s*260px\)/);
    expect(CSS_CODE).toMatch(/@media \(max-height:\s*480px\)/);
  });

  it("the height twin carries every declaration the container twin does — duplicated on purpose, and it must not drift", () => {
    // A container query cannot see viewport height, so the compact card is
    // declared twice. The height block is allowed to add SHORT-VIEWPORT-ONLY
    // extras on top (the cover cap), but it may never be missing anything the
    // container block has — that asymmetry is the drift this guards.
    const byContainer = declarationsIn(/@container bookcard \(max-width:\s*260px\)/);
    const byHeight = new Set(declarationsIn(/@media \(max-height:\s*480px\)/));
    expect(byContainer.length).toBeGreaterThan(5);
    const missing = byContainer.filter((d) => !byHeight.has(d));
    expect(missing, "a landscape phone would not get these compact rules").toEqual([]);
  });

  it("the short-viewport threshold is the layout kernel's, not a second opinion", () => {
    expect(SHORT_VIEWPORT_MAX_HEIGHT).toBe(480);
    expect(CSS_CODE).toContain(`max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px`);
  });

  it("the page chrome collapses on EITHER axis — a landscape phone is 852x393", () => {
    // Width alone is the bug the workspace layout kernel exists to prevent:
    // 6 of 7 common phones clear 768px in landscape.
    expect(CSS_CODE).toMatch(
      /@media \(max-width:\s*640px\),\s*\(max-height:\s*480px\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("no control is reachable only by hovering", () => {
  const HOVER_ONLY = /opacity-0[^"]*group-hover:opacity-100/;

  it("index.css un-hides .cc-hover-reveal where the pointer cannot hover", () => {
    expect(CSS_CODE).toMatch(/@media \(hover:\s*none\)[\s\S]{0,400}\.cc-hover-reveal\s*\{[^}]*opacity:\s*1/);
  });

  it("every hover-revealed control in the Vault opts into that rule", () => {
    for (const [name, source] of [
      ["Library.tsx", LIBRARY],
      ["LibraryShelves.tsx", SHELVES],
    ] as const) {
      // Scan className VALUES, not source lines: a per-line regex silently
      // passes any className attribute that wraps across lines.
      const classValues = [...tsxCode(source).matchAll(/className=\{?\s*(["'`])([\s\S]*?)\1/g)].map(
        (m) => m[2],
      );
      expect(classValues.length).toBeGreaterThan(10);
      const offenders = classValues.filter(
        (v) => HOVER_ONLY.test(v) && !v.includes("cc-hover-reveal"),
      );
      expect(
        offenders,
        `${name}: a control hidden behind :hover with no touch route — ` +
          "a touch screen never fires hover, so this capability would be unreachable on a phone.",
      ).toEqual([]);
    }
  });

  it("the shelf-membership menu and the shelf actions are the three that were unreachable", () => {
    // Named explicitly: these were measured at opacity 0 on the live app with
    // (any-hover: hover) false. Putting a book on a shelf, renaming a shelf and
    // deleting a shelf had no other route on a phone.
    const code = tsxCode(SHELVES);

    // The book card's shelf trigger: reveal + a 44px target on the same element.
    const trigger = code.split("\n").find((l) => l.includes("cc-tap-44"));
    expect(trigger, "the shelf-membership trigger lost its touch target").toBeTruthy();
    expect(trigger).toContain("cc-hover-reveal");

    // The shelf card's three actions: one revealed container, three 32px targets.
    const container = code.split("\n").find((l) => l.includes("cc-hover-reveal") && !l.includes("cc-tap-44"));
    expect(container, "the shelf card's action row lost its reveal").toBeTruthy();
    expect(container).toMatch(/opacity-0[^"]*group-hover:opacity-100/);
    expect([...code.matchAll(/cc-tap-32/g)]).toHaveLength(3);
    for (const title of ['title="Rename"', 'title="Delete"', "title={`Chat with"]) {
      expect(code, `${title} is gone — re-check which control this test guards`).toContain(title);
    }
  });

  it("touch targets clear the WCAG 2.2 SC 2.5.8 floor of 24px, inside the hover-none block", () => {
    // Locate EVERY @media (hover: none) block (there are two: the latched-lift
    // reset and the affordance block): sizing rules OUTSIDE all of them would
    // still work, but rules moved into a hover-CAPABLE query would never fire
    // on the devices they exist for — position is part of the contract.
    const ranges: Array<[number, number]> = [];
    for (const m of CSS_CODE.matchAll(/@media \(hover:\s*none\)/g)) {
      let j = CSS_CODE.indexOf("{", m.index!);
      let d = 0;
      for (; j < CSS_CODE.length; j++) {
        if (CSS_CODE[j] === "{") d++;
        else if (CSS_CODE[j] === "}" && --d === 0) break;
      }
      ranges.push([m.index!, j]);
    }
    expect(ranges.length).toBeGreaterThan(0);
    const inHoverNone = (at: number) => ranges.some(([a, b]) => at > a && at < b);
    for (const [cls, expected] of [["cc-tap-44", 44], ["cc-tap-32", 32]] as const) {
      // Collect EVERY rule block for the class: the two share one block for
      // `display` and take their sizes in separate ones.
      const blocks = [...CSS_CODE.matchAll(new RegExp(`\\.${cls}[^{}]*\\{([^}]*)\\}`, "g"))];
      expect(blocks.length, `.${cls} is used in the components but styled nowhere`).toBeGreaterThan(0);
      const sized = blocks.filter((b) => /min-(?:width|height):/.test(b[1]));
      for (const b of sized) {
        expect(inHoverNone(b.index!), `.${cls} sizing declared outside @media (hover: none)`).toBe(true);
      }
      const px = blocks
        .flatMap((b) => [...b[1].matchAll(/min-(?:width|height):\s*(\d+)px/g)])
        .map((x) => Number(x[1]));
      expect(px, `.${cls} sets no min-width/min-height`).toHaveLength(2);
      for (const v of px) {
        expect(v).toBe(expected);
        expect(v).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it("an ICON-ONLY action's only description is never a title= that a touch screen cannot show", () => {
    // `title` surfaces on hover, which a touch screen never fires. A button
    // with visible text is already named — adding an aria-label there would
    // override the visible label and break WCAG 2.5.3. The ones that matter
    // are icon-only: strip the icon ligature spans, and if nothing renderable
    // is left, `title` was carrying the whole meaning.
    for (const [name, source] of [
      ["Library.tsx", LIBRARY],
      ["LibraryShelves.tsx", SHELVES],
    ] as const) {
      const parts = tsxCode(source).split(/<button\b/).slice(1);
      const offenders: string[] = [];
      for (const part of parts) {
        const end = part.indexOf("</button>");
        if (end === -1) continue;
        const whole = part.slice(0, end);
        const openTag = whole.slice(0, whole.indexOf(">"));
        if (!/\btitle=/.test(openTag) || /\baria-label=/.test(openTag)) continue;
        const body = whole
          .slice(whole.indexOf(">") + 1)
          .replace(/<span[^>]*material-symbols-outlined[\s\S]*?<\/span>/g, "")
          .replace(/<[^>]*>/g, "")
          .trim();
        if (body === "") offenders.push(openTag.replace(/\s+/g, " ").slice(0, 90));
      }
      expect(
        offenders,
        `${name}: an icon-only button whose only description is a hover-only title`,
      ).toEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the marker classes are wired to something at both ends", () => {
  /**
   * THE ONE THAT ACTUALLY GUARDS THE FIX.
   *
   * Every rule in this feature is a CSS class in one file paired with a
   * `className` string in another, with nothing in the type system between
   * them. Rename either half and the Vault silently reverts to the broken
   * layout: the build is green, `tsc` is green, and every other test in this
   * file still passes because it only reads the CSS.
   */
  const MARKERS = [
    "cc-book-cover",
    "cc-book-info",
    "cc-book-title",
    "cc-book-meta",
    "cc-book-tags",
    "cc-book-status",
    "cc-book-actions",
    "cc-book-open",
    "cc-vault-main",
    "cc-vault-title",
    "cc-vault-dropzone",
    "cc-dropzone-icon",
    "cc-dropzone-title",
    "cc-dropzone-hint",
    "cc-dropzone-actions",
    "cc-hover-reveal",
    "cc-tap-44",
    "cc-tap-32",
  ] as const;

  const TSX = tsxCode(LIBRARY) + "\n" + tsxCode(SHELVES);

  for (const marker of MARKERS) {
    it(`${marker} is both styled in index.css and applied in the Vault`, () => {
      expect(CSS_CODE, `.${marker} is applied in a component but styled nowhere`).toContain(
        `.${marker}`,
      );
      expect(TSX, `.${marker} is styled in index.css but applied to no element`).toContain(marker);
    });
  }

  it("the narrow-card reveal beats its own default — source order, not specificity", () => {
    // `@container` and `@media` add NO specificity, so `[data-cc-narrow]
    // { display: none }` and the `{ display: inline-flex }` inside the compact
    // blocks are both (0,1,0) and the LATER one wins outright. Shipped the
    // wrong way round once: the default sat below both reveals, so every
    // narrow card had its secondary actions unconditionally display:none and
    // no book could be deleted, detected or renamed on a phone.
    const hide = CSS_CODE.indexOf("[data-cc-narrow] { display: none;");
    expect(hide, "the [data-cc-narrow] default is gone").toBeGreaterThan(-1);
    const reveals = [...CSS_CODE.matchAll(/\[data-cc-narrow\]\s*\{\s*display:\s*inline-flex/g)].map(
      (m) => m.index!,
    );
    // Two compact blocks + the @media (hover: none) tablet reveal — a touch
    // tablet has wide cards and a tall viewport, so neither compact block
    // fires there and the hover-none reveal is Rename's only touch route.
    expect(reveals.length, "expected the two compact reveals plus the hover-none tablet reveal").toBe(3);
    for (const at of reveals) {
      expect(at, "a reveal is declared ABOVE the default, so the default wins and nothing shows").toBeGreaterThan(hide);
    }
  });

  it("the narrow-card overflow menu is display-toggled, never branch-rendered", () => {
    // Two JSX branches for the same subtree would remount the card on every
    // column-count change and drop the dropdown's open state mid-interaction —
    // the same law that keeps the workspace viewer at one JSX position.
    expect(CSS_CODE).toMatch(/\[data-cc-narrow\]\s*\{\s*display:\s*none/);
    expect(CSS_CODE).toMatch(/\[data-cc-wide\]\s*\{\s*display:\s*none/);
    expect(LIBRARY).toContain("data-cc-narrow");
    expect(LIBRARY).toContain("data-cc-wide");
    // The wide buttons and the menu items are the same actions, so their
    // labels come from one binding each rather than being written twice.
    for (const label of ["detectLabel", "extractLabel", "removeLabel"]) {
      const uses = [...tsxCode(LIBRARY).matchAll(new RegExp(`\\b${label}\\b`, "g"))].length;
      expect(uses, `${label} should be defined once and used by both routes`).toBeGreaterThanOrEqual(3);
    }
  });

  it("no query container sits above the mind map's fixed fullscreen overlay", () => {
    // `container-type` applies layout containment, and layout containment makes
    // an element a containing block for `position: fixed` descendants. Chromium
    // 148 measured as NOT confining it, but the spec says it should and engines
    // disagree — and this repo has already shipped that exact failure once,
    // with aurora's `backdrop-filter` confining MediaFrame's fullscreen. So the
    // container lives on the shelves view, which holds the only `.book-grid`
    // and no fixed-position descendant, rather than on `<main>`.
    const GRAPH = src("src/components/LibraryGraph.tsx");
    expect(GRAPH, "the graph's fullscreen is no longer `fixed` — re-check this guard").toContain(
      "fixed inset-0 z-[100]",
    );
    // `<main>` wraps the graph, so it must not be a container.
    const mainTag = tsxCode(LIBRARY).split("\n").find((l) => l.includes("<main"));
    expect(mainTag).toBeTruthy();
    expect(mainTag, "cc-container on <main> puts a query container above the graph").not.toContain(
      "cc-container",
    );
    // …and the shelves view, which does not, must be one.
    expect([...tsxCode(SHELVES).matchAll(/cc-container/g)], "both shelves roots need it").toHaveLength(2);
  });

  it("the mind map is never taller than the viewport it has to fit in", () => {
    // A bare `min-h-[420px]` exceeds the whole 393px viewport of every rotated
    // target phone, which no amount of scrolling recovers inside a 60vh box.
    for (const [name, source] of [
      ["LibraryGraph.tsx", src("src/components/LibraryGraph.tsx")],
      ["Library.tsx", LIBRARY],
    ] as const) {
      expect(source, `${name}: an unclamped 420px floor`).not.toContain("min-h-[420px]");
      expect(source).toContain("min-h-[min(420px,60dvh)]");
    }
  });

  it("the list view's column floors fit the width the shell actually leaves it", () => {
    // The `md:` breakpoint is 768 — the same 768 that reveals TabletRail
    // (`hidden md:flex lg:hidden w-20`), so md costs 80px of rail plus the
    // Vault's own 32px of padding. Worst case is iPad portrait, 768 wide.
    const LIST = src("src/components/LibraryList.tsx");
    const md = /md:grid-cols-\[([^\]]+)\]/.exec(LIST);
    expect(md, "the md template moved").not.toBeNull();
    const REM = 16;
    const tracks = md![1].split("_").map((t) => {
      const mm = /minmax\(([\d.]+)rem/.exec(t);
      if (mm) return Number(mm[1]) * REM;
      return Number(/([\d.]+)rem/.exec(t)![1]) * REM;
    });
    const floors = tracks.reduce((a, b) => a + b, 0);
    const gaps = (tracks.length - 1) * 12; // gap-3
    const padding = 32; // px-4
    const needs = floors + gaps + padding;
    const available = 768 - 80 /* rail */ - 32 /* .cc-vault-main padding */;
    expect(needs, `md row needs ${needs}px but only ${available}px exist at 768px wide`).toBeLessThanOrEqual(
      available,
    );
  });

  it("the list header and body rows carry identical templates at every breakpoint", () => {
    // They are two separate class strings (the header hides on mobile, the
    // body has its own mobile template), so nothing but this keeps them from
    // drifting — and a drift misaligns every column at that breakpoint.
    const LIST = src("src/components/LibraryList.tsx");
    // Plain string splitting, no regex: the arbitrary-value syntax is full of
    // regex metacharacters and an escaping slip here fails open.
    const templatesIn = (line: string, prefix: string) =>
      line
        .split(`${prefix}grid-cols-[`)
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf("]")))
        // an un-prefixed split also captures sm:/md:/lg: occurrences — drop
        // any whose preceding text ends with a variant prefix
        .filter((_, idx, __) => {
          if (prefix !== "") return true;
          const at = line.split(`grid-cols-[`)[idx];
          return !/(?:sm|md|lg):$/.test(at);
        });
    const [headerLine, rowLine] = LIST.split("\n").filter((l) => l.includes("grid-cols-["));
    expect(headerLine && rowLine, "expected exactly a header line and a row line").toBeTruthy();
    // The header is hidden below sm, so its BARE template is its sm-level
    // template; the row's mobile template has no header twin by design.
    const pairs: Array<[string, string, string]> = [
      [templatesIn(headerLine, "")[0], templatesIn(rowLine, "sm:")[0], "sm"],
      [templatesIn(headerLine, "md:")[0], templatesIn(rowLine, "md:")[0], "md"],
      [templatesIn(headerLine, "lg:")[0], templatesIn(rowLine, "lg:")[0], "lg"],
    ];
    for (const [header, row, bp] of pairs) {
      expect(header, `${bp}: header template missing`).toBeTruthy();
      expect(header, `${bp}: header and row templates disagree — every column misaligns`).toBe(row);
    }
  });

  it("the shelf name has a definite width, so its truncate cannot widen the card", () => {
    // A flex item in a COLUMN flex container is fit-content in the cross axis
    // and `min-w-0` does not constrain it — only a definite width does.
    expect(SHELVES).toMatch(/className="w-full min-w-0 z-10 pointer-events-none"/);
  });
});
