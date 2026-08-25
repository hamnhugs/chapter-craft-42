-- ═══════════════════════════════════════════════════════════════════════════
-- Program Foundry — Operator tier, part 2: CRON (scheduled runs of APPROVED
-- programs). Companion to the runner-side resource ceilings (vps-runner, shipped
-- separately). Persistence and wider-egress are NOT in this migration.
--
-- Timestamped 20260825090000 so it sorts AFTER both the base migration
-- (20260824000000) and the Lovable-synced base copy (20260825082327/082755) it
-- hard-depends on — never before them.
--
-- Trust spine (each line closes an adversarial-review finding — see
-- docs/operator-tier-plan.md §0):
--   • The AI can NEVER schedule code. set_program_schedule is owner-only
--     (auth.uid(), REVOKEd from PUBLIC, explicit not-null-auth guard) and is
--     invoked from a browser click; no model-facing tool calls it. A schedule can
--     only be created for a program that is ALREADY approved, not superseded, not
--     disabled, and whose fingerprint still equals its approval pin.
--   • Authorization is re-checked INSIDE the atomic claim, never as a comment or
--     a post-hoc filter: claim_due_schedules only claims rows that STILL join to
--     an approved, non-superseded head whose INLINE-recomputed fingerprint equals
--     the stored pin AND whose lineage is not in the ban ledger. A disable or a
--     re-forge therefore stops the next tick cold.
--   • Single-flight is enforced by a per-claim LEASE TOKEN: the tick must
--     re-assert (reclaim_schedule_lease) that it still holds the token right
--     before dispatch, and settle/release only act on the matching token, so a
--     slow batch can never dispatch a schedule twice or clobber a newer claim.
--   • The runner gains NO new credential: the scheduler lives entirely here and
--     in the service-role program-cron edge fn, which dispatches via the SAME
--     HMAC/IP-pinned callRunner as program-run. pg_cron only wakes the function.
--   • claim/settle/release/reclaim/mark are REVOKEd from PUBLIC, service_role only.
--
-- Applied out-of-band by Lovable (git push does not run migrations). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. program_runs: widen the typed enums for scheduled runs. ────────────────
ALTER TABLE public.program_runs DROP CONSTRAINT IF EXISTS program_runs_mode_check;
ALTER TABLE public.program_runs ADD CONSTRAINT program_runs_mode_check
  CHECK (mode IN ('run','verify','cron'));
ALTER TABLE public.program_runs DROP CONSTRAINT IF EXISTS program_runs_status_check;
ALTER TABLE public.program_runs ADD CONSTRAINT program_runs_status_check
  CHECK (status IN ('pending','ok','error','killed','timeout','oom','egress_blocked','sandbox_unavailable','skipped'));

-- ── 2. program_schedules: one schedule per program. Recurrence is a simple,
-- computable model (interval OR daily-at-a-minute in a timezone), NOT a raw cron
-- expression. NO client write policy; every write goes through a SECURITY DEFINER
-- RPC (mirrors agent_programs).
CREATE TABLE IF NOT EXISTS public.program_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  program_id UUID NOT NULL REFERENCES public.agent_programs(id) ON DELETE CASCADE,
  root_id UUID,
  name TEXT NOT NULL,
  pinned_sha256 TEXT NOT NULL,
  every_seconds INTEGER CHECK (every_seconds IS NULL OR every_seconds BETWEEN 300 AND 604800),
  daily_at_minute INTEGER CHECK (daily_at_minute IS NULL OR daily_at_minute BETWEEN 0 AND 1439),
  tz TEXT NOT NULL DEFAULT 'UTC',
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL,
  in_flight BOOLEAN NOT NULL DEFAULT false,
  lease_until TIMESTAMPTZ,
  lease_token UUID,                    -- set per-claim; the tick must still hold it to dispatch
  last_tick_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  fail_count INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT program_schedules_one_recurrence CHECK (
    (every_seconds IS NOT NULL AND daily_at_minute IS NULL) OR
    (every_seconds IS NULL AND daily_at_minute IS NOT NULL)
  ),
  CONSTRAINT program_schedules_one_per_program UNIQUE (program_id)
);
-- Additive for re-runs against an older copy of this table.
ALTER TABLE public.program_schedules ADD COLUMN IF NOT EXISTS lease_token UUID;
CREATE INDEX IF NOT EXISTS idx_program_schedules_user ON public.program_schedules(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_schedules_due ON public.program_schedules(enabled, next_run_at);
ALTER TABLE public.program_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own program schedules" ON public.program_schedules;
CREATE POLICY "Users can view own program schedules"
ON public.program_schedules FOR SELECT USING (auth.uid() = user_id);

-- ── 3. program_cron_health: a single global liveness row for the UI badge. ────
CREATE TABLE IF NOT EXISTS public.program_cron_health (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_tick_at TIMESTAMPTZ,
  last_ok_at TIMESTAMPTZ,
  note TEXT
);
INSERT INTO public.program_cron_health (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.program_cron_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in users can read cron health" ON public.program_cron_health;
-- auth.uid() IS NOT NULL is the project's proven convention (auth.role() is
-- deprecated and, if absent, would abort the whole migration transaction).
CREATE POLICY "Signed-in users can read cron health"
ON public.program_cron_health FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── 4. next-run helper. STABLE (not IMMUTABLE): the daily branch uses
-- AT TIME ZONE, which depends on the tz database. Interval → from + N seconds
-- (fire once; missed slots skipped). Daily → next local HH:MM in tz after `from`.
CREATE OR REPLACE FUNCTION public.program_next_run_at(
  p_every INTEGER, p_daily_min INTEGER, p_tz TEXT, p_from TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  local_day DATE;
  candidate TIMESTAMPTZ;
BEGIN
  IF p_every IS NOT NULL THEN
    RETURN p_from + make_interval(secs => p_every);
  END IF;
  local_day := (p_from AT TIME ZONE p_tz)::date;
  candidate := ((local_day + make_interval(mins => p_daily_min)) AT TIME ZONE p_tz);
  IF candidate <= p_from THEN
    candidate := (((local_day + 1) + make_interval(mins => p_daily_min)) AT TIME ZONE p_tz);
  END IF;
  RETURN candidate;
END;
$$;

-- ── 5. set_program_schedule — owner-only, browser-invoked. ────────────────────
CREATE OR REPLACE FUNCTION public.set_program_schedule(
  p_program_id UUID,
  p_every_seconds INTEGER DEFAULT NULL,
  p_daily_at_minute INTEGER DEFAULT NULL,
  p_tz TEXT DEFAULT 'UTC'
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

  INSERT INTO program_schedules
    (user_id, program_id, root_id, name, pinned_sha256, every_seconds, daily_at_minute, tz, enabled, next_run_at, in_flight, lease_token, fail_count, paused_reason)
  VALUES
    (auth.uid(), p.id, lineage, p.name, digest_hex, p_every_seconds, p_daily_at_minute, v_tz, true, v_next, false, NULL, 0, NULL)
  ON CONFLICT (program_id) DO UPDATE SET
    root_id = EXCLUDED.root_id, name = EXCLUDED.name, pinned_sha256 = EXCLUDED.pinned_sha256,
    every_seconds = EXCLUDED.every_seconds, daily_at_minute = EXCLUDED.daily_at_minute, tz = EXCLUDED.tz,
    enabled = true, next_run_at = EXCLUDED.next_run_at, in_flight = false, lease_until = NULL, lease_token = NULL,
    fail_count = 0, paused_reason = NULL
  WHERE program_schedules.user_id = auth.uid();

  RETURN jsonb_build_object('ok', true, 'next_run_at', v_next);
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_program_schedule(p_program_id UUID, p_enabled BOOLEAN)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE v_next timestamptz; s record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO s FROM program_schedules WHERE program_id = p_program_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no schedule for that program'; END IF;
  IF p_enabled THEN
    v_next := program_next_run_at(s.every_seconds, s.daily_at_minute, s.tz, now());
    UPDATE program_schedules SET enabled = true, paused_reason = NULL, next_run_at = v_next,
      in_flight = false, lease_until = NULL, lease_token = NULL
      WHERE program_id = p_program_id AND user_id = auth.uid();
  ELSE
    UPDATE program_schedules SET enabled = false, paused_reason = 'paused by user'
      WHERE program_id = p_program_id AND user_id = auth.uid();
  END IF;
  RETURN jsonb_build_object('ok', true, 'enabled', p_enabled);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_program_schedule(p_program_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  DELETE FROM program_schedules WHERE program_id = p_program_id AND user_id = auth.uid();
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── 6. claim_due_schedules — the atomic heart. Service-role only. Stamps a fresh
-- lease_token per claim and returns it; the tick must reclaim (below) with that
-- token before dispatch, so a slow batch can never double-dispatch.
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

-- Re-assert the lease immediately before dispatch. Extends it only if THIS tick
-- still holds the exact token AND the lease has not lapsed. Returns true iff we
-- still own it — the caller dispatches only then, so no two ticks ever dispatch
-- the same schedule.
CREATE OR REPLACE FUNCTION public.reclaim_schedule_lease(p_schedule_id UUID, p_token UUID)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE hit int;
BEGIN
  UPDATE program_schedules SET lease_until = now() + interval '3 minutes'
   WHERE id = p_schedule_id AND lease_token = p_token AND in_flight AND lease_until > now();
  GET DIAGNOSTICS hit = ROW_COUNT;
  RETURN hit = 1;
END;
$$;

-- Settle a dispatched run (token-scoped so a stale tick can't clobber a newer
-- claim). fail_count is a STREAK; 10 consecutive real failures auto-pauses.
CREATE OR REPLACE FUNCTION public.settle_program_schedule(p_schedule_id UUID, p_token UUID, p_ok BOOLEAN)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE program_schedules SET
    in_flight = false,
    lease_until = NULL,
    lease_token = NULL,
    last_run_at = now(),
    fail_count = CASE WHEN p_ok THEN 0 ELSE fail_count + 1 END,
    enabled = CASE WHEN NOT p_ok AND fail_count + 1 >= 10 THEN false ELSE enabled END,
    paused_reason = CASE WHEN NOT p_ok AND fail_count + 1 >= 10 THEN 'auto-paused after 10 consecutive failures' ELSE paused_reason END
  WHERE id = p_schedule_id AND lease_token = p_token;
END;
$$;

-- Release a claimed schedule WITHOUT counting a failure (deferrals: rate-limited,
-- runner temporarily unreachable, a mid-tick re-approval). Token-scoped.
CREATE OR REPLACE FUNCTION public.release_schedule_lease(p_schedule_id UUID, p_token UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE program_schedules SET in_flight = false, lease_until = NULL, lease_token = NULL
  WHERE id = p_schedule_id AND lease_token = p_token;
END;
$$;

-- The owner disabled/re-forged the program: the claim will never match again, but
-- make the UI honest. Terminal, so keyed by id (not token).
CREATE OR REPLACE FUNCTION public.autopause_program_schedule(p_schedule_id UUID, p_reason TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE program_schedules SET enabled = false, in_flight = false, lease_until = NULL, lease_token = NULL,
    paused_reason = COALESCE(NULLIF(trim(p_reason), ''), 'auto-paused')
  WHERE id = p_schedule_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_cron_tick(p_ok BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE program_cron_health SET
    last_tick_at = now(),
    last_ok_at = CASE WHEN p_ok THEN now() ELSE last_ok_at END,
    note = p_note
  WHERE id = true;
END;
$$;

-- ── 7. Grants. Owner RPCs: REVOKE PUBLIC, GRANT authenticated. Tick-side RPCs:
-- REVOKE PUBLIC, GRANT service_role only.
REVOKE ALL ON FUNCTION public.set_program_schedule(uuid, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pause_program_schedule(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_program_schedule(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_program_schedule(uuid, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pause_program_schedule(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_program_schedule(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.claim_due_schedules(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reclaim_schedule_lease(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_program_schedule(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_schedule_lease(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.autopause_program_schedule(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_cron_tick(boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_schedules(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_schedule_lease(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_program_schedule(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_schedule_lease(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.autopause_program_schedule(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_cron_tick(boolean, text) TO service_role;

-- ── 8. Heartbeat (Lovable/operator step; needs pg_cron + pg_net + a Vault key).
-- The program-cron edge fn MUST be deployed with verify_jwt=false (see
-- supabase/config.toml) — its bearer is the Vault secret below, not a user JWT,
-- so the platform gateway would otherwise 401 the tick before the function runs.
--
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   CREATE EXTENSION IF NOT EXISTS pg_net;
--   -- store the same random secret in Vault AND in the edge fn's PROGRAM_CRON_KEY:
--   -- select vault.create_secret('<random>', 'program_cron_key');
--   select cron.schedule('program-cron-tick', '* * * * *', $$
--     select net.http_post(
--       url    := '<PROJECT>.functions.supabase.co/program-cron',
--       headers:= jsonb_build_object('Content-Type','application/json',
--                   'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='program_cron_key')),
--       body   := '{}'::jsonb
--     );
--   $$);
