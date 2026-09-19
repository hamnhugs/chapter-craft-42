ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS books_user_deleted_idx
  ON public.books (user_id, deleted_at);

COMMENT ON COLUMN public.books.deleted_at IS
  'NULL = live. Set when the user (or the assistant, at the user''s request) moves the book to the Trash; cleared on restore. Clients purge rows older than 30 days. Nothing else about the book changes on trash.';
