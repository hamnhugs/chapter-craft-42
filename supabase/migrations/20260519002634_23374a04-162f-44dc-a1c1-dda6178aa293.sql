
-- Incubator: holds entries that don't fit any existing wiki well
CREATE TABLE public.incubator_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  embedding extensions.halfvec(1536) NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  cluster_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  CONSTRAINT incubator_entries_status_check CHECK (status IN ('pending','clustered','expired','promoted','dismissed'))
);
CREATE UNIQUE INDEX incubator_entries_entry_unique ON public.incubator_entries(user_id, entry_id);
CREATE INDEX incubator_entries_user_status_idx ON public.incubator_entries(user_id, status);
CREATE INDEX incubator_entries_expires_idx ON public.incubator_entries(expires_at) WHERE status = 'pending';

ALTER TABLE public.incubator_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own incubator" ON public.incubator_entries FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own incubator" ON public.incubator_entries FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own incubator" ON public.incubator_entries FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own incubator" ON public.incubator_entries FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Wiki proposals: candidate new wikis formed from incubator clusters
CREATE TABLE public.wiki_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  proposed_name text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  sample_titles text[] NOT NULL DEFAULT '{}',
  member_entry_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_proposals_status_check CHECK (status IN ('pending','accepted','dismissed','expired'))
);
CREATE INDEX wiki_proposals_user_status_idx ON public.wiki_proposals(user_id, status);

ALTER TABLE public.wiki_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own proposals" ON public.wiki_proposals FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own proposals" ON public.wiki_proposals FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own proposals" ON public.wiki_proposals FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own proposals" ON public.wiki_proposals FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_wiki_proposals_updated_at
  BEFORE UPDATE ON public.wiki_proposals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
