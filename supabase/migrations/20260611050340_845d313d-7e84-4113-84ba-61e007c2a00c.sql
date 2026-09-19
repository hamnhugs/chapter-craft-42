ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';