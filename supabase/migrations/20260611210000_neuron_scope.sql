-- Neuron access scoping.
--
-- 1. user_settings.access_all_neurons — opt-in "Counsel may read every neuron
--    at once" toggle (paid feature; default off = active neuron only).
-- 2. accessible_wiki_ids() + a RESTRICTIVE RLS policy on knowledge_entries so
--    a free account's locked neurons are unreadable at the database layer —
--    not just hidden in the UI. This covers every consumer at once: PostgREST,
--    the match_knowledge_entries / entries_for_wiki RPCs (both run as invoker),
--    and every edge function that uses the caller's JWT. The wikis table stays
--    fully readable so locked neurons still show (with a lock) in the BRAIN tab.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS access_all_neurons BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_wikis_user_created
  ON public.wikis (user_id, created_at, id);

-- Wikis the user may read content from: all of them when subscribed, else
-- only the oldest (the free neuron). SECURITY DEFINER both bypasses RLS on
-- the inner wikis/subscribers reads (no policy recursion) and keeps
-- subscribers private. STABLE + a row-independent argument lets the planner
-- evaluate it once per statement (initPlan), not per row.
CREATE OR REPLACE FUNCTION public.accessible_wiki_ids(uid UUID)
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id FROM public.wikis w
  WHERE w.user_id = uid
    AND (
      (SELECT COALESCE(bool_or(s.subscribed), false)
         FROM public.subscribers s WHERE s.user_id = uid)
      OR w.id = (SELECT w2.id FROM public.wikis w2
                  WHERE w2.user_id = uid
                  ORDER BY w2.created_at ASC, w2.id ASC
                  LIMIT 1)
    );
$$;

-- RESTRICTIVE = ANDed with the existing "own rows" policy, so this only ever
-- narrows access. Entries with no wiki (legacy) stay readable; entries native
-- to OR bridged into an accessible wiki stay readable; everything else (i.e.
-- content living only in locked neurons) becomes invisible to the client and
-- to the AI's retrieval paths.
DROP POLICY IF EXISTS "Locked neuron entries are hidden" ON public.knowledge_entries;
CREATE POLICY "Locked neuron entries are hidden"
  ON public.knowledge_entries
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    wiki_id IS NULL
    OR wiki_id IN (SELECT public.accessible_wiki_ids((SELECT auth.uid())))
    OR EXISTS (
      SELECT 1 FROM public.entry_bridges b
      WHERE b.entry_id = knowledge_entries.id
        AND b.wiki_id IN (SELECT public.accessible_wiki_ids((SELECT auth.uid())))
    )
  );
