-- Multi-neuron loading + neuron chains (named sets of neurons that activate together).
--
-- * user_settings.active_wiki_ids: the FULL ordered loaded set. active_wiki_id
--   stays untouched as the PRIMARY neuron (write target) so every existing
--   single-neuron code path — and the ingest/extract edge functions that fall
--   back to it — keeps working unchanged.
-- * wiki_chains + wiki_chain_members: a join table (not a uuid[] column) so
--   deleting a neuron cascades out of every chain automatically.

-- 1) Loaded set: additive column; active_wiki_id remains the primary.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS active_wiki_ids uuid[] NOT NULL DEFAULT '{}';

-- 2) Chains: the named set, owned by a user.
CREATE TABLE IF NOT EXISTS public.wiki_chains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  cover_color  text NOT NULL DEFAULT '#7C3AED',
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_chains TO authenticated;
GRANT ALL ON public.wiki_chains TO service_role;

CREATE INDEX IF NOT EXISTS wiki_chains_user_id_idx
  ON public.wiki_chains (user_id);

-- 3) Ordered membership. position 0 = the chain's primary neuron.
CREATE TABLE IF NOT EXISTS public.wiki_chain_members (
  chain_id   uuid NOT NULL REFERENCES public.wiki_chains (id) ON DELETE CASCADE,
  wiki_id    uuid NOT NULL REFERENCES public.wikis (id) ON DELETE CASCADE,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, wiki_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_chain_members TO authenticated;
GRANT ALL ON public.wiki_chain_members TO service_role;

CREATE INDEX IF NOT EXISTS wiki_chain_members_wiki_id_idx
  ON public.wiki_chain_members (wiki_id);

-- 4) RLS (CREATE POLICY has no IF NOT EXISTS — drop/create pattern).
ALTER TABLE public.wiki_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_chain_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wiki_chains_select_own" ON public.wiki_chains;
CREATE POLICY "wiki_chains_select_own" ON public.wiki_chains
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "wiki_chains_insert_own" ON public.wiki_chains;
CREATE POLICY "wiki_chains_insert_own" ON public.wiki_chains
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "wiki_chains_update_own" ON public.wiki_chains;
CREATE POLICY "wiki_chains_update_own" ON public.wiki_chains
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "wiki_chains_delete_own" ON public.wiki_chains;
CREATE POLICY "wiki_chains_delete_own" ON public.wiki_chains
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "wiki_chain_members_select_own" ON public.wiki_chain_members;
CREATE POLICY "wiki_chain_members_select_own" ON public.wiki_chain_members
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.wiki_chains c
    WHERE c.id = chain_id AND c.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS "wiki_chain_members_insert_own" ON public.wiki_chain_members;
CREATE POLICY "wiki_chain_members_insert_own" ON public.wiki_chain_members
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.wiki_chains c
      WHERE c.id = chain_id AND c.user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.wikis w
      WHERE w.id = wiki_id AND w.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "wiki_chain_members_update_own" ON public.wiki_chain_members;
CREATE POLICY "wiki_chain_members_update_own" ON public.wiki_chain_members
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.wiki_chains c
    WHERE c.id = chain_id AND c.user_id = (SELECT auth.uid())
  ))
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.wiki_chains c
      WHERE c.id = chain_id AND c.user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.wikis w
      WHERE w.id = wiki_id AND w.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "wiki_chain_members_delete_own" ON public.wiki_chain_members;
CREATE POLICY "wiki_chain_members_delete_own" ON public.wiki_chain_members
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.wiki_chains c
    WHERE c.id = chain_id AND c.user_id = (SELECT auth.uid())
  ));

-- 5) PostgREST schema cache refresh.
NOTIFY pgrst, 'reload schema';