-- ============================================================
-- Layered Memory Stack — Schema Additions
-- Adds vibrancy/retrieval tracking, recording mode gate,
-- proper episodic log, and Sleep Cycle consolidation queue.
-- ============================================================

-- ── Layer 3: Semantic Graph — vibrancy & retrieval tracking ──
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS vibrancy           float   NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS last_retrieved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS retrieval_count    int     NOT NULL DEFAULT 0;

-- Bump vibrancy, capped at 1.0, on every retrieval touch.
-- The Sleep Cycle uses the same column to decay non-retrieved nodes.
COMMENT ON COLUMN public.knowledge_entries.vibrancy IS
  'Salience score [0.1, 1.0]. Decays toward 0.1 when not retrieved; boosted on access.';
COMMENT ON COLUMN public.knowledge_entries.last_retrieved_at IS
  'Timestamp of last retrieval hit. NULL = never retrieved since creation.';

CREATE INDEX IF NOT EXISTS ke_vibrancy_idx       ON public.knowledge_entries (user_id, vibrancy DESC);
CREATE INDEX IF NOT EXISTS ke_last_retrieved_idx ON public.knowledge_entries (user_id, last_retrieved_at DESC NULLS LAST);

-- ── Encoding-State Gate — recording/retrieval mode per user ──
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS is_recording_mode      bool NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_sleep_cycle_at    timestamptz,
  ADD COLUMN IF NOT EXISTS sleep_cycle_threshold  int  NOT NULL DEFAULT 10;

COMMENT ON COLUMN public.user_settings.is_recording_mode IS
  'When false the system enters Retrieval Mode: write operations to knowledge_entries are blocked.';
COMMENT ON COLUMN public.user_settings.sleep_cycle_threshold IS
  'Minimum number of consolidation_queue rows before the Sleep Cycle auto-triggers.';

-- ── Layer 2: Episodic / Short-Term Memory — session-scoped log ──
-- One row per conversation session; replaces the single-row conversation_memory
-- for new sessions (old row kept for backward compat with existing summaries).
CREATE TABLE IF NOT EXISTS public.episodic_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL,
  session_id   text        NOT NULL,
  summary      text,
  key_facts    jsonb       NOT NULL DEFAULT '[]',
  entry_count  int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.episodic_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own episodic log"
  ON public.episodic_log FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own episodic log"
  ON public.episodic_log FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS el_user_created_idx ON public.episodic_log (user_id, created_at DESC);

-- ── Layer 5: Consolidation Queue — Sleep Cycle staging ──
-- Entries land here when:
--   • a new node has an unresolved conflict ('conflict_staged')
--   • a new node has been added and needs edge generation ('new_entry')
--   • an orphan is identified by the Sleep Cycle ('orphan')
CREATE TABLE IF NOT EXISTS public.consolidation_queue (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL,
  entry_id       uuid        REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  reason         text        NOT NULL DEFAULT 'new_entry',   -- conflict_staged | new_entry | orphan
  priority       int         NOT NULL DEFAULT 5,             -- 1 (high) → 10 (low)
  pending_data   jsonb,                                      -- full entry JSON if not yet inserted
  processed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.consolidation_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own consolidation queue"
  ON public.consolidation_queue FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own consolidation queue"
  ON public.consolidation_queue FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS cq_user_unprocessed_idx
  ON public.consolidation_queue (user_id, processed_at NULLS FIRST, priority ASC);
CREATE INDEX IF NOT EXISTS cq_entry_id_idx ON public.consolidation_queue (entry_id);

-- ── Sleep Cycle RPC: ACT-R vibrancy re-ranking ──────────────────────────────
-- Called by the knowledge-consolidate edge function (Phase 1).
-- Uses the single-access ACT-R approximation:
--   raw  = ln(retrieval_count + 1) - d * ln(idle_seconds + 1)
--   vibrancy = clamp(sigmoid(raw) * 0.9 + 0.1, floor, ceil)
CREATE OR REPLACE FUNCTION public.rerank_vibrancy(
  p_user_id  uuid,
  p_decay    float DEFAULT 0.5,
  p_floor    float DEFAULT 0.10,
  p_ceil     float DEFAULT 1.00
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count int;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      GREATEST(
        p_floor,
        LEAST(
          p_ceil,
          -- sigmoid(raw) * 0.9 + 0.1
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

-- ── Sleep Cycle RPC: dequeue a batch (SKIP LOCKED = concurrency safe) ─────────
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
AS $$
BEGIN
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

-- ── Layer 3 helper: bump retrieval stats for a set of node IDs ──
-- Called from knowledge-retrieve after each successful search.
CREATE OR REPLACE FUNCTION public.touch_node_retrievals(node_ids uuid[], boost float DEFAULT 0.15)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.knowledge_entries
  SET
    retrieval_count   = retrieval_count + 1,
    last_retrieved_at = now(),
    vibrancy          = LEAST(1.0, vibrancy + boost)
  WHERE id = ANY(node_ids);
END;
$$;
