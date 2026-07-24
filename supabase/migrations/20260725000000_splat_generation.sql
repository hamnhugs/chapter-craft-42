-- 3D Gaussian splat generation: AI-generated splats (fal.ai queue API) stored in
-- a private bucket, linked to knowledge entries (neurons) so the assistant can
-- reference and re-show them, plus per-user splat settings and a splats column
-- on chat messages. Mirrors the video_generation migration.
--
-- Splats are generated from an IMAGE (there is no text-to-splat endpoint), so
-- source_image_id points back at the image_attachments row it grew from.

-- 1. Private storage bucket for generated splats.
--    Path: {user_id}/{request_id}.splat|.ply|.glb, poster at {user_id}/{request_id}.jpg
INSERT INTO storage.buckets (id, name, public)
VALUES ('generated-splats', 'generated-splats', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload own generated splats"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can read own generated splats"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update own generated splats"
ON storage.objects FOR UPDATE
USING (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own generated splats"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 2. Splat generations: one row per generated asset, keyed by fal's request_id
--    (the client's source of truth for the async lifecycle).
CREATE TABLE IF NOT EXISTS public.splat_generations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  request_id      TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'fal',
  model           TEXT NOT NULL DEFAULT '',
  prompt          TEXT NOT NULL DEFAULT '',
  caption         TEXT NOT NULL DEFAULT '',
  source_image_id UUID REFERENCES public.image_attachments(id) ON DELETE SET NULL,
  entry_id        UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  storage_path    TEXT,
  poster_path     TEXT,
  -- What the bytes ACTUALLY are, verified by magic-byte sniff at finalize time.
  -- fal's TripoSplat returns a splat in a field named `model_mesh`, so the
  -- field name is never trusted.
  format          TEXT NOT NULL DEFAULT 'splat' CHECK (format IN ('splat','ply','glb')),
  mime            TEXT NOT NULL DEFAULT 'application/octet-stream',
  splat_count     INTEGER,
  file_bytes      BIGINT,
  coord_system    TEXT NOT NULL DEFAULT 'opengl' CHECK (coord_system IN ('opengl','opencv')),
  -- fal returns these on submit; preferring them over a derived path keeps the
  -- client correct across models whose queue route differs from their id.
  status_url      TEXT,
  response_url    TEXT,
  cost            NUMERIC,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_splat_gen_request ON public.splat_generations(request_id);
CREATE INDEX IF NOT EXISTS idx_splat_gen_user    ON public.splat_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_splat_gen_entry   ON public.splat_generations(entry_id);
CREATE INDEX IF NOT EXISTS idx_splat_gen_created ON public.splat_generations(user_id, created_at DESC);

ALTER TABLE public.splat_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own splat generations"
ON public.splat_generations FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own splat generations"
ON public.splat_generations FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own splat generations"
ON public.splat_generations FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own splat generations"
ON public.splat_generations FOR DELETE
USING (auth.uid() = user_id);

-- 3. Chat messages can carry splat references ([{request_id, prompt, model}]).
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS splats JSONB DEFAULT NULL;

-- 4. Per-user splat generation preferences.
--    fal_api_key is separate from openrouter_api_key: splats bill to fal.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS fal_api_key TEXT,
  ADD COLUMN IF NOT EXISTS splat_model_primary TEXT,
  ADD COLUMN IF NOT EXISTS splat_default_quality TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS splat_max_file_mb NUMERIC DEFAULT 25,
  ADD COLUMN IF NOT EXISTS splat_confirm_threshold NUMERIC DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS splat_click_to_activate BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS splat_monthly_quota INTEGER,
  ADD COLUMN IF NOT EXISTS splat_auto_fallback BOOLEAN DEFAULT true;

-- 5. Monthly quota, enforced in the database.
--    The browser-direct pattern has no server chokepoint, so this trigger is the
--    only place a runaway loop (or a leaked key used from this app) can be
--    stopped. NULL or <= 0 means unlimited.
CREATE OR REPLACE FUNCTION public.enforce_splat_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  quota INTEGER;
  used  INTEGER;
BEGIN
  SELECT splat_monthly_quota INTO quota
  FROM public.user_settings
  WHERE user_id = NEW.user_id;

  IF quota IS NULL OR quota <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO used
  FROM public.splat_generations
  WHERE user_id = NEW.user_id
    AND created_at >= date_trunc('month', now());

  IF used >= quota THEN
    RAISE EXCEPTION 'Monthly 3D generation limit of % reached', quota
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Only fresh submissions are counted. insertPendingSplat writes status
-- 'pending'; the recovery upsert in finalizeSplatJob writes 'processing' for a
-- job the user has ALREADY paid for. Without this WHEN clause, hitting the
-- quota between submit and finalize would block that recovery insert and
-- destroy a paid asset.
DROP TRIGGER IF EXISTS trg_enforce_splat_quota ON public.splat_generations;
CREATE TRIGGER trg_enforce_splat_quota
BEFORE INSERT ON public.splat_generations
FOR EACH ROW WHEN (NEW.status = 'pending')
EXECUTE FUNCTION public.enforce_splat_quota();
