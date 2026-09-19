
-- 1. book_folders
CREATE TABLE public.book_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_id uuid REFERENCES public.book_folders(id) ON DELETE CASCADE,
  color text,
  sort_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.book_folders TO authenticated;
GRANT ALL ON public.book_folders TO service_role;
ALTER TABLE public.book_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner full access" ON public.book_folders FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX book_folders_user_idx ON public.book_folders(user_id, sort_index);
CREATE TRIGGER book_folders_updated_at BEFORE UPDATE ON public.book_folders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. books.folder_id
ALTER TABLE public.books ADD COLUMN folder_id uuid REFERENCES public.book_folders(id) ON DELETE SET NULL;
CREATE INDEX books_folder_idx ON public.books(user_id, folder_id);

-- 3. ingest_jobs
CREATE TABLE public.ingest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wiki_id uuid REFERENCES public.wikis(id) ON DELETE CASCADE,
  book_id uuid REFERENCES public.books(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.book_folders(id) ON DELETE SET NULL,
  model text,
  status text NOT NULL DEFAULT 'queued',
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingest_jobs TO authenticated;
GRANT ALL ON public.ingest_jobs TO service_role;
ALTER TABLE public.ingest_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner full access" ON public.ingest_jobs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ingest_jobs_user_idx ON public.ingest_jobs(user_id, status, updated_at DESC);
CREATE TRIGGER ingest_jobs_updated_at BEFORE UPDATE ON public.ingest_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. user_settings new columns
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS library_ingest_model text,
  ADD COLUMN IF NOT EXISTS library_ingest_auto_file boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS image_model_primary text,
  ADD COLUMN IF NOT EXISTS image_model_fallback text,
  ADD COLUMN IF NOT EXISTS image_quality text,
  ADD COLUMN IF NOT EXISTS image_size text,
  ADD COLUMN IF NOT EXISTS saved_image_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS chat_tool_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 5. memory edge upsert/delete
CREATE OR REPLACE FUNCTION public.memory_edge_upsert(
  _source uuid, _target uuid, _relationship text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING errcode='42501'; END IF;
  -- ownership check
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_entries WHERE id = _source AND user_id = v_uid)
     OR NOT EXISTS (SELECT 1 FROM public.knowledge_entries WHERE id = _target AND user_id = v_uid) THEN
    RAISE EXCEPTION 'entry not owned by current user';
  END IF;
  INSERT INTO public.memory_graph (user_id, source_entry_id, target_entry_id, relationship)
  VALUES (v_uid, _source, _target, _relationship)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.memory_graph
     WHERE user_id = v_uid AND source_entry_id = _source AND target_entry_id = _target;
  END IF;
  RETURN v_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.memory_edge_upsert(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.memory_edge_upsert(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.memory_edge_delete(_source uuid, _target uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING errcode='42501'; END IF;
  DELETE FROM public.memory_graph
   WHERE user_id = v_uid
     AND ((source_entry_id = _source AND target_entry_id = _target)
       OR (source_entry_id = _target AND target_entry_id = _source));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
REVOKE EXECUTE ON FUNCTION public.memory_edge_delete(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.memory_edge_delete(uuid,uuid) TO authenticated;

-- 6. memory entry upsert (create or update by id)
CREATE OR REPLACE FUNCTION public.memory_entry_upsert(
  _id uuid,
  _wiki_id uuid,
  _title text,
  _content text,
  _entry_type text,
  _tags text[],
  _confidence double precision
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING errcode='42501'; END IF;
  IF _id IS NULL THEN
    INSERT INTO public.knowledge_entries (
      user_id, wiki_id, title, content, entry_type, tags, confidence, folder, maturity
    ) VALUES (
      v_uid, _wiki_id,
      coalesce(_title,'Untitled'),
      coalesce(_content,''),
      coalesce(_entry_type,'note'),
      coalesce(_tags, ARRAY[]::text[]),
      coalesce(_confidence, 0.7),
      'wiki', 'draft'
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.knowledge_entries SET
      title = coalesce(_title, title),
      content = coalesce(_content, content),
      entry_type = coalesce(_entry_type, entry_type),
      tags = coalesce(_tags, tags),
      confidence = coalesce(_confidence, confidence),
      updated_at = now()
    WHERE id = _id AND user_id = v_uid
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'entry not found or not owned by current user'; END IF;
  END IF;
  RETURN v_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.memory_entry_upsert(uuid,uuid,text,text,text,text[],double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.memory_entry_upsert(uuid,uuid,text,text,text,text[],double precision) TO authenticated;
