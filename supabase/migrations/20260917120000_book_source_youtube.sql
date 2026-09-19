-- Book provenance: YouTube transcripts.
--
-- Books the "From YouTube" importer (video-to-pdf) saves are machine
-- transcriptions of a video, not documents the user uploaded, and every read
-- door must say so. They get their own provenance value, set by the edge
-- function at insert; the video's URL, channel and length ride in
-- source_context ({"kind":"youtube","video_url",...}).
--
-- Existing books are left as they are. Self-sufficient if the provenance
-- migration (20260903120000) was never applied, idempotent, and NOT VALID so
-- no existing row is scanned. Until it's applied, video-to-pdf falls back to
-- the reserved tag `source:youtube` (bookProvenance.ts).
--
-- Apply via a Lovable-chat prompt or the Supabase SQL editor — git push does
-- not run migrations.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS source_model   text,
  ADD COLUMN IF NOT EXISTS source_context jsonb;

ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_source_known;
ALTER TABLE public.books
  ADD CONSTRAINT books_source_known CHECK (source IN ('user', 'assistant', 'youtube')) NOT VALID;

COMMENT ON COLUMN public.books.source IS
  '''user'' = uploaded by the user (the primary tier); ''assistant'' = written by the in-app assistant at the user''s request (a derived tier); ''youtube'' = an automatic transcript of a YouTube video saved by the From YouTube importer (labelled at every read door; video details in source_context). Set by the app at insert; not model-writable.';
