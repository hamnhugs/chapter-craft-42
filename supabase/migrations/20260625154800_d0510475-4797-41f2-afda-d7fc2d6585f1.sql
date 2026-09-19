
-- image_memories table
CREATE TABLE public.image_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wiki_id uuid REFERENCES public.wikis(id) ON DELETE SET NULL,
  storage_path text NOT NULL,
  caption text,
  ocr_text text,
  tags text[] DEFAULT '{}',
  source text NOT NULL DEFAULT 'upload',
  source_message_id text,
  mime_type text,
  width int,
  height int,
  embedding_v2 extensions.halfvec(3072),
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(caption,'') || ' ' || coalesce(ocr_text,''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.image_memories TO authenticated;
GRANT ALL ON public.image_memories TO service_role;

ALTER TABLE public.image_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own image memories"
  ON public.image_memories FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX image_memories_user_wiki_idx ON public.image_memories(user_id, wiki_id, created_at DESC);
CREATE INDEX image_memories_tsv_idx ON public.image_memories USING gin(tsv);
CREATE INDEX image_memories_embedding_idx
  ON public.image_memories USING hnsw (embedding_v2 extensions.halfvec_cosine_ops);

CREATE TRIGGER image_memories_updated_at
  BEFORE UPDATE ON public.image_memories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- user_settings new columns
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS vision_model text,
  ADD COLUMN IF NOT EXISTS image_safety_check boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS trust_image_text boolean NOT NULL DEFAULT false;

-- Hybrid search for image memories
CREATE OR REPLACE FUNCTION public.match_image_memories(
  query_embedding extensions.halfvec,
  match_threshold double precision,
  match_count integer,
  filter_wiki_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid, wiki_id uuid, storage_path text, caption text, ocr_text text,
  tags text[], source text, mime_type text, created_at timestamptz, similarity double precision
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  SELECT i.id, i.wiki_id, i.storage_path, i.caption, i.ocr_text,
         i.tags, i.source, i.mime_type, i.created_at,
         (1 - (i.embedding_v2 <=> query_embedding))::float AS similarity
  FROM public.image_memories i
  WHERE i.user_id = auth.uid()
    AND i.embedding_v2 IS NOT NULL
    AND (filter_wiki_id IS NULL OR i.wiki_id = filter_wiki_id)
    AND (1 - (i.embedding_v2 <=> query_embedding)) >= match_threshold
  ORDER BY i.embedding_v2 <=> query_embedding ASC
  LIMIT LEAST(match_count, 50);
$$;
