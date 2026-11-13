/**
 * The book profile and the generated covers the cards draw.
 *
 * Two halves, as the repo does elsewhere: real unit tests for the pure
 * assembler in src/lib/bookProfile.ts and the cover generator, and source
 * assertions for the things that live in JSX and would otherwise only be
 * checked by looking.
 *
 * The Showcase and Mind map views these once covered are gone; the last block
 * pins that they stay out of the Library's view list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bookProfile, relativeDay, seedOf } from "@/lib/bookProfile";
import { coverArt, FAMILIES } from "@/lib/coverArt";
import { coverTones } from "@/lib/seasonTheme";
import type { BookDocument } from "@/types/library";

const read = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

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

describe("ThemeContext source", () => {
  it("applies the season after the theme, so it can rewrite the theme's tokens", () => {
    // A living theme's face sits between the two: tokens, face, then season.
    expect(THEME_CTX).toContain("const merged = { ...faceTokens(theme, face), ...extraVars };");
    expect(THEME_CTX).toContain("applyTheme(themeId, face, { ...vars, ...(live?.vars ?? {}) });");
    expect(THEME_CTX).toContain("appliedKeys = Object.keys(merged);");
  });

  it("re-evaluates the season when the day rolls over and when the tab returns", () => {
    expect(THEME_CTX).toContain("msUntilNextLocalMidnight");
    expect(THEME_CTX).toContain('document.addEventListener("visibilitychange", onVisible)');
  });

  it("lets the season be switched off entirely", () => {
    expect(THEME_CTX).toContain("const vars = seasonal ? seasonalTheme(worn, season).vars : {};");
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
});

describe("Library wiring", () => {
  it("keeps the big dropzone for the empty Vault only, with adding a book one click away in every view", () => {
    // The foot-tall dropzone used to sit above the books in Shelves and List
    // and push the first one ~1,400px down. It is now the empty Vault's
    // welcome; a populated Vault adds through the toolbar and a drag overlay.
    const empty = LIBRARY.slice(LIBRARY.indexOf(") : books.length === 0 ? ("));
    expect(empty.slice(0, 400)).toContain("<VaultDropzone");
    expect(LIBRARY.match(/<VaultDropzone\b/g)).toHaveLength(1);
    const tools = LIBRARY.slice(LIBRARY.indexOf("{/* Add: one click to the file picker"));
    expect(tools.slice(0, 600)).toContain("fileInputRef.current?.click()");
    expect(tools.slice(0, 3000)).toContain("From YouTube…");
    expect(LIBRARY).toContain("{dragOver && <VaultDropOverlay");
  });

  it("offers the list as the only other view", () => {
    expect(LIBRARY).toContain('type ViewMode = "cards" | "list";');
    // A stored "list" is still honoured; anything else — the retired
    // Showcase and Mind map included — lands on the cards.
    expect(LIBRARY).toContain('return v === "list" ? v : "cards";');
    expect(LIBRARY).not.toContain("LibraryShowcase");
    expect(LIBRARY).not.toContain("LibraryGraph");
  });
});
