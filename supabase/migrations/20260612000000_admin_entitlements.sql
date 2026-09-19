-- Admin accounts are entitled to every paid feature.
--
-- The admin role itself is only ever granted through public.user_roles (see
-- 20260529173000 and 20260611230000); this migration makes the two
-- database-level plan gates honor that role:
--   1. accessible_wiki_ids(): an admin's neurons are never locked, so the
--      RESTRICTIVE "Locked neuron entries are hidden" policy on
--      knowledge_entries passes for all of their content.
--   2. enforce_neuron_limit(): admins may create unlimited neurons.
-- public.has_role() is the existing SECURITY DEFINER helper from the admin
-- dashboard migration — safe to call from both spots without RLS recursion.

CREATE OR REPLACE FUNCTION public.accessible_wiki_ids(uid UUID)
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id FROM public.wikis w
  WHERE w.user_id = uid
    AND (
      public.has_role(uid, 'admin'::public.app_role)
      OR (SELECT COALESCE(bool_or(s.subscribed), false)
            FROM public.subscribers s WHERE s.user_id = uid)
      OR w.id = (SELECT w2.id FROM public.wikis w2
                  WHERE w2.user_id = uid
                  ORDER BY w2.created_at ASC, w2.id ASC
                  LIMIT 1)
    );
$$;

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
  IF public.has_role(NEW.user_id, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO existing_count FROM public.wikis WHERE user_id = NEW.user_id;
  SELECT COALESCE(bool_or(subscribed), false) INTO is_paid
    FROM public.subscribers WHERE user_id = NEW.user_id;
  IF NOT is_paid AND existing_count >= 1 THEN
    RAISE EXCEPTION 'Free accounts include one neuron. Upgrade to Pro or Lifetime to create more.';
  END IF;
  RETURN NEW;
END;
$$;
