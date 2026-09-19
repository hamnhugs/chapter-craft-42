-- Vibrancy that actually decays over weeks + Sleep Cycle neighbour anchoring.
--
-- ── 1. The bug ──────────────────────────────────────────────────────────────
-- rerank_vibrancy used the ACT-R single-access approximation on SECONDS:
--     raw = ln(n + 1) − 0.5 · ln(idle_seconds + 1)
--     v   = sigmoid(raw) · 0.9 + 0.1
-- ln(3600) ≈ 8.2, so one hour idle already gives raw ≈ −4.1 → v ≈ 0.115, and a
-- card retrieved 10 times and idle for a day scores ≈ 0.13. After any Sleep
-- Cycle essentially every node sat at the 0.10 floor: Phase 2 found no "core"
-- nodes (vibrancy ≥ 0.70) and built no edges, and knowledge-retrieve's
-- 0.55 + 0.3·vibrancy multiplier collapsed to a constant. The "30-day
-- half-life" in memory-layers.ts was never true.
--
-- ── 2. The formula (days, with a real half-life) ────────────────────────────
--     idle_days = (now − COALESCE(last_retrieved_at, created_at)) / 86400
--     H(n)      = half_life_days · (1 + ln(1 + n))       n = retrieval_count
--     v         = floor + (ceil − floor) · 2^(−idle_days / H(n))
-- The part above the floor halves every H(n) days: 30 days for a never-used
-- card, stretched logarithmically by use (n=3 → ~72d, n=10 → ~102d). Fresh
-- cards start at the ceiling. half_life_days = 15 / p_decay so the existing
-- call (p_decay = 0.5) means 30 days without a signature change (a new
-- parameter would create a PostgREST overload).
--
--   v(n, idle)   0d    1h    1d    7d    30d   60d   90d   180d
--   n = 0       1.00  1.00  0.98  0.87  0.55  0.33  0.21  0.11
--   n = 1       1.00  1.00  0.99  0.92  0.70  0.50  0.36  0.18
--   n = 3       1.00  1.00  0.99  0.94  0.77  0.60  0.48  0.26
--   n = 10      1.00  1.00  0.99  0.96  0.83  0.70  0.59  0.36
--   n = 30      1.00  1.00  1.00  0.97  0.87  0.76  0.66  0.45
-- (Same table is asserted in src/test/vibrancy.test.ts against the TS twin
-- computeVibrancy in supabase/functions/_shared/memory-layers.ts.)
--
-- Only rows whose score moves by > 0.005 are written, so a Sleep Cycle no
-- longer rewrites every row.
--
-- ── 3. Bookkeeping writes stop bumping updated_at ───────────────────────────
-- knowledge_entries.updated_at had a plain "now() on every UPDATE" trigger, so
-- each Sleep Cycle (rerank touches every row) and every retrieval touch
-- re-stamped updated_at — scrambling the WikiPanel's recency ordering and
-- making scan_cleanup_flags' "not edited in 30 days" rule never fire. The
-- vibrancy/retrieval RPCs below mark their writes with a transaction-local
-- setting (app.memory_bookkeeping) that the replacement trigger honours.
-- Every other UPDATE behaves exactly as before.
--
-- ── 4. touch_node_retrievals ────────────────────────────────────────────────
-- Same signature and ownership guard as 20260917130000. knowledge-retrieve no
-- longer calls it for every INJECTED card (that was a popularity loop: being
-- injected made a card more vibrant, which ranked it higher, which injected it
-- again). It is now for deliberate dereference (read_span via
-- cardLocators.bumpVibrancy), where counting a use is the point.
--
-- ── 5. match_entry_neighbors ────────────────────────────────────────────────
-- Phase 2 of knowledge-consolidate used to offer the LLM the 20 globally most
-- vibrant cards as anchors for EVERY queued item, related or not. This RPC
-- returns the item's own nearest living neighbours from its stored embedding
-- (no extra embedding call), with vibrancy, so the edge function can blend
-- similarity with salience. SECURITY INVOKER + auth.uid(): RLS applies.
--
-- Idempotent.

-- ── 3. updated_at trigger for knowledge_entries ─────────────────────────────
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

-- ── 2. rerank_vibrancy ──────────────────────────────────────────────────────
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

-- ── 4. touch_node_retrievals ────────────────────────────────────────────────
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

-- ── 5. match_entry_neighbors ────────────────────────────────────────────────
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
