import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Catalog generation at INGEST.
 *
 * Gists and summaries were manual and reachable only from the chat picker,
 * which is why most books carry no catalog at all. This queue runs them when
 * an upload finishes chapterizing.
 *
 * The contracts that matter are all about NOT LYING when something partial
 * happens, because this runs unattended:
 *  - gists that landed in the DB reach client state even when the run then
 *    stops (the divergence rule chapterGists earned by review);
 *  - a missing books.summary migration is a pending user action, not a failed
 *    run — the gists are useful without it, so it reads as a note;
 *  - a book with no chapters is a no-op, not an error.
 */

const gistState = vi.hoisted(() => ({
  written: {} as Record<string, string>,
  failed: 0,
  stopError: undefined as string | undefined,
  throws: null as Error | null,
  lockHeld: false,
  calls: 0,
}));

const summaryState = vi.hoisted(() => ({
  throws: null as Error | null,
  calls: 0,
  lastBookChapters: [] as { id: string; gist: string | null }[],
}));

vi.mock("@/lib/chapterGists", () => ({
  acquireGistRun: () => !gistState.lockHeld,
  releaseGistRun: () => {},
  isGistRunActive: () => gistState.lockHeld,
  generateBookGists: async (book: any) => {
    gistState.calls++;
    if (gistState.throws) throw gistState.throws;
    void book;
    return { written: gistState.written, failed: gistState.failed, rejected: 0, skipped: 0, stopError: gistState.stopError };
  },
}));

vi.mock("@/lib/bookSummary", () => ({
  SUMMARY_MIGRATION_MESSAGE: "MIGRATION_MISSING",
  acquireSummaryRun: () => true,
  releaseSummaryRun: () => {},
  generateBookSummary: async (book: any) => {
    summaryState.calls++;
    summaryState.lastBookChapters = book.chapters.map((c: any) => ({ id: c.id, gist: c.gist }));
    if (summaryState.throws) throw summaryState.throws;
    return { summary: "A summary.", model: "test-model", fromGists: true };
  },
}));

const { catalogJobs } = await import("@/lib/catalogJobs");

const chapter = (n: number) => ({
  id: `c${n}`, name: `Chapter ${n}`, startPage: n, endPage: n + 1, textContent: "", gist: null,
});

const bookOf = (n: number): any => ({
  id: "b1", title: "A Study", fileName: "a.pdf", pageCount: 20,
  addedAt: 0, folderIds: [], chapters: Array.from({ length: n }, (_, i) => chapter(i + 1)),
});

const settled = async (bookId: string) => {
  for (let i = 0; i < 200; i++) {
    const j = catalogJobs.get(bookId);
    if (j && (j.status === "done" || j.status === "error")) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job never settled");
};

let gists: Record<string, string>[] = [];
let summaries: { id: string; summary: string; model: string }[] = [];

const run = (book: any = bookOf(2)) => {
  catalogJobs.enqueue({
    bookId: book.id,
    getBook: () => book,
    settings: { model: "test-model", keys: { apiKey: "k" } },
    onGists: (g) => gists.push(g),
    onSummary: (id, summary, model) => summaries.push({ id, summary, model }),
  });
  return settled(book.id);
};

beforeEach(() => {
  catalogJobs._reset();
  gists = [];
  summaries = [];
  gistState.written = { c1: "First.", c2: "Second." };
  gistState.failed = 0;
  gistState.stopError = undefined;
  gistState.throws = null;
  gistState.lockHeld = false;
  gistState.calls = 0;
  summaryState.throws = null;
  summaryState.calls = 0;
  summaryState.lastBookChapters = [];
});

describe("catalogJobs", () => {
  it("writes chapter gists, then the book summary", async () => {
    const job = await run();
    expect(job.status).toBe("done");
    expect(job.gistsWritten).toBe(2);
    expect(job.summaryWritten).toBe(true);
    expect(gists).toEqual([{ c1: "First.", c2: "Second." }]);
    expect(summaries).toEqual([{ id: "b1", summary: "A summary.", model: "test-model" }]);
  });

  it("summarizes the book WITH the gists it just wrote", async () => {
    // State may not have re-rendered yet, so the run merges its own results
    // rather than re-reading — otherwise the rollup summarizes an ungisted
    // book and silently takes the text-sample fallback.
    await run();
    expect(summaryState.lastBookChapters).toEqual([
      { id: "c1", gist: "First." },
      { id: "c2", gist: "Second." },
    ]);
  });

  it("keeps gists that landed even when the run then stops", async () => {
    gistState.stopError = "Saving summaries failed";
    const job = await run();
    expect(job.status).toBe("error");
    // The DB has them; client state must too, or the two diverge until reload.
    expect(gists).toEqual([{ c1: "First.", c2: "Second." }]);
    expect(summaryState.calls).toBe(0);
  });

  it("treats a missing summary migration as a note, not a failure", async () => {
    summaryState.throws = new Error("MIGRATION_MISSING");
    const job = await run();
    expect(job.status).toBe("done");
    expect(job.note).toContain("database update");
    expect(gists).toHaveLength(1); // the gists still landed and still count
  });

  it("surfaces a real summary failure as an error", async () => {
    summaryState.throws = new Error("provider exploded");
    const job = await run();
    expect(job.status).toBe("error");
    expect(job.error).toContain("provider exploded");
  });

  it("does nothing for a book with no chapters", async () => {
    const job = await run(bookOf(0));
    expect(job.status).toBe("done");
    expect(job.note).toContain("No chapters");
    expect(gistState.calls).toBe(0);
    expect(summaryState.calls).toBe(0);
  });

  it("refuses rather than double-spending when a manual run holds the lock", async () => {
    gistState.lockHeld = true;
    const job = await run();
    expect(job.status).toBe("error");
    expect(job.error).toContain("already in progress");
    expect(gistState.calls).toBe(0);
  });

  it("ignores a duplicate enqueue for a book already queued", async () => {
    const book = bookOf(2);
    const input = {
      bookId: book.id,
      getBook: () => book,
      settings: { model: "test-model", keys: { apiKey: "k" } },
      onGists: (g: Record<string, string>) => gists.push(g),
      onSummary: () => {},
    };
    catalogJobs.enqueue(input);
    catalogJobs.enqueue(input);
    await settled(book.id);
    expect(gistState.calls).toBe(1);
  });

  it("reports a book that vanished mid-queue", async () => {
    catalogJobs.enqueue({
      bookId: "gone",
      getBook: () => undefined,
      settings: { model: "test-model", keys: { apiKey: "k" } },
      onGists: () => {},
      onSummary: () => {},
    });
    const job = await settled("gone");
    expect(job.status).toBe("error");
    expect(job.error).toContain("no longer in your library");
  });
});
