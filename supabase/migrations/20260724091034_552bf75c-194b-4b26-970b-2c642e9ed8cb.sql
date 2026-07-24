-- Storage policies for generated-videos bucket
DO $$ BEGIN
  CREATE POLICY "Users can upload own generated videos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can read own generated videos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update own generated videos"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete own generated videos"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'generated-videos' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- video_generations table
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.video_generations TO authenticated;
GRANT ALL ON public.video_generations TO service_role;

ALTER TABLE public.video_generations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can view own video generations"
  ON public.video_generations FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert own video generations"
  ON public.video_generations FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update own video generations"
  ON public.video_generations FOR UPDATE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete own video generations"
  ON public.video_generations FOR DELETE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS update_video_generations_updated_at ON public.video_generations;
CREATE TRIGGER update_video_generations_updated_at
  BEFORE UPDATE ON public.video_generations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Chat messages: video references
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS videos JSONB DEFAULT NULL;

-- Per-user video preferences
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS video_model_primary TEXT,
  ADD COLUMN IF NOT EXISTS saved_video_models JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS video_default_duration INTEGER,
  ADD COLUMN IF NOT EXISTS video_default_resolution TEXT,
  ADD COLUMN IF NOT EXISTS video_default_aspect TEXT,
  ADD COLUMN IF NOT EXISTS video_generate_audio BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS video_confirm_threshold NUMERIC DEFAULT 1.0;