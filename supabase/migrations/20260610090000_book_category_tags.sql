-- Library mind map: every book gets one category (fixed taxonomy, single
-- select) and a few free-form tags. Shared categories/tags become the hub
-- nodes of the 3D graph view, and both feed library search.
ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
