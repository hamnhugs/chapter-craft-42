-- Caller scoping for three SECURITY DEFINER helpers (found in the memory
-- audit, 2026-09-17).
--
--   • has_role(_user_id, _role) answered for ANY user id, so a signed-in user
--     could learn whether another account is an admin.
--   • accessible_wiki_ids(uid) listed ANY user's neuron ids.
--   • memory_entry_upsert(_id, _wiki_id, …) inserted the caller's entry into
--     whatever wiki id it was given, including another user's neuron.
--
-- The first two are called from RLS policies, triggers and admin functions,
-- so EXECUTE cannot simply be revoked. Instead each now answers only for:
--   – the caller themselves (uid = auth.uid()),
--   – an admin caller (the admin dashboard reads other users' roles), or
--   – the service role / triggers with no JWT (auth.uid() IS NULL).
-- Anything else FAILS CLOSED (false / no rows) rather than raising, so a
-- policy or trigger that reaches the guard in an unforeseen way denies
-- instead of erroring a whole query.
--
-- Every existing call site passes auth.uid() itself, runs inside an admin-
-- gated function, or runs without a JWT (signup triggers, check-subscription
-- via the service client), so behavior for legitimate callers is unchanged.
--
-- Idempotent: CREATE OR REPLACE with identical signatures; grants re-issued.

-- ── has_role ────────────────────────────────────────────────────────────────
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
    -- Direct read, not a recursive has_role call.
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'::public.app_role
    )
  );
$$;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

-- ── accessible_wiki_ids ─────────────────────────────────────────────────────
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

-- ── memory_entry_upsert ─────────────────────────────────────────────────────
-- Same body as 20260626032259, plus: a new entry's wiki must be the caller's
-- own (NULL = no neuron, as before). Updates never change wiki_id, and were
-- already restricted to the caller's own rows.
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
