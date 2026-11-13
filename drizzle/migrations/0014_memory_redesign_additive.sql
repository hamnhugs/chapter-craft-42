ALTER TABLE public.knowledge_entries ADD COLUMN IF NOT EXISTS hook text;
ALTER TABLE public.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_hook_len;
ALTER TABLE public.knowledge_entries
  ADD CONSTRAINT knowledge_entries_hook_len CHECK (hook IS NULL OR char_length(hook) <= 200);

CREATE TABLE IF NOT EXISTS public.memory_sleep_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  wiki_id        uuid REFERENCES public.wikis(id) ON DELETE SET NULL,
  edge_ids       uuid[] NOT NULL DEFAULT '{}',
  hook_entry_ids uuid[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  undone_at      timestamptz
);
CREATE INDEX IF NOT EXISTS memory_sleep_runs_user_created_idx
  ON public.memory_sleep_runs (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_sleep_runs TO authenticated;
GRANT ALL ON public.memory_sleep_runs TO service_role;
ALTER TABLE public.memory_sleep_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own sleep runs" ON public.memory_sleep_runs;
CREATE POLICY "own sleep runs" ON public.memory_sleep_runs
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.undo_sleep_run(_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  r public.memory_sleep_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.memory_sleep_runs
  WHERE id = _run_id AND user_id = auth.uid() AND undone_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM public.memory_graph
  WHERE user_id = auth.uid() AND id = ANY (r.edge_ids);
  UPDATE public.knowledge_entries
  SET hook = NULL
  WHERE user_id = auth.uid() AND id = ANY (r.hook_entry_ids);
  UPDATE public.memory_sleep_runs SET undone_at = now() WHERE id = r.id;
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.undo_sleep_run(uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.entries_due_for_review(uuid, integer);
CREATE FUNCTION public.entries_due_for_review(_wiki_id uuid DEFAULT NULL, _limit integer DEFAULT 3)
RETURNS TABLE(id uuid, title text, content text, entry_type text, wiki_id uuid,
              hook text, locators jsonb, review_count integer, next_review_at timestamptz)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT ke.id, ke.title, ke.content, ke.entry_type, ke.wiki_id,
         ke.hook, ke.locators, ke.review_count, ke.next_review_at
  FROM public.knowledge_entries ke
  WHERE ke.user_id = auth.uid()
    AND ke.archived = false
    AND ke.superseded_by IS NULL
    AND ke.entry_type NOT IN ('tool', 'program')
    AND (ke.next_review_at IS NULL OR ke.next_review_at <= now())
    AND (_wiki_id IS NULL OR ke.wiki_id = _wiki_id)
  ORDER BY (ke.next_review_at IS NULL), ke.next_review_at ASC, ke.created_at ASC
  LIMIT GREATEST(1, LEAST(50, _limit));
$$;
GRANT EXECUTE ON FUNCTION public.entries_due_for_review(uuid, integer) TO authenticated;

COMMENT ON TABLE public.incubator_entries IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.routing_decisions IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.reroute_suggestions IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.wiki_proposals IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.wiki_health_alerts IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.wiki_centroids IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.episodic_log IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.conversation_memory IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.wiki_log IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.wiki_questions IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.subject_progress IS 'DEPRECATED: retired by memory redesign';
COMMENT ON TABLE public.cleanup_flags IS 'DEPRECATED: retired by memory redesign';
