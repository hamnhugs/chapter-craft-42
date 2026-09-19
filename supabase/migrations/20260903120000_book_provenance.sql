-- Book provenance: who wrote this book, and from what.
--
-- The assistant can now write a document into the library as an ordinary book
-- (save_to_library, docs/library-agent.md §2.4). Text the assistant wrote and
-- later retrieves is a different tier from the user's own sources — the
-- research is unambiguous and structural: neural retrievers rank LLM-written
-- text above equally relevant human text (Dai et al., KDD 2024), one
-- write-back per topic lets generated text take most top slots (Chen et al.,
-- ACL 2024), and a model prefers its own prose even when only the retrieved
-- passage is correct (Tan et al., ACL 2024). Provenance therefore has to be a
-- hard-typed column set by the APP at insert time — never a tag the model can
-- write, never a tag Auto-tag can replace (updateBookTags rewrites the whole
-- tags array), and never recovered later (it cannot be).
--
-- Nullable-free but defaulted, so every existing row is 'user' and no client
-- needs to change to keep working. Additive and idempotent; every client path
-- feature-detects (42703/PGRST204) and degrades to the reserved-tag fallback
-- until this is applied — same contract as books.summary (20260902120000).
--
-- Apply via a Lovable-chat prompt or the Supabase SQL editor — git push does
-- not run migrations.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS source_model   text,
  ADD COLUMN IF NOT EXISTS source_context jsonb;

-- Guarded so a re-run is a no-op; NOT VALID so existing rows are not scanned
-- (they all carry the default and satisfy it anyway).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'books_source_known'
  ) THEN
    ALTER TABLE public.books
      ADD CONSTRAINT books_source_known CHECK (source IN ('user', 'assistant')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.books.source IS
  '''user'' = uploaded by the user (the primary tier); ''assistant'' = written by the in-app assistant at the user''s request (a derived tier: labelled at every read door, never the default retrieval pool unless loaded, never merged into a primary book). Set by the app at insert; not model-writable.';
COMMENT ON COLUMN public.books.source_model IS
  'Model id that authored an assistant-written book, so the derivation label is never anonymous.';
COMMENT ON COLUMN public.books.source_context IS
  'For assistant-written books: {"book_ids":[...],"shelf_id":...} — what was LOADED in the conversation when it was written, computed by the app (never supplied by the model). Lets a later reader see what a derived book derives from.';

-- No new RLS policy: the existing books policies scope every operation by
-- user_id, and these are columns on that same row.
