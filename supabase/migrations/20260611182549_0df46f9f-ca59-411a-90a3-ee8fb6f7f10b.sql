ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS access_all_neurons BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_wikis_user_created
  ON public.wikis (user_id, created_at, id);

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