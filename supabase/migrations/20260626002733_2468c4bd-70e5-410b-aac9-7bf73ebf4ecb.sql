
-- ============================================================
-- cleanup_flags: AI-curated "should this be deleted?" markers
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cleanup_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wiki_id uuid REFERENCES public.wikis(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  reason text NOT NULL,
  note text,
  confidence real NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  flagged_by text NOT NULL DEFAULT 'scan' CHECK (flagged_by IN ('scan','chat','user')),
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cleanup_flags_reason_chk CHECK (reason IN (
    'duplicate','low_confidence','stale','contradicted',
    'empty_or_trivial','atomicity_violation','user_marked','ai_marked'
  )),
  CONSTRAINT cleanup_flags_unique_active UNIQUE (entry_id, reason)
);

CREATE INDEX IF NOT EXISTS cleanup_flags_user_idx ON public.cleanup_flags(user_id, dismissed_at);
CREATE INDEX IF NOT EXISTS cleanup_flags_wiki_idx ON public.cleanup_flags(wiki_id, dismissed_at);
CREATE INDEX IF NOT EXISTS cleanup_flags_entry_idx ON public.cleanup_flags(entry_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cleanup_flags TO authenticated;
GRANT ALL ON public.cleanup_flags TO service_role;

ALTER TABLE public.cleanup_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own cleanup_flags"
  ON public.cleanup_flags FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.cleanup_flags;

-- ============================================================
-- scan_cleanup_flags: rule-based scanner. Idempotent — refreshes
-- the flag set for a wiki (or all wikis when wiki_id is null).
-- ============================================================
CREATE OR REPLACE FUNCTION public.scan_cleanup_flags(target_wiki_id uuid DEFAULT NULL)
RETURNS TABLE(reason text, added integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_added integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING errcode = '42501';
  END IF;

  -- Clear stale (non-dismissed) scan flags so each rescan is fresh.
  DELETE FROM public.cleanup_flags
   WHERE user_id = v_uid
     AND flagged_by = 'scan'
     AND dismissed_at IS NULL
     AND (target_wiki_id IS NULL OR wiki_id = target_wiki_id);

  -- 1. EMPTY OR TRIVIAL: < 40 chars after trim, or only a heading.
  WITH ins AS (
    INSERT INTO public.cleanup_flags (user_id, wiki_id, entry_id, reason, note, confidence, flagged_by)
    SELECT e.user_id, e.wiki_id, e.id, 'empty_or_trivial',
           'Entry has almost no content — likely a stub or test note.',
           0.95, 'scan'
      FROM public.knowledge_entries e
     WHERE e.user_id = v_uid
       AND (target_wiki_id IS NULL OR e.wiki_id = target_wiki_id)
       AND (length(btrim(coalesce(e.content,''))) < 40
            OR e.content ~ '^\s*#{1,6}\s+\S+\s*$')
    ON CONFLICT (entry_id, reason) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;
  reason := 'empty_or_trivial'; added := v_added; RETURN NEXT;

  -- 2. LOW CONFIDENCE: < 0.3 — the ingest pipeline itself wasn't sure.
  WITH ins AS (
    INSERT INTO public.cleanup_flags (user_id, wiki_id, entry_id, reason, note, confidence, flagged_by)
    SELECT e.user_id, e.wiki_id, e.id, 'low_confidence',
           'Confidence score is ' || round((e.confidence * 100)::numeric, 0) || '% — below the 30% trust threshold.',
           0.85, 'scan'
      FROM public.knowledge_entries e
     WHERE e.user_id = v_uid
       AND (target_wiki_id IS NULL OR e.wiki_id = target_wiki_id)
       AND e.confidence < 0.3
    ON CONFLICT (entry_id, reason) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;
  reason := 'low_confidence'; added := v_added; RETURN NEXT;

  -- 3. CONTRADICTED: appears on the losing side of a resolved conflict.
  WITH losers AS (
    SELECT DISTINCT c.entry_a AS entry_id, c.id AS conflict_id
      FROM public.knowledge_conflicts c
     WHERE c.user_id = v_uid AND c.status = 'resolved_b'
    UNION
    SELECT DISTINCT c.entry_b, c.id
      FROM public.knowledge_conflicts c
     WHERE c.user_id = v_uid AND c.status = 'resolved_a'
  ),
  ins AS (
    INSERT INTO public.cleanup_flags (user_id, wiki_id, entry_id, reason, note, confidence, flagged_by)
    SELECT e.user_id, e.wiki_id, e.id, 'contradicted',
           'A conflict was resolved against this entry — kept version disagrees.',
           0.9, 'scan'
      FROM losers l
      JOIN public.knowledge_entries e ON e.id = l.entry_id
     WHERE e.user_id = v_uid
       AND (target_wiki_id IS NULL OR e.wiki_id = target_wiki_id)
    ON CONFLICT (entry_id, reason) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;
  reason := 'contradicted'; added := v_added; RETURN NEXT;

  -- 4. ATOMICITY VIOLATION (stale): atomicity_warning set AND not touched in 30 days.
  WITH ins AS (
    INSERT INTO public.cleanup_flags (user_id, wiki_id, entry_id, reason, note, confidence, flagged_by)
    SELECT e.user_id, e.wiki_id, e.id, 'atomicity_violation',
           'Entry covers multiple claims and hasn''t been split or edited in over 30 days.',
           0.6, 'scan'
      FROM public.knowledge_entries e
     WHERE e.user_id = v_uid
       AND (target_wiki_id IS NULL OR e.wiki_id = target_wiki_id)
       AND e.atomicity_warning IS NOT NULL
       AND e.updated_at < now() - interval '30 days'
    ON CONFLICT (entry_id, reason) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;
  reason := 'atomicity_violation'; added := v_added; RETURN NEXT;

  -- 5. DUPLICATE: identical lowercased title within the same wiki — keep the
  -- most recently updated, flag the older copies.
  WITH dupes AS (
    SELECT e.id, e.user_id, e.wiki_id,
           row_number() OVER (PARTITION BY e.user_id, e.wiki_id, lower(btrim(e.title))
                              ORDER BY e.updated_at DESC, e.id) AS rn
      FROM public.knowledge_entries e
     WHERE e.user_id = v_uid
       AND (target_wiki_id IS NULL OR e.wiki_id = target_wiki_id)
       AND length(btrim(coalesce(e.title,''))) > 0
  ),
  ins AS (
    INSERT INTO public.cleanup_flags (user_id, wiki_id, entry_id, reason, note, confidence, flagged_by)
    SELECT d.user_id, d.wiki_id, d.id, 'duplicate',
           'Another entry in this neuron has the same title and was updated more recently.',
           0.8, 'scan'
      FROM dupes d
     WHERE d.rn > 1
    ON CONFLICT (entry_id, reason) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;
  reason := 'duplicate'; added := v_added; RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.scan_cleanup_flags(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scan_cleanup_flags(uuid) TO authenticated;

-- ============================================================
-- delete_entries_bulk: server-authoritative bulk delete. RLS
-- on knowledge_entries ensures owner-only scope; cascades clear
-- cleanup_flags, memory_graph, entry_bridges, image_attachments.
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_entries_bulk(entry_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING errcode = '42501';
  END IF;
  IF entry_ids IS NULL OR array_length(entry_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.knowledge_entries
   WHERE user_id = v_uid
     AND id = ANY(entry_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_entries_bulk(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_entries_bulk(uuid[]) TO authenticated;
