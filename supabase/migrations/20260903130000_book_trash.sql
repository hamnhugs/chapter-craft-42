-- Book Trash: a delete you can take back.
--
-- Every delete of a book was hard — PDF, figures and row gone in one click,
-- with no confirmation in the Vault's list view — and the assistant's
-- delete_book had to carry a title-bound two-step only because there was
-- nothing to undo into. The evidence (docs/library-agent-research.md §2, §4)
-- says a reversible action beats a confirmation: this column makes "delete"
-- a move to the Trash, restorable for 30 days.
--
-- NULL = live. Chapters, shelf memberships, figures, storage objects and card
-- locators are NOT touched by a trash, so a restored book comes back exactly
-- as it was. Purge (the old hard delete) still cascades everything.
--
-- Additive and idempotent; every client path feature-detects (42703) and
-- falls back to the hard delete — saying so — until this is applied. Apply
-- via a Lovable-chat prompt or the Supabase SQL editor; git push does not run
-- migrations.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS books_user_deleted_idx
  ON public.books (user_id, deleted_at);

COMMENT ON COLUMN public.books.deleted_at IS
  'NULL = live. Set when the user (or the assistant, at the user''s request) moves the book to the Trash; cleared on restore. Clients purge rows older than 30 days. Nothing else about the book changes on trash.';

-- No new RLS policy: the existing books policies scope every operation by
-- user_id, and this is a column on that same row.
