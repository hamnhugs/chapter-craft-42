-- Video generation: AI-generated video clips (OpenRouter /api/v1/videos) stored
-- in a private bucket, linked to knowledge entries (neurons) so the assistant
-- can reference and re-show them, plus per-user video settings and a videos
-- column on chat messages. Mirrors the image_memory migration.
--
-- NOTE: distinct from the existing `video_jobs` table (YouTube -> transcript).

-- 1. Private storage bucket for generated videos (path: {user_id}/{uuid}.mp4,
--    poster at {user_id}/{uuid}.jpg).
INSERT INTO storage.buckets (id, name, public)
VALUES ('generated-videos', 'generated-videos', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload own generated videos"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can read own generated videos"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own generated videos"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 2. Video generations: one row per generated clip, keyed by the OpenRouter
--    job id (the client's source of truth for the async lifecycle). entry_id
--    links the clip to a neuron; deleting the neuron keeps the clip (SET NULL).
CREATE TABLE IF NOT EXISTS public.video_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  job_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  entry_id UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  storage_path TEXT,
  poster_path TEXT,
  mime TEXT NOT NULL DEFAULT 'video/mp4',
  duration_s INTEGER,
  resolution TEXT,
  aspect_ratio TEXT,
  has_audio BOOLEAN,
  cost NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_generations_job ON public.video_generations(job_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_user ON public.video_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_video_generations_entry ON public.video_generations(entry_id);

ALTER TABLE public.video_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own video generations"
ON public.video_generations FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own video generations"
ON public.video_generations FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own video generations"
ON public.video_generations FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own video generations"
ON public.video_generations FOR DELETE
USING (auth.uid() = user_id);

-- 3. Chat messages can carry video references (array of {job_id, prompt, model}).
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS videos JSONB DEFAULT NULL;

-- 4. Per-user video generation preferences.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS video_model_primary TEXT,
  ADD COLUMN IF NOT EXISTS saved_video_models JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS video_default_duration INTEGER,
  ADD COLUMN IF NOT EXISTS video_default_resolution TEXT,
  ADD COLUMN IF NOT EXISTS video_default_aspect TEXT,
  ADD COLUMN IF NOT EXISTS video_generate_audio BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS video_confirm_threshold NUMERIC DEFAULT 1.0;
