ALTER TABLE public.book_folders
  ADD COLUMN IF NOT EXISTS default_wiki_id uuid REFERENCES public.wikis(id) ON DELETE SET NULL;