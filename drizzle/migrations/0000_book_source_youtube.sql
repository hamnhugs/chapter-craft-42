ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS source_model   text,
  ADD COLUMN IF NOT EXISTS source_context jsonb;

ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_source_known;
ALTER TABLE public.books
  ADD CONSTRAINT books_source_known CHECK (source IN ('user', 'assistant', 'youtube')) NOT VALID;

COMMENT ON COLUMN public.books.source IS
  '''user'' = uploaded by the user (the primary tier); ''assistant'' = written by the in-app assistant at the user''s request (a derived tier); ''youtube'' = an automatic transcript of a YouTube video saved by the From YouTube importer (labelled at every read door; video details in source_context). Set by the app at insert; not model-writable.';