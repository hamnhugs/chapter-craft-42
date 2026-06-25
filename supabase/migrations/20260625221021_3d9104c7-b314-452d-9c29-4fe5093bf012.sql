
-- 0) Widen plan check to include lifetime_admin
ALTER TABLE public.subscribers DROP CONSTRAINT IF EXISTS subscribers_plan_check;
ALTER TABLE public.subscribers
  ADD CONSTRAINT subscribers_plan_check
  CHECK (plan IN ('free','monthly','lifetime','lifetime_admin'));

-- 1) Backfill admins
INSERT INTO public.subscribers (user_id, email, subscribed, plan, billing_issue, granted_at, updated_at)
SELECT ur.user_id, u.email, true, 'lifetime_admin', false, now(), now()
FROM public.user_roles ur
JOIN auth.users u ON u.id = ur.user_id
WHERE ur.role = 'admin'
ON CONFLICT (email) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  subscribed = true,
  plan = 'lifetime_admin',
  billing_issue = false,
  subscription_end = NULL,
  updated_at = now()
WHERE public.subscribers.plan NOT IN ('lifetime','monthly')
   OR public.subscribers.stripe_customer_id IS NULL;

-- 2) Trigger: auto-grant on future admin role inserts
CREATE OR REPLACE FUNCTION public.grant_admin_lifetime_on_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email text;
BEGIN
  IF NEW.role <> 'admin'::public.app_role THEN RETURN NEW; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = NEW.user_id;
  IF v_email IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.subscribers (user_id, email, subscribed, plan, billing_issue, granted_at, updated_at)
  VALUES (NEW.user_id, v_email, true, 'lifetime_admin', false, now(), now())
  ON CONFLICT (email) DO UPDATE SET
    user_id = EXCLUDED.user_id, subscribed = true, plan = 'lifetime_admin',
    billing_issue = false, subscription_end = NULL, updated_at = now()
  WHERE public.subscribers.plan NOT IN ('lifetime','monthly')
     OR public.subscribers.stripe_customer_id IS NULL;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_grant_admin_lifetime_on_role ON public.user_roles;
CREATE TRIGGER trg_grant_admin_lifetime_on_role
AFTER INSERT ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.grant_admin_lifetime_on_role();

-- 3) Single-source entitlements RPC
CREATE OR REPLACE FUNCTION public.my_entitlements()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_sub record;
  v_oldest_wiki uuid;
  v_locked uuid[];
  v_is_paid boolean;
  v_plan text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('is_admin',false,'plan','free','subscribed',false,
      'is_paid',false,'billing_issue',false,'subscription_end',NULL,
      'cancel_at_period_end',false,'locked_wiki_ids','[]'::jsonb);
  END IF;
  v_is_admin := public.has_role(v_uid, 'admin'::public.app_role);
  IF v_is_admin THEN
    RETURN jsonb_build_object('is_admin',true,'plan','lifetime_admin','subscribed',true,
      'is_paid',true,'billing_issue',false,'subscription_end',NULL,
      'cancel_at_period_end',false,'locked_wiki_ids','[]'::jsonb);
  END IF;
  SELECT plan, subscribed, billing_issue, subscription_end INTO v_sub
  FROM public.subscribers WHERE user_id = v_uid
  ORDER BY updated_at DESC LIMIT 1;
  v_plan := COALESCE(v_sub.plan, 'free');
  v_is_paid := COALESCE(v_sub.subscribed, false) AND v_plan <> 'free';
  IF NOT v_is_paid THEN
    SELECT id INTO v_oldest_wiki FROM public.wikis WHERE user_id = v_uid
     ORDER BY created_at ASC, id ASC LIMIT 1;
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_locked
    FROM public.wikis WHERE user_id = v_uid
      AND id <> COALESCE(v_oldest_wiki, '00000000-0000-0000-0000-000000000000'::uuid);
  ELSE
    v_locked := ARRAY[]::uuid[];
  END IF;
  RETURN jsonb_build_object('is_admin',false,'plan',v_plan,
    'subscribed',COALESCE(v_sub.subscribed,false),'is_paid',v_is_paid,
    'billing_issue',COALESCE(v_sub.billing_issue,false),
    'subscription_end',v_sub.subscription_end,'cancel_at_period_end',false,
    'locked_wiki_ids', to_jsonb(v_locked));
END; $$;

GRANT EXECUTE ON FUNCTION public.my_entitlements() TO authenticated;
