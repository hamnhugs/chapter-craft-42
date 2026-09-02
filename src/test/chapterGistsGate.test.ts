import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * B-6 end-to-end at the generateBookGists seam: a summary its own excerpt
 * contradicts must never reach the database.
 *
 * This is the property that matters, because a stored gist is not a display
 * string — it rides in model context on every send, and nothing downstream
 * ever re-reads the chapter to check it. Catching it here is the only place
 * it can be caught.
 *
 * Rejection is reported APART from `failed`. Both are re-runnable, but they
 * mean different things: failed = the model returned nothing usable; rejected
 * = it answered and was wrong. Collapsing them would hide a model that is
 * confidently fabricating from one that is merely flaky.
 */

const state = vi.hoisted(() => ({
  /** Replies handed out in call order: [0] generation, [1] verification. */
  replies: [] as string[],
  calls: 0,
  /** Chapter ids actually written to the DB. */
  written: [] as string[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const chain: any = {
    select: () => chain,
    limit: async () => ({ data: [], error: null }),
    in: async () => ({ data: [], error: null }),
    update: (payload: { gist?: string }) => ({
      eq: async (_col: string, id: string) => {
        if (payload.gist) state.written.push(id);
        return { error: null };
      },
    }),
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
      completeChat: async () => state.replies[state.calls++] ?? "",
      streamChat: () => { throw new Error("not used here"); },
    },
  }),
  providerConfigured: () => true,
  providerKey: () => "test-key",
}));

const { generateBookGists } = await import("@/lib/chapterGists");

const chapter = (n: number) => ({
  id: `c${n}`, name: `Chapter ${n}`, startPage: n, endPage: n + 1,
  textContent: `Body of chapter ${n}, long enough to excerpt.`, gist: null,
});

const bookOf = (n: number): any => ({
  id: "b1", title: "A Study", fileName: "a.pdf", pageCount: 20,
  addedAt: 0, folderIds: [], chapters: Array.from({ length: n }, (_, i) => chapter(i + 1)),
});

const settings = { model: "test-model", keys: { apiKey: "k" } };

const GENERATED = "1| Sets out the protocol clearly.\n2| Reports three separate failures.";

beforeEach(() => {
  state.replies = [];
  state.calls = 0;
  state.written = [];
});

describe("the gist gate", () => {
  it("stores only the summaries the check did not contradict", async () => {
    state.replies = [GENERATED, "1| YES\n2| NO"];
    const r = await generateBookGists(bookOf(2), settings);
    expect(state.written).toEqual(["c1"]);
    expect(Object.keys(r.written)).toEqual(["c1"]);
    expect(r.rejected).toBe(1);
    expect(r.failed).toBe(0);
  });

  it("counts a rejection apart from a model that returned nothing", async () => {
    // Chapter 2 gets no line at all; chapter 1's line is contradicted.
    state.replies = ["1| Sets out the protocol clearly.", "1| NO"];
    const r = await generateBookGists(bookOf(2), settings);
    expect(r.rejected).toBe(1);
    expect(r.failed).toBe(1);
    expect(state.written).toEqual([]);
  });

  it("stores everything when the check passes it all", async () => {
    state.replies = [GENERATED, "1| YES\n2| YES"];
    const r = await generateBookGists(bookOf(2), settings);
    expect(state.written).toEqual(["c1", "c2"]);
    expect(r.rejected).toBe(0);
  });

  it("stores everything when the check cannot run — it never gates on silence", async () => {
    // A provider hiccup on the verifier must not cost the user a paid run's
    // worth of correct summaries.
    state.replies = [GENERATED, ""];
    const r = await generateBookGists(bookOf(2), settings);
    expect(state.written).toEqual(["c1", "c2"]);
    expect(r.rejected).toBe(0);
  });

  it("does not call the verifier when generation produced nothing", async () => {
    state.replies = ["no parseable lines here", "1| NO"];
    const r = await generateBookGists(bookOf(2), settings);
    expect(r.failed).toBe(2);
    expect(r.rejected).toBe(0);
    expect(state.calls).toBe(1); // generation only
  });

  it("reports rejections in the run summary a caller can show", async () => {
    state.replies = [GENERATED, "1| NO\n2| NO"];
    const r = await generateBookGists(bookOf(2), settings);
    expect(r).toMatchObject({ rejected: 2, failed: 0, skipped: 0 });
    expect(Object.keys(r.written)).toHaveLength(0);
  });
});
