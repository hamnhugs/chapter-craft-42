-- Upserts against PARTIAL unique indexes, done in SQL.
--
-- Two writers used PostgREST upsert (`on_conflict=cols`) against indexes that
-- only exist with a predicate:
--   consolidation_queue  uq_consolidation_queue_user_entry_reason
--                        (user_id, entry_id, reason) WHERE entry_id IS NOT NULL
--   wiki_health_alerts   wiki_health_alerts_unique_pending
--                        (user_id, wiki_id, kind) WHERE status = 'pending'
-- PostgREST emits `ON CONFLICT (cols)` with no WHERE, which Postgres cannot
-- match to a partial index ("there is no unique or exclusion constraint
-- matching the ON CONFLICT specification", 42P10). Both callers ignored the
-- error, so NO orphan was ever enqueued by the Sleep Cycle and drift alerts
-- were never written. Postgres does accept the index predicate in ON CONFLICT
-- (`ON CONFLICT (cols) WHERE predicate`) — PostgREST just can't express it —
-- hence these RPCs.
--
-- Both are SECURITY INVOKER and use auth.uid() for user_id, so the existing
-- "own rows" RLS policies still apply; ownership of the referenced entries /
-- wiki is additionally checked in the query itself.
--
-- Idempotent.

-- ── enqueue_consolidation_entries ───────────────────────────────────────────
-- Set-based: the Sleep Cycle enqueues every orphan in ONE call (it used to make
-- one HTTP round trip per orphan — and every one of them failed, see above).
-- A row that already exists is left alone while pending, and re-armed
-- (processed_at → NULL) once it was processed more than p_requeue_after ago,
-- so a node that was an orphan last month gets another chance to link to
-- knowledge added since — without re-spending an LLM call on it every cycle.
-- Returns the number of rows inserted or re-armed.
CREATE OR REPLACE FUNCTION public.enqueue_consolidation_entries(
  p_entry_ids      uuid[],
  p_reason         text,
  p_priority       int      DEFAULT 5,
  p_requeue_after  interval DEFAULT interval '7 days'
)
RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  n int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING errcode = '42501';
  END IF;
  IF p_entry_ids IS NULL OR cardinality(p_entry_ids) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.consolidation_queue (user_id, entry_id, reason, priority)
  SELECT v_uid, e.id, p_reason, COALESCE(p_priority, 5)
    FROM public.knowledge_entries e
   WHERE e.id = ANY(p_entry_ids)
     AND e.user_id = v_uid
  ON CONFLICT (user_id, entry_id, reason) WHERE entry_id IS NOT NULL
  DO UPDATE SET processed_at = NULL,
                priority     = EXCLUDED.priority,
                created_at   = now()
          WHERE consolidation_queue.processed_at IS NOT NULL
            AND consolidation_queue.processed_at < now() - COALESCE(p_requeue_after, interval '7 days');

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_consolidation_entries(uuid[], text, integer, interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_consolidation_entries(uuid[], text, integer, interval) TO authenticated, service_role;

-- ── upsert_wiki_health_alert ────────────────────────────────────────────────
-- One pending alert per (wiki, kind): a re-run refreshes its rationale and
-- suggestion in place instead of failing. Accepted/dismissed alerts are
-- outside the index predicate, so a dismissed alert never blocks a new one.
-- Returns the alert id (NULL when the wiki isn't the caller's).
CREATE OR REPLACE FUNCTION public.upsert_wiki_health_alert(
  p_wiki_id    uuid,
  p_kind       text,
  p_rationale  text,
  p_suggestion jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING errcode = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wikis w WHERE w.id = p_wiki_id AND w.user_id = v_uid) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.wiki_health_alerts (user_id, wiki_id, kind, rationale, suggestion, status)
  VALUES (v_uid, p_wiki_id, p_kind, COALESCE(p_rationale, ''), COALESCE(p_suggestion, '{}'::jsonb), 'pending')
  ON CONFLICT (user_id, wiki_id, kind) WHERE status = 'pending'
  DO UPDATE SET rationale  = EXCLUDED.rationale,
                suggestion = EXCLUDED.suggestion,
                updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_wiki_health_alert(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_wiki_health_alert(uuid, text, text, jsonb) TO authenticated, service_role;
