-- Memory redesign (2026-10-20): notes become an index of anchors.
--
--  1. knowledge_entries.hook — the one-line, search-snippet description each
--     note shows in the chat's always-loaded index (see
--     src/lib/notesIndex.ts). Written by the save tool or by the Sleep Cycle.
--  2. memory_sleep_runs + undo_sleep_run — every Sleep Cycle run that changes
--     something logs the links it added and the hooks it wrote, and can be
--     reversed in one call.
--  3. Daily recall — entries_due_for_review also serves notes that were
--     never reviewed, so a new user gets questions on day one.
--  4. Removals. One embedding space (768-d `embedding`) instead of two; the
--     1536-d column only fed smart filing, centroids and the BRAIN search box,
--     all removed. Dead tables: episodic_log and conversation_memory (only the
--     uncalled knowledge-extract wrote them), wiki_log, wiki_questions,
--     subject_progress (never referenced), cleanup_flags (written, never
--     read). Columns written only by knowledge-extract: importance, surprise,
--     encoding_strength. v1 search RPCs superseded by the _v2 pair.

-- ── 1. Hooks ────────────────────────────────────────────────────────────────
ALTER TABLE public.knowledge_entries ADD COLUMN IF NOT EXISTS hook text;
ALTER TABLE public.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_hook_len;
ALTER TABLE public.knowledge_entries
  ADD CONSTRAINT knowledge_entries_hook_len CHECK (hook IS NULL OR char_length(hook) <= 200);

-- An edit to title/content leaves the hook alone: a hook describes the note,
-- and small edits rarely change that. A full rewrite goes through supersede,
-- which makes a new row with no hook, so the Sleep Cycle writes a fresh one.

-- ── 2. Sleep Cycle run log ──────────────────────────────────────────────────
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
ALTER TABLE public.memory_sleep_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own sleep runs" ON public.memory_sleep_runs;
CREATE POLICY "own sleep runs" ON public.memory_sleep_runs
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Reverse one run: remove the links it added and clear the hooks it wrote.
-- A hook is cleared only if it still exists (the user may have edited it
-- since — an edit is theirs and stays). Returns false when the run is not
-- the caller's or was already undone.
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

-- ── 3. Daily recall ─────────────────────────────────────────────────────────
-- Due notes first (oldest due date first), then notes never reviewed (oldest
-- first). Self-built tool/program cards and retired notes are not questions.
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

-- ── 4. Removals ─────────────────────────────────────────────────────────────
-- Functions that read what is dropped below, every overload.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'find_near_duplicates', 'get_neighbors', 'hybrid_search_knowledge',
      'match_knowledge_entries', 'renormalize_vibrancy', 'scan_cleanup_flags',
      'score_entry_against_wikis', 'upsert_wiki_health_alert')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', f.sig);
  END LOOP;
END $$;

-- Staleness trigger: only one vector to clear now.
CREATE OR REPLACE FUNCTION public.clear_stale_entry_embeddings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content THEN
    IF NEW.embedding IS NOT NULL AND NOT (NEW.embedding IS DISTINCT FROM OLD.embedding) THEN
      NEW.embedding := NULL;
      NEW.embedding_768_model := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE IF EXISTS public.incubator_entries CASCADE;
DROP TABLE IF EXISTS public.routing_decisions CASCADE;
DROP TABLE IF EXISTS public.reroute_suggestions CASCADE;
DROP TABLE IF EXISTS public.wiki_proposals CASCADE;
DROP TABLE IF EXISTS public.wiki_health_alerts CASCADE;
DROP TABLE IF EXISTS public.wiki_centroids CASCADE;
DROP TABLE IF EXISTS public.episodic_log CASCADE;
DROP TABLE IF EXISTS public.conversation_memory CASCADE;
DROP TABLE IF EXISTS public.wiki_log CASCADE;
DROP TABLE IF EXISTS public.wiki_questions CASCADE;
DROP TABLE IF EXISTS public.subject_progress CASCADE;
DROP TABLE IF EXISTS public.cleanup_flags CASCADE;

ALTER TABLE public.user_settings DROP COLUMN IF EXISTS smart_filing_enabled;

ALTER TABLE public.knowledge_entries
  DROP COLUMN IF EXISTS embedding_v2,
  DROP COLUMN IF EXISTS importance,
  DROP COLUMN IF EXISTS surprise,
  DROP COLUMN IF EXISTS encoding_strength;
