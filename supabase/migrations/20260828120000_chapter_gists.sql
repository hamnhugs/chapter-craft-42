-- Card Catalog Stage 1: one-line chapter summaries ("gists").
--
-- The catalog book-context mode sends chapter maps + gists instead of full
-- text; gists are generated client-side with the user's own chat model and
-- stored here. Nullable and additive on purpose: every client path
-- feature-detects the column (42703/PGRST204) and degrades to a gistless
-- catalog until this is applied. Chapter TEXT stays immutable per id — the
-- gist is derived metadata about it, never a replacement for it.
--
-- Apply via a Lovable-chat prompt or the Supabase SQL editor (git push does
-- not run migrations).

ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS gist text;

COMMENT ON COLUMN public.chapters.gist IS
  'One-line chapter summary (~<=240 chars), model-generated client-side with the user''s key. Untrusted text: prompt/tool doors sanitize it on read. NULL = not yet generated.';
