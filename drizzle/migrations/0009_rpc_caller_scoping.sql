CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
  AND (
    auth.uid() IS NULL
    OR _user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'::public.app_role
    )
  );
$$;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.accessible_wiki_ids(uid UUID)
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id FROM public.wikis w
  WHERE w.user_id = uid
    AND (
      auth.uid() IS NULL
      OR uid = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = auth.uid() AND r.role = 'admin'::public.app_role
      )
    )
    AND (
      public.app_open_access()
      OR public.has_role(uid, 'admin'::public.app_role)
      OR (SELECT COALESCE(bool_or(s.subscribed), false)
            FROM public.subscribers s WHERE s.user_id = uid)
      OR w.id = (SELECT w2.id FROM public.wikis w2
                  WHERE w2.user_id = uid
                  ORDER BY w2.created_at ASC, w2.id ASC
                  LIMIT 1)
    );
$$;
REVOKE EXECUTE ON FUNCTION public.accessible_wiki_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accessible_wiki_ids(uuid) TO authenticated, service_role;

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
    IF _wiki_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.wikis w WHERE w.id = _wiki_id AND w.user_id = v_uid
    ) THEN
      RAISE EXCEPTION 'wiki not found or not owned by current user' USING errcode='42501';
    END IF;
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