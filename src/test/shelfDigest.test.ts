import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * Shelf digests — the catalog's third level. Chapter gists roll up into a
 * book summary; book summaries roll up into what the shelf is FOR.
 *
 * The contract worth pinning is the refusal: a digest rolled up from bare
 * titles is a list of titles the shelf card already shows, dressed as
 * knowledge it does not have. It costs the user a model call to produce
 * something worse than the count it sits under.
 */

const dbState = vi.hoisted(() => ({
  probeError: null as { code?: string } | null,
  updateError: null as { code?: string; message?: string } | null,
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
      select: () => ({ limit: async () => ({ data: [], error: dbState.probeError }) }),
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
      completeChat: async (req: any) => { modelState.calls.push(req); return modelState.reply; },
      streamChat: () => { throw new Error("not used here"); },
    },
  }),
  providerConfigured: () => modelState.configured,
  providerKey: () => "test-key",
}));

const { generateShelfDigest, bookRollup, DIGEST_MIGRATION_MESSAGE } =
  await import("@/lib/shelfDigest");

const mk = (id: string, title: string, summary: string | null): BookDocument => ({
  id, title, fileName: `${id}.pdf`, fileData: "", pageCount: 10,
  chapters: [], addedAt: 0, folderIds: ["s1"], summary,
});

const SHELF = { id: "s1", name: "Thesis research" };
const GOOD =
  "Three field studies of how research groups reorganize their archives, and one polemic against " +
  "classification. Read together they argue that filing fails at capture, not retrieval.";
const settings = { model: "test-model", keys: { apiKey: "k" } };

beforeEach(() => {
  dbState.probeError = null;
  dbState.updateError = null;
  dbState.updates = [];
  modelState.reply = GOOD;
  modelState.configured = true;
  modelState.calls = [];
});

describe("bookRollup", () => {
  it("prefers each book's summary and counts who contributed one", () => {
    const r = bookRollup([mk("b1", "Piles", "On desks and piles."), mk("b2", "Bare", null)]);
    expect(r.text).toContain("— Piles: On desks and piles.");
    expect(r.text).toContain("— Bare");
    expect(r.contributed).toBe(1);
  });

  it("is em-dash led and unnumbered, like every other rollup here", () => {
    const r = bookRollup([mk("b1", "Piles", "On desks.")]);
    expect(r.text).not.toMatch(/^\s*\d/m);
  });

  it("truncates a huge shelf rather than sending everything", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      mk(`b${i}`, `Book ${i}`, "A reasonably long summary sentence about this particular book."));
    expect(bookRollup(many).text.length).toBeLessThan(10_400);
  });
});

describe("generateShelfDigest", () => {
  it("writes a digest with its model and a timestamp", async () => {
    const r = await generateShelfDigest(SHELF, [mk("b1", "Piles", "On desks and piles.")], settings);
    expect(r.summary).toContain("field studies");
    expect(dbState.updates[0].summary_model).toBe("test-model");
    expect(typeof dbState.updates[0].summarized_at).toBe("string");
  });

  it("refuses a shelf whose books have no summaries", async () => {
    // Otherwise it spends a model call to restate the titles already on screen.
    await expect(
      generateShelfDigest(SHELF, [mk("b1", "Bare", null), mk("b2", "Also bare", null)], settings),
    ).rejects.toThrow(/catalog them first/);
    expect(modelState.calls).toHaveLength(0);
  });

  it("refuses an empty shelf before any model spend", async () => {
    await expect(generateShelfDigest(SHELF, [], settings)).rejects.toThrow(/no books/);
    expect(modelState.calls).toHaveLength(0);
  });

  it("names the migration and spends nothing when the columns are missing", async () => {
    dbState.probeError = { code: "42703" };
    await expect(
      generateShelfDigest(SHELF, [mk("b1", "Piles", "On desks.")], settings),
    ).rejects.toThrow(DIGEST_MIGRATION_MESSAGE);
    expect(modelState.calls).toHaveLength(0);
  });

  it("refuses before the model call when the provider has no key", async () => {
    modelState.configured = false;
    await expect(
      generateShelfDigest(SHELF, [mk("b1", "Piles", "On desks.")], settings),
    ).rejects.toThrow(/API key/);
  });

  it("never stores a stub", async () => {
    modelState.reply = "Books.";
    await expect(
      generateShelfDigest(SHELF, [mk("b1", "Piles", "On desks.")], settings),
    ).rejects.toThrow(/no usable digest/);
    expect(dbState.updates).toHaveLength(0);
  });

  it("lets the model say the shelf has no through-line", async () => {
    // A shelf of unrelated books is a fact about the shelf, not a failure —
    // inventing a theme for it would be the worse answer.
    await generateShelfDigest(SHELF, [mk("b1", "Piles", "On desks.")], settings);
    const system = modelState.calls[0].messages.find((m) => m.role === "system")!;
    expect(system.content).toContain("do not share one");
  });
});
