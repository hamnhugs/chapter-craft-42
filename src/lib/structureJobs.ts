import { useSyncExternalStore } from "react";
import { Chapter } from "@/types/library";
import { detectAndSaveStructure, SaveDeps, DetectResult } from "./bookStructure";

// Per-book structure-detection jobs. Module-level observable store (same
// pattern as workspaceStore) so Library cards can show live progress without
// any provider plumbing, plus a sequential queue so multiple uploads don't
// hammer pdfjs / the AI endpoint at once.

export type StructureJobStatus = "queued" | "running" | "done" | "error";

export interface StructureJob {
  bookId: string;
  status: StructureJobStatus;
  progress: string;
  savedCount?: number;
  method?: DetectResult["method"];
  error?: string;
  updatedAt: number;
}

interface JobInput {
  bookId: string;
  /** Lazily provides the PDF (fresh-upload File, or a storage URL). */
  load: () => Promise<{ file?: File | Blob; fileUrl?: string }>;
  apiKey?: string;
  model?: string;
  replaceChapters?: Chapter[];
  deps: SaveDeps;
}

let jobs: Record<string, StructureJob> = {};
const listeners = new Set<() => void>();
const queue: JobInput[] = [];
let running = false;

const emit = () => listeners.forEach((l) => l());

const patch = (bookId: string, p: Partial<StructureJob>) => {
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

async function runNext() {
  if (running) return;
  const input = queue.shift();
  if (!input) return;
  running = true;
  patch(input.bookId, { status: "running", progress: "Starting…", error: undefined });

  try {
    const { file, fileUrl } = await input.load();
    const result = await detectAndSaveStructure({
      bookId: input.bookId,
      file,
      fileUrl,
      apiKey: input.apiKey,
      model: input.model,
      replaceChapters: input.replaceChapters,
      deps: input.deps,
      onProgress: (msg) => patch(input.bookId, { progress: msg }),
    });
    patch(input.bookId, {
      status: "done",
      progress: "",
      savedCount: result.saved,
      method: result.method,
    });
  } catch (e: any) {
    console.error("Structure detection failed:", e);
    patch(input.bookId, {
      status: "error",
      progress: "",
      error: e?.message || "Detection failed",
    });
  } finally {
    running = false;
    // Yield so the UI paints between jobs.
    setTimeout(runNext, 50);
  }
}

export const structureJobs = {
  enqueue(input: JobInput) {
    const existing = jobs[input.bookId];
    if (existing && (existing.status === "queued" || existing.status === "running")) return;
    if (queue.some((q) => q.bookId === input.bookId)) return;
    queue.push(input);
    patch(input.bookId, { status: "queued", progress: "Waiting…", error: undefined, savedCount: undefined });
    runNext();
  },
  dismiss(bookId: string) {
    if (!(bookId in jobs)) return;
    const { [bookId]: _gone, ...rest } = jobs;
    jobs = rest;
    emit();
  },
  get(bookId: string): StructureJob | undefined {
    return jobs[bookId];
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getAll(): Record<string, StructureJob> {
    return jobs;
  },
};

const EMPTY: Record<string, StructureJob> = {};

export function useStructureJobs(): Record<string, StructureJob> {
  return useSyncExternalStore(
    structureJobs.subscribe,
    structureJobs.getAll,
    () => EMPTY,
  );
}
