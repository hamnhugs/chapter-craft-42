-- The production ledger + scene locking.
--
-- LEDGER. Every generation is a CANDIDATE until someone accepts it — the
-- Version/PublishedFile split real pipelines run. The row records model,
-- provider, params, estimated cost, and (on rejection) a one-tap reason, so
-- the app can surface the number no consumer tool shows: cost per ACCEPTED
-- shot, per model. Published 2026 production data: ~25% of clips are kept and
-- usable shots take ~3 generations, so per-generation sticker price is
-- meaningless without this record.
--
-- SCENE LOCK. production_scenes.locked_at implements the film-set convention:
-- after lock, shot numbers are immutable and shots cut from a revision are
-- kept as omitted tombstones (client-side preserveShotNumbers enforces both).
--
-- Idempotent: safe to re-run. Apply via Lovable chat prompt.

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

-- Scene locking
ALTER TABLE public.production_scenes ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.production_scenes.locked_at IS
  'When set, the shot list is locked: numbers are immutable and shots removed by a revision persist as omitted tombstones (film-set convention, enforced client-side in preserveShotNumbers).';
