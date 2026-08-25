-- ═══════════════════════════════════════════════════════════════════════════
-- Program Foundry — AI-authored PROGRAMS that run on the user's own VPS.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_entry_type_check;
ALTER TABLE public.knowledge_entries ADD CONSTRAINT knowledge_entries_entry_type_check
  CHECK (entry_type IN ('concept','entity','synthesis','fact','comparison','summary','tool','program'));

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS program_runner_url text,
  ADD COLUMN IF NOT EXISTS program_runner_key_id text,
  ADD COLUMN IF NOT EXISTS program_runner_signing_key text,
  ADD COLUMN IF NOT EXISTS program_runner_last4 text;

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

CREATE TABLE IF NOT EXISTS public.agent_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id UUID REFERENCES public.agent_programs(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{2,40}$'),
  description TEXT NOT NULL CHECK (char_length(description) <= 300),
  language TEXT NOT NULL CHECK (language IN ('bash','python','node')),
  code TEXT NOT NULL CHECK (char_length(code) <= 65536),
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  io_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by UUID REFERENCES public.agent_programs(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  verifier_fingerprint TEXT,
  verifier_report JSONB,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_programs_user_name ON public.agent_programs(user_id, name);
CREATE INDEX IF NOT EXISTS idx_agent_programs_user_created ON public.agent_programs(user_id, created_at DESC);

ALTER TABLE public.agent_programs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own programs" ON public.agent_programs;
CREATE POLICY "Users can view own programs"
ON public.agent_programs FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own program drafts" ON public.agent_programs;
CREATE POLICY "Users can insert own program drafts"
ON public.agent_programs FOR INSERT WITH CHECK (auth.uid() = user_id AND status = 'draft');

DROP POLICY IF EXISTS "Users can delete own programs" ON public.agent_programs;
CREATE POLICY "Users can delete own programs"
ON public.agent_programs FOR DELETE USING (auth.uid() = user_id);

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

DROP TRIGGER IF EXISTS agent_programs_guard_trigger ON public.agent_programs;
CREATE TRIGGER agent_programs_guard_trigger
BEFORE INSERT OR UPDATE ON public.agent_programs
FOR EACH ROW EXECUTE FUNCTION public.agent_programs_guard();

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