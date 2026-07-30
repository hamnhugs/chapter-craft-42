-- Memory Lens display state + Tool Foundry (agent-authored tools).
-- Idempotent: safe to run more than once.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Memory Lens: per-image recall display state
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_shown_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_last_shown_at TIMESTAMPTZ;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_last_session TEXT;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_suppressed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.image_attachments ADD COLUMN IF NOT EXISTS recall_requested_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS auto_show_memory_images BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS auto_approve_tool_updates BOOLEAN NOT NULL DEFAULT FALSE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Tools are neurons: allow entry_type 'tool' on knowledge entries
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_entry_type_check;
ALTER TABLE public.knowledge_entries ADD CONSTRAINT knowledge_entries_entry_type_check
  CHECK (entry_type IN ('concept', 'entity', 'synthesis', 'fact', 'comparison', 'summary', 'tool'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. agent_tools: the executable payloads (code + manifest + tests).
--    Clients can only INSERT drafts; approval happens exclusively through the
--    approve_tool() SECURITY DEFINER RPC below; approved rows are immutable
--    (trigger) so an approved hash can never be rug-pulled.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.agent_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  -- lineage root: first version's id (NULL on the root row itself)
  root_id UUID REFERENCES public.agent_tools(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{2,40}$'),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  code TEXT NOT NULL CHECK (char_length(code) <= 32768),
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  tests JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by UUID REFERENCES public.agent_tools(id) ON DELETE SET NULL,
  entry_id UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_user ON public.agent_tools(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_user_name ON public.agent_tools(user_id, name);

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own agent tools" ON public.agent_tools;
CREATE POLICY "Users can view own agent tools"
ON public.agent_tools FOR SELECT
USING (auth.uid() = user_id);

-- INSERT: drafts only — a client (and therefore the model driving it) can
-- never mint an approved row.
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

-- Immutability trigger: approved rows can't have their reviewed fields
-- changed, and status can only become 'approved' inside approve_tool()
-- (transaction-local GUC — set_config is not reachable through PostgREST).
CREATE OR REPLACE FUNCTION public.agent_tools_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.code IS DISTINCT FROM OLD.code
       OR NEW.manifest::text IS DISTINCT FROM OLD.manifest::text
       OR NEW.tests::text IS DISTINCT FROM OLD.tests::text
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.description IS DISTINCT FROM OLD.description THEN
      RAISE EXCEPTION 'approved tools are immutable — create a new version instead';
    END IF;
  END IF;
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'
     AND current_setting('app.tool_approval', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'tools can only be approved via approve_tool()';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_tools_guard_trigger ON public.agent_tools;
CREATE TRIGGER agent_tools_guard_trigger
BEFORE UPDATE ON public.agent_tools
FOR EACH ROW EXECUTE FUNCTION public.agent_tools_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. tool_approvals: the pin lives OUTSIDE the row it protects. No INSERT /
--    UPDATE / DELETE policies — only the SECURITY DEFINER RPC writes here.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.tool_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id UUID NOT NULL REFERENCES public.agent_tools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  sha256 TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_approvals_tool ON public.tool_approvals(tool_id);

ALTER TABLE public.tool_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own tool approvals" ON public.tool_approvals;
CREATE POLICY "Users can view own tool approvals"
ON public.tool_approvals FOR SELECT
USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. tool_runs: append-only audit. Inserted at run START (kills stay visible),
--    updated on settle. Deliberately NO DELETE policy.
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RPCs. pgcrypto digest() lives in the extensions schema on Supabase.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Server-computed fingerprint of exactly what would run: code + manifest.
-- The approval card displays THIS value; approve_tool() recomputes and
-- compares, so any mutation between review and approval is rejected. The
-- client never computes hashes (cross-language JSON canonicalization traps).
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

-- The ONLY path to status='approved'. Verifies the reviewed fingerprint,
-- refuses user-disabled lineages, supersedes the previously approved version
-- in the same transaction, and writes the immutable approvals pin.
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
  -- A USER-disabled version (disabled without being superseded) blocks the
  -- whole lineage: re-forging a banned tool under the same name must not
  -- launder it back. Re-enable in Settings first.
  IF EXISTS (
    SELECT 1 FROM agent_tools
    WHERE user_id = auth.uid()
      AND COALESCE(root_id, id) = lineage
      AND status = 'disabled' AND superseded_by IS NULL
      AND id <> t.id
  ) THEN
    RAISE EXCEPTION 'this tool was previously disabled by the user — re-enable it in Settings before approving a new version';
  END IF;
  PERFORM set_config('app.tool_approval', '1', true);
  UPDATE agent_tools SET status = 'disabled', superseded_by = t.id
    WHERE user_id = auth.uid()
      AND COALESCE(root_id, id) = lineage
      AND status = 'approved'
      AND id <> t.id;
  UPDATE agent_tools SET status = 'approved' WHERE id = t.id;
  INSERT INTO tool_approvals (tool_id, user_id, sha256) VALUES (t.id, auth.uid(), digest_hex);
  RETURN jsonb_build_object('ok', true, 'sha256', digest_hex);
END;
$$;
