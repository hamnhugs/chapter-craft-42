import { describe, it, expect } from "vitest";
import { levelOf, readTimeLabel, readingNow, sortCards, tierOf, toCard, MAX_LEVEL } from "@/lib/bookCard";
import type { BookDocument } from "@/types/library";

const book = (id: string, pageCount: number, addedAt = 0, title = id): BookDocument => ({
  id, title, fileName: `${id}.pdf`, fileData: "", pageCount, chapters: [], addedAt, folderIds: [],
});

describe("tierOf", () => {
  it("places a book by its length", () => {
    expect(tierOf(12).id).toBe("leaflet");
    expect(tierOf(79).id).toBe("leaflet");
    expect(tierOf(80).id).toBe("volume");
    expect(tierOf(300).id).toBe("tome");
    expect(tierOf(600).id).toBe("opus");
    expect(tierOf(2400).id).toBe("opus");
  });
  it("treats an unknown length as an ordinary volume", () => {
    expect(tierOf(0).id).toBe("volume");
    expect(tierOf(NaN).id).toBe("volume");
  });
});

describe("levelOf", () => {
  it("starts an unopened book at level 1 with an empty meter", () => {
    expect(levelOf(300, 0)).toMatchObject({ level: 1, fill: 0, pct: 0, maxed: false });
    // Page 1 is "opened", not progress.
    expect(levelOf(300, 1)).toMatchObject({ level: 1, fill: 0, pct: 0 });
  });
  it("climbs with the reading position and never passes the cap early", () => {
    let prev = 0;
    for (let page = 2; page < 300; page += 7) {
      const l = levelOf(300, page);
      expect(l.level).toBeGreaterThanOrEqual(prev);
      expect(l.level).toBeLessThan(MAX_LEVEL);
      expect(l.fill).toBeGreaterThanOrEqual(0);
      expect(l.fill).toBeLessThan(1);
      expect(l.pagesToNext).toBeGreaterThan(0);
      prev = l.level;
    }
  });
  it("maxes out only on the last page", () => {
    expect(levelOf(300, 299).maxed).toBe(false);
    expect(levelOf(300, 300)).toMatchObject({ level: MAX_LEVEL, fill: 1, pct: 100, maxed: true, pagesToNext: 0 });
    // A stale position past the end (the file was replaced by a shorter one).
    expect(levelOf(300, 450).maxed).toBe(true);
  });
  it("reaching the page it names really is the next level", () => {
    const l = levelOf(300, 100);
    expect(levelOf(300, 100 + l.pagesToNext).level).toBeGreaterThan(l.level);
  });
  it("copes with an unknown page count", () => {
    expect(levelOf(0, 40)).toMatchObject({ level: 1, pct: 0, maxed: false, pagesToNext: 0 });
  });
});

describe("readTimeLabel", () => {
  it("is minutes for a short read and hours for a long one", () => {
    expect(readTimeLabel(10)).toBe("20m");
    expect(readTimeLabel(1)).toBe("5m");
    expect(readTimeLabel(30)).toBe("1h");
    expect(readTimeLabel(300)).toBe("10h");
  });
  it("is absent when the length is unknown", () => {
    expect(readTimeLabel(0)).toBeNull();
  });
});

describe("sortCards / readingNow", () => {
  const cards = [
    toCard(book("a", 100, 3, "Beta"), 50),
    toCard(book("b", 700, 1, "Alpha"), 0),
    toCard(book("c", 40, 2, "Gamma"), 40),
    toCard(book("d", 350, 4, "Delta"), 300),
  ];
  it("sorts each way without mutating its input", () => {
    const before = cards.map((c) => c.book.id).join("");
    expect(sortCards(cards, "recent").map((c) => c.book.id)).toEqual(["d", "a", "c", "b"]);
    expect(sortCards(cards, "name").map((c) => c.book.title)).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    expect(sortCards(cards, "tier").map((c) => c.book.id)).toEqual(["b", "d", "a", "c"]);
    expect(sortCards(cards, "level")[0].book.id).toBe("c");
    expect(cards.map((c) => c.book.id).join("")).toBe(before);
  });
  it("lists started-but-unfinished books, furthest along first", () => {
    expect(readingNow(cards).map((c) => c.book.id)).toEqual(["d", "a"]);
    expect(readingNow(cards, 1)).toHaveLength(1);
  });
});
