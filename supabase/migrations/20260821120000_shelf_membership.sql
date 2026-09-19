-- Non-exclusive shelf membership + ingest machinery cleanup.
--
-- MEMBERSHIP. Shelves (book_folders) stop being exclusive: book_shelf_members
-- is a plain (folder_id, book_id) junction, so one book can sit on "Sci-fi"
-- and "Thesis research" at once — the flat checkbox-collection model every
-- mass-market reading app converged on, and what chat context groups need.
-- The backfill copies every existing books.folder_id assignment, so no
-- membership is lost the moment the client switches to junction reads.
--
-- books.folder_id is NOT dropped here. The client keeps it as a best-effort
-- single-shelf mirror (first membership wins) because stale cached bundles
-- still read and write it; it goes in a later migration once bundles have
-- cycled. Same deferral for user_settings.library_ingest_model /
-- library_ingest_auto_file / auto_extract_figures — the old bundle's settings
-- save writes those columns by name and its optionalColumns self-heal list
-- does not cover library_ingest_*, so dropping them now would break every
-- settings save for stale clients.
--
-- CLEANUP. Book digestion was removed end-to-end client-side (commit 570e45f)
-- and both edge functions are undeployed (probed 404), so the queue table,
-- its two service-role RPCs, and its realtime publication entry go now.
-- book_folders' dormant columns (parent_id / color / default_wiki_id) have no
-- reader or writer in any shipped bundle — the client has always selected and
-- written explicit columns around them.
--
-- Idempotent: safe to re-run. Apply via Lovable chat prompt.

-- 1. The junction
CREATE TABLE IF NOT EXISTS public.book_shelf_members (
  folder_id  uuid NOT NULL REFERENCES public.book_folders(id) ON DELETE CASCADE,
  book_id    uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, book_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.book_shelf_members TO authenticated;
GRANT ALL ON public.book_shelf_members TO service_role;
ALTER TABLE public.book_shelf_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own shelf memberships" ON public.book_shelf_members;
CREATE POLICY "Users can view own shelf memberships"
ON public.book_shelf_members FOR SELECT USING (auth.uid() = user_id);

-- INSERT also proves the referenced shelf and book belong to the caller, so a
-- row can never attach one user's book to another user's shelf (the FKs alone
-- would allow that cross-tenant pollution).
DROP POLICY IF EXISTS "Users can add own shelf memberships" ON public.book_shelf_members;
CREATE POLICY "Users can add own shelf memberships"
ON public.book_shelf_members FOR INSERT WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.book_folders f WHERE f.id = folder_id AND f.user_id = auth.uid())
  AND EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_id AND b.user_id = auth.uid())
);

-- UPDATE's WITH CHECK carries the same ownership proofs as INSERT: PK columns
-- are updatable in Postgres and FKs don't respect RLS, so without them a user
-- could re-point their own row's folder_id/book_id at another user's shelf
-- or book. (The app never UPDATEs these rows — adds use ON CONFLICT DO
-- NOTHING — but the policy must not be the gap.)
DROP POLICY IF EXISTS "Users can update own shelf memberships" ON public.book_shelf_members;
CREATE POLICY "Users can update own shelf memberships"
ON public.book_shelf_members FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.book_folders f WHERE f.id = folder_id AND f.user_id = auth.uid())
  AND EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_id AND b.user_id = auth.uid())
);

DROP POLICY IF EXISTS "Users can remove own shelf memberships" ON public.book_shelf_members;
CREATE POLICY "Users can remove own shelf memberships"
ON public.book_shelf_members FOR DELETE USING (auth.uid() = user_id);

-- PK covers per-shelf lookups; these cover the client's per-user full read
-- and the FK cascade from books deletes.
CREATE INDEX IF NOT EXISTS book_shelf_members_user_book_idx
  ON public.book_shelf_members(user_id, book_id);
CREATE INDEX IF NOT EXISTS book_shelf_members_book_idx
  ON public.book_shelf_members(book_id);

-- 2. Backfill from the exclusive column (idempotent via the PK)
INSERT INTO public.book_shelf_members (folder_id, book_id, user_id)
SELECT b.folder_id, b.id, b.user_id
FROM public.books b
WHERE b.folder_id IS NOT NULL
ON CONFLICT (folder_id, book_id) DO NOTHING;

COMMENT ON TABLE public.book_shelf_members IS
  'Non-exclusive shelf membership (shelves are book_folders rows). books.folder_id survives as a client-maintained single-shelf mirror for stale bundles until a later migration drops it.';

-- 3. Ingest machinery teardown (client references removed in 570e45f,
--    edge functions undeployed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ingest_jobs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.ingest_jobs';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.claim_next_ingest_job(uuid);
DROP FUNCTION IF EXISTS public.requeue_stuck_ingest_jobs();
DROP TABLE IF EXISTS public.ingest_jobs;

-- 4. book_folders dormant columns (never read or written by any bundle)
ALTER TABLE public.book_folders
  DROP COLUMN IF EXISTS default_wiki_id,
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS parent_id;

-- Deferred to a later migration (see header): books.folder_id,
-- user_settings.library_ingest_model / library_ingest_auto_file /
-- auto_extract_figures.
