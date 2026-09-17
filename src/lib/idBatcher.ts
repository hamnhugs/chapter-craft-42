// Debounced id batcher: collects ids from many call sites and flushes them
// together once the burst goes quiet (or the batch fills up).
//
// Used by knowledgeApi.embedEntriesSoon so a chat turn that creates five cards
// costs ONE knowledge-embed call instead of five, and so an id written twice
// in a burst (create → attach locators → update) is embedded once, after the
// last write. Pure — the timer functions are injectable for tests.

export interface IdBatcher {
  /** Queue ids; blanks are ignored and duplicates coalesce. */
  add(ids: Iterable<string | null | undefined>): void;
  /** Flush immediately (e.g. page hide). */
  flush(): void;
  /** Ids waiting for the next flush (diagnostics/tests). */
  pending(): string[];
}

export interface IdBatcherOptions {
  /** Quiet period before a flush. Each add re-arms it, capped by maxWaitMs. */
  delayMs: number;
  /** Hard ceiling from the FIRST queued id, so a steady trickle still flushes. */
  maxWaitMs?: number;
  /** Flush synchronously as soon as this many ids are queued; also the chunk size per onFlush call. */
  maxBatch: number;
  onFlush: (ids: string[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export function createIdBatcher(opts: IdBatcherOptions): IdBatcher {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = opts.now ?? (() => Date.now());
  const maxWait = opts.maxWaitMs ?? opts.delayMs * 3;
  const queue = new Set<string>();
  let timer: unknown = null;
  let firstQueuedAt = 0;

  const flush = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (queue.size === 0) return;
    const ids = [...queue];
    queue.clear();
    for (let i = 0; i < ids.length; i += opts.maxBatch) {
      opts.onFlush(ids.slice(i, i + opts.maxBatch));
    }
  };

  return {
    add(ids) {
      let added = false;
      for (const raw of ids) {
        const id = typeof raw === "string" ? raw.trim() : "";
        if (!id) continue;
        if (queue.size === 0) firstQueuedAt = now();
        queue.add(id);
        added = true;
      }
      if (!added) return;
      if (queue.size >= opts.maxBatch) { flush(); return; }
      if (timer !== null) clearTimer(timer);
      const waited = now() - firstQueuedAt;
      timer = setTimer(flush, Math.max(0, Math.min(opts.delayMs, maxWait - waited)));
    },
    flush,
    pending: () => [...queue],
  };
}
