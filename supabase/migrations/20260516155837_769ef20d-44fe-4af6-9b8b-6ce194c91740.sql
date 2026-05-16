CREATE TABLE public.prompt_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  body text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT 'both',
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.prompt_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own prompt presets" ON public.prompt_presets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own prompt presets" ON public.prompt_presets
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own prompt presets" ON public.prompt_presets
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own prompt presets" ON public.prompt_presets
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE UNIQUE INDEX prompt_presets_one_active_per_user
  ON public.prompt_presets (user_id) WHERE is_active;

CREATE INDEX prompt_presets_user_idx ON public.prompt_presets (user_id);

CREATE TRIGGER update_prompt_presets_updated_at
  BEFORE UPDATE ON public.prompt_presets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.prompt_presets
  ADD CONSTRAINT prompt_presets_scope_check CHECK (scope IN ('both','chat','voice'));