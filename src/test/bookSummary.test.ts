import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The BOOK-level summary — the Card Catalog layer above chapters.gist.
 *
 * Three contracts under test:
 *
 * 1. It prefers ROLLING UP the chapter gists over re-reading the book. That
 *    is RAPTOR's recursion step (ICLR 2024): one short call, and it inherits
 *    whatever context the gists already carry. Reading chapter text is the
 *    fallback for a book that has no gists at all.
 *
 * 2. It feature-detects the migration BEFORE spending the user's key. The
 *    gist path learned this the hard way — probing after the first LLM batch
 *    bought a wasted batch on every pre-migration attempt.
 *
 * 3. It never stores a stub. A short reply is a refusal, an empty completion
 *    or a truncated first token, never a usable summary — and unlike the gist
 *    run there is no partial success to preserve, so failing loudly strands
 *    nothing.
 */

const dbState = vi.hoisted(() => ({
  probeError: null as { code?: string } | null,
  updateError: null as { code?: string; message?: string } | null,
  chapterRows: [] as { id: string; text_content: string | null }[],
  updates: [] as Record<string, unknown>[],
}));

const modelState = vi.hoisted(() => ({
  reply: "",
  configured: true,
  calls: [] as { messages: { role: string; content: string }[] }[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: async () => ({ data: [], error: dbState.probeError }),
        in: async () => ({ data: dbState.chapterRows, error: null }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          if (!dbState.updateError) dbState.updates.push(payload);
          return { error: dbState.updateError };
        },
      }),
    }),
  },
}));

vi.mock("@/lib/providers/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/registry")>()),
  resolveModel: () => ({
    provider: "openrouter",
    localId: "test-model",
    adapter: {
      id: "openrouter",
      completeChat: async (req: any) => {
        modelState.calls.push(req);
        return modelState.reply;
      },
      streamChat: () => { throw new Error("not used here"); },
    },
  }),
  providerConfigured: () => modelState.configured,
  providerKey: () => "test-key",
}));

const { generateBookSummary, gistRollup, cleanSummary, SUMMARY_MIGRATION_MESSAGE } =
  await import("@/lib/bookSummary");

const chapter = (n: number, name: string, gist: string | null) => ({
  id: `c${n}`, name, startPage: n, endPage: n + 1, textContent: "", gist,
});

const bookOf = (chapters: ReturnType<typeof chapter>[]): any => ({
  id: "b1", title: "A Study", fileName: "a.pdf", pageCount: 40,
  addedAt: 0, folderIds: [], chapters,
});

const GOOD_REPLY =
  "A field study of how three research groups reorganized their archives, and what broke each time. " +
  "It argues that classification schemes fail at the moment of capture, not at retrieval.";

const settings = { model: "test-model", keys: { apiKey: "k" } };

beforeEach(() => {
  dbState.probeError = null;
  dbState.updateError = null;
  dbState.chapterRows = [];
  dbState.updates = [];
  modelState.reply = GOOD_REPLY;
  modelState.configured = true;
  modelState.calls = [];
});

describe("gistRollup", () => {
  it("lists gisted chapters, unnumbered and em-dash led", () => {
    const out = gistRollup(bookOf([
      chapter(1, "Method", "Sets out the protocol."),
      chapter(2, "Results", "Reports three failures."),
    ]));
    expect(out).toContain("— Method: Sets out the protocol.");
    expect(out).toContain("— Results: Reports three failures.");
    expect(out).not.toMatch(/^\s*\d/m);
  });

  it("skips chapters that have no gist", () => {
    const out = gistRollup(bookOf([
      chapter(1, "Method", "Sets out the protocol."),
      chapter(2, "Appendix", null),
    ]));
    expect(out).toContain("Method");
    expect(out).not.toContain("Appendix");
  });

  it("is empty when nothing is gisted, which is what selects the fallback", () => {
    expect(gistRollup(bookOf([chapter(1, "Method", null)]))).toBe("");
  });

  it("truncates a very long book rather than sending everything", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      chapter(i + 1, `Chapter ${i}`, `A reasonably long one-line summary of chapter ${i}.`));
    const out = gistRollup(bookOf(many));
    expect(out.length).toBeLessThan(12_400);
    expect(out).toContain("omitted for length");
  });
});

describe("cleanSummary", () => {
  it("collapses to one line and neutralizes the wire delimiter", () => {
    expect(cleanSummary("a\n\nb | c")).toBe("a b / c");
  });
  it("bounds the length", () => {
    expect(cleanSummary("x".repeat(2_000)).length).toBe(700);
  });
});

describe("generateBookSummary", () => {
  it("rolls up gists when the book has them", async () => {
    const result = await generateBookSummary(
      bookOf([chapter(1, "Method", "Sets out the protocol."), chapter(2, "Results", "Reports three failures.")]),
      settings,
    );
    expect(result.fromGists).toBe(true);
    const user = modelState.calls[0].messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("— Method: Sets out the protocol.");
    // The rollup path must not go reading chapter text it doesn't need.
    expect(user.content).not.toContain("no text extracted");
  });

  it("falls back to chapter text when nothing is gisted", async () => {
    dbState.chapterRows = [{ id: "c1", text_content: "The archive was reorganized in 1998." }];
    const result = await generateBookSummary(bookOf([chapter(1, "Method", null)]), settings);
    expect(result.fromGists).toBe(false);
    const user = modelState.calls[0].messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("The archive was reorganized in 1998.");
  });

  it("tells the model which input it is looking at", async () => {
    await generateBookSummary(bookOf([chapter(1, "Method", "Sets out the protocol.")]), settings);
    const system = modelState.calls[0].messages.find((m) => m.role === "system")!;
    expect(system.content).toContain("one line per chapter");
  });

  it("names the migration and spends nothing when the columns are missing", async () => {
    dbState.probeError = { code: "42703" };
    await expect(
      generateBookSummary(bookOf([chapter(1, "Method", "g")]), settings),
    ).rejects.toThrow(SUMMARY_MIGRATION_MESSAGE);
    expect(modelState.calls).toHaveLength(0);
  });

  it("refuses before the model call when the provider has no key", async () => {
    modelState.configured = false;
    await expect(
      generateBookSummary(bookOf([chapter(1, "Method", "g")]), settings),
    ).rejects.toThrow(/API key/);
    expect(modelState.calls).toHaveLength(0);
  });

  it("refuses a book with nothing to read", async () => {
    await expect(generateBookSummary(bookOf([]), settings)).rejects.toThrow(/no chapters or text/);
    expect(modelState.calls).toHaveLength(0);
  });

  it("never stores a stub", async () => {
    modelState.reply = "Ok.";
    await expect(
      generateBookSummary(bookOf([chapter(1, "Method", "g")]), settings),
    ).rejects.toThrow(/no usable summary/);
    expect(dbState.updates).toHaveLength(0);
  });

  it("writes the summary with its model and a timestamp", async () => {
    await generateBookSummary(bookOf([chapter(1, "Method", "Sets out the protocol.")]), settings);
    expect(dbState.updates).toHaveLength(1);
    const row = dbState.updates[0];
    expect(row.summary).toContain("field study");
    // Attribution is stored, not inferred — a summary is never shown as
    // unattributed book metadata (CHI 2026 on disclosure and trust).
    expect(row.summary_model).toBe("test-model");
    expect(typeof row.summarized_at).toBe("string");
  });

  it("reports a save failure as the migration when that is the cause", async () => {
    dbState.updateError = { code: "42703" };
    await expect(
      generateBookSummary(bookOf([chapter(1, "Method", "g")]), settings),
    ).rejects.toThrow(SUMMARY_MIGRATION_MESSAGE);
  });
});
