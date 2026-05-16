
DROP INDEX IF EXISTS public.knowledge_entries_embedding_idx;

ALTER TABLE public.knowledge_entries DROP COLUMN IF EXISTS embedding;
ALTER TABLE public.knowledge_entries ADD COLUMN embedding extensions.vector(768);

CREATE INDEX knowledge_entries_embedding_idx
  ON public.knowledge_entries
  USING hnsw (embedding extensions.vector_cosine_ops);

-- Recreate functions that referenced vector(1536)
DROP FUNCTION IF EXISTS public.match_knowledge(extensions.vector, int, uuid);
DROP FUNCTION IF EXISTS public.hybrid_search_knowledge(text, extensions.vector, int, double precision, double precision, int);

CREATE OR REPLACE FUNCTION public.match_knowledge(
  query_embedding extensions.vector(768),
  match_count int DEFAULT 10,
  book_filter uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid, title text, content text, entry_type text,
  tags text[], source_book_id uuid, similarity double precision
)
LANGUAGE plpgsql
STABLE SECURITY INVOKER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT k.id, k.title, k.content, k.entry_type, k.tags, k.source_book_id,
         1 - (k.embedding <=> query_embedding) AS similarity
  FROM public.knowledge_entries k
  WHERE k.user_id = auth.uid()
    AND k.embedding IS NOT NULL
    AND (book_filter IS NULL OR k.source_book_id = book_filter)
  ORDER BY k.embedding <=> query_embedding
  LIMIT greatest(1, match_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.hybrid_search_knowledge(
  query_text text,
  query_embedding extensions.vector(768),
  match_count int DEFAULT 10,
  full_text_weight double precision DEFAULT 1.0,
  semantic_weight double precision DEFAULT 1.0,
  rrf_k int DEFAULT 50
)
RETURNS TABLE (
  id uuid, title text, content text, entry_type text,
  tags text[], source_book_id uuid, score double precision
)
LANGUAGE plpgsql
STABLE SECURITY INVOKER
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
  SELECT k.id, k.title, k.content, k.entry_type, k.tags, k.source_book_id,
         coalesce(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
         coalesce(1.0 / (rrf_k + sem.rank_ix), 0.0) * semantic_weight AS score
  FROM ft FULL OUTER JOIN sem ON ft.id = sem.id
    JOIN public.knowledge_entries k ON k.id = coalesce(ft.id, sem.id)
  WHERE k.user_id = auth.uid()
  ORDER BY score DESC
  LIMIT match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_knowledge(extensions.vector, int, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_knowledge(text, extensions.vector, int, double precision, double precision, int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.match_knowledge(extensions.vector, int, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_knowledge(text, extensions.vector, int, double precision, double precision, int) TO authenticated;
