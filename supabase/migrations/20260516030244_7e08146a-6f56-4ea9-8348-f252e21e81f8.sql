
-- ==========================================================
-- PHASE 1 — Knowledge graph foundation
-- ==========================================================

-- 1. pgvector
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 2. knowledge_entries: embedding + tsv + atomicity warning
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS atomicity_warning text,
  ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
    ) STORED;

CREATE INDEX IF NOT EXISTS knowledge_entries_embedding_idx
  ON public.knowledge_entries
  USING hnsw (embedding extensions.vector_cosine_ops);

CREATE INDEX IF NOT EXISTS knowledge_entries_tsv_idx
  ON public.knowledge_entries USING GIN (tsv);

CREATE INDEX IF NOT EXISTS knowledge_entries_user_idx
  ON public.knowledge_entries (user_id);

-- 3. Atomicity validation trigger (soft + hard limits)
CREATE OR REPLACE FUNCTION public.validate_knowledge_entry_atomicity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  heading_count int;
  len int;
BEGIN
  len := coalesce(length(NEW.content), 0);

  -- Hard ceiling: refuse anything truly bulky
  IF len > 8000 THEN
    RAISE EXCEPTION 'knowledge_entry content exceeds 8000 chars (got %); split into atomic entries.', len;
  END IF;

  -- Soft warning: >1500 chars or >1 top-level heading
  heading_count := (
    SELECT count(*) FROM regexp_matches(coalesce(NEW.content,''), '(^|\n)##\s', 'g')
  );

  IF len > 1500 OR heading_count > 1 THEN
    NEW.atomicity_warning :=
      'Entry may cover multiple claims (len=' || len ||
      ', headings=' || heading_count || '). Consider splitting.';
  ELSE
    NEW.atomicity_warning := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_knowledge_entry_atomicity_trg ON public.knowledge_entries;
CREATE TRIGGER validate_knowledge_entry_atomicity_trg
  BEFORE INSERT OR UPDATE OF content ON public.knowledge_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_knowledge_entry_atomicity();

-- 4. memory_graph: taxonomy + class + weight + provenance
ALTER TABLE public.memory_graph
  ADD COLUMN IF NOT EXISTS edge_class text,
  ADD COLUMN IF NOT EXISTS weight double precision NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'ingest';

-- Drop any existing check, add the canonical taxonomy
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'memory_graph_relationship_check'
  ) THEN
    ALTER TABLE public.memory_graph DROP CONSTRAINT memory_graph_relationship_check;
  END IF;
END $$;

ALTER TABLE public.memory_graph
  ADD CONSTRAINT memory_graph_relationship_check
  CHECK (relationship IN (
    'contradicts','refutes','supports','extends',
    'derived_from','prerequisite','relates_to','mentions'
  ));

-- Auto-classify edge_class from relationship
CREATE OR REPLACE FUNCTION public.set_memory_graph_edge_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.edge_class := CASE NEW.relationship
    WHEN 'contradicts'   THEN 'structural'
    WHEN 'refutes'       THEN 'structural'
    WHEN 'supports'      THEN 'structural'
    WHEN 'extends'       THEN 'structural'
    WHEN 'derived_from'  THEN 'structural'
    WHEN 'prerequisite'  THEN 'structural'
    WHEN 'relates_to'    THEN 'associative'
    WHEN 'mentions'      THEN 'associative'
    ELSE 'associative'
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_memory_graph_edge_class_trg ON public.memory_graph;
CREATE TRIGGER set_memory_graph_edge_class_trg
  BEFORE INSERT OR UPDATE OF relationship ON public.memory_graph
  FOR EACH ROW
  EXECUTE FUNCTION public.set_memory_graph_edge_class();

-- Backfill edge_class for existing rows
UPDATE public.memory_graph
SET edge_class = CASE relationship
  WHEN 'contradicts'   THEN 'structural'
  WHEN 'refutes'       THEN 'structural'
  WHEN 'supports'      THEN 'structural'
  WHEN 'extends'       THEN 'structural'
  WHEN 'derived_from'  THEN 'structural'
  WHEN 'prerequisite'  THEN 'structural'
  ELSE 'associative'
END
WHERE edge_class IS NULL;

-- Unique edges
CREATE UNIQUE INDEX IF NOT EXISTS memory_graph_unique_edge_idx
  ON public.memory_graph (source_entry_id, target_entry_id, relationship);

CREATE INDEX IF NOT EXISTS memory_graph_user_source_idx
  ON public.memory_graph (user_id, source_entry_id);
CREATE INDEX IF NOT EXISTS memory_graph_user_target_idx
  ON public.memory_graph (user_id, target_entry_id);

-- 5. knowledge_conflicts table
CREATE TABLE IF NOT EXISTS public.knowledge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_a uuid NOT NULL,
  entry_b uuid NOT NULL,
  kind text NOT NULL DEFAULT 'contradicts'
    CHECK (kind IN ('contradicts','refutes','supersedes','overlaps')),
  rationale text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_a, entry_b, kind)
);

ALTER TABLE public.knowledge_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own conflicts"
  ON public.knowledge_conflicts FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own conflicts"
  ON public.knowledge_conflicts FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own conflicts"
  ON public.knowledge_conflicts FOR UPDATE
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own conflicts"
  ON public.knowledge_conflicts FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER knowledge_conflicts_updated_at
  BEFORE UPDATE ON public.knowledge_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS knowledge_conflicts_user_status_idx
  ON public.knowledge_conflicts (user_id, status);

-- 6. RPC: semantic kNN
CREATE OR REPLACE FUNCTION public.match_knowledge(
  query_embedding extensions.vector(1536),
  match_count int DEFAULT 10,
  book_filter uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  entry_type text,
  tags text[],
  source_book_id uuid,
  similarity double precision
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id, k.title, k.content, k.entry_type, k.tags, k.source_book_id,
    1 - (k.embedding <=> query_embedding) AS similarity
  FROM public.knowledge_entries k
  WHERE k.user_id = auth.uid()
    AND k.embedding IS NOT NULL
    AND (book_filter IS NULL OR k.source_book_id = book_filter)
  ORDER BY k.embedding <=> query_embedding
  LIMIT greatest(1, match_count);
END;
$$;

-- 7. RPC: hybrid search (RRF)
CREATE OR REPLACE FUNCTION public.hybrid_search_knowledge(
  query_text text,
  query_embedding extensions.vector(1536),
  match_count int DEFAULT 10,
  full_text_weight double precision DEFAULT 1.0,
  semantic_weight double precision DEFAULT 1.0,
  rrf_k int DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  entry_type text,
  tags text[],
  source_book_id uuid,
  score double precision
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  RETURN QUERY
  WITH ft AS (
    SELECT k.id,
           row_number() OVER (ORDER BY ts_rank_cd(k.tsv, websearch_to_tsquery('english', query_text)) DESC) AS rank_ix
    FROM public.knowledge_entries k
    WHERE k.user_id = auth.uid()
      AND k.tsv @@ websearch_to_tsquery('english', query_text)
    ORDER BY rank_ix
    LIMIT least(match_count, 30) * 2
  ),
  sem AS (
    SELECT k.id,
           row_number() OVER (ORDER BY k.embedding <=> query_embedding) AS rank_ix
    FROM public.knowledge_entries k
    WHERE k.user_id = auth.uid()
      AND k.embedding IS NOT NULL
    ORDER BY rank_ix
    LIMIT least(match_count, 30) * 2
  )
  SELECT
    k.id, k.title, k.content, k.entry_type, k.tags, k.source_book_id,
    coalesce(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + sem.rank_ix), 0.0) * semantic_weight AS score
  FROM ft
    FULL OUTER JOIN sem ON ft.id = sem.id
    JOIN public.knowledge_entries k ON k.id = coalesce(ft.id, sem.id)
  WHERE k.user_id = auth.uid()
  ORDER BY score DESC
  LIMIT match_count;
END;
$$;

-- 8. RPC: bidirectional graph traversal
CREATE OR REPLACE FUNCTION public.get_neighbors(
  seed_ids uuid[],
  depth int DEFAULT 2,
  classes text[] DEFAULT ARRAY['structural','associative']
)
RETURNS TABLE (
  entry_id uuid,
  title text,
  content text,
  hop int,
  via_relationship text,
  via_edge_class text,
  from_seed uuid
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE walk AS (
    SELECT
      unnest(seed_ids) AS entry_id,
      0 AS hop,
      NULL::text AS via_relationship,
      NULL::text AS via_edge_class,
      unnest(seed_ids) AS from_seed
    UNION
    SELECT
      CASE WHEN g.source_entry_id = w.entry_id THEN g.target_entry_id ELSE g.source_entry_id END,
      w.hop + 1,
      g.relationship,
      g.edge_class,
      w.from_seed
    FROM walk w
    JOIN public.memory_graph g
      ON (g.source_entry_id = w.entry_id OR g.target_entry_id = w.entry_id)
    WHERE w.hop < depth
      AND g.user_id = auth.uid()
      AND g.edge_class = ANY(classes)
  )
  SELECT DISTINCT ON (w.entry_id)
    w.entry_id, k.title, k.content, w.hop, w.via_relationship, w.via_edge_class, w.from_seed
  FROM walk w
  JOIN public.knowledge_entries k
    ON k.id = w.entry_id AND k.user_id = auth.uid()
  ORDER BY w.entry_id, w.hop ASC;
END;
$$;

-- 9. RPC: direct contradiction lookup
CREATE OR REPLACE FUNCTION public.find_contradictions(entry_id uuid)
RETURNS TABLE (
  other_id uuid,
  other_title text,
  other_content text,
  relationship text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT k.id, k.title, k.content, g.relationship
  FROM public.memory_graph g
  JOIN public.knowledge_entries k
    ON k.id = CASE WHEN g.source_entry_id = entry_id THEN g.target_entry_id ELSE g.source_entry_id END
  WHERE g.user_id = auth.uid()
    AND k.user_id = auth.uid()
    AND g.relationship IN ('contradicts','refutes')
    AND (g.source_entry_id = entry_id OR g.target_entry_id = entry_id);
END;
$$;
