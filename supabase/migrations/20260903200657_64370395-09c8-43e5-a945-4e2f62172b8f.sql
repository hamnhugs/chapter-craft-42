-- Deferred cleanup, part 1: the retired library-ingest settings.
-- Book digestion was removed end-to-end client-side (570e45f) and no shipped
-- code reads or writes these columns any more.
--
-- books.folder_id is deliberately NOT dropped here. The client still selects
-- it by name, so dropping it would fail the books query outright and render
-- an empty library. It comes out in part 2, after a bundle ships that stops
-- reading it.
ALTER TABLE public.user_settings
  DROP COLUMN IF EXISTS library_ingest_model,
  DROP COLUMN IF EXISTS library_ingest_auto_file,
  DROP COLUMN IF EXISTS auto_extract_figures;