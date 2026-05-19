
-- Smart Filing: Phase 1 schema

CREATE TABLE public.wiki_centroids (
  wiki_id uuid PRIMARY KEY REFERENCES public.wikis(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  centroid extensions.halfvec(1536) NOT NULL,
  entry_count int NOT NULL DEFAULT 0,
  confident_threshold real NOT NULL DEFAULT 0.78,
  novelty_threshold real NOT NULL DEFAULT 0.55,
  last_recomputed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wiki_centroids ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own centroids" ON public.wiki_centroids FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own centroids" ON public.wiki_centroids FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own centroids" ON public.wiki_centroids FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own centroids" ON public.wiki_centroids FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.reroute_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_id uuid NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  from_wiki_id uuid NOT NULL REFERENCES public.wikis(id) ON DELETE CASCADE,
  to_wiki_id uuid NOT NULL REFERENCES public.wikis(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reroute_user_status_idx ON public.reroute_suggestions(user_id, status);
ALTER TABLE public.reroute_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own reroutes" ON public.reroute_suggestions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own reroutes" ON public.reroute_suggestions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own reroutes" ON public.reroute_suggestions FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own reroutes" ON public.reroute_suggestions FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.routing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_id uuid NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  s_max real, s_active real, s_2nd real, novelty real,
  proposed_wiki_id uuid REFERENCES public.wikis(id) ON DELETE SET NULL,
  proposed_action text NOT NULL CHECK (proposed_action IN ('assimilate_active','reroute','propose_new','incubate')),
  final_wiki_id uuid REFERENCES public.wikis(id) ON DELETE SET NULL,
  user_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routing_decisions_user_idx ON public.routing_decisions(user_id, created_at DESC);
ALTER TABLE public.routing_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own routing decisions" ON public.routing_decisions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own routing decisions" ON public.routing_decisions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own routing decisions" ON public.routing_decisions FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own routing decisions" ON public.routing_decisions FOR DELETE TO authenticated USING (auth.uid() = user_id);

ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS smart_filing_enabled boolean NOT NULL DEFAULT false;

-- updated_at trigger for reroute_suggestions
CREATE TRIGGER reroute_suggestions_updated_at
BEFORE UPDATE ON public.reroute_suggestions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RPC: score an entry against all of a user's wiki centroids
CREATE OR REPLACE FUNCTION public.score_entry_against_wikis(query_embedding extensions.halfvec)
RETURNS TABLE(wiki_id uuid, similarity real, confident_threshold real, novelty_threshold real)
LANGUAGE sql
STABLE
SET search_path TO 'public','extensions'
AS $$
  SELECT c.wiki_id,
         (1 - (c.centroid <=> query_embedding))::real AS similarity,
         c.confident_threshold,
         c.novelty_threshold
  FROM public.wiki_centroids c
  WHERE c.user_id = auth.uid()
  ORDER BY c.centroid <=> query_embedding ASC;
$$;
