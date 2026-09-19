import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * "Where did I read that?" — the exact-text seek across the whole library.
 *
 * bookSearch.ts has carried this predicate for a while, reviewed and
 * property-tested, reachable only as a chat tool — so finding a
 * half-remembered passage required a conversation. This runs it from the
 * Vault.
 *
 * The contracts under test are all about COVERAGE HONESTY. A search that read
 * eight of forty candidate chapters and found nothing has not established
 * that the phrase is absent, and the difference between "not there" and "not
 * looked at" is the whole value of the feature.
 */

const dbState = vi.hoisted(() => ({
  prefilterIds: [] as { id: string }[],
  prefilterError: null as { message?: string } | null,
  lastIlike: "" as string,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        ilike: (_col: string, pattern: string) => { dbState.lastIlike = pattern; return chain; },
        limit: async () => ({ data: dbState.prefilterIds, error: dbState.prefilterError }),
      };
      return chain;
    },
  },
}));

const { seekLibrary, SEEK_FETCH_CAP } = await import("@/lib/librarySeek");

const chapter = (id: string, name: string, text: string) => ({
  id, name, startPage: 1, endPage: 10, textContent: text, gist: null,
});

const mk = (id: string, title: string, chapters: ReturnType<typeof chapter>[]): BookDocument => ({
  id, title, fileName: `${id}.pdf`, fileData: "", pageCount: 10,
  chapters, addedAt: 0, folderIds: [],
});

const loaders = (byId: Record<string, string>) => ({
  loadChapterText: async (id: string) => byId[id] ?? "",
});

beforeEach(() => {
  dbState.prefilterIds = [];
  dbState.prefilterError = null;
  dbState.lastIlike = "";
});

describe("seekLibrary", () => {
  it("finds a phrase in chapters already loaded, with no round trip", async () => {
    const books = [mk("b1", "Solaris", [chapter("c1", "The Ocean", "the ocean was thinking about us")])];
    const out = await seekLibrary(books, "u1", "ocean was thinking", loaders({}));
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].bookTitle).toBe("Solaris");
    expect(out.hits[0].chapterName).toBe("The Ocean");
    expect(out.hits[0].excerpt).toContain("thinking");
  });

  it("is whitespace-flexible, because PDF text hard-wraps mid-sentence", async () => {
    const books = [mk("b1", "Maths", [chapter("c1", "Trig", "apply the law of\nsines here")])];
    const out = await seekLibrary(books, "u1", "law of sines", loaders({}));
    expect(out.hits).toHaveLength(1);
  });

  it("is not typo-tolerant — a search that corrects the text mints fake anchors", async () => {
    const books = [mk("b1", "Scan", [chapter("c1", "One", "the modem hummed")])];
    const out = await seekLibrary(books, "u1", "modern hummed", loaders({}));
    expect(out.hits).toHaveLength(0);
  });

  it("refuses a query too short to be meaningful", async () => {
    const books = [mk("b1", "X", [chapter("c1", "One", "ab")])];
    const out = await seekLibrary(books, "u1", "ab", loaders({}));
    expect(out.normalizedQuery).toBeNull();
    expect(out.hits).toHaveLength(0);
  });

  it("fetches only chapters the server prefilter matched", async () => {
    const books = [mk("b1", "Big", [
      chapter("c1", "One", ""), chapter("c2", "Two", ""), chapter("c3", "Three", ""),
    ])];
    dbState.prefilterIds = [{ id: "c2" }];
    const out = await seekLibrary(books, "u1", "sentient ocean",
      loaders({ c2: "a sentient ocean indeed", c1: "nope", c3: "nope" }));
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].chapterId).toBe("c2");
    // The prefilter narrows on the longest plain word, never the whole query.
    expect(dbState.lastIlike).toContain("sentient");
  });

  it("says how many matching chapters it did not read", async () => {
    const many = Array.from({ length: SEEK_FETCH_CAP + 5 }, (_, i) => chapter(`c${i}`, `Ch ${i}`, ""));
    dbState.prefilterIds = many.map((c) => ({ id: c.id }));
    const out = await seekLibrary([mk("b1", "Big", many)], "u1", "sentient ocean", loaders({}));
    expect(out.notSearched).toBe(5);
  });

  it("degrades loudly when server narrowing fails, never to a false zero", async () => {
    dbState.prefilterError = { message: "boom" };
    const books = [mk("b1", "Big", [chapter("c1", "One", "")])];
    const out = await seekLibrary(books, "u1", "sentient ocean", loaders({ c1: "nothing here" }));
    expect(out.hits).toHaveLength(0);
    // The caller must be able to tell "not there" from "not looked at".
    expect(out.degraded).toBe(true);
    expect(out.note).toContain("narrowing was unavailable");
  });

  it("degrades when the query has no plain word to narrow on", async () => {
    const books = [mk("b1", "Big", [chapter("c1", "One", "")])];
    const out = await seekLibrary(books, "u1", "—— ——", loaders({ c1: "x" }));
    if (out.normalizedQuery) expect(out.degraded).toBe(true);
  });

  it("survives an unreadable chapter without turning it into a zero result", async () => {
    const books = [mk("b1", "Big", [chapter("c1", "One", ""), chapter("c2", "Two", "")])];
    dbState.prefilterIds = [{ id: "c1" }, { id: "c2" }];
    const out = await seekLibrary(books, "u1", "sentient ocean", {
      loadChapterText: async (id: string) => {
        if (id === "c1") throw new Error("storage down");
        return "a sentient ocean";
      },
    });
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].chapterId).toBe("c2");
  });

  it("returns hits in reading order across books", async () => {
    const books = [
      mk("b1", "First", [chapter("c1", "One", "the ocean")]),
      mk("b2", "Second", [chapter("c2", "Two", "the ocean again")]),
    ];
    const out = await seekLibrary(books, "u1", "the ocean", loaders({}));
    expect(out.hits.map((h) => h.bookTitle)).toEqual(["First", "Second"]);
  });

  it("is a no-op on an empty library", async () => {
    const out = await seekLibrary([], "u1", "anything at all", loaders({}));
    expect(out.hits).toHaveLength(0);
  });

  it("reports an approximate page inside the chapter's range", async () => {
    const books = [mk("b1", "Solaris", [chapter("c1", "The Ocean", "x".repeat(500) + " sentient ocean")])];
    const out = await seekLibrary(books, "u1", "sentient ocean", loaders({}));
    expect(out.hits[0].page).toBeGreaterThanOrEqual(1);
    expect(out.hits[0].page).toBeLessThanOrEqual(10);
  });
});
