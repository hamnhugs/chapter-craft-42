
ALTER TABLE public.subscribers
  ADD COLUMN IF NOT EXISTS granted_by_admin_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grant_note text,
  ADD COLUMN IF NOT EXISTS granted_at timestamptz;

DROP FUNCTION IF EXISTS public.admin_list_users();

CREATE OR REPLACE FUNCTION public.admin_grant_lifetime(_user_id uuid, _note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_email text; v_existing record;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized' USING errcode = '42501'; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = _user_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'user not found'; END IF;
  SELECT plan, stripe_customer_id INTO v_existing
    FROM public.subscribers WHERE user_id = _user_id OR email = v_email
    ORDER BY updated_at DESC LIMIT 1;
  IF v_existing.plan IN ('lifetime', 'monthly') AND v_existing.stripe_customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'user has an active Stripe subscription; manage in Stripe instead';
  END IF;
  INSERT INTO public.subscribers (
    user_id, email, subscribed, plan, subscription_end, billing_issue,
    granted_by_admin_id, grant_note, granted_at, updated_at
  ) VALUES (
    _user_id, v_email, true, 'lifetime_admin', NULL, false,
    auth.uid(), _note, now(), now()
  )
  ON CONFLICT (email) DO UPDATE SET
    user_id = EXCLUDED.user_id, subscribed = true, plan = 'lifetime_admin',
    subscription_end = NULL, billing_issue = false,
    granted_by_admin_id = auth.uid(), grant_note = _note,
    granted_at = now(), updated_at = now();
  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, target_id, detail)
  VALUES (auth.uid(), 'grant_lifetime', _user_id, _user_id::text,
    jsonb_build_object('email', v_email, 'note', _note));
END; $$;

CREATE OR REPLACE FUNCTION public.admin_revoke_lifetime(_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_email text; v_plan text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized' USING errcode = '42501'; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = _user_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'user not found'; END IF;
  SELECT plan INTO v_plan FROM public.subscribers
    WHERE (user_id = _user_id OR email = v_email)
    ORDER BY updated_at DESC LIMIT 1;
  IF v_plan IS DISTINCT FROM 'lifetime_admin' THEN
    RAISE EXCEPTION 'no admin-granted lifetime to revoke';
  END IF;
  UPDATE public.subscribers
     SET subscribed = false, plan = 'free',
         granted_by_admin_id = NULL, grant_note = NULL,
         granted_at = NULL, updated_at = now()
   WHERE (user_id = _user_id OR email = v_email) AND plan = 'lifetime_admin';
  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, target_id, detail)
  VALUES (auth.uid(), 'revoke_lifetime', _user_id, _user_id::text,
    jsonb_build_object('email', v_email));
END; $$;

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE(
  id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  selected_model text, deep_research_model text, voice_model text, wiki_model text,
  openrouter_api_key text, inworld_api_key text, burplexity_api_token text,
  is_admin boolean, visits_total bigint, visits_today bigint, last_seen timestamptz,
  plan text, subscribed boolean, granted_by_admin_id uuid, subscription_end timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized' USING errcode = '42501'; END IF;
  RETURN QUERY
  SELECT u.id, u.email::text, u.created_at, u.last_sign_in_at,
    s.selected_model, s.deep_research_model, s.voice_model, s.wiki_model,
    s.openrouter_api_key, s.inworld_api_key, s.burplexity_api_token,
    public.has_role(u.id, 'admin'::public.app_role) AS is_admin,
    COALESCE(a.visits_total, 0) AS visits_total,
    COALESCE(a.visits_today, 0) AS visits_today,
    a.last_seen,
    COALESCE(sub.plan, 'free') AS plan,
    COALESCE(sub.subscribed, false) AS subscribed,
    sub.granted_by_admin_id,
    sub.subscription_end
  FROM auth.users u
  LEFT JOIN public.user_settings s ON s.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT count(*) AS visits_total,
           count(*) FILTER (WHERE e.created_at >= date_trunc('day', now())) AS visits_today,
           max(e.created_at) AS last_seen
    FROM public.activity_events e WHERE e.user_id = u.id
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT s2.plan, s2.subscribed, s2.granted_by_admin_id, s2.subscription_end
    FROM public.subscribers s2
    WHERE s2.user_id = u.id OR s2.email = u.email
    ORDER BY s2.updated_at DESC LIMIT 1
  ) sub ON true
  ORDER BY u.created_at DESC;
END; $$;

GRANT EXECUTE ON FUNCTION public.admin_grant_lifetime(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_lifetime(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;
