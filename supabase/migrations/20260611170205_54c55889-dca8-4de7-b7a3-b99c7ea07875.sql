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

GRANT SELECT ON public.subscribers TO authenticated;
GRANT ALL ON public.subscribers TO service_role;

CREATE INDEX idx_subscribers_user ON public.subscribers (user_id);

ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own subscription" ON public.subscribers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR email = auth.email());

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