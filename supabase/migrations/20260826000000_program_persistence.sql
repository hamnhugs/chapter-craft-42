-- ═══════════════════════════════════════════════════════════════════════════
-- Program Foundry — Operator tier, part 3: PERSISTENCE (a program can keep state
-- between its otherwise-throwaway runs, in a per-lineage directory on the VPS).
--
-- The red-team's load-bearing law (see docs/operator-tier-plan.md §3): /state is
-- keyed by LINEAGE, but approval/fingerprint/redaction key off the CURRENT
-- version — so without a fence, program v1 could stash a secret (or an
-- interpreter-runnable payload) for a benign-looking v2 of the SAME lineage to
-- read past the human gate. The fence, enforced HERE at approval time:
--   • program_state.epoch is part of the on-disk path (runner side). A NEW
--     approved version of a persist lineage gets a FRESH epoch by default (empty
--     /state) — it CANNOT silently inherit the prior version's state.
--   • Carrying state forward across a version is an explicit choice
--     (p_state_disposition = 'carry'); anything else, including the default NULL,
--     is treated as 'fresh' — the SAFE default.
-- The runner additionally redacts the FULL secrets map (not just declared names)
-- from any persist run's output, since /state may hold a secret an ancestor wrote.
--
-- Timestamped after the cron migration. Applied out-of-band by Lovable. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. program_state: one row per lineage; epoch fences /state across versions.
-- NO client write policy — only approve_program (SECURITY DEFINER) writes it.
CREATE TABLE IF NOT EXISTS public.program_state (
  root_id UUID PRIMARY KEY,          -- lineage = COALESCE(agent_programs.root_id, id)
  user_id UUID NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.program_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own program state" ON public.program_state;
CREATE POLICY "Users can view own program state"
ON public.program_state FOR SELECT USING (auth.uid() = user_id);

-- ── 2. approve_program v2: same trust checks as the base function, plus epoch
-- management for persist lineages. Replaces the 2-arg version (drop first so the
-- 2-arg named call from the client resolves to this 3-arg one with the default).
DROP FUNCTION IF EXISTS public.approve_program(uuid, text);

CREATE OR REPLACE FUNCTION public.approve_program(
  p_program_id uuid,
  p_expected_sha256 text,
  p_state_disposition text DEFAULT NULL   -- 'carry' reuses the lineage's /state; anything else = fresh (safe)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  p record;
  digest_hex text;
  lineage uuid;
  wants_persist boolean;
BEGIN
  -- Fail CLOSED under a null identity: `<>` is NULL (not TRUE) when auth.uid() is
  -- NULL, so without this an anon caller would slip past the ownership gate.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO p FROM agent_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'program not found'; END IF;
  IF p.user_id <> auth.uid() THEN RAISE EXCEPTION 'not the owner'; END IF;
  IF p.status = 'approved' THEN RETURN jsonb_build_object('ok', true, 'already', true); END IF;
  IF p.status <> 'draft' THEN RAISE EXCEPTION 'only a draft can be approved'; END IF;
  digest_hex := encode(digest(convert_to(
    p.code || E'\n--lang--\n' || p.language ||
    E'\n--io--\n' || p.io_spec::text ||
    E'\n--manifest--\n' || p.manifest::text, 'UTF8'), 'sha256'), 'hex');
  IF digest_hex IS DISTINCT FROM p_expected_sha256 THEN
    RAISE EXCEPTION 'fingerprint mismatch — the program changed since it was reviewed; review it again';
  END IF;
  lineage := COALESCE(p.root_id, p.id);
  IF EXISTS (
    SELECT 1 FROM program_disables
    WHERE user_id = auth.uid()
      AND (name = p.name OR (root_id IS NOT NULL AND root_id = lineage))
  ) THEN
    RAISE EXCEPTION 'this program name was disabled by the user — it cannot be re-approved';
  END IF;
  IF p.verifier_fingerprint IS DISTINCT FROM digest_hex THEN
    RAISE EXCEPTION 'this program has not been verified for its current code — run verification first';
  END IF;
  IF COALESCE(p.verifier_report->>'verdict', '') = 'failed' THEN
    RAISE EXCEPTION 'the isolated verifier reported a failure — fix the program and forge again';
  END IF;

  PERFORM set_config('app.program_approval', '1', true);
  UPDATE agent_programs SET status = 'disabled', superseded_by = p.id
    WHERE user_id = auth.uid()
      AND (name = p.name OR COALESCE(root_id, id) = lineage)
      AND status = 'approved'
      AND id <> p.id;
  UPDATE agent_programs SET status = 'approved' WHERE id = p.id;
  INSERT INTO program_approvals (program_id, user_id, sha256) VALUES (p.id, auth.uid(), digest_hex);

  -- Epoch fence for persist lineages. A NEW approved version gets a fresh epoch
  -- (empty /state) unless the user explicitly chose to carry the prior state
  -- forward (which may contain secrets/payloads the previous version wrote).
  wants_persist := COALESCE((p.manifest->>'persist')::boolean, false);
  IF wants_persist THEN
    INSERT INTO program_state (root_id, user_id, epoch)
      VALUES (lineage, auth.uid(), 1)
    ON CONFLICT (root_id) DO UPDATE
      SET epoch = CASE WHEN p_state_disposition = 'carry'
                       THEN program_state.epoch
                       ELSE program_state.epoch + 1 END,
          updated_at = now();
  END IF;

  RETURN jsonb_build_object('ok', true, 'sha256', digest_hex);
END;
$$;

-- Restore the base's deliberate hardening: this privileged SECURITY DEFINER RPC
-- is never callable without signing in. DROP+CREATE minted a fresh function
-- object whose ACL reverts to PUBLIC-executable, so the REVOKE the earlier
-- migration applied to the 2-arg signature must be re-applied to this 3-arg one.
REVOKE EXECUTE ON FUNCTION public.approve_program(uuid, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_program(uuid, text, text) TO authenticated;
