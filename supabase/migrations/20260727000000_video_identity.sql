-- Identity-conditioned video: source linkage + conditioning parameters + QC
-- scores on video_generations, and the per-user settings that drive them.
--
-- Every column is nullable/defaulted, so EXISTING rows (pure text-to-video
-- clips) remain valid untouched and pure-text generation keeps working even if
-- this migration is never applied — the client pre-flights for these columns
-- and only refuses the NEW identity features (image_id / reference packs /
-- motion transfer / QC) until the migration runs.
--
-- SAFE TO RE-RUN: every statement is idempotent (ADD COLUMN IF NOT EXISTS,
-- guarded DO blocks for constraints).

-- 1. Source linkage + conditioning parameters on video_generations.
--    provider distinguishes the billing/API path: 'openrouter' (text +
--    image-conditioned clips) vs 'fal' (motion transfer / reference drafts,
--    billed to the separate fal key, request ids stored as 'fal:<request_id>'
--    in job_id so one unique key spans both providers).
ALTER TABLE public.video_generations
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openrouter',
  ADD COLUMN IF NOT EXISTS source_image_ids UUID[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_splat_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS master_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS condition_mode TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motion_mode TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motion_video_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS identity_scale NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS assembly_instruction TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS negative_constraints TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lock_palette TEXT[] DEFAULT NULL,
  -- Post-generation consistency scores ({ qc_version, ref_sim_mean, ... }).
  -- Advisory only: a low score warns, it never deletes a paid clip.
  ADD COLUMN IF NOT EXISTS qc JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_video_generations_master
  ON public.video_generations(master_id);

-- 2. Guarded foreign keys. source_splat_id references splat_generations, which
--    lives in its own migration — only add the FK when that table exists so
--    this migration never depends on migration ordering.
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'splat_generations')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'video_generations_source_splat_id_fkey') THEN
    ALTER TABLE public.video_generations
      ADD CONSTRAINT video_generations_source_splat_id_fkey
      FOREIGN KEY (source_splat_id)
      REFERENCES public.splat_generations(id) ON DELETE SET NULL;
  END IF;
END $$;

-- motion_video_id points at ANOTHER generated clip used as the driving video
-- for motion transfer. Self-referencing FK; deleting the driver keeps the
-- derived clip.
DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'video_generations_motion_video_id_fkey') THEN
    ALTER TABLE public.video_generations
      ADD CONSTRAINT video_generations_motion_video_id_fkey
      FOREIGN KEY (motion_video_id)
      REFERENCES public.video_generations(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Per-user identity/QC preferences.
--    video_identity_scale: default appearance-pinning strength (0-1) mapped to
--      each provider's own knob (Veo conditioningScale, Kling cfg_scale).
--    video_qc_enabled: run the client-side consistency scorer on identity-
--      conditioned clips after they finish (warn-only, never blocks).
--    video_motion_model: preferred fal motion-transfer endpoint.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS video_identity_scale NUMERIC DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS video_qc_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS video_motion_model TEXT;
