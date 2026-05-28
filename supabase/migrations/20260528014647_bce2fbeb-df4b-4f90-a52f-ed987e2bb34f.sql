CREATE TABLE public.workspace_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  saved_to_library BOOLEAN NOT NULL DEFAULT false,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workspace_items_user_created ON public.workspace_items (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_items TO authenticated;
GRANT ALL ON public.workspace_items TO service_role;

ALTER TABLE public.workspace_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own workspace_items"
  ON public.workspace_items FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own workspace_items"
  ON public.workspace_items FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own workspace_items"
  ON public.workspace_items FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own workspace_items"
  ON public.workspace_items FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER update_workspace_items_updated_at
  BEFORE UPDATE ON public.workspace_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.workspace_items REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_items;