/**
 * The Showcase view and the profile it plays.
 *
 * Two halves, as the repo does elsewhere: real unit tests for the pure
 * assembler in src/lib/bookProfile.ts, and source assertions for the things
 * that live in JSX and would otherwise only be checked by looking.
 *
 * The source assertions are not decoration. An auto-advancing view carries
 * obligations under WCAG 2.2.2 — a pause control, no motion under
 * prefers-reduced-motion, a live region that does not narrate a reel driving
 * itself — and those are exactly the things that get quietly refactored away.
 * They also pin the design claim the whole feature rests on: that nothing in
 * the Showcase branches on *which* season it is. The moment a
 * `season.season === "autumn"` appears, the seasonal layer has stopped being a
 * transform of the theme and started being four hard-coded looks, which is the
 * thing this was built to avoid.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bookProfile, relativeDay, seedOf } from "@/lib/bookProfile";
import { coverArt, FAMILIES } from "@/lib/coverArt";
import { coverTones } from "@/lib/seasonTheme";
import type { BookDocument } from "@/types/library";

const read = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

/**
 * Comments stripped. The assertions below forbid things like
 * `requestAnimationFrame` and `getComputedStyle` appearing in these files, and
 * both files explain at length why those were removed — so matching raw text
 * would fail on the very prose that documents the fix. A claim about what the
 * code does should be checked against the code.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SHOWCASE = stripComments(read("components/LibraryShowcase.tsx"));
const AMBIENCE = stripComments(read("components/SeasonAmbience.tsx"));
const THEME_CTX = read("context/ThemeContext.tsx");
const LIBRARY = read("components/Library.tsx");

const book = (over: Partial<BookDocument> = {}): BookDocument => ({
  id: "b1",
  title: "The Master and His Emissary",
  fileName: "mae.pdf",
  fileData: "",
  pageCount: 600,
  chapters: [],
  addedAt: Date.parse("2026-09-01T00:00:00Z"),
  folderIds: [],
  ...over,
});

describe("bookProfile", () => {
  it("gathers what four different views each used to gather separately", () => {
    const p = bookProfile({
      book: book({
        category: "philosophy",
        tags: ["mind", "hemispheres"],
        summary: "  A case about attention.  ",
        summaryModel: "claude-opus-5",
        chapters: [
          { id: "c1", name: "Asymmetry", startPage: 1, endPage: 40, textContent: "", gist: "Why two hemispheres." },
          { id: "c2", name: "What Do the Two Do?", startPage: 41, endPage: 90, textContent: "" },
        ],
        folderIds: ["s1"],
      }),
      shelfNames: new Map([["s1", "Reading now"]]),
      now: Date.parse("2026-09-19T00:00:00Z"),
    });
    expect(p.summary).toBe("A case about attention.");
    expect(p.summaryModel).toBe("claude-opus-5");
    expect(p.category).toBe("philosophy");
    expect(p.tags).toEqual(["mind", "hemispheres"]);
    expect(p.shelves).toEqual(["Reading now"]);
    expect(p.highlights).toEqual([{ name: "Asymmetry", gist: "Why two hemispheres." }]);
  });

  it("falls back to bare chapter names when no catalog has been generated", () => {
    const p = bookProfile({
      book: book({ chapters: [
        { id: "c1", name: "One", startPage: 1, endPage: 2, textContent: "" },
        { id: "c2", name: "Two", startPage: 3, endPage: 4, textContent: "" },
      ] }),
    });
    expect(p.highlights.map((h) => h.name)).toEqual(["One", "Two"]);
    expect(p.highlights.every((h) => h.gist === null)).toBe(true);
  });

  it("treats opening a book as opening it, not as reading a page of it", () => {
    // Page 1 is where every unopened book sits; calling that 0.2% read would
    // put a progress bar on books nobody has touched.
    expect(bookProfile({ book: book(), lastPage: 1 }).progress).toBeNull();
    expect(bookProfile({ book: book(), lastPage: 0 }).progress).toBeNull();
    expect(bookProfile({ book: book(), lastPage: 150 }).progress).toEqual({ page: 150, pages: 600, pct: 25 });
  });

  it("clamps a stale reading position to the book's length", () => {
    const p = bookProfile({ book: book({ pageCount: 100 }), lastPage: 4000 });
    expect(p.progress).toEqual({ page: 100, pages: 100, pct: 100 });
  });

  it("reports no progress for a book with no page count", () => {
    expect(bookProfile({ book: book({ pageCount: 0 }), lastPage: 12 }).progress).toBeNull();
  });

  it("always has something to say in the stat row", () => {
    const bare = bookProfile({ book: book({ pageCount: 0, chapters: [] }) });
    expect(bare.stats.length).toBeGreaterThan(0);
    expect(bare.stats.some((s) => s.label === "added")).toBe(true);
  });

  it("keeps reserved provenance tags out of the topic tags", () => {
    const p = bookProfile({ book: book({ source: "assistant", tags: ["written-by:assistant", "real-topic"] }) });
    expect(p.tags).toEqual(["real-topic"]);
    expect(p.source).toBe("assistant");
  });

  it("seeds a cover from the book id, so re-sorting cannot restain it", () => {
    expect(seedOf("b1")).toBe(seedOf("b1"));
    expect(seedOf("b1")).not.toBe(seedOf("b2"));
    expect(Number.isInteger(seedOf("anything"))).toBe(true);
  });

  it("formats added dates the way the rest of the library does", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(relativeDay(now - 3600_000, now)).toBe("today");
    expect(relativeDay(now - 36 * 3600_000, now)).toBe("yesterday");
    expect(relativeDay(now - 5 * 86_400_000, now)).toBe("5 days ago");
    expect(relativeDay(Date.parse("2020-01-02T00:00:00Z"), now)).toMatch(/2020/);
  });
});

describe("LibraryShowcase source", () => {
  it("was actually read", () => {
    expect(SHOWCASE.length).toBeGreaterThan(4000); // stripped of comments
  });

  it("never branches on which season it is", () => {
    // The premise: season is a transform published by the theme layer, not
    // four authored looks. Any equality test against a season name here means
    // that premise has been abandoned.
    expect(SHOWCASE).not.toMatch(/season\.season\s*===/);
    expect(SHOWCASE).not.toMatch(/case\s+"(winter|spring|summer|autumn)"/);
  });

  /**
   * THE HANG. This view first shipped as a self-advancing reel: a 50ms
   * interval re-rendered the whole rail twenty times a second while the
   * backdrop ran an animation frame loop. That is what made the Vault take
   * minutes to become usable. Nothing in this view may drive itself.
   */
  it("has no timer and no animation frame of any kind", () => {
    expect(SHOWCASE).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    expect(AMBIENCE).not.toMatch(/setInterval|requestAnimationFrame/);
  });

  it("never reads computed style, which is what actually locked the tab", () => {
    // getComputedStyle forces the browser to flush style for the whole
    // document. Eight per frame at 60fps, on a Vault holding hundreds of rows,
    // is several hundred forced style recalculations a second. The scalars are
    // handed over as numbers by seasonalTheme() instead.
    expect(AMBIENCE).not.toContain("getComputedStyle");
    expect(SHOWCASE).not.toContain("getComputedStyle");
  });

  it("remembers which book was open across a view switch", () => {
    expect(SHOWCASE).toContain('const SELECTED_KEY = "vault_showcase_book"');
    expect(SHOWCASE).toContain("localStorage.getItem(SELECTED_KEY)");
    expect(SHOWCASE).toContain("localStorage.setItem(SELECTED_KEY, id)");
  });

  it("renders the rail a page at a time rather than the whole library", () => {
    expect(SHOWCASE).toContain("const RAIL_PAGE = 50;");
    expect(SHOWCASE).toContain("profiles.slice(0, shown)");
  });

  it("computes cover tones on demand and caches them", () => {
    // Each one runs a gamut-mapping bisection per stop; doing all of them up
    // front is real work on a large library and pointless when the rail shows
    // fifty rows.
    expect(SHOWCASE).toContain("cache.get(seed)");
  });

  it("binds the arrow keys, Home and End", () => {
    expect(SHOWCASE).toContain('e.key === "ArrowDown"');
    expect(SHOWCASE).toContain('e.key === "ArrowUp"');
    expect(SHOWCASE).toContain('e.key === "Home"');
    expect(SHOWCASE).toContain('e.key === "End"');
  });

  it("scrolls the remembered row into view without yanking the page", () => {
    expect(SHOWCASE).toContain('scrollIntoView({ block: "nearest" })');
  });

  it("lazily loads real cover images", () => {
    expect(SHOWCASE).toContain('loading="lazy"');
  });

  it("makes no network call and generates nothing", () => {
    // The user reasonably asked whether this view was spending model quota.
    // It reads what is already in memory; there is nothing here to spend.
    for (const forbidden of ["supabase", "fetch(", "enqueue", "generateBookSummary"]) {
      expect(SHOWCASE).not.toContain(forbidden);
    }
  });
});

describe("SeasonAmbience source", () => {
  it("was actually read", () => {
    expect(AMBIENCE.length).toBeGreaterThan(900); // stripped of comments
  });

  it("takes every colour and every scalar from the theme layer, as numbers", () => {
    expect(AMBIENCE).toContain("seasonalTheme(getTheme(themeId), season)");
    for (const v of ["s.elevation", "s.aurora", "s.bloom", "s.onDark", "s.glow", "s.mote"]) {
      expect(AMBIENCE).toContain(v);
    }
    // No hex literals: a hard-coded colour would be one theme's colour.
    expect(AMBIENCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("never branches on which season it is", () => {
    expect(AMBIENCE).not.toMatch(/"(winter|spring|summer|autumn)"/);
  });

  it("blends the other way round on a light theme", () => {
    // Light added to paper white reads as nothing. If this ever collapses to a
    // single blend mode, the glow silently disappears on Fruit Stripe.
    expect(AMBIENCE).toContain('mixBlendMode: s.onDark ? "screen" : "multiply"');
    expect(AMBIENCE).toContain("oklchToHex(s.onDark ? s.glow : s.mote)");
  });

  /**
   * THE LOOK. The still canvas fixed the hang and kept the picture: three
   * diagonal shafts and an aurora curtain, smeared straight through the title
   * and summary. It is one glow now, and it is not a canvas at all.
   */
  it("is one gradient on a div — no canvas, no observer, no effect", () => {
    for (const gone of ["<canvas", "getContext", "ResizeObserver", "useEffect", "drawImage"]) {
      expect(AMBIENCE).not.toContain(gone);
    }
    expect(AMBIENCE.match(/radial-gradient\(/g)?.length).toBe(1);
  });

  it("stands on the year marker, and only in the header", () => {
    expect(AMBIENCE).toContain("at ${x}% 100%");
    expect(SHOWCASE).toContain("<SeasonAmbience at={yearFrac} />");
    // Mounted inside <header>, so nothing is painted behind text to be read.
    const header = SHOWCASE.slice(SHOWCASE.indexOf("<header"), SHOWCASE.indexOf("</header>"));
    expect(header).toContain("<SeasonAmbience");
    expect(SHOWCASE.replace(header, "")).not.toContain("<SeasonAmbience");
  });
});

describe("ThemeContext source", () => {
  it("applies the season after the theme, so it can rewrite the theme's tokens", () => {
    expect(THEME_CTX).toContain("const merged = { ...theme.tokens, ...seasonVars };");
    expect(THEME_CTX).toContain("appliedKeys = Object.keys(merged);");
  });

  it("re-evaluates the season when the day rolls over and when the tab returns", () => {
    expect(THEME_CTX).toContain("msUntilNextLocalMidnight");
    expect(THEME_CTX).toContain('document.addEventListener("visibilitychange", onVisible)');
  });

  it("lets the season be switched off entirely", () => {
    expect(THEME_CTX).toContain("const vars = seasonal ? seasonalTheme(getTheme(themeId), season).vars : {};");
  });
});

describe("generated covers", () => {
  it("draws the same cover for the same book, every time", () => {
    expect(coverArt(12345)).toEqual(coverArt(12345));
  });

  it("uses every family across a shelf, even for near-identical ids", () => {
    // `seed % 6` on FNV hashes of "book-1".."book-40" clustered; the family
    // comes off the generator instead.
    const seen = new Set(Array.from({ length: 40 }, (_, i) => coverArt(seedOf(`book-${i}`)).family));
    expect(seen.size).toBe(FAMILIES.length);
  });

  it("stays flat: three tones, nothing else", () => {
    for (let i = 0; i < 200; i++) {
      for (const sh of coverArt(seedOf(`b${i}`)).shapes) {
        expect(["figure", "accent", "ground"]).toContain(sh.tone);
      }
    }
  });

  it("always has an accent, so no cover is a single flat colour", () => {
    for (let i = 0; i < 200; i++) {
      const tones = coverArt(seedOf(`b${i}`)).shapes.map((s) => s.tone);
      expect(tones).toContain("accent");
      expect(tones.length).toBeGreaterThan(1);
    }
  });

  it("emits finite, rounded numbers", () => {
    for (let i = 0; i < 100; i++) {
      for (const sh of coverArt(seedOf(`n${i}`)).shapes) {
        const nums = sh.k === "path" ? sh.d.match(/-?[\d.]+/g)!.map(Number) : Object.values(sh).filter((v) => typeof v === "number") as number[];
        for (const n of nums) {
          expect(Number.isFinite(n)).toBe(true);
          expect(Math.abs(n * 100 - Math.round(n * 100))).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("prints them as a ladder away from the page, on dark and on paper", () => {
    const glow = { l: 0.7, c: 0.12, h: 30 };
    const L = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    const dark = coverTones(7, glow, 0.15);
    expect(L(dark.ground)).toBeLessThan(L(dark.figure));
    expect(L(dark.figure)).toBeLessThan(L(dark.accent));
    expect(L(dark.accent)).toBeLessThan(L(dark.ink));
    const paper = coverTones(7, glow, 0.97);
    expect(L(paper.ground)).toBeGreaterThan(L(paper.figure));
    expect(L(paper.figure)).toBeGreaterThan(L(paper.accent));
    expect(L(paper.accent)).toBeGreaterThan(L(paper.ink));
  });

  it("is what the Showcase draws when a book has no image", () => {
    expect(SHOWCASE).toContain("coverArt(profile.seed)");
    expect(SHOWCASE).not.toContain("linear-gradient(145deg");
  });
});

describe("the year is the header's rule", () => {
  it("replaces the corner dial with a full-width band", () => {
    expect(SHOWCASE).not.toContain("YearRing");
    expect(SHOWCASE).toContain("<YearBand frac={yearFrac}");
    expect(SHOWCASE).toContain("season.angle / (Math.PI * 2)");
  });

  it("still describes itself to a screen reader", () => {
    expect(SHOWCASE).toMatch(/role="img" aria-label=\{label\}/);
  });
});

describe("Library wiring", () => {
  it("keeps the upload dropzone out of the Showcase, but adding a book within reach", () => {
    expect(LIBRARY).toContain('view !== "graph" && view !== "showcase" && (');
    const compact = LIBRARY.slice(LIBRARY.indexOf('(view === "graph" || view === "showcase") && ('));
    expect(compact.slice(0, 900)).toContain("fileInputRef.current?.click()");
    expect(compact.slice(0, 1800)).toContain("From YouTube");
  });

  it("offers the Showcase as a fourth view and remembers it", () => {
    expect(LIBRARY).toContain('type ViewMode = "shelves" | "list" | "showcase" | "graph";');
    expect(LIBRARY).toContain('{ id: "showcase", icon: "play_circle", label: "Showcase" },');
    expect(LIBRARY).toContain('v === "showcase" ? v : "shelves"');
    expect(LIBRARY).toContain('view === "showcase" ? (');
  });

  it("feeds the Showcase the filtered set, so search still narrows it", () => {
    const slice = LIBRARY.slice(LIBRARY.indexOf('view === "showcase" ? ('), LIBRARY.indexOf('view === "list" ? ('));
    expect(slice.length).toBeGreaterThan(120);
    expect(slice).toContain("books={filteredBooks}");
    expect(slice).toContain("shelves={shelves}");
  });
});
