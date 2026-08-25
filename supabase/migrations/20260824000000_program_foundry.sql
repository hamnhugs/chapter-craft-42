-- ═══════════════════════════════════════════════════════════════════════════
-- Program Foundry — AI-authored PROGRAMS (arbitrary bash/python/node) that run
-- on the user's own connected VPS, distinct from the browser-sandboxed Tool
-- Foundry (agent_tools, pure read-only QuickJS).
--
-- This schema is the trust spine. It was hardened against a 6-lens adversarial
-- design critique; the invariants below each close a CONFIRMED finding:
--
--   • Drafts are INSERT-ONLY. There is NO client UPDATE policy on agent_programs
--     at all, so the whole draft-mutation attack class is gone: a client cannot
--     rewrite a draft's code between verification and approval, cannot flip a
--     disabled row back to draft, and cannot forge the verifier verdict onto a
--     row. Every version is a fresh INSERT, exactly like forge_tool.
--   • The verifier verdict is written ONLY by the program-verify edge function
--     (service role). The guard rejects any client-supplied verified_* at INSERT
--     — otherwise a client could INSERT a draft with verifier_fingerprint already
--     set to the correct hash and verdict 'passed', forging verification.
--   • approve_program refuses unless verifier_fingerprint == the SERVER-recomputed
--     fingerprint AND the verdict is not 'failed'. A stale report cannot ride a
--     changed row (drafts are immutable, so this is belt-and-suspenders, but the
--     check is cheap and states the contract).
--   • The user's DISABLE decision is an insert-only LEDGER (program_disables),
--     written only by disable_program(). approve_program consults it by
--     name+lineage, never a mutable column, so re-forging a banned name cannot
--     launder it back.
--   • program_runs and program_approvals and program_disables carry NO client
--     write policy — only service-role edge fns / SECURITY DEFINER RPCs write
--     them, so aggregated run/fail counters and the ban ledger are unforgeable.
--
-- Applied out-of-band by Lovable (git push does not run migrations). The client
-- is dual-mode: it probes agent_programs once per session and degrades cleanly
-- when this migration has not landed.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. entry_type widening: programs mirror as a Toolshed card at APPROVAL time
-- (deferred from draft time so an unapproved description can never re-enter
-- model context via search_wiki). Mirror of 20260730120000's 'tool' widening.
ALTER TABLE public.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_entry_type_check;
ALTER TABLE public.knowledge_entries ADD CONSTRAINT knowledge_entries_entry_type_check
  CHECK (entry_type IN ('concept','entity','synthesis','fact','comparison','summary','tool','program'));

-- ── 2. user_settings: per-user VPS runner connection.
-- program_runner_signing_key is WRITE-ONLY (never SELECTed back to the browser,
-- like nvidia_api_key). The keep-trigger below stops a broad settings upsert
-- from nulling it.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS program_runner_url text,
  ADD COLUMN IF NOT EXISTS program_runner_key_id text,
  ADD COLUMN IF NOT EXISTS program_runner_signing_key text,
  ADD COLUMN IF NOT EXISTS program_runner_last4 text;

-- A partial write that omits the signing key (or sends it blank) must KEEP the
-- stored key rather than wipe it — the write-only column can only be nulled by
-- a broad upsert, and losing it silently bricks every run. COALESCE-keep.
CREATE OR REPLACE FUNCTION public.keep_program_signing_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.program_runner_signing_key IS NULL OR NEW.program_runner_signing_key = '' THEN
    NEW.program_runner_signing_key := OLD.program_runner_signing_key;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS keep_program_signing_key_trigger ON public.user_settings;
CREATE TRIGGER keep_program_signing_key_trigger
BEFORE UPDATE ON public.user_settings
FOR EACH ROW EXECUTE FUNCTION public.keep_program_signing_key();

-- ── 3. agent_programs: the program itself (code + declared execution profile).
CREATE TABLE IF NOT EXISTS public.agent_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id UUID REFERENCES public.agent_programs(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{2,40}$'),
  description TEXT NOT NULL CHECK (char_length(description) <= 300),
  language TEXT NOT NULL CHECK (language IN ('bash','python','node')),
  code TEXT NOT NULL CHECK (char_length(code) <= 65536),
  -- Declared execution profile the user approves alongside the code:
  --   { network: 'none'|'allowlist', allowed_hosts: [], timeout_ms, secrets: [names] }
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Author-supplied, user-approved oracle spec for the isolated verifier:
  --   { input_schema, examples: [{ args, expect }], invariants: [] }
  io_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by UUID REFERENCES public.agent_programs(id) ON DELETE SET NULL,
  -- Isolated-verifier verdict. Written ONLY by program-verify (service role);
  -- the guard rejects any client-supplied value at INSERT. Bound to the exact
  -- code it verified via verifier_fingerprint.
  verified_at TIMESTAMPTZ,
  verifier_fingerprint TEXT,
  verifier_report JSONB,
  -- Run health. Aggregated by the run edge fn (service role); the guard freezes
  -- everything execution-determining, so these counters are the only mutable
  -- columns and cannot smuggle a code change through.
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_programs_user_name ON public.agent_programs(user_id, name);
CREATE INDEX IF NOT EXISTS idx_agent_programs_user_created ON public.agent_programs(user_id, created_at DESC);

ALTER TABLE public.agent_programs ENABLE ROW LEVEL SECURITY;

-- SELECT / INSERT(draft only) / DELETE own. Deliberately NO UPDATE policy:
-- drafts are insert-only, and every privileged mutation goes through a
-- SECURITY DEFINER RPC or the service-role edge fn.
DROP POLICY IF EXISTS "Users can view own programs" ON public.agent_programs;
CREATE POLICY "Users can view own programs"
ON public.agent_programs FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own program drafts" ON public.agent_programs;
CREATE POLICY "Users can insert own program drafts"
ON public.agent_programs FOR INSERT WITH CHECK (auth.uid() = user_id AND status = 'draft');

DROP POLICY IF EXISTS "Users can delete own programs" ON public.agent_programs;
CREATE POLICY "Users can delete own programs"
ON public.agent_programs FOR DELETE USING (auth.uid() = user_id);

-- Belt on top of the missing UPDATE policy: even the service role's writes fire
-- this trigger, so the code/manifest/identity of any row is frozen and a client
-- cannot forge the verifier verdict at INSERT.
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
    -- The verifier verdict is the program-verify edge fn's to write, never the
    -- client's — otherwise a draft could be inserted pre-stamped as verified.
    IF NEW.verified_at IS NOT NULL OR NEW.verifier_fingerprint IS NOT NULL OR NEW.verifier_report IS NOT NULL THEN
      RAISE EXCEPTION 'verifier_* is set by program-verify, not at insert';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'programs are inserted as drafts';
    END IF;
    -- Run-health is the run edge fn's (service role) to move, so a draft can
    -- never be inserted claiming a battle-tested, zero-failure history that
    -- would sway the human approval decision. Force the genuine initial state.
    NEW.run_count := 0;
    NEW.fail_count := 0;
    NEW.last_run_at := NULL;
    RETURN NEW;
  END IF;
  -- Everything that determines what executes is immutable for the life of the
  -- row. Only run_count/fail_count/last_run_at, the verifier_* columns, status
  -- (via the GUCs below) and superseded_by (via the approval GUC) may move.
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
  -- A disabled program never comes back except through the disable RPC's own
  -- path (which does not un-disable — the ledger is permanent).
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

DROP TRIGGER IF EXISTS agent_programs_guard_trigger ON public.agent_programs;
CREATE TRIGGER agent_programs_guard_trigger
BEFORE INSERT OR UPDATE ON public.agent_programs
FOR EACH ROW EXECUTE FUNCTION public.agent_programs_guard();

-- ── 4. program_approvals: the pin lives OUTSIDE the row it protects. No write
-- policies — only approve_program() writes here.
CREATE TABLE IF NOT EXISTS public.program_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES public.agent_programs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  sha256 TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_program_approvals_program ON public.program_approvals(program_id);
ALTER TABLE public.program_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own program approvals" ON public.program_approvals;
CREATE POLICY "Users can view own program approvals"
ON public.program_approvals FOR SELECT USING (auth.uid() = user_id);

-- ── 5. program_disables: the ban ledger. Insert-only, written only by
-- disable_program(). approve_program() consults it by name+lineage.
CREATE TABLE IF NOT EXISTS public.program_disables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  root_id UUID,
  user_id UUID NOT NULL,
  disabled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_program_disables_user_name ON public.program_disables(user_id, name);
ALTER TABLE public.program_disables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own program disables" ON public.program_disables;
CREATE POLICY "Users can view own program disables"
ON public.program_disables FOR SELECT USING (auth.uid() = user_id);

-- ── 6. program_runs: append-only audit of every run AND verify. Written only by
-- the edge functions (service role), so aggregated counters cannot be forged.
CREATE TABLE IF NOT EXISTS public.program_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  program_id UUID REFERENCES public.agent_programs(id) ON DELETE SET NULL,
  sha256 TEXT,
  mode TEXT NOT NULL DEFAULT 'run' CHECK (mode IN ('run','verify')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ok','error','killed','timeout','oom','egress_blocked','sandbox_unavailable')),
  exit_code INTEGER,
  ms INTEGER,
  stdout_bytes INTEGER,
  stderr_bytes INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_program_runs_user_created ON public.program_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_runs_program ON public.program_runs(program_id, created_at DESC);
ALTER TABLE public.program_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own program runs" ON public.program_runs;
CREATE POLICY "Users can view own program runs"
ON public.program_runs FOR SELECT USING (auth.uid() = user_id);

-- ── 7. RPCs.
-- Server-computed fingerprint of exactly what would run: code + language +
-- io_spec + manifest. Everything the user approves and everything that changes
-- how the program behaves is inside the hash, so a change to the declared
-- network mode, allowed hosts, secret list, or verifier spec re-pins.
CREATE OR REPLACE FUNCTION public.program_fingerprint(p_program_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE p record;
BEGIN
  SELECT code, language, io_spec, manifest INTO p
    FROM agent_programs WHERE id = p_program_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'program not found'; END IF;
  RETURN encode(digest(convert_to(
    p.code || E'\n--lang--\n' || p.language ||
    E'\n--io--\n' || p.io_spec::text ||
    E'\n--manifest--\n' || p.manifest::text, 'UTF8'), 'sha256'), 'hex');
END;
$$;

-- The ONLY path to status='approved'. Ownership + FOR UPDATE (TOCTOU), the
-- reviewed-fingerprint check, the ban-ledger check by name+lineage, the
-- verifier binding (report must be FOR this exact fingerprint and not a
-- failure), then supersede-and-pin in one transaction.
CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid, p_expected_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  p record;
  digest_hex text;
  lineage uuid;
BEGIN
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
  -- The verifier verdict must have been produced FOR this exact code, and must
  -- not be a failure. 'inconclusive' is allowed: the user owns that decision
  -- with the visible code + profile in front of them.
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
  RETURN jsonb_build_object('ok', true, 'sha256', digest_hex);
END;
$$;

-- Permanently ban a program name+lineage. Writes the insert-only ledger and
-- disables every current version. The ledger — not a mutable column — is what
-- approve_program consults, so this survives a re-forge under the same name.
CREATE OR REPLACE FUNCTION public.disable_program(p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_root uuid;
BEGIN
  SELECT COALESCE(root_id, id) INTO v_root FROM agent_programs
    WHERE user_id = auth.uid() AND name = p_name
    ORDER BY created_at ASC LIMIT 1;
  INSERT INTO program_disables (name, root_id, user_id) VALUES (p_name, v_root, auth.uid());
  PERFORM set_config('app.program_disable', '1', true);
  UPDATE agent_programs SET status = 'disabled'
    WHERE user_id = auth.uid() AND name = p_name AND status <> 'disabled';
  RETURN jsonb_build_object('ok', true, 'name', p_name);
END;
$$;
