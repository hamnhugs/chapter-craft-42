
CREATE POLICY "Users can upload own generated images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can read own generated images"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own generated images"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-images' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE TABLE IF NOT EXISTS public.image_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  entry_id UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  source_image_id UUID REFERENCES public.image_attachments(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/png',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.image_attachments TO authenticated;
GRANT ALL ON public.image_attachments TO service_role;

CREATE INDEX IF NOT EXISTS idx_image_attachments_user ON public.image_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_image_attachments_entry ON public.image_attachments(entry_id);

ALTER TABLE public.image_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own image attachments"
ON public.image_attachments FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own image attachments"
ON public.image_attachments FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own image attachments"
ON public.image_attachments FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own image attachments"
ON public.image_attachments FOR DELETE
USING (auth.uid() = user_id);

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS images JSONB DEFAULT NULL;
