import { describe, it, expect } from "vitest";
import type { BookDocument } from "@/types/library";
import { bookHaystack, chapterMatch, matchesAll, tokenize, spineHaystack } from "@/lib/librarySearch";

/**
 * Vault search after it was given the catalog to look at.
 *
 * Before: title, category and tags only — so chapter names and the summaries
 * the app spends the user's key generating were invisible, and the Vault
 * offered a title filter or a chat message and nothing between them. Teevan
 * et al. (CHI 2004) measured 61% of real re-finding as orienteering, which is
 * exactly the middle that was missing.
 */

const chapter = (name: string, gist: string | null = null) => ({
  id: `c-${name}`, name, startPage: 1, endPage: 2, textContent: "", gist,
});

const mk = (over: Partial<BookDocument> = {}): BookDocument => ({
  id: "b1", title: "Solaris", fileName: "s.pdf", fileData: "", pageCount: 10,
  chapters: [], addedAt: 0, folderIds: [], ...over,
});

describe("tokenize", () => {
  it("splits, lowercases and folds diacritics", () => {
    expect(tokenize("  Café  NAÏVE ")).toEqual(["cafe", "naive"]);
  });
  it("is empty for an empty query, which means 'no filter'", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("bookHaystack", () => {
  it("sees the book summary", () => {
    const b = mk({ summary: "A psychologist arrives at a station above a sentient ocean." });
    expect(matchesAll(bookHaystack(b), tokenize("sentient ocean"))).toBe(true);
  });

  it("sees chapter names", () => {
    const b = mk({ chapters: [chapter("The Little Apocrypha")] });
    expect(matchesAll(bookHaystack(b), tokenize("apocrypha"))).toBe(true);
  });

  it("sees chapter gists", () => {
    const b = mk({ chapters: [chapter("Four", "Kelvin reviews the station's library.")] });
    expect(matchesAll(bookHaystack(b), tokenize("kelvin library"))).toBe(true);
  });

  it("still sees title, category and tags", () => {
    const b = mk({ category: "fiction", tags: ["space"] });
    expect(matchesAll(bookHaystack(b), tokenize("solaris fiction space"))).toBe(true);
  });

  it("requires every token — more words narrow, never widen", () => {
    const b = mk({ summary: "A sentient ocean." });
    expect(matchesAll(bookHaystack(b), tokenize("sentient ocean"))).toBe(true);
    expect(matchesAll(bookHaystack(b), tokenize("sentient desert"))).toBe(false);
  });

  it("folds diacritics on both sides", () => {
    const b = mk({ title: "Café Ouvert" });
    expect(matchesAll(bookHaystack(b), tokenize("cafe"))).toBe(true);
  });

  it("does not read chapter bodies — that is bookSearch's job, with offsets", () => {
    const b = mk({ chapters: [{ ...chapter("One"), textContent: "a rare word: fnordium" }] });
    expect(matchesAll(bookHaystack(b), tokenize("fnordium"))).toBe(false);
  });
});

describe("chapterMatch", () => {
  it("names the chapter that answered, when the spine did not", () => {
    const b = mk({ chapters: [chapter("Three"), chapter("The Ocean", "Kelvin studies the surface.")] });
    expect(chapterMatch(b, tokenize("kelvin"))).toEqual({
      name: "The Ocean", gist: "Kelvin studies the surface.",
    });
  });

  it("stays quiet when the title already explains the match", () => {
    // Repeating the title back as a reason is noise, not a step.
    const b = mk({ chapters: [chapter("Solaris Revisited")] });
    expect(chapterMatch(b, tokenize("solaris"))).toBeNull();
  });

  it("stays quiet when a tag explains the match", () => {
    const b = mk({ tags: ["space"], chapters: [chapter("Space Station")] });
    expect(chapterMatch(b, tokenize("space"))).toBeNull();
  });

  it("returns the FIRST matching chapter, in reading order", () => {
    const b = mk({ chapters: [chapter("Early", "the ocean"), chapter("Late", "the ocean again")] });
    expect(chapterMatch(b, tokenize("ocean"))?.name).toBe("Early");
  });

  it("is null with no query", () => {
    expect(chapterMatch(mk({ chapters: [chapter("One")] }), [])).toBeNull();
  });

  it("is null when nothing matches", () => {
    expect(chapterMatch(mk({ chapters: [chapter("One")] }), tokenize("zzz"))).toBeNull();
  });
});

describe("spineHaystack", () => {
  it("excludes summaries and chapters — it is what the card already shows", () => {
    const b = mk({ summary: "sentient ocean", chapters: [chapter("The Ocean")] });
    expect(matchesAll(spineHaystack(b), tokenize("ocean"))).toBe(false);
    expect(matchesAll(spineHaystack(b), tokenize("solaris"))).toBe(true);
  });
});
