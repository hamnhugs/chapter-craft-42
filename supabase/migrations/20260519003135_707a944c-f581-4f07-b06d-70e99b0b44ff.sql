
CREATE TABLE public.wiki_health_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  wiki_id uuid NOT NULL,
  kind text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  suggestion jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_health_alerts_kind_check CHECK (kind IN ('split','rename')),
  CONSTRAINT wiki_health_alerts_status_check CHECK (status IN ('pending','accepted','dismissed'))
);
CREATE INDEX wiki_health_alerts_user_status_idx ON public.wiki_health_alerts(user_id, status);
CREATE UNIQUE INDEX wiki_health_alerts_unique_pending ON public.wiki_health_alerts(user_id, wiki_id, kind) WHERE status = 'pending';

ALTER TABLE public.wiki_health_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own health alerts" ON public.wiki_health_alerts FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own health alerts" ON public.wiki_health_alerts FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own health alerts" ON public.wiki_health_alerts FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own health alerts" ON public.wiki_health_alerts FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_wiki_health_alerts_updated_at
  BEFORE UPDATE ON public.wiki_health_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
