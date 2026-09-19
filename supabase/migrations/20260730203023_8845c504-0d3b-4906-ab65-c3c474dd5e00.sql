-- Memory Lens display state + Tool Foundry (agent-authored tools).
-- Idempotent: safe to run more than once.

ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_shown_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_last_shown_at TIMESTAMPTZ;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_last_session TEXT;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_suppressed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_requested_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS auto_show_memory_images BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS auto_approve_tool_updates BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_entry_type_check;
ALTER TABLE public.knowledge_entries ADD CONSTRAINT knowledge_entries_entry_type_check
  CHECK (entry_type IN ('concept', 'entity', 'synthesis', 'fact', 'comparison', 'summary', 'tool'));

CREATE TABLE IF NOT EXISTS public.agent_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  root_id UUID REFERENCES public.agent_tools(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{2,40}$'),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  code TEXT NOT NULL CHECK (char_length(code) <= 32768),
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  tests JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'disabled')),
  disabled_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by UUID REFERENCES public.agent_tools(id) ON DELETE SET NULL,
  entry_id UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_tools TO authenticated;
GRANT ALL ON public.agent_tools TO service_role;

CREATE INDEX IF NOT EXISTS idx_agent_tools_user ON public.agent_tools(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_user_name ON public.agent_tools(user_id, name);

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own agent tools" ON public.agent_tools;
CREATE POLICY "Users can view own agent tools"
ON public.agent_tools FOR SELECT
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own draft tools" ON public.agent_tools;
CREATE POLICY "Users can insert own draft tools"
ON public.agent_tools FOR INSERT
WITH CHECK (auth.uid() = user_id AND status = 'draft');

DROP POLICY IF EXISTS "Users can update own agent tools" ON public.agent_tools;
CREATE POLICY "Users can update own agent tools"
ON public.agent_tools FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own agent tools" ON public.agent_tools;
CREATE POLICY "Users can delete own agent tools"
ON public.agent_tools FOR DELETE
USING (auth.uid() = user_id);

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

DROP TRIGGER IF EXISTS agent_tools_guard_trigger ON public.agent_tools;
CREATE TRIGGER agent_tools_guard_trigger
BEFORE INSERT OR UPDATE ON public.agent_tools
FOR EACH ROW EXECUTE FUNCTION public.agent_tools_guard();

CREATE TABLE IF NOT EXISTS public.tool_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id UUID NOT NULL REFERENCES public.agent_tools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  sha256 TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tool_approvals TO authenticated;
GRANT ALL ON public.tool_approvals TO service_role;

CREATE INDEX IF NOT EXISTS idx_tool_approvals_tool ON public.tool_approvals(tool_id);

ALTER TABLE public.tool_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own tool approvals" ON public.tool_approvals;
CREATE POLICY "Users can view own tool approvals"
ON public.tool_approvals FOR SELECT
USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.tool_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tool_id UUID REFERENCES public.agent_tools(id) ON DELETE SET NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error', 'killed')),
  ms INTEGER,
  capability_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.tool_runs TO authenticated;
GRANT ALL ON public.tool_runs TO service_role;

CREATE INDEX IF NOT EXISTS idx_tool_runs_user_created ON public.tool_runs(user_id, created_at DESC);

ALTER TABLE public.tool_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own tool runs" ON public.tool_runs;
CREATE POLICY "Users can view own tool runs"
ON public.tool_runs FOR SELECT
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own tool runs" ON public.tool_runs;
CREATE POLICY "Users can insert own tool runs"
ON public.tool_runs FOR INSERT
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own tool runs" ON public.tool_runs;
CREATE POLICY "Users can update own tool runs"
ON public.tool_runs FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.tool_runs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS tool_runs_guard_trigger ON public.tool_runs;
CREATE TRIGGER tool_runs_guard_trigger
BEFORE UPDATE ON public.tool_runs
FOR EACH ROW EXECUTE FUNCTION public.tool_runs_guard();

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.tool_fingerprint(p_tool_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE t record;
BEGIN
  SELECT code, manifest INTO t FROM agent_tools WHERE id = p_tool_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'tool not found'; END IF;
  RETURN encode(digest(convert_to(t.code || E'\n--manifest--\n' || t.manifest::text, 'UTF8'), 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_tool(p_tool_id uuid, p_expected_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  t record;
  digest_hex text;
  lineage uuid;
BEGIN
  SELECT * INTO t FROM agent_tools WHERE id = p_tool_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'tool not found'; END IF;
  IF t.status = 'approved' THEN RETURN jsonb_build_object('ok', true, 'already', true); END IF;
  digest_hex := encode(digest(convert_to(t.code || E'\n--manifest--\n' || t.manifest::text, 'UTF8'), 'sha256'), 'hex');
  IF digest_hex IS DISTINCT FROM p_expected_sha256 THEN
    RAISE EXCEPTION 'fingerprint mismatch — the tool changed since it was reviewed; review it again';
  END IF;
  lineage := COALESCE(t.root_id, t.id);
  IF EXISTS (
    SELECT 1 FROM agent_tools
    WHERE user_id = auth.uid()
      AND disabled_by_user
      AND (name = t.name OR COALESCE(root_id, id) = lineage)
      AND id <> t.id
  ) THEN
    RAISE EXCEPTION 'this tool was previously disabled by the user — re-enable it in Settings before approving a new version';
  END IF;
  PERFORM set_config('app.tool_approval', '1', true);
  UPDATE agent_tools SET status = 'disabled', superseded_by = t.id
    WHERE user_id = auth.uid()
      AND (name = t.name OR COALESCE(root_id, id) = lineage)
      AND status = 'approved'
      AND id <> t.id;
  UPDATE agent_tools SET status = 'approved' WHERE id = t.id;
  INSERT INTO tool_approvals (tool_id, user_id, sha256) VALUES (t.id, auth.uid(), digest_hex);
  RETURN jsonb_build_object('ok', true, 'sha256', digest_hex);
END;
$$;

REVOKE ALL ON FUNCTION public.tool_fingerprint(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_tool(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tool_fingerprint(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_tool(uuid, text) TO authenticated;