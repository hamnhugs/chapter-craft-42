-- Bi-temporal supersession for the knowledge graph (VGMS "4D axis" upgrade).
-- Fact corrections stop destroying history: instead of editing in place or hard
-- deleting, an outdated entry is RETIRED — valid_to closes its belief window,
-- superseded_by links it to its replacement, archived hides it from reviews —
-- and the corrected entry is born as a new row. "What did I believe before?"
-- becomes answerable (entry_lineage), and conflict resolution keeps evidence.
--
-- ALL ADDITIVE + backward-compatible, same contract as brain_memory:
--   • new columns have defaults; nothing existing is rewritten
--   • the client feature-detects (42703/PGRST204/42883) and falls back to the
--     legacy behavior until this is applied
--   • deployed edge functions are untouched: entries_for_wiki is replaced
--     in-database with an identical signature, and retrieval results are
--     additionally filtered client-side (see buildChatSystemPrompt.ts)
-- Apply via a Lovable-chat prompt or the SQL editor — git push does NOT run
-- migrations. Safe to run repeatedly (idempotent).

-- ── 1. Lineage columns ──────────────────────────────────────────────────────
-- valid_from / valid_to already exist (20260416003641) but were dormant.
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS superseded_by    uuid REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supersede_reason text;

-- Mirror-guards for columns owned by earlier optional migrations, so this one
-- works whether or not layered_memory_stack / brain_memory were applied
-- (definitions are byte-identical to theirs; IF NOT EXISTS makes them no-ops
-- when already present).
ALTER TABLE public.knowledge_entries
  ADD COLUMN IF NOT EXISTS vibrancy float   NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ke_superseded_by_idx
  ON public.knowledge_entries (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS ke_live_idx
  ON public.knowledge_entries (user_id, wiki_id) WHERE superseded_by IS NULL;

-- ── 2. supersede_knowledge_entry ────────────────────────────────────────────
-- Atomically: insert the corrected entry (inheriting scope + salience), close
-- the old row's validity window, link lineage, re-point graph edges and wiki
-- bridges to the successor, and nudge the Sleep Cycle to grow fresh edges.
-- _also_supersede supports conflict merges: BOTH old rows point at the one
-- merged successor.
CREATE OR REPLACE FUNCTION public.supersede_knowledge_entry(
  _old_id         uuid,
  _new_title      text     DEFAULT NULL,
  _new_content    text     DEFAULT NULL,
  _new_entry_type text     DEFAULT NULL,
  _new_tags       text[]   DEFAULT NULL,
  _reason         text     DEFAULT NULL,
  _also_supersede uuid     DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  old_row  public.knowledge_entries%ROWTYPE;
  olds     uuid[];
  oid      uuid;
  new_id   uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _new_content IS NULL OR btrim(_new_content) = '' THEN
    RAISE EXCEPTION 'supersede requires the corrected content (_new_content)';
  END IF;

  olds := ARRAY[_old_id];
  IF _also_supersede IS NOT NULL AND _also_supersede <> _old_id THEN
    olds := olds || _also_supersede;
  END IF;

  -- Validate + lock every row being retired (blocks concurrent double-supersede).
  FOREACH oid IN ARRAY olds LOOP
    PERFORM 1 FROM public.knowledge_entries
      WHERE id = oid AND user_id = auth.uid() AND superseded_by IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Entry % not found, not yours, or already superseded', oid;
    END IF;
  END LOOP;

  SELECT * INTO old_row FROM public.knowledge_entries WHERE id = _old_id;

  INSERT INTO public.knowledge_entries
    (user_id, wiki_id, title, content, entry_type, tags, confidence,
     source_book_id, vibrancy, valid_from)
  VALUES
    (old_row.user_id,
     old_row.wiki_id,
     COALESCE(NULLIF(btrim(COALESCE(_new_title, '')), ''), old_row.title),
     _new_content,
     COALESCE(NULLIF(btrim(COALESCE(_new_entry_type, '')), ''), old_row.entry_type),
     COALESCE(_new_tags, old_row.tags),
     old_row.confidence,
     old_row.source_book_id,
     COALESCE(old_row.vibrancy, 1.0),
     now())
  RETURNING id INTO new_id;

  FOREACH oid IN ARRAY olds LOOP
    UPDATE public.knowledge_entries
       SET valid_to         = now(),
           superseded_by    = new_id,
           supersede_reason = _reason,
           archived         = true
     WHERE id = oid;

    -- Graph edges and wiki bridges follow the LIVING fact; the retired row
    -- keeps its place in history via superseded_by. Derived-structure upkeep
    -- must never fail the correction itself, hence the swallow-all guards.
    BEGIN
      UPDATE public.memory_graph mg
         SET source_entry_id = new_id
       WHERE mg.source_entry_id = oid
         AND mg.target_entry_id <> new_id
         AND NOT EXISTS (SELECT 1 FROM public.memory_graph d
                          WHERE d.source_entry_id = new_id
                            AND d.target_entry_id = mg.target_entry_id
                            AND d.relationship    = mg.relationship);
      UPDATE public.memory_graph mg
         SET target_entry_id = new_id
       WHERE mg.target_entry_id = oid
         AND mg.source_entry_id <> new_id
         AND NOT EXISTS (SELECT 1 FROM public.memory_graph d
                          WHERE d.source_entry_id = mg.source_entry_id
                            AND d.target_entry_id = new_id
                            AND d.relationship    = mg.relationship);
      DELETE FROM public.memory_graph
       WHERE source_entry_id = oid OR target_entry_id = oid;
      DELETE FROM public.memory_graph
       WHERE source_entry_id = new_id AND target_entry_id = new_id;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
      UPDATE public.entry_bridges b
         SET entry_id = new_id
       WHERE b.entry_id = oid
         AND NOT EXISTS (SELECT 1 FROM public.entry_bridges d
                          WHERE d.entry_id = new_id AND d.wiki_id = b.wiki_id);
      DELETE FROM public.entry_bridges WHERE entry_id = oid;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  -- Ask the Sleep Cycle to generate fresh edges for the corrected fact.
  BEGIN
    INSERT INTO public.consolidation_queue (user_id, entry_id, reason, priority)
    VALUES (old_row.user_id, new_id, 'new_entry', 3);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN new_id;
END;
$$;

-- ── 3. entry_lineage ────────────────────────────────────────────────────────
-- Full supersession chain through any entry: ancestors (what was believed
-- before, including both parents of a merge), the entry itself, and its
-- successors up to the current version. depth < 0 = older, 0 = the queried
-- entry, > 0 = newer; is_current marks the living version.
CREATE OR REPLACE FUNCTION public.entry_lineage(_entry_id uuid)
RETURNS TABLE (
  id uuid, title text, content text, entry_type text,
  valid_from timestamptz, valid_to timestamptz,
  superseded_by uuid, supersede_reason text,
  is_current boolean, depth int
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  WITH RECURSIVE back AS (
    SELECT e.id, e.title, e.content, e.entry_type, e.valid_from, e.valid_to,
           e.superseded_by, e.supersede_reason, 0 AS depth
      FROM public.knowledge_entries e
     WHERE e.id = _entry_id AND e.user_id = auth.uid()
    UNION ALL
    SELECT p.id, p.title, p.content, p.entry_type, p.valid_from, p.valid_to,
           p.superseded_by, p.supersede_reason, b.depth - 1
      FROM public.knowledge_entries p
      JOIN back b ON p.superseded_by = b.id
     WHERE p.user_id = auth.uid()
  ), fwd AS (
    SELECT e.id, e.title, e.content, e.entry_type, e.valid_from, e.valid_to,
           e.superseded_by, e.supersede_reason, 0 AS depth
      FROM public.knowledge_entries e
     WHERE e.id = _entry_id AND e.user_id = auth.uid()
    UNION ALL
    SELECT s.id, s.title, s.content, s.entry_type, s.valid_from, s.valid_to,
           s.superseded_by, s.supersede_reason, f.depth + 1
      FROM public.knowledge_entries s
      JOIN fwd f ON f.superseded_by = s.id
     WHERE s.user_id = auth.uid()
  )
  SELECT t.id, t.title, t.content, t.entry_type, t.valid_from, t.valid_to,
         t.superseded_by, t.supersede_reason,
         (t.superseded_by IS NULL) AS is_current, t.depth
    FROM (
      SELECT DISTINCT ON (u.id) u.*
        FROM (SELECT * FROM back UNION ALL SELECT * FROM fwd) u
       ORDER BY u.id, u.depth
    ) t
   ORDER BY t.depth ASC, t.valid_from ASC;
$$;

-- ── 4. entries_for_wiki: superseded entries leave the living view ───────────
-- Same signature/return type as 20260518014311 (+ SECURITY INVOKER per the
-- 20260625125808 hardening), with one added predicate. History stays reachable
-- via entry_lineage; the WikiPanel and chat fallback go through this RPC.
CREATE OR REPLACE FUNCTION public.entries_for_wiki (
  target_wiki_id UUID
)
RETURNS SETOF public.knowledge_entries
LANGUAGE SQL STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.*
    FROM public.knowledge_entries e
   WHERE e.user_id = auth.uid()
     AND e.superseded_by IS NULL
     AND (
       e.wiki_id = target_wiki_id
       OR EXISTS (
         SELECT 1 FROM public.entry_bridges b
          WHERE b.entry_id = e.id
            AND b.wiki_id = target_wiki_id
            AND b.user_id = auth.uid()
       )
     )
   ORDER BY e.updated_at DESC;
$$;

-- ── 5. Grants (repo convention: authenticated + service_role only) ──────────
REVOKE EXECUTE ON FUNCTION public.supersede_knowledge_entry(uuid, text, text, text, text[], text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.supersede_knowledge_entry(uuid, text, text, text, text[], text, uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.entry_lineage(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.entry_lineage(uuid) TO authenticated, service_role;

-- Known limitation until the knowledge edge functions are redeployed with a
-- superseded_by filter: knowledge-retrieve / search-knowledge may still MATCH
-- retired rows server-side. The client drops them before the prompt is built
-- (filterSupersededNodes), so they never reach the model.
