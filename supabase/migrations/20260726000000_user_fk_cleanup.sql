-- Consistent ownership: every user-scoped table references auth.users.
--
-- 11 tables already did this (wikis, user_settings, image_memories, wiki_chains,
-- book_folders, ingest_jobs, entry_bridges, workspace_items, subscribers,
-- cleanup_flags); 18 did not — including the core memory tables
-- (knowledge_entries, memory_graph, episodic_log, consolidation_queue) and both
-- media tables. Without the constraint, deleting an account leaves its rows
-- behind forever: invisible (RLS can never match a deleted auth.uid()) but
-- still occupying the database.
--
-- SAFETY — this migration cannot fail on existing data and deletes nothing:
--   * Constraints are added NOT VALID, so existing rows are never checked at
--     creation time. New/updated rows ARE checked, and ON DELETE CASCADE fires
--     for future account deletions regardless of validation state.
--   * Validation is then attempted per-table inside its own exception block. A
--     table holding orphaned rows simply stays unvalidated and reports how to
--     inspect it, rather than aborting the migration.
--   * Both blocks are idempotent — re-running skips anything already done.
--
-- KNOWN REMAINING GAP: cascading a row does NOT remove its object in the
-- generated-images / generated-videos / generated-splats buckets. Storage
-- cleanup on account deletion is still a separate concern.

DO $$
DECLARE
  t         text;
  targets   text[] := ARRAY[
    'api_keys', 'consolidation_queue', 'conversation_memory', 'episodic_log',
    'image_attachments', 'incubator_entries', 'knowledge_conflicts',
    'knowledge_entries', 'memory_graph', 'notes', 'prompt_presets',
    'reroute_suggestions', 'routing_decisions', 'splat_generations',
    'video_generations', 'wiki_centroids', 'wiki_health_alerts', 'wiki_proposals'
  ];
  has_col   boolean;
  has_fk    boolean;
  added     int := 0;
BEGIN
  FOREACH t IN ARRAY targets LOOP
    -- The table (and a user_id column) must actually exist. Some of these were
    -- created by more than one historical migration; a missing one is skipped
    -- rather than treated as an error.
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id'
    ) INTO has_col;

    IF NOT has_col THEN
      RAISE NOTICE 'skip %: no public.%.user_id column', t, t;
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class     rel ON rel.oid = c.conrelid
      JOIN pg_namespace n   ON n.oid   = rel.relnamespace
      WHERE c.contype = 'f'
        AND n.nspname = 'public'
        AND rel.relname = t
        AND c.confrelid = 'auth.users'::regclass
    ) INTO has_fk;

    IF has_fk THEN
      RAISE NOTICE 'skip %: already references auth.users', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) '
      || 'REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID',
      t, t || '_user_id_fkey'
    );
    added := added + 1;
    RAISE NOTICE 'added user_id -> auth.users on public.%', t;
  END LOOP;

  RAISE NOTICE 'user FK cleanup: % constraint(s) added', added;
END $$;

-- Validate what can be validated. Anything holding orphaned rows is reported
-- and left NOT VALID — still enforced going forward, just not retroactively.
DO $$
DECLARE
  r         record;
  validated int := 0;
  skipped   int := 0;
BEGIN
  FOR r IN
    SELECT rel.relname AS tbl, c.conname AS con
    FROM pg_constraint c
    JOIN pg_class     rel ON rel.oid = c.conrelid
    JOIN pg_namespace n   ON n.oid   = rel.relnamespace
    WHERE c.contype = 'f'
      AND NOT c.convalidated
      AND n.nspname = 'public'
      AND c.confrelid = 'auth.users'::regclass
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.tbl, r.con);
      validated := validated + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      skipped := skipped + 1;
      RAISE WARNING 'public.% holds rows whose user_id is not a real account; constraint left unvalidated (new rows are still checked, and future account deletions still cascade). Inspect with: SELECT count(*) FROM public.% x LEFT JOIN auth.users u ON u.id = x.user_id WHERE u.id IS NULL;', r.tbl, r.tbl;
    END;
  END LOOP;

  RAISE NOTICE 'user FK cleanup: % validated, % left unvalidated', validated, skipped;
END $$;
