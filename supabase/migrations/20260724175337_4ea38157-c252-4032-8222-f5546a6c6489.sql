-- ============================================================
-- Part 1: Splat generation (idempotent; bucket already exists)
-- ============================================================

DROP POLICY IF EXISTS "Users can upload own generated splats" ON storage.objects;
CREATE POLICY "Users can upload own generated splats"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users can read own generated splats" ON storage.objects;
CREATE POLICY "Users can read own generated splats"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users can update own generated splats" ON storage.objects;
CREATE POLICY "Users can update own generated splats"
ON storage.objects FOR UPDATE
USING (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users can delete own generated splats" ON storage.objects;
CREATE POLICY "Users can delete own generated splats"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-splats' AND auth.uid()::text = (storage.foldername(name))[1]);

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
  format          TEXT NOT NULL DEFAULT 'splat' CHECK (format IN ('splat','ply','glb')),
  mime            TEXT NOT NULL DEFAULT 'application/octet-stream',
  splat_count     INTEGER,
  file_bytes      BIGINT,
  coord_system    TEXT NOT NULL DEFAULT 'opengl' CHECK (coord_system IN ('opengl','opencv')),
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.splat_generations TO authenticated;
GRANT ALL ON public.splat_generations TO service_role;

DROP POLICY IF EXISTS "Users can view own splat generations" ON public.splat_generations;
CREATE POLICY "Users can view own splat generations"
ON public.splat_generations FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own splat generations" ON public.splat_generations;
CREATE POLICY "Users can insert own splat generations"
ON public.splat_generations FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own splat generations" ON public.splat_generations;
CREATE POLICY "Users can update own splat generations"
ON public.splat_generations FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own splat generations" ON public.splat_generations;
CREATE POLICY "Users can delete own splat generations"
ON public.splat_generations FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS splats JSONB DEFAULT NULL;

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS fal_api_key TEXT,
  ADD COLUMN IF NOT EXISTS splat_model_primary TEXT,
  ADD COLUMN IF NOT EXISTS splat_default_quality TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS splat_max_file_mb NUMERIC DEFAULT 25,
  ADD COLUMN IF NOT EXISTS splat_confirm_threshold NUMERIC DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS splat_click_to_activate BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS splat_monthly_quota INTEGER,
  ADD COLUMN IF NOT EXISTS splat_auto_fallback BOOLEAN DEFAULT true;

CREATE OR REPLACE FUNCTION public.enforce_splat_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE quota INTEGER; used INTEGER;
BEGIN
  SELECT splat_monthly_quota INTO quota FROM public.user_settings WHERE user_id = NEW.user_id;
  IF quota IS NULL OR quota <= 0 THEN RETURN NEW; END IF;
  SELECT COUNT(*) INTO used FROM public.splat_generations
    WHERE user_id = NEW.user_id AND created_at >= date_trunc('month', now());
  IF used >= quota THEN
    RAISE EXCEPTION 'Monthly 3D generation limit of % reached', quota USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_enforce_splat_quota ON public.splat_generations;
CREATE TRIGGER trg_enforce_splat_quota
BEFORE INSERT ON public.splat_generations
FOR EACH ROW WHEN (NEW.status = 'pending')
EXECUTE FUNCTION public.enforce_splat_quota();

-- ============================================================
-- Part 2: User FK cleanup (cascade deletes on account removal)
-- ============================================================

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'api_keys', 'consolidation_queue', 'conversation_memory', 'episodic_log',
    'image_attachments', 'incubator_entries', 'knowledge_conflicts',
    'knowledge_entries', 'memory_graph', 'notes', 'prompt_presets',
    'reroute_suggestions', 'routing_decisions', 'splat_generations',
    'video_generations', 'wiki_centroids', 'wiki_health_alerts', 'wiki_proposals'
  ];
  has_col boolean; has_fk boolean; added int := 0;
BEGIN
  FOREACH t IN ARRAY targets LOOP
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='user_id') INTO has_col;
    IF NOT has_col THEN CONTINUE; END IF;
    SELECT EXISTS (SELECT 1 FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE c.contype='f' AND n.nspname='public' AND rel.relname=t
        AND c.confrelid = 'auth.users'::regclass) INTO has_fk;
    IF has_fk THEN CONTINUE; END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) '
      || 'REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID',
      t, t || '_user_id_fkey');
    added := added + 1;
  END LOOP;
  RAISE NOTICE 'user FK cleanup: % constraint(s) added', added;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT rel.relname AS tbl, c.conname AS con
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE c.contype='f' AND NOT c.convalidated
      AND n.nspname='public' AND c.confrelid = 'auth.users'::regclass
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.tbl, r.con);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'public.% holds orphaned user_id rows; left unvalidated', r.tbl;
    END;
  END LOOP;
END $$;