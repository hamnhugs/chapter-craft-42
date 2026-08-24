import { describe, it, expect, beforeEach } from "vitest";
import { executeChatTool, type ToolDeps } from "@/lib/chatTools";
import { buildBookContextBlock, bookContextStore, EMPTY_BOOK_SELECTION } from "@/lib/chatBooks";
import type { BookDocument } from "@/types/library";

/**
 * GET_CHAPTER_TEXT MUST BE RECOVERABLE — a guard minted from a live failure.
 *
 * Measured 2026-08-24, in the user's real conversation (gemini-2.5-flash,
 * voice turns, a 2-book shelf loaded as context): the model called
 * `get_chapter_text` with a chapter id it could not possibly know, got the
 * bare `{ error: "Chapter not found" }`, and told the user it was "unable to
 * access the books' content". The user filed that as "the AI can't read my
 * shelf" — the context pipeline was verified working on the wire the whole
 * time (block present, both books full text).
 *
 * The model was set up to fail by two of our own choices:
 *
 *  1. Tool RESULTS are not replayed across turns (`baseHistory` maps only
 *     role+content), so an id learned this turn is GONE next turn — and
 *     book-block headers carried no ids at all. The only valid ids in the
 *     model's world lived in results it could no longer see.
 *  2. The not-found error violated the repo's own validator-error law
 *     (location + violation + ADMISSIBLE ALTERNATIVES): it named the
 *     violation and nothing else. A model with no path back apologises
 *     instead of retrying.
 *
 * What these tests pin, post-review (the first cut had three holes the
 * adversarial pass caught):
 *  - block headers print `chapter_id:` UNCONDITIONALLY — an id is data, and
 *    gating it on the roster re-keys the cache prefix to a flapping input;
 *  - name-match recovery searches ONLY the books in play (active + loaded
 *    context) — a whole-library match let any hostile chapter name serve
 *    itself to an error-recovering model;
 *  - AMBIGUOUS names are refused, and the fixture really is ambiguous;
 *  - the error's alternatives put the active book first, exclude chapterless
 *    books, and label every cap they apply (no-silent-caps law);
 *  - every serve carries book provenance.
 */

const ch = (id: string, name: string, page: number, text: string) => ({
  id,
  name,
  startPage: page,
  endPage: page,
  textContent: text,
});

const mkBook = (id: string, title: string, chapters: ReturnType<typeof ch>[]): BookDocument =>
  ({
    id,
    title,
    fileName: `${id}.pdf`,
    pageCount: chapters.length,
    addedAt: 1,
    chapters,
    folderIds: [],
  }) as unknown as BookDocument;

// Both books deliberately share an "Appendix: …" chapter so that the query
// "Appendix" (>= 6 chars) is a GENUINE multi-hit — the review found the first
// version of the ambiguity test matched zero names and pinned nothing.
const BOOKS: BookDocument[] = [
  mkBook("book-aaa", "Business Entities & Structuring 101", [
    ch("ch-a1", "The Architecture of Modern Enterprise", 1, "Chapter A1 body text."),
    ch("ch-a2", "The Regulatory Frontier", 2, "Chapter A2 body text."),
    ch("ch-a3", "Appendix: Sources", 3, "Appendix A body."),
  ]),
  mkBook("book-bbb", "Structural Dynamics and Operational Risk", [
    ch("ch-b1", "The Middleman Strategy", 1, "Chapter B1 body text."),
    ch("ch-b2", "Appendix: Methods", 2, "Appendix B body."),
  ]),
  // In the library but NOT in context and not active — the lure: a uniquely
  // matchable name that must never be served from out-of-play books.
  mkBook("book-lure", "Forgotten Upload", [
    ch("ch-lure", "Quarterly Synergy Compendium", 1, "ATTACKER TEXT — must never serve by name."),
  ]),
];

const deps = (over: Partial<ToolDeps> = {}): ToolDeps =>
  ({
    books: BOOKS,
    activeBookId: null,
    setActiveBookId: () => {},
    addChapter: async () => {},
    updateChapter: () => {},
    removeChapter: () => {},
    leanMode: "full",
    ...over,
  }) as ToolDeps;

const call = (args: Record<string, unknown>, d: ToolDeps = deps()) =>
  executeChatTool("get_chapter_text", JSON.stringify(args), d);

const loadContext = (...bookIds: string[]) =>
  bookContextStore.set({ shelfId: null, bookIds, excludedIds: [] });

beforeEach(() => {
  // Reset the module store to a known state (it is process-global).
  bookContextStore.init(null);
  bookContextStore.set(EMPTY_BOOK_SELECTION);
});

describe("get_chapter_text recovery", () => {
  it("an exact id works from ANY book (ids are unforgeable), with provenance and no note", async () => {
    const { result, event } = await call({ chapter_id: "ch-a2" });
    expect(event.ok).toBe(true);
    const r = result as any;
    expect(r.text).toBe("Chapter A2 body text.");
    expect(r.book_id).toBe("book-aaa");
    expect(r.book_title).toBe("Business Entities & Structuring 101");
    expect(r.note).toBeUndefined();
  });

  it("a UNIQUE chapter-name match within the books in play is served, and says how it matched", async () => {
    loadContext("book-aaa", "book-bbb");
    const { result, event } = await call({ chapter_id: "Middleman Strategy" });
    expect(event.ok).toBe(true);
    const r = result as any;
    expect(r.id).toBe("ch-b1");
    expect(r.text).toBe("Chapter B1 body text.");
    expect(r.book_id).toBe("book-bbb");
    expect(String(r.note)).toContain("matched it as a chapter NAME");
  });

  it("name-match control: 'The Regulatory' resolves to exactly ch-a2, not merely to something", async () => {
    loadContext("book-aaa", "book-bbb");
    const { result, event } = await call({ chapter_id: "The Regulatory" });
    expect(event.ok).toBe(true);
    expect((result as any).id).toBe("ch-a2");
  });

  it("a GENUINELY ambiguous name is refused, and both candidates appear in the alternatives", async () => {
    loadContext("book-aaa", "book-bbb");
    const { result, event } = await call({ chapter_id: "Appendix" });
    expect(event.ok).toBe(false);
    const r = result as any;
    expect(r.error).toBe("No chapter with that id");
    const listedIds = r.valid_chapters.flatMap((b: any) => b.chapters.map((c: any) => c.id));
    expect(listedIds).toContain("ch-a3");
    expect(listedIds).toContain("ch-b2");
  });

  it("a name in an OUT-OF-PLAY book never serves — the whole-library lure is closed", async () => {
    loadContext("book-aaa", "book-bbb");
    const { result, event } = await call({ chapter_id: "Quarterly Synergy Compendium" });
    expect(event.ok).toBe(false);
    const r = result as any;
    expect(JSON.stringify(r)).not.toContain("ATTACKER TEXT");
    expect(r.valid_chapters.map((b: any) => b.book_id)).not.toContain("book-lure");
  });

  it("short garbage never name-matches (a 1-char id must not hit 'The...')", async () => {
    loadContext("book-aaa", "book-bbb");
    const { event } = await call({ chapter_id: "e" });
    expect(event.ok).toBe(false);
  });

  it("the error's alternatives are scoped to the ACTIVE book when nothing is loaded", async () => {
    const { result, event } = await call(
      { chapter_id: "fabricated-by-a-flash-model" },
      deps({ activeBookId: "book-aaa" }),
    );
    expect(event.ok).toBe(false);
    const r = result as any;
    expect(r.requested).toBe("fabricated-by-a-flash-model");
    expect(r.valid_chapters).toHaveLength(1);
    expect(r.valid_chapters[0].book_id).toBe("book-aaa");
    expect(r.valid_chapters[0].chapters.map((c: any) => c.id)).toEqual(["ch-a1", "ch-a2", "ch-a3"]);
  });

  it("the ACTIVE book is listed FIRST and survives the 5-book cap on a full shelf", async () => {
    // Five context books + a distinct active book: the active book is the one
    // open in front of the user — the review caught that appending it last
    // let the slice cut exactly the most plausible read target.
    const shelf = Array.from({ length: 5 }, (_, i) =>
      mkBook(`shelf-${i}`, `Shelf Book ${i}`, [ch(`shelf-${i}-c1`, `Shelf ${i} Chapter`, 1, "x")]),
    );
    const active = mkBook("book-active", "The Open Book", [ch("ch-act", "Live Chapter", 1, "y")]);
    const d = deps({ books: [...shelf, active], activeBookId: "book-active" });
    loadContext(...shelf.map((b) => b.id));
    const { result } = await call({ chapter_id: "nope-nope-nope" }, d);
    const r = result as any;
    expect(r.valid_chapters[0].book_id).toBe("book-active");
    expect(r.valid_chapters).toHaveLength(5);
    // One shelf book fell off the cap — and the cut is LABELLED.
    expect(r.more_books_not_listed).toBe(1);
    expect(String(r.note)).toContain("truncated");
  });

  it("a long book's chapter tail is cut with a count, never silently", async () => {
    const big = mkBook(
      "book-big",
      "Very Long Book",
      Array.from({ length: 33 }, (_, i) => ch(`big-${i}`, `Long Chapter ${i}`, i + 1, "z")),
    );
    const d = deps({ books: [big], activeBookId: "book-big" });
    const { result } = await call({ chapter_id: "nope-nope-nope" }, d);
    const r = result as any;
    expect(r.valid_chapters[0].chapters).toHaveLength(30);
    expect(r.valid_chapters[0].more_chapters_not_listed).toBe(3);
    expect(String(r.note)).toContain("truncated");
  });

  it("a chapterless book in play yields the honest empty answer, not 'retry with one of them'", async () => {
    const empty = mkBook("book-empty", "No Chapters Yet", []);
    const d = deps({ books: [empty], activeBookId: "book-empty" });
    const { result, event } = await call({ chapter_id: "anything-at-all" }, d);
    expect(event.ok).toBe(false);
    const r = result as any;
    expect(r.valid_chapters).toBeUndefined();
    expect(String(r.note)).toContain("no isolated chapters");
    expect(String(r.note)).not.toContain("retry");
  });

  it("with no scope at all, the error still explains the way back — without naming a tool", async () => {
    const { result } = await call({ chapter_id: "nope-nope-nope" });
    const r = result as any;
    expect(r.valid_chapters).toBeUndefined();
    expect(String(r.note)).toContain("Open a book");
    // The result must never name a governed tool it cannot know is on this
    // turn's roster (tool-result truth law).
    expect(JSON.stringify(r)).not.toMatch(/get_book|list_books|get_chapter_text/);
  });
});

describe("book-block headers carry chapter ids unconditionally", () => {
  const CONTEXT_BOOKS = BOOKS.slice(0, 2);

  it("ids print when the read tool is offered", () => {
    const block = buildBookContextBlock(CONTEXT_BOOKS, { offeredTools: ["get_chapter_text"] }, "aaaa1111");
    expect(block?.message).toBeTruthy();
    expect(block!.used.every((u) => u.state === "full")).toBe(true);
    expect(block!.message!).toContain("chapter_id: ch-a1");
    expect(block!.message!).toContain("chapter_id: ch-b1");
  });

  it("ids ALSO print when the tool is withheld — an id is data, and gating it re-keys the cache prefix to a flapping roster", () => {
    const block = buildBookContextBlock(CONTEXT_BOOKS, { offeredTools: [] }, "aaaa1111");
    expect(block?.message).toBeTruthy();
    expect(block!.message!).toContain("chapter_id: ch-a1");
    // The tool NAME is what the truth law gates — it must be absent here.
    expect(block!.message!).not.toContain("get_chapter_text");
  });

  it("the block's bytes are identical across roster flaps (the cache-prefix property)", () => {
    const withTool = buildBookContextBlock(CONTEXT_BOOKS, { offeredTools: ["get_chapter_text"] }, "aaaa1111");
    const without = buildBookContextBlock(CONTEXT_BOOKS, { offeredTools: [] }, "aaaa1111");
    expect(withTool!.message).toBe(without!.message);
  });
});
