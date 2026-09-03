-- Deferred cleanup, part 2: the single-shelf mirror.
-- book_shelf_members has been the only membership store since
-- 20260821120000, and as of the currently deployed bundle no client path
-- reads or writes books.folder_id. The column is now dead weight and its
-- FK to book_folders is the last thing keeping a retired model alive.
ALTER TABLE public.books DROP COLUMN IF EXISTS folder_id;