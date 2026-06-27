# Single-doc digest on folder assignment

When you move an unassigned (or any) document into a folder in the Vault tab, a confirm dialog will appear asking whether to digest just that one document into the folder's neuron. The folder remembers the neuron it was last digested into, so the prompt always offers the correct target — even if the active neuron in the Wiki tab has since changed.

## What changes for you

- Assigning a document to a folder pops a clean confirm dialog:
  - **"Digest 'Document Title' into 'Neuron Name' now?"** with **Digest** / **Skip** buttons.
- The neuron shown is the one this folder has been digested into before. If the folder has never been digested, it falls back to the currently active neuron and the dialog says so.
- Clicking **Digest** queues a single durable job on the server (same pipeline as the bulk "Digest folder" button) — safe to refresh or close the tab, progress shows in the live queue strip.
- Clicking **Skip** just moves the document, no prompt nagging afterward.
- No prompt appears when *removing* a document from a folder (assigning to Unassigned).

## How it works

1. **Folder remembers its neuron.** Add `default_wiki_id` to `book_folders`. Set it the first time a folder is digested (bulk or single-doc); update it whenever the user digests that folder into a different neuron.
2. **Assignment hook.** `LibraryCollections.assignBook` becomes a two-step flow: move the book, then open a dialog if the target folder is not null. Dialog uses shadcn `AlertDialog` for accessibility.
3. **Resolve target neuron.** Prefer `folder.default_wiki_id`; fall back to `activeWikiId`; if neither exists, the dialog shows a soft warning and a "Pick a neuron in the Wiki tab" hint with only a Close button.
4. **Queue one job.** On confirm, call existing `enqueueIngestJobs([{ book_id, wiki_id, folder_id, model }])` — reuses the durable server runner, realtime progress, retries, and dedupe already in place. No new edge function needed.
5. **Idempotency / no double-digest.** Server runner already skips books that are currently queued or running for the same `(book_id, wiki_id)`. If the book has already been fully digested into that neuron, the runner short-circuits and the live strip shows "Already digested".
6. **Bulk path stays intact.** "Digest folder into neuron" button is unchanged; it just also writes `default_wiki_id` on the folder when it runs.

## Technical notes

- **DB migration:** `ALTER TABLE public.book_folders ADD COLUMN default_wiki_id uuid REFERENCES public.wikis(id) ON DELETE SET NULL;` (nullable, no backfill — folders start blank and learn on first digest).
- **Files touched:**
  - `supabase/migrations/<new>.sql` — column add.
  - `src/lib/bookFolders.ts` — extend `BookFolder` type with `default_wiki_id`; add `setFolderDefaultWiki(id, wikiId)` helper.
  - `src/components/LibraryCollections.tsx` — refactor `assignBook` to open a confirm dialog (shadcn `AlertDialog`), wire `enqueueIngestJobs` for the single book, update `handleDigest` (bulk) to also persist `default_wiki_id`.
  - Resolve neuron name for the dialog via existing `wikisApi` (cached list already loaded elsewhere; lightweight fetch if not in scope).
- **Permissions / safety:** uses the same RLS-scoped queue table and runner; no new policies needed. Skip prompt entirely for assignments to `null` (Unassigned).
- **UX details:** dialog auto-focuses **Digest**; pressing Esc = Skip; toast on success ("Queued 'Title' for digestion") and on skip is silent.
