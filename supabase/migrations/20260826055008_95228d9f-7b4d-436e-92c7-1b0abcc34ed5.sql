-- ═══════════════════════════════════════════════════════════════════════════
-- Program Foundry — Operator tier, part 4: LONG UNATTENDED RUNS (poll model).
--
-- Lifts scheduled runs past the tick's sync wall-clock (~60s) WITHOUT giving the
-- runner any outbound channel or credential. The runner stays inbound-only:
-- program-cron dispatches a long job async (the runner accepts and returns
-- immediately), and LATER ticks poll the runner's signed GET /result endpoint,
-- settling the schedule when the durable result file appears. This replaces the
-- previously-designed report-back path (plan §9) — see docs/operator-tier-plan.md.
--
-- Timestamped 20260827000000 to sort AFTER the persistence migration
-- (20260826000000) and every Lovable twin. Idempotent.
--
-- Trust spine (extends 20260825090000's):
--   • Long runtime is granted on the SCHEDULE (owner-only browser RPC), never in
--     the program's manifest — the approval fingerprint is untouched, and a
--     program still cannot self-schedule or self-extend its wall-clock.
--   • Single-flight hands off atomically from the claim lease to an
--     active_run_id marker: begin_async_program_run is a CAS that only succeeds
--     while the dispatching tick still holds its lease token, and
--     claim_due_schedules refuses to claim a schedule whose marker is set, so an
--     in-flight long run blocks re-dispatch across every tick.
--   • Settlement is single-winner: settle/abort are CAS on the exact
--     active_run_id, so two overlapping ticks that both saw the result cannot
--     double-count an outcome.
--   • All async lifecycle RPCs are REVOKEd from PUBLIC, service_role only.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. program_runs: a run the runner lost (restart mid-flight / never saw it).
ALTER TABLE public.program_runs DROP CONSTRAINT IF EXISTS program_runs_status_check;
ALTER TABLE public.program_runs ADD CONSTRAINT program_runs_status_check
  CHECK (status IN ('pending','ok','error','killed','timeout','oom','egress_blocked','sandbox_unavailable','skipped','lost'));

-- ── 2. program_schedules: the long-run allowance + the in-flight async marker.
ALTER TABLE public.program_schedules ADD COLUMN IF NOT EXISTS max_runtime_s INTEGER
  CHECK (max_runtime_s IS NULL OR max_runtime_s BETWEEN 120 AND 3600);
ALTER TABLE public.program_schedules ADD COLUMN IF NOT EXISTS active_run_id UUID;
ALTER TABLE public.program_schedules ADD COLUMN IF NOT EXISTS active_run_started_at TIMESTAMPTZ;
ALTER TABLE public.program_schedules ADD COLUMN IF NOT EXISTS active_run_deadline TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_program_schedules_active
  ON public.program_schedules(active_run_id) WHERE active_run_id IS NOT NULL;

-- ── 3. set_program_schedule v2: adds the optional per-schedule runtime
-- allowance. The old signature is dropped (CREATE OR REPLACE with a new
-- parameter list would OVERLOAD, and PostgREST rpc resolution must stay
-- unambiguous), so the REVOKE/GRANT pair is re-issued for the new signature.
DROP FUNCTION IF EXISTS public.set_program_schedule(uuid, integer, integer, text);
CREATE OR REPLACE FUNCTION public.set_program_schedule(
  p_program_id UUID,
  p_every_seconds INTEGER DEFAULT NULL,
  p_daily_at_minute INTEGER DEFAULT NULL,
  p_tz TEXT DEFAULT 'UTC',
  p_max_runtime_s INTEGER DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  p record;
  digest_hex text;
  pin text;
  lineage uuid;
  v_next timestamptz;
  v_tz text;
BEGIN
  -- Fail CLOSED under anon: the ownership check below is `<>` which is NULL (not
  -- true) when auth.uid() is NULL, so it would not raise on its own.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  IF (p_every_seconds IS NULL) = (p_daily_at_minute IS NULL) THEN
    RAISE EXCEPTION 'set exactly one of every_seconds or daily_at_minute';
  END IF;
  IF p_every_seconds IS NOT NULL AND (p_every_seconds < 300 OR p_every_seconds > 604800) THEN
    RAISE EXCEPTION 'every_seconds must be between 300 (5 min) and 604800 (7 days)';
  END IF;
  IF p_daily_at_minute IS NOT NULL AND (p_daily_at_minute < 0 OR p_daily_at_minute > 1439) THEN
    RAISE EXCEPTION 'daily_at_minute must be 0..1439';
  END IF;
  IF p_max_runtime_s IS NOT NULL AND (p_max_runtime_s < 120 OR p_max_runtime_s > 3600) THEN
    RAISE EXCEPTION 'max_runtime_s must be between 120 (2 min) and 3600 (1 hour), or null for the standard sync limit';
  END IF;
  -- A long allowance on a too-tight recurrence would overlap itself — and a
  -- 100%-duty-cycle schedule (interval == allowance) monopolizes a small
  -- runner's only slot, deterministically starving every other schedule.
  -- Require real headroom: one minimum-recurrence unit of idle time.
  IF p_max_runtime_s IS NOT NULL AND p_every_seconds IS NOT NULL AND p_every_seconds < p_max_runtime_s + 300 THEN
    RAISE EXCEPTION 'the interval must exceed max_runtime_s by at least 5 minutes of headroom';
  END IF;

  v_tz := COALESCE(NULLIF(trim(p_tz), ''), 'UTC');
  BEGIN
    PERFORM now() AT TIME ZONE v_tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'unknown timezone: %', p_tz;
  END;

  SELECT * INTO p FROM agent_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'program not found'; END IF;
  IF p.user_id <> auth.uid() THEN RAISE EXCEPTION 'not the owner'; END IF;
  IF p.status <> 'approved' OR p.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'only an approved, current program can be scheduled';
  END IF;

  digest_hex := encode(digest(convert_to(
    p.code || E'\n--lang--\n' || p.language ||
    E'\n--io--\n' || p.io_spec::text ||
    E'\n--manifest--\n' || p.manifest::text, 'UTF8'), 'sha256'), 'hex');

  SELECT sha256 INTO pin FROM program_approvals
    WHERE program_id = p.id ORDER BY approved_at DESC LIMIT 1;
  IF pin IS NULL OR pin IS DISTINCT FROM digest_hex THEN
    RAISE EXCEPTION 'the program no longer matches its approval — review and re-approve before scheduling';
  END IF;

  lineage := COALESCE(p.root_id, p.id);
  IF EXISTS (
    SELECT 1 FROM program_disables
    WHERE user_id = auth.uid() AND (name = p.name OR (root_id IS NOT NULL AND root_id = lineage))
  ) THEN
    RAISE EXCEPTION 'this program name was disabled by the user — it cannot be scheduled';
  END IF;

  v_next := program_next_run_at(p_every_seconds, p_daily_at_minute, v_tz, now());

  -- NOTE: the upsert deliberately does NOT touch active_run_* — replacing the
  -- recurrence while a long run is in flight must not orphan that run; it will
  -- settle against the updated schedule on a later tick.
  INSERT INTO program_schedules
    (user_id, program_id, root_id, name, pinned_sha256, every_seconds, daily_at_minute, tz, max_runtime_s, enabled, next_run_at, in_flight, lease_token, fail_count, paused_reason)
  VALUES
    (auth.uid(), p.id, lineage, p.name, digest_hex, p_every_seconds, p_daily_at_minute, v_tz, p_max_runtime_s, true, v_next, false, NULL, 0, NULL)
  ON CONFLICT (program_id) DO UPDATE SET
    root_id = EXCLUDED.root_id, name = EXCLUDED.name, pinned_sha256 = EXCLUDED.pinned_sha256,
    every_seconds = EXCLUDED.every_seconds, daily_at_minute = EXCLUDED.daily_at_minute, tz = EXCLUDED.tz,
    max_runtime_s = EXCLUDED.max_runtime_s,
    enabled = true, next_run_at = EXCLUDED.next_run_at, in_flight = false, lease_until = NULL, lease_token = NULL,
    fail_count = 0, paused_reason = NULL
  WHERE program_schedules.user_id = auth.uid();

  RETURN jsonb_build_object('ok', true, 'next_run_at', v_next);
END;
$$;
REVOKE ALL ON FUNCTION public.set_program_schedule(uuid, integer, integer, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_program_schedule(uuid, integer, integer, text, integer) TO authenticated;

-- ── 4. delete_program_schedule v2: deleting a schedule while a long run is in
-- flight would orphan its pending program_runs row forever (nothing left to poll
-- it). Mark it skipped first, honestly. Same signature — REPLACE keeps grants.
CREATE OR REPLACE FUNCTION public.delete_program_schedule(p_program_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  UPDATE program_runs SET status = 'skipped',
    error = 'the schedule was deleted while this run was in flight; its result was discarded'
  WHERE status = 'pending'
    AND user_id = auth.uid()
    AND id IN (SELECT active_run_id FROM program_schedules
                WHERE program_id = p_program_id AND user_id = auth.uid() AND active_run_id IS NOT NULL);
  DELETE FROM program_schedules WHERE program_id = p_program_id AND user_id = auth.uid();
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── 5. claim_due_schedules: an in-flight async run blocks re-claim. Same
-- signature — REPLACE keeps grants (service_role only).
CREATE OR REPLACE FUNCTION public.claim_due_schedules(p_limit INTEGER DEFAULT 5)
RETURNS TABLE (
  schedule_id UUID, user_id UUID, program_id UUID, tz TEXT, lease_token UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s.id
      FROM program_schedules s
      JOIN agent_programs ap ON ap.id = s.program_id
     WHERE s.enabled
       AND s.next_run_at <= now()
       AND (NOT s.in_flight OR s.lease_until < now())
       AND s.active_run_id IS NULL
       AND ap.status = 'approved'
       AND ap.superseded_by IS NULL
       AND ap.user_id = s.user_id
       AND encode(digest(convert_to(
             ap.code || E'\n--lang--\n' || ap.language ||
             E'\n--io--\n' || ap.io_spec::text ||
             E'\n--manifest--\n' || ap.manifest::text, 'UTF8'), 'sha256'), 'hex') = s.pinned_sha256
       AND NOT EXISTS (
             SELECT 1 FROM program_disables d
              WHERE d.user_id = s.user_id AND (d.name = s.name OR d.root_id = s.root_id))
     ORDER BY s.next_run_at ASC
     LIMIT GREATEST(1, LEAST(50, p_limit))
     FOR UPDATE OF s SKIP LOCKED
  )
  UPDATE program_schedules s
     SET in_flight = true,
         last_tick_at = now(),
         lease_until = now() + interval '5 minutes',
         lease_token = gen_random_uuid(),
         next_run_at = program_next_run_at(s.every_seconds, s.daily_at_minute, s.tz, now())
    FROM due
   WHERE s.id = due.id
  RETURNING s.id, s.user_id, s.program_id, s.tz, s.lease_token;
END;
$$;

-- ── 6. Async lifecycle: lease → marker → settled, each step a CAS. ────────────

-- Atomic hand-off from the claim lease to the active-run marker. Succeeds only
-- while the dispatching tick still holds its unexpired token and no other run is
-- active, so a stale tick can never mark a schedule busy. Consumes the lease.
CREATE OR REPLACE FUNCTION public.begin_async_program_run(
  p_schedule_id UUID, p_token UUID, p_run_id UUID, p_deadline TIMESTAMPTZ
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE hit int;
BEGIN
  UPDATE program_schedules SET
    active_run_id = p_run_id,
    active_run_started_at = now(),
    active_run_deadline = p_deadline,
    in_flight = false, lease_until = NULL, lease_token = NULL
  WHERE id = p_schedule_id AND lease_token = p_token AND in_flight
    AND lease_until > now() AND active_run_id IS NULL;
  GET DIAGNOSTICS hit = ROW_COUNT;
  RETURN hit = 1;
END;
$$;

-- Record a long run's outcome. CAS on the exact run id: of two overlapping ticks
-- that both fetched the result, exactly one wins and moves the fail streak /
-- auto-pause; the loser's call is a no-op returning false.
CREATE OR REPLACE FUNCTION public.settle_async_program_run(
  p_schedule_id UUID, p_run_id UUID, p_ok BOOLEAN
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE hit int;
BEGIN
  UPDATE program_schedules SET
    active_run_id = NULL, active_run_started_at = NULL, active_run_deadline = NULL,
    last_run_at = now(),
    fail_count = CASE WHEN p_ok THEN 0 ELSE fail_count + 1 END,
    enabled = CASE WHEN NOT p_ok AND fail_count + 1 >= 10 THEN false ELSE enabled END,
    paused_reason = CASE WHEN NOT p_ok AND fail_count + 1 >= 10 THEN 'auto-paused after 10 consecutive failures' ELSE paused_reason END
  WHERE id = p_schedule_id AND active_run_id = p_run_id;
  GET DIAGNOSTICS hit = ROW_COUNT;
  RETURN hit = 1;
END;
$$;

-- Clear the marker WITHOUT counting a failure — the deferral path (runner busy,
-- transiently unreachable at dispatch). The run did not happen; the next due
-- slot retries. CAS on the exact run id.
CREATE OR REPLACE FUNCTION public.abort_async_program_run(
  p_schedule_id UUID, p_run_id UUID
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE hit int;
BEGIN
  UPDATE program_schedules SET
    active_run_id = NULL, active_run_started_at = NULL, active_run_deadline = NULL
  WHERE id = p_schedule_id AND active_run_id = p_run_id;
  GET DIAGNOSTICS hit = ROW_COUNT;
  RETURN hit = 1;
END;
$$;

-- REVOKE FROM PUBLIC alone is NOT enough on Supabase: the project's default
-- privileges grant EXECUTE on new public functions to anon and authenticated as
-- ROLE-SPECIFIC ACL entries, which the PUBLIC revoke does not touch. These
-- functions have no internal authorization (service-role-only by design), so
-- the role grants must be stripped explicitly — the claim_next_ingest_job
-- convention (migration 20260626034633).
REVOKE ALL ON FUNCTION public.begin_async_program_run(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_async_program_run(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_async_program_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_async_program_run(uuid, uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_async_program_run(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.abort_async_program_run(uuid, uuid) TO service_role;

-- Re-harden the BASE tick RPCs (20260825090000) — they shipped with the same
-- REVOKE-FROM-PUBLIC-only gap, leaving default-privilege EXECUTE for anon/
-- authenticated on functions with no internal auth (e.g. autopause by bare
-- UUID, spoofing the global cron-health row). Idempotent.
REVOKE ALL ON FUNCTION public.claim_due_schedules(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reclaim_schedule_lease(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_program_schedule(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_schedule_lease(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autopause_program_schedule(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_cron_tick(boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_schedules(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_schedule_lease(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_program_schedule(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_schedule_lease(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.autopause_program_schedule(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_cron_tick(boolean, text) TO service_role;

-- ── 7. Cascade-safe skip-marking: deleting a program (the model-facing
-- delete_program verb, user-confirmed) cascades program_schedules away WITHOUT
-- passing through delete_program_schedule, which would orphan the in-flight
-- run's row as 'pending' forever. A BEFORE DELETE trigger fires on both paths.
-- SECURITY DEFINER because the cascade runs as the deleting user, who has no
-- UPDATE right on program_runs.
CREATE OR REPLACE FUNCTION public.mark_deleted_schedule_run()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.active_run_id IS NOT NULL THEN
    UPDATE program_runs SET status = 'skipped',
      error = 'the schedule was deleted while this run was in flight; its result was discarded'
    WHERE id = OLD.active_run_id AND status = 'pending';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_program_schedules_delete_marks_run ON public.program_schedules;
CREATE TRIGGER trg_program_schedules_delete_marks_run
  BEFORE DELETE ON public.program_schedules
  FOR EACH ROW EXECUTE FUNCTION public.mark_deleted_schedule_run();
REVOKE ALL ON FUNCTION public.mark_deleted_schedule_run() FROM PUBLIC, anon, authenticated;

-- ── 8. Orphan sweeper: a cron run row can be stranded 'pending' with no marker
-- pointing at it (edge-worker death between insert and any terminal write, or
-- historical cascades). Typed loss beats silent 'pending' forever; the tick
-- calls this once per run. Service-role only.
CREATE OR REPLACE FUNCTION public.sweep_orphan_cron_runs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE n int;
BEGIN
  UPDATE program_runs r SET status = 'lost',
    error = 'orphaned: the scheduler lost track of this run before it settled'
  WHERE r.mode = 'cron' AND r.status = 'pending'
    AND r.created_at < now() - interval '6 hours'
    AND NOT EXISTS (SELECT 1 FROM program_schedules s WHERE s.active_run_id = r.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.sweep_orphan_cron_runs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_orphan_cron_runs() TO service_role;