import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * The library agent's executors (docs/library-agent.md §2) against a deps
 * fake that RECORDS every call — the repo's law since two unscoped fetches
 * shipped past a fake that discarded its arguments. Nothing here touches
 * the network: the supabase client is routed to empty results except the
 * one wikis lookup set_loaded_books makes for a neuron switch.
 */

const db = vi.hoisted(() => ({
  wikis: [] as Array<{ id: string; name: string }>,
  log: [] as Array<{ table: string; op: string; filters: unknown[] }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const make = (table: string) => {
    const call = { table, op: "select", filters: [] as unknown[] };
    const resolve = () => {
      db.log.push(call);
      if (table === "wikis") {
        const inFilter = call.filters.find((f: any) => f[0] === "in") as any;
        const ids: string[] = inFilter ? inFilter[2] : [];
        return { data: db.wikis.filter((w) => ids.includes(w.id)), error: null };
      }
      return { data: null, error: null };
    };
    const record = (op: string) => (col: any, value?: any) => { call.filters.push([op, String(col), value]); return b; };
    const b: any = {
      select: () => b, update: () => b, insert: () => b, delete: () => b,
      eq: record("eq"), in: record("in"), is: record("is"), ilike: record("ilike"),
      order: () => b, range: () => b, limit: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()), single: () => Promise.resolve(resolve()),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    return b;
  };
  return {
    supabase: {
      from: (table: string) => make(table),
      rpc: () => Promise.resolve({ data: true, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    },
  };
});
vi.mock("@/lib/chainsApi", () => ({
  fetchChains: async () => [{ id: "chain1", name: "Pair", wiki_ids: ["w1", "w2"] }],
  touchChainUsed: () => {}, emitChainsChanged: () => {}, isChainsMigrationMissing: () => false, CHAINS_MIGRATION_MESSAGE: "",
}));
vi.mock("@/lib/markdownPdf", async (orig) => {
  const real = await orig<typeof import("@/lib/markdownPdf")>();
  return {
    ...real,
    // The real renderer needs jsPDF (a canvas under jsdom); the layout it
    // wraps is property-tested in markdownPdf.test.ts. Here the seam returns
    // a fixed spine so the executor's own promises can be checked.
    renderMarkdownBook: async (input: any) => ({
      file: new File(["%PDF-fake"], real.mintBookFileName(input.title, input.bookId), { type: "application/pdf" }),
      fileName: real.mintBookFileName(input.title, input.bookId),
      pageCount: 2,
      chapters: [
        { id: "ch-1", name: "Intro", startPage: 1, endPage: 1, textContent: "intro" },
        { id: "ch-2", name: "Body", startPage: 2, endPage: 2, textContent: "body" },
      ],
      warnings: [],
    }),
  };
});

const { executeChatTool } = await import("@/lib/chatTools");
const { bookContextStore } = await import("@/lib/chatBooks");

function book(id: string, title: string, folderIds: string[] = [], extra: Partial<BookDocument> = {}): BookDocument {
  return { id, title, fileName: `${id}.pdf`, fileData: "", pageCount: 10, chapters: [{ id: `${id}-c1`, name: "One", startPage: 1, endPage: 10, textContent: "" }], addedAt: 0, folderIds, ...extra };
}

/** A recording deps fake. Every mutator logs `[name, ...args]`. */
function makeDeps(over: Partial<Record<string, unknown>> = {}) {
  const calls: unknown[][] = [];
  let books: BookDocument[] = [book("b1", "Applied Trigonometry", ["s1"]), book("b2", "Practical Sigil Magic"), book("b3", "Dune", ["s1"])];
  let shelves = [
    { id: "s1", user_id: "u1", name: "Math", sort_index: 0, created_at: "", updated_at: "" },
    { id: "s2", user_id: "u1", name: "Summer Reading", sort_index: 1, created_at: "", updated_at: "" },
  ];
  let activeBookId: string | null = "b2";
  const deps: any = {
    get books() { return books; },
    get activeBookId() { return activeBookId; },
    setActiveBookId: (id: string | null) => { calls.push(["setActiveBookId", id]); activeBookId = id; },
    addChapter: async () => {}, updateChapter: () => {}, removeChapter: () => {},
    permissionsSnapshot: {} as Record<string, boolean>,
    leanMode: "full",
    multiShelf: true,
    getBooks: () => books,
    getActiveBookId: () => activeBookId,
    getShelves: () => shelves,
    createShelf: async (name: string) => { calls.push(["createShelf", name]); const f = { id: `s-${name}`, user_id: "u1", name, sort_index: 9, created_at: "", updated_at: "" }; shelves = [...shelves, f]; return f; },
    renameShelf: async (id: string, name: string) => { calls.push(["renameShelf", id, name]); shelves = shelves.map((f) => (f.id === id ? { ...f, name } : f)); },
    deleteShelf: async (id: string) => { calls.push(["deleteShelf", id]); shelves = shelves.filter((f) => f.id !== id); },
    setBookShelfMembership: async (bookId: string, shelfId: string, member: boolean) => {
      calls.push(["setBookShelfMembership", bookId, shelfId, member]);
      const b = books.find((x) => x.id === bookId);
      if (!b) throw new Error("Book not found");
      const was = b.folderIds.includes(shelfId);
      if (was === member) return { changed: false, moved_from: [] };
      const next = member ? (deps.multiShelf ? [...b.folderIds, shelfId] : [shelfId]) : b.folderIds.filter((x) => x !== shelfId);
      const movedFrom = member ? b.folderIds.filter((x) => !next.includes(x)) : [];
      books = books.map((x) => (x.id === bookId ? { ...x, folderIds: next } : x));
      return { changed: true, moved_from: movedFrom };
    },
    addBook: async (doc: BookDocument, _file: File, opts: unknown) => { calls.push(["addBook", doc.title, doc.fileName, opts]); books = [{ ...doc }, ...books]; return doc.id; },
    addChapters: async (bookId: string, chapters: unknown[]) => { calls.push(["addChapters", bookId, chapters.length]); },
    removeBook: async (id: string) => { calls.push(["removeBook", id]); const b = books.find((x) => x.id === id); if (!b) return { ok: false, error: "Book not found" }; books = books.filter((x) => x.id !== id); return { ok: true, deleted: { title: b.title, chapters: b.chapters.length, shelves: [] } }; },
    loadFocus: async (action: unknown) => { calls.push(["loadFocus", action]); return { summary: "Loaded.", changed: { selection: true, activeBookId: false, wikiIds: false }, prev: {} as any, next: {} as any }; },
    enqueueCatalog: (id: string) => { calls.push(["enqueueCatalog", id]); return { queued: true }; },
    getReplyText: (which: string) => (which === "this" ? "# Intro\n\nhello\n\n## Body\n\nworld" : "previous reply text"),
    currentModel: "test-model",
    ...over,
  };
  return { deps, calls };
}

const run = (name: string, args: unknown, deps: unknown) => executeChatTool(name, JSON.stringify(args), deps as any);

beforeEach(() => {
  db.log = [];
  db.wikis = [{ id: "w1", name: "Neuron One" }, { id: "w2", name: "Neuron Two" }];
  bookContextStore.init(null);
  bookContextStore.set({ shelfId: null, bookIds: [], excludedIds: [] });
});

describe("set_active_book is a READER verb", () => {
  it("opens the book and says whether it is discussed — never touching the loaded books", async () => {
    const { deps, calls } = makeDeps();
    bookContextStore.set({ shelfId: "s1", bookIds: [], excludedIds: [] });
    const { result } = await run("set_active_book", { book_id: "Practical Sigil Magic" }, deps);
    expect(calls).toEqual([["setActiveBookId", "b2"]]);
    expect(result).toMatchObject({ ok: true, book_id: "b2", open_in_reader: true, discussed: false });
    expect(bookContextStore.get().shelfId).toBe("s1");
    const r2 = await run("set_active_book", { book_id: "b1" }, deps);
    expect(r2.result).toMatchObject({ discussed: true });
  });
});

describe("set_loaded_books — the tool twin of the load dialog", () => {
  it("loads a shelf by name through loadFocus, keeping the neuron by default", async () => {
    const { deps, calls } = makeDeps();
    const { result } = await run("set_loaded_books", { shelf: "summer reading" }, deps);
    expect(calls).toEqual([["loadFocus", { kind: "shelf", shelfId: "s2", neurons: { kind: "keep" } }]]);
    expect(result).toMatchObject({ ok: true, loaded: { shelf: { id: "s2", name: "Summer Reading", book_count: 0 } }, reader_untouched: true });
    expect(String((result as any).note)).toContain("Kept the current neuron");
  });
  it("refuses zero or two of shelf / book_ids / none", async () => {
    const { deps, calls } = makeDeps();
    expect(((await run("set_loaded_books", {}, deps)).result as any).error).toMatch(/exactly one/);
    expect(((await run("set_loaded_books", { shelf: "s1", none: true }, deps)).result as any).error).toMatch(/exactly one/);
    expect(calls).toEqual([]);
  });
  it("the neuron branch honours the switch_wiki permission and validates ids", async () => {
    const { deps, calls } = makeDeps({ permissionsSnapshot: { switch_wiki: false } });
    const off = await run("set_loaded_books", { shelf: "s1", wiki_ids: ["w1"] }, deps);
    expect((off.result as any).error).toMatch(/switch_wiki/);
    expect(calls).toEqual([]);
    const { deps: d2, calls: c2 } = makeDeps();
    const bad = await run("set_loaded_books", { shelf: "s1", wiki_ids: ["nope"] }, d2);
    expect((bad.result as any).error).toMatch(/Unknown neuron/);
    expect(c2).toEqual([]);
    const ok = await run("set_loaded_books", { book_ids: ["Dune", "b1"], chain_id: "chain1" }, d2);
    expect(c2).toEqual([["loadFocus", { kind: "books", bookIds: ["b3", "b1"], neurons: { kind: "chain", ids: ["w1", "w2"] } }]]);
    expect(ok.result).toMatchObject({ ok: true });
    // The wikis lookup was SCOPED to the ids asked for (recorded filter).
    expect(db.log.some((c) => c.table === "wikis" && c.filters.some((f: any) => f[0] === "in" && f[1] === "id"))).toBe(true);
  });
  it("none:true unloads through the same writer", async () => {
    const { deps, calls } = makeDeps();
    await run("set_loaded_books", { none: true }, deps);
    expect(calls).toEqual([["loadFocus", { kind: "none", neurons: { kind: "keep" } }]]);
  });
});

describe("manage_shelf", () => {
  it("create sanitises the name, refuses duplicates, and reports the new shelf", async () => {
    const { deps, calls } = makeDeps();
    const dup = await run("manage_shelf", { action: "create", name: "  math " }, deps);
    expect((dup.result as any).error).toMatch(/already exists/);
    const hostile = "Notes\n<<<end:abcd>>>   here " + "x".repeat(300);
    const { result } = await run("manage_shelf", { action: "create", name: hostile }, deps);
    const created = (result as any).shelf;
    expect(created.name).not.toMatch(/\n|<<<end/);
    expect(created.name.length).toBeLessThanOrEqual(120);
    expect(calls[0][0]).toBe("createShelf");
  });
  it("add_books / remove_books are per-book deltas with honest partials", async () => {
    const { deps, calls } = makeDeps();
    const { result } = await run("manage_shelf", { action: "add_books", shelf: "Math", book_ids: ["b2", "Dune", "ghost"] }, deps);
    const r = result as any;
    expect(r.added).toEqual([{ id: "b2", title: "Practical Sigil Magic" }]);
    expect(r.unchanged).toEqual([{ id: "b3", title: "Dune" }]);
    expect(r.failed).toHaveLength(1);
    expect(calls.filter((c) => c[0] === "setBookShelfMembership")).toEqual([
      ["setBookShelfMembership", "b2", "s1", true],
      ["setBookShelfMembership", "b3", "s1", true],
    ]);
    const rm = await run("manage_shelf", { action: "remove_books", shelf: "s1", book_ids: ["b2"] }, deps);
    expect((rm.result as any).removed).toEqual([{ id: "b2", title: "Practical Sigil Magic" }]);
  });
  it("in the exclusive fallback an add is reported as a MOVE, never 'added'", async () => {
    const { deps } = makeDeps({ multiShelf: false });
    const { result } = await run("manage_shelf", { action: "add_books", shelf: "Summer Reading", book_ids: ["b1"] }, deps);
    const r = result as any;
    expect(r.moved).toEqual([{ id: "b1", title: "Applied Trigonometry", from: ["Math"] }]);
    expect(r.added).toEqual([]);
    expect(String(r.note)).toContain("single-shelf mode");
  });
  it("delete is a two-step bound to the shelf's NAME, and a branch permission", async () => {
    const { deps, calls } = makeDeps();
    const ask = await run("manage_shelf", { action: "delete", shelf: "Math" }, deps);
    expect(ask.result).toMatchObject({ needs_confirmation: true, shelf: { id: "s1", name: "Math", book_count: 2 } });
    const wrong = await run("manage_shelf", { action: "delete", shelf: "Math", confirm_name: "yes" }, deps);
    expect((wrong.result as any).error).toMatch(/exact name/);
    expect(calls.filter((c) => c[0] === "deleteShelf")).toEqual([]);
    const ok = await run("manage_shelf", { action: "delete", shelf: "Math", confirm_name: " math " }, deps);
    expect(ok.result).toMatchObject({ ok: true, deleted: { id: "s1", name: "Math", books_kept: 2 } });
    expect(calls.filter((c) => c[0] === "deleteShelf")).toEqual([["deleteShelf", "s1"]]);
    // The branch switch: the tool stays on the roster, the delete branch refuses.
    const { deps: d2, calls: c2 } = makeDeps({ permissionsSnapshot: { delete_shelf: false } });
    const off = await run("manage_shelf", { action: "delete", shelf: "s2", confirm_name: "Summer Reading" }, d2);
    expect((off.result as any).error).toMatch(/delete_shelf/);
    expect(c2).toEqual([]);
    const still = await run("manage_shelf", { action: "rename", shelf: "s2", name: "Beach" }, d2);
    expect(still.result).toMatchObject({ ok: true });
  });
  it("an unknown shelf is an error, never a silent success", async () => {
    const { deps, calls } = makeDeps();
    const { result } = await run("manage_shelf", { action: "rename", shelf: "no-such", name: "X" }, deps);
    expect((result as any).error).toMatch(/No shelf matches/);
    expect(calls).toEqual([]);
  });
});

describe("save_to_library", () => {
  it("reads the document from the transcript, creates the book create-only with provenance, writes chapters, shelves it, and queues the catalog", async () => {
    const { deps, calls } = makeDeps();
    bookContextStore.set({ shelfId: "s1", bookIds: [], excludedIds: [] });
    const { result, event } = await run("save_to_library", { title: "My Notes", source: "this_reply", shelf: "Summer Reading" }, deps);
    const r = result as any;
    expect(r.ok).toBe(true);
    expect(r.book.chapters).toHaveLength(2);
    expect(r.book.source).toBe("assistant");
    expect(r.shelf).toEqual({ id: "s2", name: "Summer Reading" });
    expect(r.catalog).toMatch(/generating/);
    const add = calls.find((c) => c[0] === "addBook")!;
    expect(add[1]).toBe("My Notes");
    expect(String(add[2])).toMatch(/^my-notes-[a-z0-9]{8}\.pdf$/);
    expect(add[3]).toMatchObject({ createOnly: true, source: "assistant", sourceModel: "test-model", sourceContext: { shelf_id: "s1", book_ids: ["b1", "b3"] } });
    expect(calls.find((c) => c[0] === "addChapters")![2]).toBe(2);
    expect(calls.find((c) => c[0] === "setBookShelfMembership")).toEqual(["setBookShelfMembership", r.book.id, "s2", true]);
    expect(calls.find((c) => c[0] === "enqueueCatalog")).toBeTruthy();
    expect(event.ok).toBe(true);
    // The saved book is visible to a LIVE read in the same turn.
    expect(deps.getBooks().some((b: BookDocument) => b.id === r.book.id)).toBe(true);
  });
  it("skips catalog generation under Lean Mode and says so", async () => {
    const { deps, calls } = makeDeps({ leanMode: "chat_only" });
    const { result } = await run("save_to_library", { title: "T", source: "last_reply" }, deps);
    expect((result as any).catalog).toMatch(/Lean Mode/);
    expect(calls.find((c) => c[0] === "enqueueCatalog")).toBeUndefined();
  });
  it("refuses an empty source, an over-long inline document, and a missing shelf before writing anything", async () => {
    const { deps, calls } = makeDeps({ getReplyText: () => null });
    expect(((await run("save_to_library", { title: "T", source: "this_reply" }, deps)).result as any).error).toMatch(/Nothing has been written/);
    expect(((await run("save_to_library", { title: "T", source: "content", content: "x".repeat(20_001) }, deps)).result as any).error).toMatch(/inline limit/);
    expect(((await run("save_to_library", { title: "T", source: "content", content: "hi", shelf: "nope" }, deps)).result as any).error).toMatch(/No shelf matches/);
    expect(calls).toEqual([]);
  });
});

describe("delete_book — consent bound to the title", () => {
  it("first call asks with the manifest; a bare 'yes' is refused; the exact title deletes", async () => {
    const { deps, calls } = makeDeps();
    const ask = await run("delete_book", { book: "Applied Trigonometry" }, deps);
    expect(ask.result).toMatchObject({ needs_confirmation: true, book: { id: "b1", title: "Applied Trigonometry" }, would_remove: { chapters: 1, shelves: ["Math"] } });
    const yes = await run("delete_book", { book: "b1", confirm_title: "yes" }, deps);
    expect((yes.result as any).error).toMatch(/exact title/);
    expect(calls.filter((c) => c[0] === "removeBook")).toEqual([]);
    const ok = await run("delete_book", { book: "b1", confirm_title: "applied  trigonometry" }, deps);
    expect(ok.result).toMatchObject({ ok: true, deleted: { id: "b1", title: "Applied Trigonometry" } });
    expect(calls.filter((c) => c[0] === "removeBook")).toEqual([["removeBook", "b1"]]);
  });
  it("refuses the reader's or a loaded book without even_if_loaded", async () => {
    const { deps, calls } = makeDeps(); // reader = b2
    const r = await run("delete_book", { book: "b2", confirm_title: "Practical Sigil Magic" }, deps);
    expect((r.result as any).error).toMatch(/open in the reader/);
    bookContextStore.set({ shelfId: "s1", bookIds: [], excludedIds: [] });
    const r2 = await run("delete_book", { book: "Dune", confirm_title: "Dune" }, deps);
    expect((r2.result as any).error).toMatch(/loaded in this conversation/);
    expect(calls.filter((c) => c[0] === "removeBook")).toEqual([]);
    const r3 = await run("delete_book", { book: "Dune", confirm_title: "Dune", even_if_loaded: true }, deps);
    expect(r3.result).toMatchObject({ ok: true });
  });
  it("reports a failed delete honestly", async () => {
    const { deps } = makeDeps({ removeBook: async () => ({ ok: false, error: "row still there" }) });
    const r = await run("delete_book", { book: "b1", confirm_title: "Applied Trigonometry" }, deps);
    expect((r.result as any).error).toMatch(/row still there/);
    expect((r.result as any).ok).toBeUndefined();
  });
  it("is off when the delete_book permission is off (choke point)", async () => {
    const { deps, calls } = makeDeps({ permissionsSnapshot: { delete_book: false } });
    const r = await run("delete_book", { book: "b1", confirm_title: "Applied Trigonometry" }, deps);
    expect((r.result as any).error).toMatch(/delete_book/);
    expect(calls).toEqual([]);
  });
});

describe("list_books with a shelf reader", () => {
  it("adds shelves, shelf_ids, the loaded set, and provenance", async () => {
    const { deps } = makeDeps();
    deps.getBooks = () => [book("b1", "Applied Trigonometry", ["s1"]), book("b9", "Draft", [], { source: "assistant" })];
    bookContextStore.set({ shelfId: "s1", bookIds: [], excludedIds: [] });
    const { result } = await run("list_books", {}, deps);
    const r = result as any;
    expect(r.books).toEqual([
      { id: "b1", title: "Applied Trigonometry", page_count: 10, chapter_count: 1, is_active: false, shelf_ids: ["s1"] },
      { id: "b9", title: "Draft", page_count: 10, chapter_count: 1, is_active: false, shelf_ids: [], source: "assistant" },
    ]);
    expect(r.shelves).toEqual([
      { id: "s1", name: "Math", book_count: 1, loaded_in_chat: true },
      { id: "s2", name: "Summer Reading", book_count: 0, loaded_in_chat: false },
    ]);
    expect(r.loaded).toEqual({ shelf_id: "s1" });
  });
});
