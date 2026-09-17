-- Memory RPC ownership hardening.
--
-- 20260516200000_layered_memory_stack created three SECURITY DEFINER helpers
-- that trust their arguments completely:
--
--   • rerank_vibrancy(p_user_id, …)           — rewrites vibrancy for ANY user
--   • dequeue_consolidation_batch(p_user_id, …) — reads ANY user's queue
--     (entry ids + pending_data, which carries full not-yet-inserted entries)
--   • touch_node_retrievals(node_ids, boost)   — bumps stats on ANY rows by id
--
-- SECURITY DEFINER bypasses RLS, none of them compared the argument with
-- auth.uid(), and none pinned search_path (so a caller-controlled search_path
-- could shadow `public` objects). Any signed-in user could therefore read or
-- write another tenant's memory by passing their user id / entry ids.
--
-- Fix, same bodies otherwise:
--   • SET search_path = public on all three.
--   • When the call carries a user JWT (auth.uid() IS NOT NULL) the target
--     user must BE that user, else RAISE 42501. Calls with the service role
--     (auth.uid() IS NULL — pg_cron / server-side jobs) keep working; EXECUTE
--     is revoked from PUBLIC/anon below so an unauthenticated caller can't
--     reach the NULL branch.
--   • touch_node_retrievals only touches the caller's own rows.
--
-- Callers today (all with the user's JWT, so auth.uid() is the owner):
--   knowledge-consolidate → rerank_vibrancy, dequeue_consolidation_batch
--   knowledge-retrieve    → touch_node_retrievals
--
-- Idempotent: CREATE OR REPLACE with identical signatures (grants survive, and
-- are re-issued explicitly anyway). NOTE: 20260917130400_vibrancy_idle_days
-- replaces rerank_vibrancy / touch_node_retrievals bodies again (formula fix)
-- and keeps these guards.

-- ── rerank_vibrancy ─────────────────────────────────────────────────────────
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

-- ── dequeue_consolidation_batch ─────────────────────────────────────────────
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

-- ── touch_node_retrievals ───────────────────────────────────────────────────
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
    -- User JWT: own rows only. Service role (uid NULL): unrestricted, as before.
    AND (auth.uid() IS NULL OR user_id = auth.uid());
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase default privileges grant EXECUTE to anon/authenticated as
-- role-specific ACL entries, so PUBLIC alone is not enough (see
-- 20260826055008): strip anon explicitly.
REVOKE ALL ON FUNCTION public.rerank_vibrancy(uuid, double precision, double precision, double precision) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dequeue_consolidation_batch(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.touch_node_retrievals(uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rerank_vibrancy(uuid, double precision, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dequeue_consolidation_batch(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_node_retrievals(uuid[], double precision) TO authenticated, service_role;
