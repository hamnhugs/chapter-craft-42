-- Book figure extraction: figures pulled out of uploaded documents ride the
-- existing image_attachments rails (private generated-images bucket, entry_id
-- link to knowledge_entries, WikiPanel "Attached Images", chat show_image).
-- New columns distinguish extracted figures from AI-generated images and give
-- them page provenance + a perceptual hash for dedup across re-extractions.

ALTER TABLE public.image_attachments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generated',
  ADD COLUMN IF NOT EXISTS book_id UUID REFERENCES public.books(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS page INTEGER,
  ADD COLUMN IF NOT EXISTS phash TEXT;

CREATE INDEX IF NOT EXISTS idx_image_attachments_book
  ON public.image_attachments(book_id) WHERE book_id IS NOT NULL;

-- Per-user figure-extraction preferences.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS image_extraction_model TEXT,
  ADD COLUMN IF NOT EXISTS auto_extract_figures BOOLEAN NOT NULL DEFAULT TRUE;
