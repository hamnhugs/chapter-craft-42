import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * Stage 2 executors — search_book_text and read_span, plus the
 * create/update memory paths' locator laws (docs/stage2-card-pointers.md).
 *
 * The supabase client is a ROUTED fake: tests declare what each
 * (table, op) resolves, and every un-declared route resolves empty — so a
 * test that asserts "no network" can also assert the route log is empty.
 */

interface RouteCall { table: string; op: "select" | "update" | "rpc"; cols?: string; payload?: any; fn?: string }
const db: {
  log: RouteCall[];
  route: (c: RouteCall) => { data?: any; error?: any };
} = {
  log: [],
  route: () => ({ data: null, error: null }),
};

vi.mock("@/integrations/supabase/client", () => {
  const make = (table: string) => {
    const call: RouteCall = { table, op: "select" };
    const resolve = () => {
      db.log.push(call);
      const r = db.route(call) || {};
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const b: any = {
      select: (cols?: string) => { call.op = call.op === "update" ? call.op : "select"; call.cols = String(cols ?? ""); return b; },
      update: (payload: any) => { call.op = "update"; call.payload = payload; return b; },
      eq: () => b, in: () => b, is: () => b, ilike: () => b, overlaps: () => b, order: () => b, range: () => b,
      limit: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    return b;
  };
  return {
    supabase: {
      from: (table: string) => make(table),
      rpc: (fn: string, args: any) => {
        const call: RouteCall = { table: "(rpc)", op: "rpc", fn, payload: args };
        db.log.push(call);
        const r = db.route(call) || {};
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      },
    },
  };
});

const { executeChatTool: rawExecute } = await import("@/lib/chatTools");
// The executor takes args as the provider wire gives them: a JSON STRING.
const executeChatTool = (name: string, args: any, d: any) =>
  rawExecute(name, JSON.stringify(args), d) as Promise<{ result: any; event: any }>;
const { bookContextStore } = await import("@/lib/chatBooks");
const { resetCardLocatorAvailability, noteCardSchema } = await import("@/lib/cardLocators");

const ch = (id: string, name: string, startPage: number, endPage: number, text: string) => ({
  id, name, startPage, endPage, textContent: text,
});
const mkBook = (id: string, title: string, chapters: any[]): BookDocument =>
  ({ id, title, fileName: `${id}.pdf`, pageCount: 40, addedAt: 1, chapters, folderIds: [] }) as unknown as BookDocument;

const TRIG_TEXT =
  "Early filler prose about triangles and their many practical uses in surveying land. " +
  "The law of\nsines states that the ratio of a side to the sine of its opposite angle is constant. " +
  "Later material continues here with more examples and exercises for the reader.";
const SIGIL_TEXT =
  "Most modem occultists agree that sigils operate through the subconscious. More text follows here.";

const BOOKS: BookDocument[] = [
  mkBook("book-trig", "Applied Trigonometry", [
    ch("ch-t1", "Foundations", 1, 12, TRIG_TEXT),
    ch("ch-t2", "Deep Waters", 13, 30, "Nothing relevant lives in this chapter at all."),
  ]),
  mkBook("book-sigil", "Practical Sigils", [ch("ch-s1", "Origins", 1, 20, SIGIL_TEXT)]),
  mkBook("book-out", "Forgotten Upload", [ch("ch-out", "Lurker", 1, 5, "the law of sines lives here too")]),
];

const deps = (over: Partial<any> = {}): any => ({
  books: BOOKS,
  activeBookId: null,
  setActiveBookId: () => {},
  addChapter: async () => {},
  updateChapter: () => {},
  removeChapter: () => {},
  permissionsSnapshot: {},
  ...over,
});

beforeEach(() => {
  db.log = [];
  db.route = () => ({ data: null, error: null });
  resetCardLocatorAvailability();
  bookContextStore.init(null);
  bookContextStore.clear();
  bookContextStore.set({ shelfId: null, bookIds: ["book-trig", "book-sigil"], excludedIds: [] });
});

describe("search_book_text — in-memory path", () => {
  it("finds a phrase across a PDF line wrap, serves a fenced verbatim excerpt with provenance, and touches no network", async () => {
    const { result, event } = await executeChatTool("search_book_text", { query: "the law of sines" }, deps());
    expect(event.ok).toBe(true);
    expect(result.total_matches).toBe(1);
    const m = result.matches[0];
    expect(m.book_id).toBe("book-trig");
    expect(m.chapter_id).toBe("ch-t1");
    expect(m.chapter_name).toBe("Foundations");
    expect(m.approx_page).toBeGreaterThanOrEqual(1);
    expect(m.approx_page).toBeLessThanOrEqual(12);
    expect(TRIG_TEXT.slice(m.char_start, m.char_end)).toBe("The law of\nsines");
    expect(m.excerpt).toContain("law of\nsines states that the ratio");
    expect(m.excerpt).toMatch(/<<<data:[a-z0-9]+>>>/);
    expect(result.quote_note).toContain("byte-for-byte");
    // Every chapter had text client-side — the prefilter must never fire.
    expect(db.log.filter((c) => c.table === "chapters")).toHaveLength(0);
  });

  it("scopes to the books in play by default — a forgotten upload is not searched — while an exact book_id reaches it", async () => {
    const inPlay = await executeChatTool("search_book_text", { query: "the law of sines" }, deps());
    expect(inPlay.result.matches.every((m: any) => m.book_id !== "book-out")).toBe(true);
    const direct = await executeChatTool("search_book_text", { query: "the law of sines", book_id: "book-out" }, deps());
    expect(direct.result.total_matches).toBe(1);
    expect(direct.result.matches[0].book_id).toBe("book-out");
  });

  it("0 matches returns the honest exact-phrase hint, naming no tools", async () => {
    const { result } = await executeChatTool("search_book_text", { query: "modern occultists" }, deps());
    expect(result.total_matches).toBe(0);
    expect(result.hint).toContain("exact-phrase");
    expect(result.hint).toContain("OCR");
    expect(result.hint).not.toMatch(/[a-z]+_[a-z_]+\(/);
    expect(result.hint).not.toContain("get_chapter_text");
  });

  it("rejects an unusable query", async () => {
    const { event } = await executeChatTool("search_book_text", { query: "ab" }, deps());
    expect(event.ok).toBe(false);
  });
});

describe("search_book_text — server prefilter path (catalog-mode chapters carry no text)", () => {
  const textlessBooks = [
    mkBook("book-cat", "Catalog Mode Book", [
      ch("ch-c1", "One", 1, 10, ""),
      ch("ch-c2", "Two", 11, 20, ""),
      ch("ch-c3", "Three", 21, 30, ""),
    ]),
  ];
  const catDeps = (loaderText: Record<string, string>, over: Partial<any> = {}) =>
    deps({
      books: textlessBooks,
      loadChapterTextStrict: async (id: string) =>
        id in loaderText ? { ok: true, text: loaderText[id] } : { ok: false, error: "chapter not found" },
      ...over,
    });

  beforeEach(() => {
    bookContextStore.set({ shelfId: null, bookIds: ["book-cat"], excludedIds: [] });
  });

  it("prefilters by the longest ASCII token, fetches only candidates, and matches with the JS authority", async () => {
    db.route = (c) => {
      if (c.table === "chapters" && c.op === "select") return { data: [{ id: "ch-c2" }] };
      return { data: null };
    };
    const { result } = await executeChatTool(
      "search_book_text",
      { query: "the law of sines" },
      catDeps({ "ch-c2": "somewhere deep, the law of\nsines states things" }),
    );
    expect(result.total_matches).toBe(1);
    expect(result.matches[0].chapter_id).toBe("ch-c2");
    expect(db.log.filter((c) => c.table === "chapters")).toHaveLength(1);
  });

  it("counts candidates beyond the fetch cap — a cap is never silent", async () => {
    const many = mkBook("book-cat", "Catalog Mode Book",
      Array.from({ length: 9 }, (_, i) => ch(`cc-${i}`, `C${i}`, i * 3 + 1, i * 3 + 3, "")));
    db.route = (c) => {
      if (c.table === "chapters") return { data: many.chapters.map((x: any) => ({ id: x.id })) };
      return { data: null };
    };
    const loaded = Object.fromEntries(many.chapters.map((x: any) => [x.id, "no hits in this text"]));
    const { result } = await executeChatTool(
      "search_book_text",
      { query: "the law of sines" },
      deps({ books: [many], loadChapterTextStrict: async (id: string) => ({ ok: true, text: loaded[id] || "" }) }),
    );
    expect(result.chapters_matched_not_searched).toBe(3); // 9 candidates, cap 6
    expect(result.narrowing_hint).toBeTruthy();
  });

  it("reports unreadable candidates instead of claiming 0 matches, and degrades when the prefilter errors", async () => {
    db.route = (c) => {
      if (c.table === "chapters") return { error: { code: "500", message: "boom" } };
      return { data: null };
    };
    const { result } = await executeChatTool("search_book_text", { query: "the law of sines" }, catDeps({}));
    // Prefilter failed ⇒ all three textless chapters became candidates; the
    // strict loader knows none of them ⇒ all unreadable, honestly counted.
    expect(result.chapters_unreadable).toBe(3);
    expect(result.note).toContain("narrowing was unavailable");
  });
});

describe("read_span — dereference serves ground truth or an honest failure", () => {
  const LOC = {
    chapter_id: "ch-t1",
    char_start: TRIG_TEXT.indexOf("The law of\nsines"),
    char_end: TRIG_TEXT.indexOf("constant.") + "constant.".length,
    page: 3,
    quote: "the ratio of a side to the sine",
    book_id: "book-trig",
    book_title: "Applied Trigonometry",
    chapter_name: "Foundations",
  };
  const entryRoute = (locators: any) => (c: RouteCall) => {
    if (c.table === "knowledge_entries" && c.op === "select" && (c.cols || "").includes("locators")) {
      return { data: { id: "e1", title: "Law of Sines", locators } };
    }
    return { data: null };
  };

  it("serves the verified span fenced, with stored (denormalized) provenance", async () => {
    db.route = entryRoute([LOC]);
    const { result, event } = await executeChatTool("read_span", { entry_id: "e1" }, deps());
    expect(event.ok).toBe(true);
    const s = result.spans[0];
    expect(s.verified).toBe(true);
    expect(s.book_title).toBe("Applied Trigonometry");
    expect(s.chapter_name).toBe("Foundations");
    expect(s.span).toContain("law of\nsines states that the ratio");
    expect(s.span).toMatch(/<<<data:[a-z0-9]+>>>/);
    expect(result.note).toContain("byte-for-byte");
  });

  it("re-anchors the quote when stored offsets are stale — never serving the stale offsets' bytes", async () => {
    db.route = entryRoute([{ ...LOC, char_start: 0, char_end: 20 }]);
    const { result } = await executeChatTool("read_span", { entry_id: "e1" }, deps());
    const s = result.spans[0];
    expect(s.verified).toBe(true);
    expect(s.note).toContain("stale");
    expect(s.span).toContain("the ratio of a side to the sine");
    expect(s.span).not.toContain("Early filler");
  });

  it("serves NO bytes when the quote is gone from the chapter", async () => {
    db.route = entryRoute([{ ...LOC, quote: "this sentence never existed anywhere" }]);
    const { result, event } = await executeChatTool("read_span", { entry_id: "e1" }, deps());
    expect(result.spans[0].verified).toBe(false);
    expect(result.spans[0].span).toBeUndefined();
    expect(result.spans[0].error).toContain("could not be verified");
    expect(event.ok).toBe(false);
  });

  it("answers honestly for an unanchored note and for a dead chapter", async () => {
    db.route = entryRoute(null);
    const un = await executeChatTool("read_span", { entry_id: "e1" }, deps());
    expect(un.result.note).toContain("unanchored");
    db.route = entryRoute([{ ...LOC, chapter_id: "ch-gone" }]);
    const dead = await executeChatTool(
      "read_span",
      { entry_id: "e1" },
      deps({ loadChapterTextStrict: async () => ({ ok: false, error: "chapter not found" }) }),
    );
    expect(dead.result.spans[0].error).toContain("no longer exists");
  });

  it("says 'couldn't read — retry' on a transient load failure, never a drift claim", async () => {
    db.route = entryRoute([{ ...LOC, chapter_id: "ch-elsewhere" }]);
    const { result } = await executeChatTool(
      "read_span",
      { entry_id: "e1" },
      deps({ loadChapterTextStrict: async () => ({ ok: false, error: "network timeout" }) }),
    );
    expect(result.spans[0].error).toContain("retry");
    expect(result.spans[0].error).not.toContain("no longer exists");
  });

  it("returns the typed migration message when the schema is known missing", async () => {
    noteCardSchema("missing");
    const { result, event } = await executeChatTool("read_span", { entry_id: "e1" }, deps());
    expect(event.ok).toBe(false);
    expect(result.error).toContain("migration");
    expect(db.log).toHaveLength(0);
  });
});

describe("create_memory_entry — the locator gate and the register", () => {
  const scope = (extra: (c: RouteCall) => any = () => null) => (c: RouteCall) => {
    if (c.table === "user_settings") return { data: { active_wiki_id: "wiki-1", access_all_neurons: false, active_wiki_ids: [] } };
    if (c.table === "subscribers") return { data: { subscribed: false } };
    if (c.table === "wikis") return { data: [] };
    return extra(c) || { data: null };
  };

  beforeEach(() => {
    noteCardSchema("present"); // the gate stands down pre-migration by design
  });

  it("teaches instead of minting an unanchored book note while books are loaded", async () => {
    db.route = scope();
    const { result, event } = await executeChatTool(
      "create_memory_entry",
      { title: "Sigil basics", content: "Sigils work via the subconscious." },
      deps(),
    );
    expect(event.ok).toBe(false);
    expect(result.error).toContain("locators:[{chapter_id, quote}]");
    expect(result.error).toContain("unanchored:true");
    expect(db.log.filter((c) => c.op === "rpc")).toHaveLength(0);
  });

  it("unanchored:true saves, with the audit note", async () => {
    db.route = scope((c) => (c.op === "rpc" && c.fn === "memory_entry_upsert" ? { data: "new-entry-1" } : null));
    const { result, event } = await executeChatTool(
      "create_memory_entry",
      { title: "My preference", content: "User prefers dark mode.", unanchored: true },
      deps(),
    );
    expect(event.ok).toBe(true);
    expect(result.entry_id).toBe("new-entry-1");
    expect(result.note).toContain("Saved unanchored");
  });

  it("anchors, attaches, and reports honestly on the happy path", async () => {
    const updates: any[] = [];
    db.route = scope((c) => {
      if (c.op === "rpc" && c.fn === "memory_entry_upsert") return { data: "new-entry-2" };
      if (c.table === "knowledge_entries" && c.op === "update") { updates.push(c.payload); return { data: null }; }
      return null;
    });
    const { result, event } = await executeChatTool(
      "create_memory_entry",
      {
        title: "Law of Sines",
        content: "Side-to-sine ratios are constant.",
        locators: [{ chapter_id: "ch-t1", quote: "the ratio of a side to the sine" }],
      },
      deps(),
    );
    expect(event.ok).toBe(true);
    expect(event.summary).toContain("anchored to 1 passage(s)");
    expect(result.locators_saved).toBe(1);
    const written = updates.find((p) => p.locators);
    expect(written.locators[0]).toMatchObject({
      chapter_id: "ch-t1",
      book_id: "book-trig",
      book_title: "Applied Trigonometry",
      chapter_name: "Foundations",
    });
    expect(written.author).toBe("assistant");
  });

  it("fail-closed: one bad locator saves nothing", async () => {
    db.route = scope();
    const { result, event } = await executeChatTool(
      "create_memory_entry",
      {
        title: "Mixed",
        content: "x",
        locators: [
          { chapter_id: "ch-t1", quote: "the ratio of a side to the sine" },
          { chapter_id: "ch-t1", quote: "this text is nowhere in the chapter" },
        ],
      },
      deps(),
    );
    expect(event.ok).toBe(false);
    expect(result.details.join(" ")).toContain("quote not found");
    expect(db.log.filter((c) => c.op === "rpc")).toHaveLength(0);
  });

  it("merges locators into an existing ASSISTANT card instead of minting a duplicate", async () => {
    db.route = scope((c) => {
      if (c.table === "knowledge_entries" && c.op === "select") {
        return { data: [{ id: "old-1", title: "Law of Sines", content: "gloss", author: "assistant", locators: [], aliases: [] }] };
      }
      if (c.op === "rpc" && c.fn === "entry_locators_merge") return { data: [{ chapter_id: "ch-t1", char_start: 1, char_end: 9, page: 1, quote: "abcdefgh" }] };
      return null;
    });
    const { result } = await executeChatTool(
      "create_memory_entry",
      { title: "law of sines", content: "dup", locators: [{ chapter_id: "ch-t1", quote: "the ratio of a side to the sine" }] },
      deps(),
    );
    expect(result.merged_into_existing).toBe(true);
    expect(result.entry_id).toBe("old-1");
    expect(db.log.filter((c) => c.fn === "memory_entry_upsert")).toHaveLength(0);
  });

  it("never auto-merges into a USER-authored card — returns it for deliberate action", async () => {
    db.route = scope((c) => {
      if (c.table === "knowledge_entries" && c.op === "select") {
        return { data: [{ id: "user-1", title: "Law of Sines", content: "the user's own claim", author: "user", locators: [], aliases: [] }] };
      }
      return null;
    });
    const { result } = await executeChatTool(
      "create_memory_entry",
      { title: "Law of Sines", content: "dup", locators: [{ chapter_id: "ch-t1", quote: "the ratio of a side to the sine" }] },
      deps(),
    );
    expect(result.already_exists).toBe(true);
    expect(result.entry_id).toBe("user-1");
    expect(db.log.filter((c) => c.fn === "entry_locators_merge")).toHaveLength(0);
    expect(db.log.filter((c) => c.fn === "memory_entry_upsert")).toHaveLength(0);
  });

  it("a failed attach is loudly partial — never a silent unanchored mint", async () => {
    db.route = scope((c) => {
      if (c.op === "rpc" && c.fn === "memory_entry_upsert") return { data: "new-entry-3" };
      if (c.table === "knowledge_entries" && c.op === "update") return { error: { code: "500", message: "boom" } };
      return null;
    });
    const { result, event } = await executeChatTool(
      "create_memory_entry",
      { title: "Partial", content: "x", locators: [{ chapter_id: "ch-t1", quote: "the ratio of a side to the sine" }] },
      deps(),
    );
    expect(result.locators_saved).toBe(0);
    expect(result.locators_not_saved).toBe(1);
    expect(result.note).toContain("UNANCHORED");
    expect(event.summary).toContain("locators not saved");
    expect(event.summary).not.toContain("anchored to");
  });
});

describe("update_memory_entry — add_locators", () => {
  it("anchors an existing card without touching its fields", async () => {
    db.route = (c) => {
      if (c.op === "rpc" && c.fn === "entry_locators_merge") {
        return { data: [{ chapter_id: "ch-t1", char_start: 1, char_end: 9, page: 1, quote: "abcdefgh" }] };
      }
      return { data: null };
    };
    const { result, event } = await executeChatTool(
      "update_memory_entry",
      { entry_id: "e9", add_locators: [{ chapter_id: "ch-t1", quote: "the ratio of a side to the sine" }] },
      deps(),
    );
    expect(event.ok).toBe(true);
    expect(event.summary).toContain("Anchored");
    expect(result.locators_on_card).toBe(1);
    expect(db.log.filter((c) => c.fn === "memory_entry_upsert")).toHaveLength(0);
  });

  it("rejects an unverifiable add_locators batch with nothing changed", async () => {
    const { result, event } = await executeChatTool(
      "update_memory_entry",
      { entry_id: "e9", add_locators: [{ chapter_id: "ch-t1", quote: "never in the chapter at all" }] },
      deps(),
    );
    expect(event.ok).toBe(false);
    expect(result.details.join(" ")).toContain("quote not found");
    expect(db.log.filter((c) => c.op === "rpc")).toHaveLength(0);
  });
});
