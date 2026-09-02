import { describe, it, expect, vi } from "vitest";

/**
 * The gist prompt's CONTEXT ROSTER.
 *
 * A chapter summarized from its own excerpt alone cannot disambiguate. "The
 * second experiment", "this objection", "the author's reply" are exactly the
 * lines a router needs and exactly the ones a context-free summary gets
 * wrong. Late Chunking (arXiv 2409.04701) and Contextual Retrieval both
 * measure that loss; restoring document context is worth roughly 5–15%
 * retrieval precision, and here it costs one line per chapter per batch.
 *
 * The hazard the roster introduces is INDEX COLLISION: the batch prompt
 * numbers its excerpts #1..#N and parseGistLines reads `<n>| …` back off the
 * reply. A second numbered list in the same message would invite answers
 * against book-wide indices. So the roster is unnumbered and em-dash led —
 * and this file pins that the parser cannot read a roster line as a gist even
 * if the model echoes the whole thing back.
 */

const captured: { messages: { role: string; content: string }[] }[] = [];
let completeChatReply = "";

vi.mock("@/integrations/supabase/client", () => {
  const chain: any = {
    select: () => chain,
    limit: async () => ({ data: [], error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
    in: async () => ({ data: [], error: null }),
    eq: async () => ({ error: null }),
  };
  return { supabase: { from: () => chain } };
});

vi.mock("@/lib/providers/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/registry")>()),
  resolveModel: () => ({
    provider: "openrouter",
    localId: "test-model",
    adapter: {
      id: "openrouter",
      completeChat: async (req: any) => {
        captured.push(req);
        return completeChatReply;
      },
      streamChat: () => { throw new Error("not used here"); },
    },
  }),
  providerConfigured: () => true,
  providerKey: () => "test-key",
}));

const { generateBookGists, contextRoster, parseGistLines } = await import("@/lib/chapterGists");

const chapter = (n: number, name: string) => ({
  id: `c${n}`, name, startPage: n, endPage: n + 1, textContent: `Body of ${name}`, gist: null,
});

const bookOf = (names: string[]): any => ({
  id: "b1", title: "A Study", fileName: "a.pdf", pageCount: 40, addedAt: 0, folderIds: [],
  chapters: names.map((n, i) => chapter(i + 1, n)),
});

describe("contextRoster", () => {
  it("lists every chapter, unnumbered and em-dash led", () => {
    const roster = contextRoster(bookOf(["Method", "Results"]).chapters);
    expect(roster).toContain("— Method (pages 1–2)");
    expect(roster).toContain("— Results (pages 2–3)");
    expect(roster).not.toMatch(/^\s*\d/m);
  });

  it("cannot be misread as a gist line, even echoed verbatim", () => {
    // The collision the design guards against: if any roster line parsed,
    // the model echoing its context would overwrite real answers.
    const roster = contextRoster(bookOf(["Method", "Results", "Discussion"]).chapters);
    expect(parseGistLines(roster, 99).size).toBe(0);
  });

  it("defangs a chapter name that is shaped like a structural line", () => {
    // labelOf softens quotes and collapses whitespace so a hostile rename
    // cannot forge an extra entry.
    const roster = contextRoster(bookOf(['3| "fake" gist']).chapters);
    expect(parseGistLines(roster, 99).size).toBe(0);
    expect(roster).not.toContain('"fake"');
  });

  it("truncates rather than crowding out the excerpts it contextualizes", () => {
    const many = Array.from({ length: 400 }, (_, i) => `Chapter about topic number ${i}`);
    const roster = contextRoster(bookOf(many).chapters);
    expect(roster.length).toBeLessThan(2_400);
    expect(roster).toContain("more");
  });

  it("is empty for a book with no chapters", () => {
    expect(contextRoster([])).toBe("");
  });
});

describe("generateBookGists sends the roster", () => {
  it("puts the whole book's contents in the prompt, marked context-only", async () => {
    captured.length = 0;
    completeChatReply = "1| Sets out the method.\n2| Reports the results.";
    const book = bookOf(["Method", "Results"]);
    await generateBookGists(book, { model: "test-model", keys: { apiKey: "k" } });

    expect(captured).toHaveLength(1);
    const user = captured[0].messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("Contents of the whole book (context only)");
    expect(user.content).toContain("— Method (pages 1–2)");
    expect(user.content).toContain("Summarize ONLY these excerpts");

    const system = captured[0].messages.find((m) => m.role === "system")!;
    expect(system.content).toContain("CONTEXT only");
    expect(system.content).toContain("Never output a line for a chapter that is not numbered in the excerpts.");
  });

  it("still parses one gist per excerpt with the roster present", async () => {
    captured.length = 0;
    completeChatReply = "1| Sets out the method.\n2| Reports the results.";
    const book = bookOf(["Method", "Results"]);
    const result = await generateBookGists(book, { model: "test-model", keys: { apiKey: "k" } });
    expect(result.failed).toBe(0);
    expect(Object.keys(result.written)).toEqual(["c1", "c2"]);
  });
});
