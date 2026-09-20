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
import type { BookDocument } from "@/types/library";

const read = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

const SHOWCASE = read("components/LibraryShowcase.tsx");
const AMBIENCE = read("components/SeasonAmbience.tsx");
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
    expect(SHOWCASE.length).toBeGreaterThan(4000);
  });

  it("never branches on which season it is", () => {
    // The entire premise: season is a transform published as CSS variables,
    // not four authored looks. Any equality test against a season name here
    // means that premise has been abandoned.
    expect(SHOWCASE).not.toMatch(/season\.season\s*===/);
    expect(SHOWCASE).not.toMatch(/case\s+"(winter|spring|summer|autumn)"/);
  });

  it("carries a real pause control, not just prefers-reduced-motion", () => {
    expect(SHOWCASE).toContain('aria-label={playing ? "Pause the showcase" : "Play the showcase"}');
    expect(SHOWCASE).toContain("aria-pressed={playing}");
  });

  it("does not auto-advance under prefers-reduced-motion", () => {
    expect(SHOWCASE).toContain("const [playing, setPlaying] = useState(() => !readReduced());");
    expect(SHOWCASE).toContain("const advancing = playing && !reduced && !hovered && count > 1;");
  });

  it("watches prefers-reduced-motion rather than reading it once at mount", () => {
    expect(SHOWCASE).toContain('mq.addEventListener?.("change", onChange)');
    expect(AMBIENCE).toContain('mq.addEventListener?.("change", onChange)');
  });

  it("pauses when a pointer or the keyboard is on it", () => {
    expect(SHOWCASE).toContain("onMouseEnter={() => setHovered(true)}");
    expect(SHOWCASE).toContain("onFocus={() => setHovered(true)}");
  });

  it("stays quiet while driving itself and speaks when the reader drives", () => {
    expect(SHOWCASE).toContain('aria-live={advancing ? "off" : "polite"}');
  });

  it("binds the arrow keys and space", () => {
    expect(SHOWCASE).toContain('e.key === "ArrowRight"');
    expect(SHOWCASE).toContain('e.key === "ArrowLeft"');
    expect(SHOWCASE).toContain('e.key === " "');
  });
});

describe("SeasonAmbience source", () => {
  it("was actually read", () => {
    expect(AMBIENCE.length).toBeGreaterThan(3000);
  });

  it("takes every colour and direction from the theme layer's variables", () => {
    for (const v of ["--season-mote", "--season-glow", "--season-drift", "--season-light",
                     "--season-tempo", "--season-elevation", "--season-aurora", "--season-polarity"]) {
      expect(AMBIENCE).toContain(v);
    }
    // No hex literals: a hard-coded colour would be one theme's colour.
    expect(AMBIENCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("never branches on which season it is", () => {
    // Same premise as the Showcase: the show is a function of the published
    // variables, not four authored looks.
    expect(AMBIENCE).not.toMatch(/"(winter|spring|summer|autumn)"/);
  });

  it("composites the other way round on a light theme", () => {
    // Light added to paper white reads as nothing. If this ever collapses to a
    // single composite mode, the show silently disappears on Fruit Stripe.
    expect(AMBIENCE).toContain('ctx.globalCompositeOperation = onDark ? "lighter" : "source-over";');
    expect(AMBIENCE).toContain('color: onDark ? glow : mote');
  });

  it("draws the gradient layers into a small buffer rather than at full size", () => {
    expect(AMBIENCE).toContain("FIELD_MAX_W");
    expect(AMBIENCE).toContain("CURTAINS");
    expect(AMBIENCE).toContain("bloom: Math.max(0, light)");
    expect(AMBIENCE).toContain("ctx.drawImage(off, 0, 0, w, h)");
  });

  it("paints a still frame instead of running a loop when motion is off", () => {
    expect(AMBIENCE).toContain("draw(0); // one still frame");
  });

  it("clamps the frame delta so a backgrounded tab does not jump on resume", () => {
    expect(AMBIENCE).toContain("Math.min((t - lastRef.current) / 1000, 0.1)");
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

describe("Library wiring", () => {
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
