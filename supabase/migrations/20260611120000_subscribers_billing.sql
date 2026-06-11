-- Billing: subscribers cache table (written only by edge functions via service
-- role; clients may only read their own row) + free-tier neuron limit trigger.

CREATE TABLE public.subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  subscribed BOOLEAN NOT NULL DEFAULT false,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'monthly', 'lifetime')),
  subscription_end TIMESTAMPTZ,
  billing_issue BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscribers_user ON public.subscribers (user_id);

ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner; all writes happen through edge functions using the
-- service role key (which bypasses RLS). No INSERT/UPDATE/DELETE policies.
CREATE POLICY "Users can read own subscription" ON public.subscribers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR email = auth.email());

-- Free tier: one neuron (wiki). Enforced server-side so a tampered client
-- can't bypass the limit. Paid users (subscribed = true) are unlimited.
CREATE OR REPLACE FUNCTION public.enforce_neuron_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_count INT;
  is_paid BOOLEAN;
BEGIN
  SELECT count(*) INTO existing_count FROM public.wikis WHERE user_id = NEW.user_id;
  SELECT COALESCE(bool_or(subscribed), false) INTO is_paid
    FROM public.subscribers WHERE user_id = NEW.user_id;
  IF NOT is_paid AND existing_count >= 1 THEN
    RAISE EXCEPTION 'Free accounts include one neuron. Upgrade to Pro or Lifetime to create more.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_neuron_limit
  BEFORE INSERT ON public.wikis
  FOR EACH ROW EXECUTE FUNCTION public.enforce_neuron_limit();
