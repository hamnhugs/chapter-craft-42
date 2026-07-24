-- ===== 20260727000000_video_identity.sql =====
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
  ADD COLUMN IF NOT EXISTS qc JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_video_generations_master
  ON public.video_generations(master_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='splat_generations')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname='video_generations_source_splat_id_fkey') THEN
    ALTER TABLE public.video_generations
      ADD CONSTRAINT video_generations_source_splat_id_fkey
      FOREIGN KEY (source_splat_id)
      REFERENCES public.splat_generations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='video_generations_motion_video_id_fkey') THEN
    ALTER TABLE public.video_generations
      ADD CONSTRAINT video_generations_motion_video_id_fkey
      FOREIGN KEY (motion_video_id)
      REFERENCES public.video_generations(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS video_identity_scale NUMERIC DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS video_qc_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS video_motion_model TEXT;

-- ===== 20260727000001_master_assets.sql =====
CREATE TABLE IF NOT EXISTS public.master_assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  hero_image_id    UUID REFERENCES public.image_attachments(id) ON DELETE SET NULL,
  view_image_ids   UUID[] NOT NULL DEFAULT '{}',
  splat_id         UUID,
  entry_id         UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  tech_pack_text   TEXT NOT NULL DEFAULT '',
  assembly_tag     TEXT NOT NULL DEFAULT '',
  negative_constraints TEXT[] NOT NULL DEFAULT '{}',
  banned_traits    TEXT[] NOT NULL DEFAULT '{}',
  palette          TEXT[] NOT NULL DEFAULT '{}',
  style_lock       TEXT NOT NULL DEFAULT 'custom'
                   CHECK (style_lock IN ('vector','soft_3d','live_action','custom')),
  front_azimuth_deg NUMERIC NOT NULL DEFAULT 0,
  ref_embeddings   JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_master_assets_user_name
  ON public.master_assets(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_master_assets_user
  ON public.master_assets(user_id);

ALTER TABLE public.master_assets ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.master_assets TO authenticated;
GRANT ALL ON public.master_assets TO service_role;

DROP POLICY IF EXISTS "Users can view own master assets" ON public.master_assets;
CREATE POLICY "Users can view own master assets"
ON public.master_assets FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own master assets" ON public.master_assets;
CREATE POLICY "Users can insert own master assets"
ON public.master_assets FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own master assets" ON public.master_assets;
CREATE POLICY "Users can update own master assets"
ON public.master_assets FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own master assets" ON public.master_assets;
CREATE POLICY "Users can delete own master assets"
ON public.master_assets FOR DELETE USING (auth.uid() = user_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='splat_generations')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname='master_assets_splat_id_fkey') THEN
    ALTER TABLE public.master_assets
      ADD CONSTRAINT master_assets_splat_id_fkey
      FOREIGN KEY (splat_id)
      REFERENCES public.splat_generations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='video_generations'
               AND column_name='master_id')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname='video_generations_master_id_fkey') THEN
    ALTER TABLE public.video_generations
      ADD CONSTRAINT video_generations_master_id_fkey
      FOREIGN KEY (master_id)
      REFERENCES public.master_assets(id) ON DELETE SET NULL;
  END IF;
END $$;