-- Coins: a prepaid balance for the built-in AI ("Bookworm AI"), plus Pro
-- passes bought with it.
--
-- Shape:
--   coin_wallets  one row per user, the current balance.
--   coin_ledger   append-only history; every balance change has a row. `ref`
--                 is the idempotency key (a Stripe session id, a welcome or
--                 daily marker) — unique, so the same event can never credit
--                 twice however many times it is replayed.
--   coin_passes   time-boxed Pro access bought with coins.
--
-- Clients can READ their own rows and nothing else. Every write goes through
-- a SECURITY DEFINER function: coin_apply (service role only — the edge
-- functions that verify payments and meter AI usage), or one of the three
-- caller-scoped RPCs below, each of which decides its own amounts. No client
-- ever names a number of coins.

CREATE TABLE IF NOT EXISTS public.coin_wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_purchased bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coin_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta bigint NOT NULL,
  balance_after bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('welcome', 'daily', 'purchase', 'spend_ai', 'spend_pass', 'admin', 'refund')),
  ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coin_ledger_ref_key ON public.coin_ledger (ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS coin_ledger_user_created ON public.coin_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.coin_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coin_passes_user_expires ON public.coin_passes (user_id, expires_at DESC);

ALTER TABLE public.coin_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_passes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coin_wallets_select_own ON public.coin_wallets;
CREATE POLICY coin_wallets_select_own ON public.coin_wallets
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS coin_ledger_select_own ON public.coin_ledger;
CREATE POLICY coin_ledger_select_own ON public.coin_ledger
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS coin_passes_select_own ON public.coin_passes;
CREATE POLICY coin_passes_select_own ON public.coin_passes
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.coin_wallets, public.coin_ledger, public.coin_passes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.coin_wallets, public.coin_ledger, public.coin_passes TO authenticated;
GRANT ALL ON public.coin_wallets, public.coin_ledger, public.coin_passes TO service_role;

-- The one writer. Positive delta credits, negative debits.
--   _ref    idempotency key: a replay returns the current balance untouched.
--   _clamp  a debit larger than the balance takes what is there instead of
--           failing — for metered usage, where the work already happened.
CREATE OR REPLACE FUNCTION public.coin_apply(
  _user_id uuid,
  _delta bigint,
  _kind text,
  _ref text DEFAULT NULL,
  _note text DEFAULT NULL,
  _clamp boolean DEFAULT false
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_bal bigint;
  v_delta bigint := _delta;
BEGIN
  INSERT INTO public.coin_wallets (user_id) VALUES (_user_id) ON CONFLICT (user_id) DO NOTHING;
  -- The row lock serializes every change to one wallet, so the replay check
  -- below cannot race a concurrent call carrying the same ref.
  SELECT balance INTO v_bal FROM public.coin_wallets WHERE user_id = _user_id FOR UPDATE;
  IF _ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.coin_ledger WHERE ref = _ref) THEN
    RETURN v_bal;
  END IF;
  IF v_bal + v_delta < 0 THEN
    IF _clamp THEN
      v_delta := -v_bal;
    ELSE
      RAISE EXCEPTION 'insufficient_coins' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF v_delta = 0 THEN
    RETURN v_bal;
  END IF;
  UPDATE public.coin_wallets
     SET balance = v_bal + v_delta,
         lifetime_purchased = lifetime_purchased + CASE WHEN _kind = 'purchase' THEN v_delta ELSE 0 END,
         updated_at = now()
   WHERE user_id = _user_id;
  INSERT INTO public.coin_ledger (user_id, delta, balance_after, kind, ref, note)
  VALUES (_user_id, v_delta, v_bal + v_delta, _kind, _ref, left(_note, 300));
  RETURN v_bal + v_delta;
END; $$;

REVOKE ALL ON FUNCTION public.coin_apply(uuid, bigint, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coin_apply(uuid, bigint, text, text, text, boolean) TO service_role;

-- The caller's wallet. First call opens it with the welcome grant.
CREATE OR REPLACE FUNCTION public.my_wallet()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_bal bigint;
  v_welcome constant bigint := 100;
  v_pass timestamptz;
  v_today text := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD');
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('balance', 0, 'daily_available', false, 'pass_until', NULL);
  END IF;
  v_bal := public.coin_apply(v_uid, v_welcome, 'welcome', 'welcome:' || v_uid::text, 'Welcome coins');
  SELECT max(expires_at) INTO v_pass FROM public.coin_passes WHERE user_id = v_uid AND expires_at > now();
  RETURN jsonb_build_object(
    'balance', v_bal,
    'daily_available', NOT EXISTS (
      SELECT 1 FROM public.coin_ledger WHERE ref = 'daily:' || v_uid::text || ':' || v_today
    ),
    'pass_until', v_pass
  );
END; $$;

-- One small free top-up per UTC day.
CREATE OR REPLACE FUNCTION public.claim_daily_coins()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_daily constant bigint := 10;
  v_ref text;
  v_before bigint;
  v_after bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  v_ref := 'daily:' || v_uid::text || ':' || to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD');
  SELECT balance INTO v_before FROM public.coin_wallets WHERE user_id = v_uid;
  v_after := public.coin_apply(v_uid, v_daily, 'daily', v_ref, 'Daily coins');
  RETURN jsonb_build_object('balance', v_after, 'granted', v_after - COALESCE(v_before, 0));
END; $$;

-- Spend coins on a Pro pass. Prices live here and nowhere else; a pass bought
-- while one is running extends it rather than overlapping it.
CREATE OR REPLACE FUNCTION public.buy_pass(_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_price bigint;
  v_days int;
  v_from timestamptz;
  v_bal bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF _kind = 'pass_7d' THEN v_price := 400; v_days := 7;
  ELSIF _kind = 'pass_30d' THEN v_price := 1200; v_days := 30;
  ELSE RAISE EXCEPTION 'unknown_pass';
  END IF;
  v_bal := public.coin_apply(v_uid, -v_price, 'spend_pass', NULL, 'Pro pass: ' || v_days || ' days');
  SELECT GREATEST(now(), COALESCE(max(expires_at), now())) INTO v_from
    FROM public.coin_passes WHERE user_id = v_uid;
  INSERT INTO public.coin_passes (user_id, kind, starts_at, expires_at)
  VALUES (v_uid, _kind, v_from, v_from + make_interval(days => v_days));
  RETURN jsonb_build_object('balance', v_bal, 'pass_until', v_from + make_interval(days => v_days));
END; $$;

REVOKE ALL ON FUNCTION public.my_wallet() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_daily_coins() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.buy_pass(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_wallet() TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_daily_coins() TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_pass(text) TO authenticated;

-- Entitlements: a running coin pass is Pro. Everything else is the function
-- as it stood (20260625221021); only the paid test and the reported end date
-- learn about passes.
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
  v_pass timestamptz;
  v_sub_paid boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('is_admin',false,'plan','free','subscribed',false,
      'is_paid',false,'billing_issue',false,'subscription_end',NULL,
      'cancel_at_period_end',false,'locked_wiki_ids','[]'::jsonb,'pass_until',NULL);
  END IF;
  v_is_admin := public.has_role(v_uid, 'admin'::public.app_role);
  IF v_is_admin THEN
    RETURN jsonb_build_object('is_admin',true,'plan','lifetime_admin','subscribed',true,
      'is_paid',true,'billing_issue',false,'subscription_end',NULL,
      'cancel_at_period_end',false,'locked_wiki_ids','[]'::jsonb,'pass_until',NULL);
  END IF;
  SELECT plan, subscribed, billing_issue, subscription_end INTO v_sub
  FROM public.subscribers WHERE user_id = v_uid
  ORDER BY updated_at DESC LIMIT 1;
  SELECT max(expires_at) INTO v_pass FROM public.coin_passes WHERE user_id = v_uid AND expires_at > now();
  v_plan := COALESCE(v_sub.plan, 'free');
  v_sub_paid := COALESCE(v_sub.subscribed, false) AND v_plan <> 'free';
  v_is_paid := v_sub_paid OR v_pass IS NOT NULL;
  IF v_is_paid AND NOT v_sub_paid THEN v_plan := 'monthly'; END IF;
  IF NOT v_is_paid THEN
    v_plan := 'free';
    SELECT id INTO v_oldest_wiki FROM public.wikis WHERE user_id = v_uid
     ORDER BY created_at ASC, id ASC LIMIT 1;
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_locked
    FROM public.wikis WHERE user_id = v_uid
      AND id <> COALESCE(v_oldest_wiki, '00000000-0000-0000-0000-000000000000'::uuid);
  ELSE
    v_locked := ARRAY[]::uuid[];
  END IF;
  RETURN jsonb_build_object('is_admin',false,'plan',v_plan,
    'subscribed',v_is_paid,'is_paid',v_is_paid,
    'billing_issue',COALESCE(v_sub.billing_issue,false) AND v_sub_paid,
    'subscription_end',CASE WHEN v_sub_paid THEN v_sub.subscription_end ELSE v_pass END,
    'cancel_at_period_end',false,
    'locked_wiki_ids', to_jsonb(v_locked),
    'pass_until', v_pass);
END; $$;

REVOKE EXECUTE ON FUNCTION public.my_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_entitlements() TO authenticated;
