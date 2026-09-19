-- MasterAsset: a locked character/asset bundle — hero image + multi-view
-- reference pack + optional 3D splat + tech pack + palette + negative
-- constraints — that generate_video loads by id or @name, so chat never has to
-- re-describe a character (the industry "saved character" pattern: identity
-- lives in the reference images, the prompt describes only motion).
--
-- SAFE TO RE-RUN: CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS before
-- CREATE POLICY, guarded DO blocks for cross-table foreign keys.

CREATE TABLE IF NOT EXISTS public.master_assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Handle used as @name in prompts. Unique per user, case-insensitive.
  name             TEXT NOT NULL,
  hero_image_id    UUID REFERENCES public.image_attachments(id) ON DELETE SET NULL,
  -- Multi-view identity pack (front / 3-4 / side / back). The back view is the
  -- highest-value member: back views are underdetermined from a front hero, so
  -- turnaround shots hallucinate without it.
  view_image_ids   UUID[] NOT NULL DEFAULT '{}',
  splat_id         UUID,
  -- Asset Factory neuron this master is documented in.
  entry_id         UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  -- Full technical spec (palette hex, body construction, joints, forbidden
  -- traits). Kept OUT of generation prompts by design — long appearance prose
  -- fights image conditioning — and used for the QC checklist instead.
  tech_pack_text   TEXT NOT NULL DEFAULT '',
  -- ONE short discriminative tag injected into prompts ("the teal-and-white
  -- cartoon robot"). Must match the reference images and never contradict them.
  assembly_tag     TEXT NOT NULL DEFAULT '',
  negative_constraints TEXT[] NOT NULL DEFAULT '{}',
  banned_traits    TEXT[] NOT NULL DEFAULT '{}',
  -- Locked palette as hex strings; drives the QC palette-drift score.
  palette          TEXT[] NOT NULL DEFAULT '{}',
  style_lock       TEXT NOT NULL DEFAULT 'custom'
                   CHECK (style_lock IN ('vector','soft_3d','live_action','custom')),
  -- Which azimuth (degrees) of the splat is "front". Splat files carry no
  -- orientation metadata; the hero image's viewpoint is front by construction
  -- for single-image reconstructors, and this records the user's correction.
  front_azimuth_deg NUMERIC NOT NULL DEFAULT 0,
  -- Cached reference embeddings for the QC scorer:
  -- { model_id, dims, vectors: { "<image_id>": number[] } }. Regenerated
  -- client-side whenever the pack changes; a cache, never a source of truth.
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
ON public.master_assets FOR SELECT
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own master assets" ON public.master_assets;
CREATE POLICY "Users can insert own master assets"
ON public.master_assets FOR INSERT
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own master assets" ON public.master_assets;
CREATE POLICY "Users can update own master assets"
ON public.master_assets FOR UPDATE
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own master assets" ON public.master_assets;
CREATE POLICY "Users can delete own master assets"
ON public.master_assets FOR DELETE
USING (auth.uid() = user_id);

-- Guarded cross-table FKs: splat_generations lives in its own migration, and
-- video_generations.master_id needs this table to exist first.
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'splat_generations')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'master_assets_splat_id_fkey') THEN
    ALTER TABLE public.master_assets
      ADD CONSTRAINT master_assets_splat_id_fkey
      FOREIGN KEY (splat_id)
      REFERENCES public.splat_generations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'video_generations'
         AND column_name = 'master_id')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'video_generations_master_id_fkey') THEN
    ALTER TABLE public.video_generations
      ADD CONSTRAINT video_generations_master_id_fkey
      FOREIGN KEY (master_id)
      REFERENCES public.master_assets(id) ON DELETE SET NULL;
  END IF;
END $$;
