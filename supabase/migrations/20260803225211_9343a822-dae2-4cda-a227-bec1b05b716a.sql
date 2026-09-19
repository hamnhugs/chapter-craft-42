CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS key_hash TEXT;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'key_value'
  ) THEN
    EXECUTE $sql$
      UPDATE public.api_keys
      SET key_hash = encode(extensions.digest(key_value, 'sha256'), 'hex'),
          key_prefix = left(key_value, 10)
      WHERE key_hash IS NULL AND key_value IS NOT NULL
    $sql$;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON public.api_keys (key_hash);

DROP INDEX IF EXISTS public.idx_api_keys_key_value;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS key_value;

DO $$ BEGIN
  CREATE POLICY "Users can update own PDFs"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS artifacts JSONB;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS tool_events JSONB;

COMMENT ON COLUMN public.chat_messages.artifacts IS
  'Array of {title, kind: html|svg, content} artifacts rendered with this assistant message, so the transcript survives reload. Content is size-capped client-side (ARTIFACT_MAX_CONTENT).';
COMMENT ON COLUMN public.chat_messages.tool_events IS
  'Array of {name, summary, ok} tool-event chips for this assistant message — the audit trail of what the assistant did (and what failed), which used to vanish on reload.';

CREATE TABLE IF NOT EXISTS public.generation_ledger (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('image', 'video', 'splat')),
  provider              TEXT NOT NULL DEFAULT '',
  model                 TEXT NOT NULL DEFAULT '',
  prompt_excerpt        TEXT NOT NULL DEFAULT '',
  params                JSONB,
  cost_estimate         NUMERIC,
  status                TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'accepted', 'rejected')),
  rejection_reason      TEXT CHECK (rejection_reason IS NULL OR rejection_reason IN
                          ('structural', 'identity', 'temporal', 'compositional', 'prompt_miss', 'policy', 'aesthetic')),
  master_id             UUID,
  scene_id              UUID,
  shot_number           TEXT,
  output_id             UUID,
  source_generation_id  UUID REFERENCES public.generation_ledger(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generation_ledger_user
  ON public.generation_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_ledger_model
  ON public.generation_ledger(user_id, model, status);

ALTER TABLE public.generation_ledger ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_ledger TO authenticated;
GRANT ALL ON public.generation_ledger TO service_role;

DROP POLICY IF EXISTS "Users can view own ledger rows" ON public.generation_ledger;
CREATE POLICY "Users can view own ledger rows"
ON public.generation_ledger FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own ledger rows" ON public.generation_ledger;
CREATE POLICY "Users can insert own ledger rows"
ON public.generation_ledger FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own ledger rows" ON public.generation_ledger;
CREATE POLICY "Users can update own ledger rows"
ON public.generation_ledger FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own ledger rows" ON public.generation_ledger;
CREATE POLICY "Users can delete own ledger rows"
ON public.generation_ledger FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE public.generation_ledger IS
  'Candidate → accepted/rejected record for every generation, with cost estimate and rejection taxonomy. Cost-per-accepted-shot per model is derived from this.';

ALTER TABLE public.production_scenes ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.production_scenes.locked_at IS
  'When set, the shot list is locked: numbers are immutable and shots removed by a revision persist as omitted tombstones (film-set convention, enforced client-side in preserveShotNumbers).';