CREATE OR REPLACE FUNCTION public.find_near_duplicates(
  p_entry_ids uuid[],
  p_threshold double precision DEFAULT 0.92
)
RETURNS TABLE (
  entry_id        uuid,
  wiki_id         uuid,
  duplicate_of    uuid,
  duplicate_title text,
  similarity      double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT s.id, s.wiki_id, n.id, n.title, n.similarity
    FROM public.knowledge_entries s
    CROSS JOIN LATERAL (
      SELECT k.id, k.title,
             (1 - (k.embedding <=> s.embedding))::double precision AS similarity
        FROM public.knowledge_entries k
       WHERE k.user_id = auth.uid()
         AND k.id <> s.id
         AND k.embedding IS NOT NULL
         AND k.superseded_by IS NULL
         AND k.archived = false
         AND k.wiki_id IS NOT DISTINCT FROM s.wiki_id
         AND (k.created_at, k.id) < (s.created_at, s.id)
         AND (k.embedding_768_model IS NULL OR s.embedding_768_model IS NULL
              OR k.embedding_768_model = s.embedding_768_model)
       ORDER BY k.embedding <=> s.embedding
       LIMIT 1
    ) n
   WHERE s.id = ANY(p_entry_ids)
     AND s.user_id = auth.uid()
     AND s.embedding IS NOT NULL
     AND s.superseded_by IS NULL
     AND n.similarity >= COALESCE(p_threshold, 0.92);
$$;

REVOKE ALL ON FUNCTION public.find_near_duplicates(uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_near_duplicates(uuid[], double precision) TO authenticated, service_role;