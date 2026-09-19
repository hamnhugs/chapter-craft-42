-- Card Catalog: the book-level summary node.
--
-- chapters.gist (20260828120000) gave the catalog a leaf layer — one line per
-- chapter. Nothing sits above it, so the tree is one level deep: the model
-- routing a question across a loaded shelf has chapter lines and book TITLES
-- and nothing in between. This adds the node that answers "what is this book
-- about" without reading its chapter list, which is also the level a shelf
-- card can actually show.
--
-- Generated client-side with the user's own chat model, the same seam
-- chapterGists.ts uses — no edge function, so the only server dependency is
-- these three columns.
--
-- Nullable and additive on purpose: every client path feature-detects
-- (42703/PGRST204) and degrades to a summary-less catalog until this is
-- applied, exactly as the gist column does. Idempotent, safe to re-run.
--
-- Apply via a Lovable-chat prompt or the Supabase SQL editor — git push does
-- not run migrations.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS summary       text,
  ADD COLUMN IF NOT EXISTS summary_model text,
  ADD COLUMN IF NOT EXISTS summarized_at timestamptz;

COMMENT ON COLUMN public.books.summary IS
  'Model-authored book-level summary (Card Catalog), rolled up from chapter gists where they exist. Untrusted text: stored raw, sanitized at every read door, same contract as chapters.gist. NULL = not yet generated.';
COMMENT ON COLUMN public.books.summary_model IS
  'Model id that authored `summary`. Shown in the UI so a summary is never presented as unattributed book metadata, and lets a stale-model regeneration be targeted.';
COMMENT ON COLUMN public.books.summarized_at IS
  'When `summary` was written. Compared against the book''s chapter set so a summary generated before chapters were re-detected can be flagged as stale.';

-- No new RLS policy: the existing books policies scope every operation by
-- user_id, and these are columns on that same row.
--
-- No index: `summary` is never a filter predicate server-side. Vault search
-- over summaries runs client-side against already-loaded rows (the library is
-- in memory), matching how title/category/tag search already works.

-- ── Auto-catalog at ingest ─────────────────────────────────────────────────
-- Catalog generation is manual today and buried in the chat picker, which is
-- why so many books carry no gists at all. This opts a user into running it
-- automatically when an upload finishes chapterizing.
--
-- DEFAULT FALSE deliberately: the run spends the user's own model key, and
-- nothing should start spending it without them saying so. The Settings
-- toggle is the opt-in.
--
-- The client's settings save carries an optional-column cascade, and
-- auto_catalog_on_upload is registered in it, so a bundle that ships before
-- this migration lands strips the column and saves the rest rather than
-- failing the whole row.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS auto_catalog_on_upload boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_settings.auto_catalog_on_upload IS
  'When true, a finished upload automatically generates chapter gists and a book summary using the user''s own model key. Off by default — it spends their key.';

-- ── Shelf digests ──────────────────────────────────────────────────────────
-- The catalog's third level: book gists roll up from chapter gists, and a
-- shelf digest rolls up from its books' summaries. A shelf card can currently
-- show a name, a count and three cover thumbnails — nothing about what the
-- shelf is FOR, which is the one thing its owner named it for.
--
-- Same contract as books.summary: nullable, additive, feature-detected on the
-- client (42703/PGRST204), model-authored text stored raw and sanitized at
-- every read door.

ALTER TABLE public.book_folders
  ADD COLUMN IF NOT EXISTS summary       text,
  ADD COLUMN IF NOT EXISTS summary_model text,
  ADD COLUMN IF NOT EXISTS summarized_at timestamptz;

COMMENT ON COLUMN public.book_folders.summary IS
  'Model-authored shelf digest, rolled up from member books'' summaries. Untrusted text: stored raw, sanitized at every read door. NULL = not yet generated.';
COMMENT ON COLUMN public.book_folders.summary_model IS
  'Model id that authored the shelf digest, so it is never shown as unattributed metadata.';
COMMENT ON COLUMN public.book_folders.summarized_at IS
  'When the digest was written. A shelf whose membership changed since is stale by comparison.';

-- No new RLS policy: existing book_folders policies scope by user_id, and
-- these are columns on that same row.
