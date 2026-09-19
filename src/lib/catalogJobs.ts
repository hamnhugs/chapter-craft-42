import { useSyncExternalStore } from "react";
import type { BookDocument } from "@/types/library";
import {
  acquireGistRun, generateBookGists, releaseGistRun, isGistRunActive,
} from "@/lib/chapterGists";
import {
  acquireSummaryRun, generateBookSummary, releaseSummaryRun, SUMMARY_MIGRATION_MESSAGE,
} from "@/lib/bookSummary";

// Catalog generation at INGEST. Same observable-store + sequential-queue
// shape as structureJobs and figureJobs, so a Library card can show live
// progress with no provider plumbing and two uploads can't run the user's
// model concurrently.
//
// Why this exists: gists and summaries were manual and reachable only from
// the chat picker, which is why so many books carry no catalog at all. This
// runs them when an upload finishes chapterizing — opt-in, because it spends
// the user's own key.
//
// HONEST LIMITATION, same as structureJobs: this runs in the tab. Closing the
// Vault mid-run abandons it. The work is idempotent (gists skip chapters that
// already have one; a re-run resumes), so an abandoned run costs progress,
// never correctness.

export type CatalogJobStatus = "queued" | "running" | "done" | "error";

export interface CatalogJob {
  bookId: string;
  status: CatalogJobStatus;
  progress: string;
  /** Chapter gists written this run. */
  gistsWritten?: number;
  /** Chapters the model returned nothing usable for (re-runnable). */
  gistsFailed?: number;
  /** Chapters whose generated summary its own excerpt contradicted, so it
   *  was discarded rather than stored. */
  gistsRejected?: number;
  /** True once the book-level summary landed. */
  summaryWritten?: boolean;
  /** Set when the run finished but the summary was skipped for a nameable,
   *  non-failure reason — currently only "migration not applied". */
  note?: string;
  error?: string;
  updatedAt: number;
}

export interface CatalogJobInput {
  bookId: string;
  /** Resolves the CURRENT book. Chapters usually land between enqueue and
   *  run, so a captured object would be summarizing an empty book. */
  getBook: () => BookDocument | undefined;
  settings: {
    model: string;
    keys: { apiKey?: string; geminiApiKey?: string; nvidiaKeyLast4?: string };
  };
  /** Mirror written gists into library state (DB write already happened). */
  onGists: (gistById: Record<string, string>) => void;
  /** Mirror the written summary into library state. */
  onSummary: (bookId: string, summary: string, model: string) => void;
}

let jobs: Record<string, CatalogJob> = {};
const listeners = new Set<() => void>();
const queue: CatalogJobInput[] = [];
let running = false;

const emit = () => listeners.forEach((l) => l());

const patch = (bookId: string, p: Partial<CatalogJob>) => {
  jobs = {
    ...jobs,
    [bookId]: {
      bookId,
      status: "queued",
      progress: "",
      ...jobs[bookId],
      ...p,
      updatedAt: Date.now(),
    },
  };
  emit();
};

async function runOne(input: CatalogJobInput): Promise<void> {
  const book = input.getBook();
  if (!book) {
    patch(input.bookId, { status: "error", progress: "", error: "That book is no longer in your library." });
    return;
  }
  if (book.chapters.length === 0) {
    // Nothing to summarize and nothing to roll up. Not a failure worth
    // shouting about — chapter detection simply found nothing.
    patch(input.bookId, { status: "done", progress: "", note: "No chapters to catalog." });
    return;
  }

  // ── Chapter gists ────────────────────────────────────────────────────────
  let written: Record<string, string> = {};
  if (!acquireGistRun()) {
    patch(input.bookId, {
      status: "error", progress: "",
      error: "A catalog run is already in progress — try this book again when it finishes.",
    });
    return;
  }
  try {
    patch(input.bookId, { status: "running", progress: "Summarizing chapters…", error: undefined });
    const result = await generateBookGists(book, input.settings, (msg) =>
      patch(input.bookId, { progress: msg }));
    written = result.written;
    // Apply BEFORE surfacing any stop error: everything in `written` is
    // already in the database, and leaving it out of client state diverges
    // the two until reload (the rule chapterGists earned by review).
    if (Object.keys(written).length > 0) input.onGists(written);
    patch(input.bookId, {
      gistsWritten: Object.keys(written).length,
      gistsFailed: result.failed,
      gistsRejected: result.rejected,
    });
    if (result.stopError) {
      patch(input.bookId, { status: "error", progress: "", error: result.stopError });
      return;
    }
  } catch (e) {
    patch(input.bookId, {
      status: "error", progress: "",
      error: e instanceof Error ? e.message : "Chapter summaries failed",
    });
    return;
  } finally {
    releaseGistRun();
  }

  // ── Book summary ─────────────────────────────────────────────────────────
  // Built from the book as it now stands: merge this run's gists in rather
  // than re-reading state, which may not have re-rendered yet.
  const withGists: BookDocument = {
    ...book,
    chapters: book.chapters.map((c) => (written[c.id] ? { ...c, gist: written[c.id] } : c)),
  };

  if (!acquireSummaryRun()) {
    patch(input.bookId, { status: "done", progress: "", note: "Chapter summaries written; book summary skipped (another run held the lock)." });
    return;
  }
  try {
    patch(input.bookId, { progress: "Writing the book summary…" });
    const summary = await generateBookSummary(withGists, input.settings, (msg) =>
      patch(input.bookId, { progress: msg }));
    input.onSummary(book.id, summary.summary, summary.model);
    patch(input.bookId, { status: "done", progress: "", summaryWritten: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Book summary failed";
    if (message === SUMMARY_MIGRATION_MESSAGE) {
      // The gists DID land and are useful on their own. A missing migration
      // is a pending user action, not a failed run — don't paint it red on
      // every upload.
      patch(input.bookId, { status: "done", progress: "", note: "Chapter summaries written. Book summary needs the database update." });
      return;
    }
    patch(input.bookId, { status: "error", progress: "", error: message });
  } finally {
    releaseSummaryRun();
  }
}

async function runNext() {
  if (running) return;
  const input = queue.shift();
  if (!input) return;
  running = true;
  try {
    await runOne(input);
  } finally {
    running = false;
    // Yield so the UI paints between books.
    setTimeout(runNext, 50);
  }
}

export const catalogJobs = {
  enqueue(input: CatalogJobInput) {
    const existing = jobs[input.bookId];
    if (existing && (existing.status === "queued" || existing.status === "running")) return;
    if (queue.some((q) => q.bookId === input.bookId)) return;
    queue.push(input);
    patch(input.bookId, { status: "queued", progress: "Waiting…", error: undefined, note: undefined });
    runNext();
  },
  dismiss(bookId: string) {
    if (!(bookId in jobs)) return;
    const { [bookId]: _gone, ...rest } = jobs;
    jobs = rest;
    emit();
  },
  get(bookId: string): CatalogJob | undefined {
    return jobs[bookId];
  },
  /** True when any catalog work is in flight anywhere (the manual picker run
   *  included) — surfaces shared with the picker read this so two entry
   *  points can't look independently available. */
  busy(): boolean {
    return running || isGistRunActive();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getAll(): Record<string, CatalogJob> {
    return jobs;
  },
  /** Tests only. */
  _reset() {
    jobs = {};
    queue.length = 0;
    running = false;
  },
};

/**
 * ONE enqueue recipe for every surface that can finish a book (the Vault's
 * upload path, the assistant's save_to_library). The settings ride through
 * a getter so a long-lived closure reads the CURRENT model/keys/opt-in; the
 * book is resolved at RUN time through `getBook` — except that a caller who
 * has just built the chapters passes them explicitly, because the library
 * mirror may not have committed them yet (a job that read an effect-updated
 * ref one microtask after the last insert cataloged N-1 chapters and marked
 * itself done — review finding).
 */
export function makeCatalogEnqueuer(deps: {
  getSettings: () => { autoCatalogOnUpload: boolean; model: string; keys: CatalogJobInput["settings"]["keys"] };
  getBook: (bookId: string) => BookDocument | undefined;
  onGists: CatalogJobInput["onGists"];
  onSummary: CatalogJobInput["onSummary"];
}) {
  return (bookId: string, known?: BookDocument): { queued: boolean; reason?: "opt_out" } => {
    const { autoCatalogOnUpload, model, keys } = deps.getSettings();
    if (!autoCatalogOnUpload) return { queued: false, reason: "opt_out" };
    catalogJobs.enqueue({
      bookId,
      getBook: () => {
        const live = deps.getBook(bookId);
        if (!known) return live;
        // The freshly built chapters win over a mirror that has not caught up.
        return live && live.chapters.length >= known.chapters.length ? live : { ...(live ?? known), chapters: known.chapters };
      },
      settings: { model, keys },
      onGists: deps.onGists,
      onSummary: deps.onSummary,
    });
    return { queued: true };
  };
}

const EMPTY: Record<string, CatalogJob> = {};

export function useCatalogJobs(): Record<string, CatalogJob> {
  return useSyncExternalStore(catalogJobs.subscribe, catalogJobs.getAll, () => EMPTY);
}
