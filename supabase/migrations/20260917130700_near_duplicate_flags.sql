-- Semantic near-duplicate detection for freshly embedded entries.
--
-- The chat tools already refuse an exact title/alias re-create (register
-- lookup), and scan_cleanup_flags catches identical titles — but the same claim
-- saved under a different title slipped through and quietly split retrieval
-- between two cards. knowledge-embed now calls this right after a TARGETED
-- embed (the embedEntriesSoon path that follows every create/edit): for each
-- given entry, the nearest OLDER living entry in the same wiki by cosine. At
-- or above p_threshold (default 0.92) the edge function records a
-- cleanup_flags row (reason 'duplicate', flagged_by 'chat') on the NEWER entry
-- and returns the pairs as possible_duplicates. Note: no client screen reads
-- cleanup_flags today — the flags are stored for a review surface / the AI's
-- cleanup tools to pick up. Nothing is merged or deleted automatically.
--
-- "Older" (created_at, then id) makes the relation one-directional, so a pair
-- produces one flag, on the newcomer. Scope: same wiki_id (NULL matches NULL),
-- living rows only, the caller's own rows (SECURITY INVOKER + auth.uid()).
-- When both vectors carry a known, different embedding_768_model the pair is
-- skipped (cross-model cosine is meaningless). Idempotent.

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
