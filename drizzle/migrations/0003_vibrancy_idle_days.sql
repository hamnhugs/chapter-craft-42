CREATE OR REPLACE FUNCTION public.knowledge_entries_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.memory_bookkeeping', true) = 'on' THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.knowledge_entries_set_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS update_knowledge_entries_updated_at ON public.knowledge_entries;
CREATE TRIGGER update_knowledge_entries_updated_at
  BEFORE UPDATE ON public.knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_entries_set_updated_at();

CREATE OR REPLACE FUNCTION public.rerank_vibrancy(
  p_user_id  uuid,
  p_decay    float DEFAULT 0.5,
  p_floor    float DEFAULT 0.10,
  p_ceil     float DEFAULT 1.00
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count int;
  half_life_days float := 15.0 / GREATEST(COALESCE(p_decay, 0.5), 0.01);
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'rerank_vibrancy: not allowed for another user' USING errcode = '42501';
  END IF;

  PERFORM set_config('app.memory_bookkeeping', 'on', true);

  WITH ranked AS (
    SELECT
      id,
      GREATEST(p_floor, LEAST(p_ceil,
        p_floor + (p_ceil - p_floor) * POWER(2.0,
          -(GREATEST(0.0, EXTRACT(EPOCH FROM (NOW() - COALESCE(last_retrieved_at, created_at))) / 86400.0))
          / (half_life_days * (1.0 + LN(1.0 + GREATEST(retrieval_count, 0))))
        )
      )) AS new_vibrancy
    FROM public.knowledge_entries
    WHERE user_id = p_user_id
  )
  UPDATE public.knowledge_entries ke
  SET vibrancy = r.new_vibrancy
  FROM ranked r
  WHERE ke.id = r.id
    AND ke.user_id = p_user_id
    AND ABS(COALESCE(ke.vibrancy, 0) - r.new_vibrancy) > 0.005;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  PERFORM set_config('app.memory_bookkeeping', 'off', true);
  RETURN updated_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_node_retrievals(node_ids uuid[], boost float DEFAULT 0.15)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.memory_bookkeeping', 'on', true);
  UPDATE public.knowledge_entries
  SET
    retrieval_count   = retrieval_count + 1,
    last_retrieved_at = now(),
    vibrancy          = LEAST(1.0, vibrancy + GREATEST(COALESCE(boost, 0), 0))
  WHERE id = ANY(node_ids)
    AND (auth.uid() IS NULL OR user_id = auth.uid());
  PERFORM set_config('app.memory_bookkeeping', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rerank_vibrancy(uuid, double precision, double precision, double precision) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.touch_node_retrievals(uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rerank_vibrancy(uuid, double precision, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_node_retrievals(uuid[], double precision) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.match_entry_neighbors(
  p_entry_id uuid,
  p_count    int  DEFAULT 12,
  p_wiki_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  id         uuid,
  title      text,
  content    text,
  entry_type text,
  vibrancy   double precision,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH src AS (
    SELECT e.embedding
      FROM public.knowledge_entries e
     WHERE e.id = p_entry_id
       AND e.user_id = auth.uid()
       AND e.embedding IS NOT NULL
  )
  SELECT k.id,
         k.title,
         left(k.content, 600) AS content,
         k.entry_type,
         k.vibrancy::double precision,
         (1 - (k.embedding <=> src.embedding))::double precision AS similarity
    FROM src, public.knowledge_entries k
   WHERE k.user_id = auth.uid()
     AND k.id <> p_entry_id
     AND k.embedding IS NOT NULL
     AND k.superseded_by IS NULL
     AND k.archived = false
     AND (p_wiki_id IS NULL OR k.wiki_id = p_wiki_id)
   ORDER BY k.embedding <=> src.embedding
   LIMIT LEAST(GREATEST(COALESCE(p_count, 12), 1), 50);
$$;

REVOKE ALL ON FUNCTION public.match_entry_neighbors(uuid, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_entry_neighbors(uuid, integer, uuid) TO authenticated, service_role;