-- Remove coins. The Store, the coin wallet, Bookworm AI and coin-bought Pro
-- passes are gone from the app; this takes their database side with them
-- (20261112120000_coins.sql) and puts my_entitlements() back to the function
-- as it stood before (20260625221021).
--
-- Re-runnable. One thing is deliberately kept: if anyone paid real money for
-- a coin pack, the ledger survives as coin_ledger_archive (service role only)
-- so those purchases can be found and refunded. With no purchases it is
-- dropped like the rest.

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

REVOKE EXECUTE ON FUNCTION public.my_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_entitlements() TO authenticated;

DROP FUNCTION IF EXISTS public.buy_pass(text);
DROP FUNCTION IF EXISTS public.claim_daily_coins();
DROP FUNCTION IF EXISTS public.my_wallet();
DROP FUNCTION IF EXISTS public.coin_apply(uuid, bigint, text, text, text, boolean);

DROP TABLE IF EXISTS public.coin_passes;
DROP TABLE IF EXISTS public.coin_wallets;

DO $$
DECLARE
  v_paid boolean := false;
BEGIN
  IF to_regclass('public.coin_ledger') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.coin_ledger WHERE kind = ''purchase'')' INTO v_paid;
  IF v_paid AND to_regclass('public.coin_ledger_archive') IS NULL THEN
    DROP POLICY IF EXISTS coin_ledger_select_own ON public.coin_ledger;
    REVOKE ALL ON public.coin_ledger FROM PUBLIC, anon, authenticated;
    ALTER TABLE public.coin_ledger RENAME TO coin_ledger_archive;
  ELSE
    DROP TABLE public.coin_ledger;
  END IF;
END $$;
