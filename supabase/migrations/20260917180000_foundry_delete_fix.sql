-- Foundry deletion fix: let a tool or program actually be deleted.
--
-- Three FK columns point at a Foundry row with ON DELETE SET NULL:
--   tool_runs.tool_id, agent_tools.superseded_by, agent_tools.root_id
--   program_runs.program_id, agent_programs.superseded_by, agent_programs.root_id
-- Postgres implements SET NULL as an UPDATE, which fires the BEFORE UPDATE
-- guard on those tables — and each guard refused the write:
--   • tool_runs_guard  → 'tool_runs rows are settled once and then immutable'
--     so ANY tool that had ever been run could not be deleted, by the Settings
--     screen or by delete_tool. This was the common case: a tool you used.
--   • agent_tools_guard / agent_programs_guard → 'superseded_by is maintained
--     by approve_tool()' / 'root_id is immutable', so deleting one version of a
--     tool or program that had more than one version failed too.
--
-- The fix is deliberately narrow: each guard now accepts exactly one extra
-- shape — the column being nulled, for a parent row that is ALREADY GONE, with
-- every other column untouched. A client cannot forge that shape: it has to
-- delete the referenced row first, which is the thing it was trying to do.
-- Everything these guards protected before, they still protect.
--
-- Idempotent: CREATE OR REPLACE FUNCTION only.

-- ── tool_runs: the audit ledger keeps the run, loses the pointer ─────────────
CREATE OR REPLACE FUNCTION public.tool_runs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Referential null-out from a deleted tool. The run row itself is unchanged,
  -- so the ledger still records that the run happened, what it cost and how it
  -- ended — it just no longer points at a row that no longer exists.
  IF NEW.tool_id IS NULL AND OLD.tool_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agent_tools WHERE id = OLD.tool_id)
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.ms IS NOT DISTINCT FROM OLD.ms
     AND NEW.error IS NOT DISTINCT FROM OLD.error
     AND NEW.capability_calls::text IS NOT DISTINCT FROM OLD.capability_calls::text
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'tool_runs rows are settled once and then immutable';
  END IF;
  IF NEW.tool_id IS DISTINCT FROM OLD.tool_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'tool run identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- ── agent_tools: a sibling version being deleted nulls the lineage links ─────
CREATE OR REPLACE FUNCTION public.agent_tools_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'superseded_by is set by approve_tool(), not by clients';
    END IF;
    IF NEW.disabled_by_user THEN
      RAISE EXCEPTION 'disabled_by_user is set by the Settings disable action, not at insert';
    END IF;
    RETURN NEW;
  END IF;
  -- Lineage link nulled because the version it pointed at was deleted. Only
  -- reachable once that row is gone, and it changes nothing else.
  IF ((NEW.superseded_by IS NULL AND OLD.superseded_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_tools WHERE id = OLD.superseded_by))
      OR (NEW.root_id IS NULL AND OLD.root_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_tools WHERE id = OLD.root_id)))
     AND NEW.code IS NOT DISTINCT FROM OLD.code
     AND NEW.manifest::text IS NOT DISTINCT FROM OLD.manifest::text
     AND NEW.tests::text IS NOT DISTINCT FROM OLD.tests::text
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' OR EXISTS (SELECT 1 FROM tool_approvals WHERE tool_id = OLD.id) THEN
    IF NEW.code IS DISTINCT FROM OLD.code
       OR NEW.manifest::text IS DISTINCT FROM OLD.manifest::text
       OR NEW.tests::text IS DISTINCT FROM OLD.tests::text
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.description IS DISTINCT FROM OLD.description THEN
      RAISE EXCEPTION 'approved tools are immutable — create a new version instead';
    END IF;
  END IF;
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'
     AND pg_catalog.current_setting('app.tool_approval', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'tools can only be approved via approve_tool()';
  END IF;
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
     AND pg_catalog.current_setting('app.tool_approval', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'superseded_by is maintained by approve_tool()';
  END IF;
  IF NEW.root_id IS DISTINCT FROM OLD.root_id THEN
    RAISE EXCEPTION 'root_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- ── agent_programs: same shape, same one exemption ───────────────────────────
CREATE OR REPLACE FUNCTION public.agent_programs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'superseded_by is set by approve_program(), not by clients';
    END IF;
    IF NEW.verified_at IS NOT NULL OR NEW.verifier_fingerprint IS NOT NULL OR NEW.verifier_report IS NOT NULL THEN
      RAISE EXCEPTION 'verifier_* is set by program-verify, not at insert';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'programs are inserted as drafts';
    END IF;
    NEW.run_count := 0;
    NEW.fail_count := 0;
    NEW.last_run_at := NULL;
    RETURN NEW;
  END IF;
  -- Lineage link nulled because the version it pointed at was deleted.
  IF ((NEW.superseded_by IS NULL AND OLD.superseded_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_programs WHERE id = OLD.superseded_by))
      OR (NEW.root_id IS NULL AND OLD.root_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_programs WHERE id = OLD.root_id)))
     AND NEW.code IS NOT DISTINCT FROM OLD.code
     AND NEW.language IS NOT DISTINCT FROM OLD.language
     AND NEW.manifest::text IS NOT DISTINCT FROM OLD.manifest::text
     AND NEW.io_spec::text IS NOT DISTINCT FROM OLD.io_spec::text
     AND NEW.name IS NOT DISTINCT FROM OLD.name
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.manifest::text IS DISTINCT FROM OLD.manifest::text
     OR NEW.io_spec::text IS DISTINCT FROM OLD.io_spec::text
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.root_id IS DISTINCT FROM OLD.root_id THEN
    RAISE EXCEPTION 'agent_programs: code/manifest/identity columns are immutable — create a new version instead';
  END IF;
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'
     AND pg_catalog.current_setting('app.program_approval', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'programs can only be approved via approve_program()';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status IS DISTINCT FROM 'disabled'
     AND pg_catalog.current_setting('app.program_disable', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'a disabled program cannot be re-enabled';
  END IF;
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
     AND pg_catalog.current_setting('app.program_approval', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'superseded_by is maintained by approve_program()';
  END IF;
  RETURN NEW;
END;
$$;

-- ── stranded interactive runs ────────────────────────────────────────────────
-- program-run writes a 'pending' row BEFORE dispatch (so a burst rate-limits
-- itself honestly) and settles it when the runner answers. If the edge worker
-- dies mid-flight nothing settles it: the row stays 'pending' forever and keeps
-- counting against the user's 20/min and 500/day budget, so a single crash
-- silently shrinks their quota for a day. sweep_orphan_cron_runs only ever
-- looked at mode='cron'; it now also settles interactive runs that have been
-- pending far longer than any interactive run can legally take (the edge
-- function's own ceiling is ~90s).
CREATE OR REPLACE FUNCTION public.sweep_orphan_cron_runs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE n int; m int;
BEGIN
  UPDATE program_runs r SET status = 'lost',
    error = 'orphaned: the scheduler lost track of this run before it settled'
  WHERE r.mode = 'cron' AND r.status = 'pending'
    AND r.created_at < now() - interval '6 hours'
    AND NOT EXISTS (SELECT 1 FROM program_schedules s WHERE s.active_run_id = r.id);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE program_runs r SET status = 'lost',
    error = 'orphaned: the request died before the run settled'
  WHERE r.mode IN ('run', 'verify') AND r.status = 'pending'
    AND r.created_at < now() - interval '30 minutes';
  GET DIAGNOSTICS m = ROW_COUNT;

  RETURN n + m;
END;
$$;
REVOKE ALL ON FUNCTION public.sweep_orphan_cron_runs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_orphan_cron_runs() TO service_role;
