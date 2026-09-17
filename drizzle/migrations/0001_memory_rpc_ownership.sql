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
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'rerank_vibrancy: not allowed for another user' USING errcode = '42501';
  END IF;

  WITH ranked AS (
    SELECT
      id,
      GREATEST(
        p_floor,
        LEAST(
          p_ceil,
          (1.0 / (1.0 + EXP(-(
            LN(retrieval_count + 1.0)
            - p_decay * LN(
                EXTRACT(EPOCH FROM (NOW() - COALESCE(last_retrieved_at, created_at))) + 1.0
              )
          )))) * 0.9 + 0.1
        )
      ) AS new_vibrancy
    FROM public.knowledge_entries
    WHERE user_id = p_user_id
  )
  UPDATE public.knowledge_entries ke
  SET vibrancy = r.new_vibrancy
  FROM ranked r
  WHERE ke.id = r.id
    AND ke.user_id = p_user_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.dequeue_consolidation_batch(
  p_user_id    uuid,
  p_batch_size int DEFAULT 25
)
RETURNS TABLE (
  id           uuid,
  entry_id     uuid,
  reason       text,
  priority     int,
  pending_data jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'dequeue_consolidation_batch: not allowed for another user' USING errcode = '42501';
  END IF;

  RETURN QUERY
  SELECT
    cq.id,
    cq.entry_id,
    cq.reason,
    cq.priority,
    cq.pending_data
  FROM public.consolidation_queue cq
  WHERE cq.user_id = p_user_id
    AND cq.processed_at IS NULL
  ORDER BY cq.priority ASC, cq.created_at ASC
  LIMIT p_batch_size
  FOR UPDATE SKIP LOCKED;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_node_retrievals(node_ids uuid[], boost float DEFAULT 0.15)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.knowledge_entries
  SET
    retrieval_count   = retrieval_count + 1,
    last_retrieved_at = now(),
    vibrancy          = LEAST(1.0, vibrancy + boost)
  WHERE id = ANY(node_ids)
    AND (auth.uid() IS NULL OR user_id = auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.rerank_vibrancy(uuid, double precision, double precision, double precision) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dequeue_consolidation_batch(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.touch_node_retrievals(uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rerank_vibrancy(uuid, double precision, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dequeue_consolidation_batch(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_node_retrievals(uuid[], double precision) TO authenticated, service_role;