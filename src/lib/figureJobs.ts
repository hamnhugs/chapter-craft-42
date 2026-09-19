import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { extractFiguresFromPdf, blobToScaledJpegDataUrl, ExtractedFigure } from "./figureExtraction";
import { modelProvider } from "@/lib/providers/registry";

// Per-book figure-extraction jobs. Same module-level observable store +
// sequential queue pattern as structureJobs.ts: Library cards get live
// progress with no provider plumbing, and one job at a time keeps pdfjs
// memory use bounded.
//
// Pipeline per job (digestion-free — books need no neurons to extract):
//   1. load the book's neurons as OPTIONAL pairing candidates (chat
//      extraction still writes knowledge_entries.source_book_id; zero is a
//      normal state, not an error),
//   2. extract figures from the PDF client-side (free, no AI),
//   3. replace any previously extracted figures for the book,
//   4. describe (and, when candidates exist, pair) figures in batches via
//      the describe-figures edge function (vision model: user's pick, else
//      built-in default),
//   5. upload kept figures to the private generated-images bucket and insert
//      image_attachments rows (kind='figure', entry_id → neuron or null,
//      book_id + page always) — the Images panel shows every figure, and the
//      stored prompt line carries book, page, and chapter provenance derived
//      from the page number and the book's chapter ranges.

export type FigureJobStatus = "queued" | "running" | "done" | "error";

export interface FigureJob {
  bookId: string;
  status: FigureJobStatus;
  progress: string;
  kept?: number;
  skipped?: number;
  error?: string;
  updatedAt: number;
}

interface JobInput {
  bookId: string;
  bookTitle: string;
  /** User's figure-extraction model override; server falls back to settings/default. */
  model?: string;
  /** The book's chapter ranges, for chapter provenance on stored figures. */
  chapters?: ChapterRange[];
  /** Lazily provides the PDF (fresh-upload File, or a storage URL). */
  load: () => Promise<{ file?: File | Blob; fileUrl?: string }>;
}

export interface ChapterRange {
  name: string;
  startPage: number;
  endPage: number;
}

/** The chapter a page falls in (first match in reading order), cleaned for
 *  embedding in a stored one-line provenance string. Chapter names are
 *  UNTRUSTED (PDF headings, model renames) — strip the structural
 *  characters that could break out of the bracketed [Attached image …]
 *  note chat builds around this text (quotes, brackets, braces, backticks,
 *  backslashes), collapse whitespace, and cap tight enough that provenance
 *  survives the note's 120-char sanitizeInline budget. */
export function chapterForPage(chapters: ChapterRange[] | undefined, page: number): string | null {
  if (!chapters) return null;
  const ch = chapters.find((c) => page >= c.startPage && page <= c.endPage);
  if (!ch?.name) return null;
  const clean = ch.name.replace(/["[\]{}`\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30);
  return clean.length > 0 ? clean : null;
}

const BATCH_SIZE = 4;

let jobs: Record<string, FigureJob> = {};
const listeners = new Set<() => void>();
const queue: JobInput[] = [];
let running = false;

const emit = () => listeners.forEach((l) => l());

const patch = (bookId: string, p: Partial<FigureJob>) => {
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

interface DescribeResult {
  index: number;
  alt: string;
  caption: string;
  type: string;
  concept_id: string | null;
  keep: boolean;
}

class DescribeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function invokeDescribe(body: unknown): Promise<{ results: DescribeResult[]; model_used: string }> {
  const { data, error } = await supabase.functions.invoke("describe-figures", { body });
  if (error) {
    let msg = error.message || "Figure description failed";
    let status = 0;
    const resp = (error as any)?.context;
    if (resp && typeof resp.json === "function") {
      status = resp.status || 0;
      try {
        const j = await resp.json();
        if (j?.error) msg = j.error;
      } catch { /* body already consumed or not JSON */ }
    }
    throw new DescribeError(msg, status);
  }
  if ((data as any)?.error) throw new DescribeError((data as any).error, 0);
  return data as { results: DescribeResult[]; model_used: string };
}

async function describeBatchWithRetry(body: unknown): Promise<{ results: DescribeResult[]; model_used: string }> {
  let lastErr: DescribeError | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await invokeDescribe(body);
    } catch (e) {
      const err = e instanceof DescribeError ? e : new DescribeError((e as Error)?.message || "failed", 0);
      // Key/credit/plan problems affect every batch — abort the whole job.
      if (err.status === 401 || err.status === 402) throw err;
      // A 400 is the edge function's own validation rejecting this payload —
      // deterministic, so re-uploading the identical multi-MB batch (up to 4
      // × 3.5M-char data URLs) two more times can only waste the uplink.
      if (err.status === 400) throw err;
      lastErr = err;
      if (attempt < 3) {
        // Free vision models allow ~20 req/min; back off harder on 429.
        await new Promise((r) => setTimeout(r, err.status === 429 ? 8000 : 1500));
      }
    }
  }
  throw lastErr!;
}

async function runJob(input: JobInput): Promise<void> {
  const { bookId, bookTitle } = input;

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in.");

  // 1. The book's neurons — OPTIONAL pairing candidates for the vision
  // model. Zero neurons is a normal state (digestion is gone; only chat
  // extraction writes source_book_id now): the job proceeds and figures
  // simply carry no neuron pairing, just book/page/chapter provenance.
  patch(bookId, { progress: "Checking this book's neurons…" });
  const { data: entries, error: entriesErr } = await supabase
    .from("knowledge_entries")
    .select("id, title")
    .eq("source_book_id", bookId)
    .limit(400);
  if (entriesErr) throw new Error(`Could not load neurons: ${entriesErr.message}`);
  const candidates = (entries || []).map((e: any) => ({ id: e.id as string, title: (e.title as string) || "" }));

  // 2. Extract candidates client-side (no AI spend yet).
  const { file, fileUrl } = await input.load();
  const extraction = await extractFiguresFromPdf({
    file,
    fileUrl,
    onProgress: (msg) => patch(bookId, { progress: msg }),
  });
  const figures = extraction.figures;
  if (extraction.droppedByCap > 0) {
    toast(`"${bookTitle}" has more figures than the per-book cap — keeping the first ${figures.length}, ${extraction.droppedByCap} further candidates were skipped.`, { id: `figcap-${bookId}` });
  }
  if (figures.length === 0) {
    patch(bookId, { status: "done", progress: "", kept: 0, skipped: 0 });
    return;
  }

  // 3. Replace figures from any previous run (re-extraction = clean slate).
  // The CHECK runs up front (it doubles as the figures-migration probe), but
  // the destructive delete is DEFERRED until the first kept figure is about
  // to land: a run whose every describe call fails — old server still
  // deployed, provider outage — must not have already destroyed the book's
  // existing figures on the way to its error card. Rows go first and every
  // step is error-checked: rows are the source of truth, so an interruption
  // may orphan storage objects (invisible) but can never leave rows pointing
  // at deleted objects.
  const { data: old, error: oldErr } = await (supabase.from("image_attachments" as any) as any)
    .select("id, storage_path")
    .eq("book_id", bookId)
    .eq("kind", "figure");
  if (oldErr) {
    if (/column|kind|book_id/i.test(oldErr.message || "")) {
      throw new Error("The figures database migration hasn't been applied yet — give the deploy a minute and try again.");
    }
    throw new Error(`Could not check existing figures: ${oldErr.message}`);
  }
  let replaced = false;
  const ensureOldReplaced = async (): Promise<void> => {
    if (replaced) return;
    replaced = true;
    if (!old || old.length === 0) return;
    patch(bookId, { progress: `Replacing ${old.length} previously extracted figures…` });
    const { error: delErr } = await (supabase.from("image_attachments" as any) as any)
      .delete()
      .eq("book_id", bookId)
      .eq("kind", "figure");
    if (delErr) throw new Error(`Could not replace the previous figures: ${delErr.message}`);
    try {
      await supabase.storage.from("generated-images").remove(old.map((r: any) => r.storage_path));
    } catch { /* best-effort cleanup — orphaned objects are harmless */ }
  };

  // 4 + 5. Describe in batches, then store kept figures as they come back.
  let kept = 0;
  let skipped = 0;
  let lastBatchError: DescribeError | null = null;
  const candidateIds = new Set(candidates.map((c) => c.id));

  for (let start = 0; start < figures.length; start += BATCH_SIZE) {
    const batch = figures.slice(start, start + BATCH_SIZE);
    patch(bookId, { progress: `Describing figures ${start + 1}–${Math.min(start + batch.length, figures.length)} of ${figures.length}…` });

    const payloadFigures = [];
    for (const f of batch) {
      payloadFigures.push({
        data_url: await blobToScaledJpegDataUrl(f.blob),
        page: f.page,
        context: f.context,
      });
    }

    let described: { results: DescribeResult[]; model_used: string };
    try {
      described = await describeBatchWithRetry({
        book_title: bookTitle,
        model: input.model || undefined,
        figures: payloadFigures,
        candidates,
      });
    } catch (e) {
      const err = e as DescribeError;
      if (err.status === 401 || err.status === 402) throw err; // fatal for the whole job
      // A still-deployed pre-rework server rejects candidate-less requests
      // outright — every batch would fail the same way, so name the real
      // cause instead of reporting it as a per-batch description failure.
      // Matched on the SERVER's message, not the client-side candidate
      // count: the old server filters empty ids/titles before counting, so
      // the two counts can disagree.
      if (/candidates required/i.test(err.message)) {
        throw new Error("The updated figure-extraction service hasn't been deployed yet — give the deploy a minute and try again.");
      }
      console.warn("[figureJobs] batch failed, skipping", err);
      lastBatchError = err;
      skipped += batch.length;
      continue;
    }

    const batchIds: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const fig: ExtractedFigure = batch[i];
      // The server normalizes indices to unique 0-based positions; never
      // fall back positionally — a mismatched index must not attach another
      // figure's caption and neuron pairing.
      const r = described.results.find((x) => x.index === i);
      if (!r || r.keep === false || r.type === "decorative" || !r.caption) {
        skipped += 1;
        continue;
      }
      const entryId = r.concept_id && candidateIds.has(r.concept_id) ? r.concept_id : null;
      // Provenance comes FIRST in the stored line: chat's attached-image
      // note renders this field through sanitizeInline(…, 120), so anything
      // past ~120 chars never reaches the model. Front-loading page, chapter,
      // and title (chapter ≤30, title ≤30 ⇒ provenance ≤ ~85 chars) means
      // truncation can only ever cost the alt's tail, never the provenance.
      const alt = (r.alt || "Figure").slice(0, 90);
      const chapterName = chapterForPage(input.chapters, fig.page);
      const path = `${uid}/figures/${bookId}/${crypto.randomUUID()}.jpg`;
      // Outside the per-figure try: a failed replace is a job error (the old
      // set's integrity is at stake), never a silent per-figure skip.
      await ensureOldReplaced();
      let uploaded = false;
      try {
        const { error: upErr } = await supabase.storage
          .from("generated-images")
          .upload(path, fig.blob, { contentType: "image/jpeg", upsert: false });
        if (upErr) throw upErr;
        uploaded = true;
        const { data: insRow, error: insErr } = await (supabase.from("image_attachments" as any) as any).insert({
          user_id: uid,
          entry_id: entryId,
          book_id: bookId,
          page: fig.page,
          phash: fig.phash,
          kind: "figure",
          // `prompt` is what chat retrieval quotes next to the neuron — make
          // it a self-describing line with provenance (page, chapter, book)
          // front-loaded; see the budget comment above.
          prompt: `Fig. p. ${fig.page}${chapterName ? ` (${chapterName})` : ""} of "${bookTitle.replace(/["[\]{}`\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30)}" — ${alt}`.slice(0, 300),
          caption: (r.caption || "").slice(0, 2000),
          model: described.model_used || input.model || "",
          storage_path: path,
          mime: "image/jpeg",
        }).select("id").single();
        if (insErr) throw insErr;
        if ((insRow as any)?.id) batchIds.push((insRow as any).id);
        kept += 1;
        patch(bookId, { progress: `Saved ${kept} figure${kept === 1 ? "" : "s"}…`, kept });
      } catch (e) {
        console.warn("[figureJobs] store failed for a figure", e);
        if (uploaded) {
          // Don't orphan the object when its row never landed.
          try { await supabase.storage.from("generated-images").remove([path]); } catch { /* best-effort */ }
        }
        skipped += 1;
      }
    }
    // Let any open image library refresh as figures land, batch by batch.
    if (batchIds.length > 0 && typeof window !== "undefined") {
      try { window.dispatchEvent(new CustomEvent("image-attachments-changed", { detail: { created: batchIds } })); } catch { /* noop */ }
    }
  }

  // Total description failure must not masquerade as "no figures found".
  if (kept === 0 && skipped > 0 && lastBatchError) {
    throw new Error(`Found ${figures.length} figures but none could be described: ${lastBatchError.message}`);
  }
  patch(bookId, { status: "done", progress: "", kept, skipped });
}

async function runNext() {
  if (running) return;
  const input = queue.shift();
  if (!input) return;
  running = true;
  patch(input.bookId, { status: "running", progress: "Starting…", error: undefined, kept: undefined, skipped: undefined });

  try {
    await runJob(input);
  } catch (e: any) {
    console.error("Figure extraction failed:", e);
    patch(input.bookId, {
      status: "error",
      progress: "",
      error: e?.message || "Figure extraction failed",
    });
  } finally {
    running = false;
    // Yield so the UI paints between jobs.
    setTimeout(runNext, 50);
  }
}

export const figureJobs = {
  enqueue(rawInput: JobInput) {
    // describe-figures runs server-side against OpenRouter / the Lovable
    // gateway — an "nvidia:" id would be forwarded verbatim and fail every
    // batch. Drop it so the server picks its own default. (Single choke
    // point: every caller passes through here.)
    // Positive check, not a per-provider denylist: only OpenRouter ids can
    // survive here, so a new provider can never leak through by omission.
    const input: JobInput = rawInput.model && modelProvider(rawInput.model) !== "openrouter"
      ? { ...rawInput, model: undefined }
      : rawInput;
    const existing = jobs[input.bookId];
    if (existing && (existing.status === "queued" || existing.status === "running")) return;
    if (queue.some((q) => q.bookId === input.bookId)) return;
    queue.push(input);
    patch(input.bookId, { status: "queued", progress: "Waiting…", error: undefined });
    runNext();
  },
  dismiss(bookId: string) {
    if (!(bookId in jobs)) return;
    const { [bookId]: _gone, ...rest } = jobs;
    jobs = rest;
    emit();
  },
  get(bookId: string): FigureJob | undefined {
    return jobs[bookId];
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getAll(): Record<string, FigureJob> {
    return jobs;
  },
};

const EMPTY: Record<string, FigureJob> = {};

export function useFigureJobs(): Record<string, FigureJob> {
  return useSyncExternalStore(
    figureJobs.subscribe,
    figureJobs.getAll,
    () => EMPTY,
  );
}
