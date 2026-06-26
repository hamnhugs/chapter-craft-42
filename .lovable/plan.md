## Goal
When you digest a folder (or a single book) into a neuron, the work should run on the server and survive any browser refresh, tab close, or network drop. The Vault should reattach to the in-flight jobs and show live progress when you come back.

## Why it breaks today
The "Digest folder" button in `LibraryCollections.tsx` loops in the browser, calling `ingestBook(...)` one book at a time and awaiting each response. Every step depends on the tab staying open:
- Refresh kills the loop, so remaining books never start.
- Even the *current* book's `knowledge-ingest` HTTP call is abandoned mid-flight (the function may finish, but you lose the result and the next book never fires).

The `ingest_jobs` table already exists but nothing writes to it.

## New architecture (industry-standard async job pattern)

```text
Browser ──POST──▶ enqueue-ingest ──(insert rows)──▶ ingest_jobs (queued)
                       │
                       └─ EdgeRuntime.waitUntil(runWorker())
                                              │
                                              ▼
                       ingest_jobs (running → done / error)
                                              │
                       Realtime ◀─────────────┘
                                              │
                       Vault UI (live progress, resumes on reload)

pg_cron every minute ──▶ ingest-resume ──▶ picks up stuck/queued jobs
```

### 1. Enqueue function (`enqueue-ingest`)
- Accepts `{ wiki_id, book_ids[] }` OR `{ wiki_id, folder_id }`.
- Verifies ownership, inserts one `ingest_jobs` row per book with `status='queued'`, model and folder_id captured.
- Returns `202` with the created job ids immediately.
- Fires `EdgeRuntime.waitUntil(processQueue(user_id))` so work starts without the client waiting.

### 2. Worker (shared module + `ingest-resume` function)
- Loops while there are `queued` jobs for the user:
  1. Atomically claim next job (`UPDATE ... SET status='running', updated_at=now() WHERE id=(SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`).
  2. Run the existing `knowledge-ingest` extraction logic against the book.
  3. On success: `status='done'`. On failure: `attempts++`, `status='error'` with `error` text; retry up to 3 attempts with backoff before giving up.
- Concurrency cap: 1 running job per user (prevents AI rate-limit thrash).
- `EdgeRuntime.waitUntil` keeps the process alive after the HTTP response is sent.

### 3. Cron resume (`pg_cron` → `ingest-resume`)
- Every minute: find jobs where `status='queued'` OR (`status='running'` AND `updated_at < now()-interval '5 minutes'`), reset stuck ones to `queued`, then trigger the worker per affected user.
- Guarantees that even if every edge instance was killed mid-run, the next minute picks the work back up — true "fire and forget".

### 4. Refactor `knowledge-ingest`
- Keep the extraction logic; expose it as a shared helper so both the synchronous endpoint (used by single-shot AI tool calls) and the worker call the same code.
- The endpoint stays for backward compatibility but the client switches to the queue.

### 5. Client changes
- `src/lib/knowledgeApi.ts`: new `enqueueIngestJobs({ wikiId, bookIds })` + `listIngestJobs({ wikiId })`.
- `src/components/LibraryCollections.tsx`: "Digest folder" button now calls `enqueueIngestJobs` once and immediately shows the queue — no in-browser loop.
- `src/components/WikiPanel.tsx`: single-book "Ingest" button switches to the queue too.
- New `useIngestJobs(wikiId)` hook: initial `SELECT` of unfinished jobs + Realtime `postgres_changes` subscription on `public.ingest_jobs` for the user. Renders per-book progress chips (Queued / Running / Done / Error + Retry) inside the Library + Folder views.
- On mount the Vault automatically shows any in-flight jobs from prior sessions — that is the "survives refresh" behavior.

### 6. Database / infra
- Migration:
  - Add `progress text`, `book_count int`, `started_at timestamptz`, `finished_at timestamptz` to `ingest_jobs` for richer UI status.
  - Ensure RLS policies allow the owner to `select` their jobs (already in place — verify).
  - `ALTER PUBLICATION supabase_realtime ADD TABLE public.ingest_jobs;` for live updates.
  - Index on `(user_id, status, created_at)` for the worker claim query.
- Enable `pg_cron` + `pg_net`, schedule the 1-minute resume call via `supabase--insert` (per platform rules — not a migration, since it contains the project URL + anon key).
- `supabase/config.toml`: register `enqueue-ingest` and `ingest-resume` with `verify_jwt = false` (consistent with existing knowledge-* functions; auth still checked in code via the JWT).

### 7. UX polish
- Folder card shows `3 / 12 digested · 1 running · 8 queued` with a progress bar.
- Toast on enqueue: "Digestion started — safe to close this tab."
- Retry button on errored jobs (resets `status='queued'`).
- Clear-completed button to prune `done` rows older than 24h.

## Files touched
- New: `supabase/functions/_shared/ingest-runner.ts`, `supabase/functions/enqueue-ingest/index.ts`, `supabase/functions/ingest-resume/index.ts`, `src/hooks/useIngestJobs.ts`, `src/components/IngestJobsBadge.tsx`.
- Edit: `supabase/functions/knowledge-ingest/index.ts` (extract shared runner), `supabase/config.toml`, `src/lib/knowledgeApi.ts`, `src/components/LibraryCollections.tsx`, `src/components/Library.tsx`, `src/components/WikiPanel.tsx`.
- Migration: schema additions, realtime publication, index.
- `supabase--insert`: schedule `pg_cron` job.

## What you'll see after this
1. Click "Digest folder" → instant toast, progress chips appear, you can close the tab.
2. Reopen Vault later → same chips reappear with current status from the server.
3. If the AI fails on book 4 of 12, books 5-12 still complete; book 4 shows a Retry button.
