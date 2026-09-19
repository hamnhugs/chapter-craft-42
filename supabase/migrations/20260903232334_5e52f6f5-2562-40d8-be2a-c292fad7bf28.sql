-- Book provenance: who wrote this book, and from what.
ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS source_model   text,
  ADD COLUMN IF NOT EXISTS source_context jsonb;

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