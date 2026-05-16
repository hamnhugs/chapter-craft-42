-- 1. user_settings.is_recording_mode
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS is_recording_mode boolean NOT NULL DEFAULT true;

-- 2. episodic_log
CREATE TABLE IF NOT EXISTS public.episodic_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  summary text,
  key_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  entry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodic_log_user_created
  ON public.episodic_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_log_user_session
  ON public.episodic_log (user_id, session_id);

ALTER TABLE public.episodic_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own episodic log"
  ON public.episodic_log FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own episodic log"
  ON public.episodic_log FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own episodic log"
  ON public.episodic_log FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own episodic log"
  ON public.episodic_log FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- 3. consolidation_queue
CREATE TABLE IF NOT EXISTS public.consolidation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_id uuid NULL,
  reason text NOT NULL CHECK (reason IN ('conflict_staged','new_entry','orphan')),
  priority integer NOT NULL DEFAULT 5,
  pending_data jsonb NULL,
  processed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_consolidation_queue_user_entry_reason
  ON public.consolidation_queue (user_id, entry_id, reason)
  WHERE entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consolidation_queue_pending
  ON public.consolidation_queue (user_id, processed_at, priority, created_at);

ALTER TABLE public.consolidation_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own consolidation queue"
  ON public.consolidation_queue FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own consolidation queue"
  ON public.consolidation_queue FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own consolidation queue"
  ON public.consolidation_queue FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own consolidation queue"
  ON public.consolidation_queue FOR DELETE TO authenticated
  USING (auth.uid() = user_id);