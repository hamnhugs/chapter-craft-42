-- Wikis: named, isolated pockets of knowledge entries
CREATE TABLE public.wikis (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_color TEXT NOT NULL DEFAULT '#7C3AED',
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_meta BOOLEAN NOT NULL DEFAULT FALSE,
  last_loaded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.wikis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own wikis" ON public.wikis FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own wikis" ON public.wikis FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own wikis" ON public.wikis FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own wikis" ON public.wikis FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_wikis_user ON public.wikis(user_id);
CREATE INDEX idx_wikis_tags ON public.wikis USING GIN(tags);

CREATE TRIGGER update_wikis_updated_at
  BEFORE UPDATE ON public.wikis
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add wiki_id + linked_wiki_id to knowledge_entries
ALTER TABLE public.knowledge_entries
  ADD COLUMN wiki_id UUID REFERENCES public.wikis(id) ON DELETE CASCADE,
  ADD COLUMN linked_wiki_id UUID REFERENCES public.wikis(id) ON DELETE SET NULL;

CREATE INDEX idx_knowledge_entries_wiki ON public.knowledge_entries(wiki_id);
CREATE INDEX idx_knowledge_entries_linked_wiki ON public.knowledge_entries(linked_wiki_id);

-- Add active_wiki_id to user_settings
ALTER TABLE public.user_settings
  ADD COLUMN active_wiki_id UUID REFERENCES public.wikis(id) ON DELETE SET NULL;

-- Backfill: every existing user with knowledge entries gets a "My Wiki" default,
-- and all their orphan entries are reassigned to it.
DO $$
DECLARE
  rec RECORD;
  new_wiki_id UUID;
BEGIN
  FOR rec IN
    SELECT DISTINCT user_id FROM public.knowledge_entries WHERE wiki_id IS NULL
  LOOP
    INSERT INTO public.wikis (user_id, name, description, is_default)
    VALUES (rec.user_id, 'My Wiki', 'Your default wiki — all existing entries live here.', TRUE)
    RETURNING id INTO new_wiki_id;

    UPDATE public.knowledge_entries
      SET wiki_id = new_wiki_id
      WHERE user_id = rec.user_id AND wiki_id IS NULL;

    UPDATE public.user_settings
      SET active_wiki_id = new_wiki_id
      WHERE user_id = rec.user_id AND active_wiki_id IS NULL;
  END LOOP;
END $$;

-- =================================================================
-- Wiki advanced: side-by-side 1536-dim embedding for cross-wiki search.
-- Existing `embedding vector(768)` column is left intact for current retrieval.
-- New `embedding_v2 halfvec(1536)` powers the new search-knowledge function.
-- =================================================================
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

ALTER TABLE public.knowledge_entries
  ADD COLUMN embedding_v2 extensions.halfvec(1536);

CREATE INDEX idx_knowledge_entries_embedding_v2
  ON public.knowledge_entries
  USING hnsw (embedding_v2 extensions.halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Bridge entries: an entry can appear in multiple wikis
CREATE TABLE public.entry_bridges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_id UUID NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  wiki_id UUID NOT NULL REFERENCES public.wikis(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(entry_id, wiki_id)
);

ALTER TABLE public.entry_bridges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own bridges" ON public.entry_bridges FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own bridges" ON public.entry_bridges FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own bridges" ON public.entry_bridges FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_entry_bridges_user ON public.entry_bridges(user_id);
CREATE INDEX idx_entry_bridges_wiki ON public.entry_bridges(wiki_id);
CREATE INDEX idx_entry_bridges_entry ON public.entry_bridges(entry_id);

-- Cross-wiki semantic similarity using embedding_v2 (1536-dim halfvec)
CREATE OR REPLACE FUNCTION public.match_knowledge_entries (
  query_embedding extensions.halfvec(1536),
  match_threshold FLOAT,
  match_count INT,
  filter_wiki_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  wiki_id UUID,
  title TEXT,
  content TEXT,
  entry_type TEXT,
  tags TEXT[],
  confidence FLOAT,
  source_book_id UUID,
  similarity FLOAT
)
LANGUAGE SQL STABLE
SET search_path = public, extensions
AS $$
  SELECT
    e.id,
    e.wiki_id,
    e.title,
    e.content,
    e.entry_type,
    e.tags,
    e.confidence,
    e.source_book_id,
    (1 - (e.embedding_v2 <=> query_embedding))::float AS similarity
  FROM public.knowledge_entries e
  WHERE e.user_id = auth.uid()
    AND e.embedding_v2 IS NOT NULL
    AND (filter_wiki_ids IS NULL OR e.wiki_id = ANY(filter_wiki_ids))
    AND (1 - (e.embedding_v2 <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding_v2 <=> query_embedding ASC
  LIMIT LEAST(match_count, 100);
$$;

-- Resolve effective entries for a wiki: native + bridged-in
CREATE OR REPLACE FUNCTION public.entries_for_wiki (
  target_wiki_id UUID
)
RETURNS SETOF public.knowledge_entries
LANGUAGE SQL STABLE
SET search_path = public
AS $$
  SELECT e.*
    FROM public.knowledge_entries e
   WHERE e.user_id = auth.uid()
     AND (
       e.wiki_id = target_wiki_id
       OR EXISTS (
         SELECT 1 FROM public.entry_bridges b
          WHERE b.entry_id = e.id
            AND b.wiki_id = target_wiki_id
            AND b.user_id = auth.uid()
       )
     )
   ORDER BY e.updated_at DESC;
$$;