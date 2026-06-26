
ALTER TABLE public.ingest_jobs
  ADD COLUMN IF NOT EXISTS progress text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS result jsonb;

CREATE INDEX IF NOT EXISTS ingest_jobs_user_status_created_idx
  ON public.ingest_jobs (user_id, status, created_at);

ALTER TABLE public.ingest_jobs REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ingest_jobs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ingest_jobs';
  END IF;
END $$;

-- Atomic claim of the next queued job for a user (SECURITY DEFINER so the worker
-- can claim with service_role too).
CREATE OR REPLACE FUNCTION public.claim_next_ingest_job(_user_id uuid)
RETURNS public.ingest_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingest_jobs;
BEGIN
  UPDATE public.ingest_jobs
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         updated_at = now(),
         attempts = COALESCE(attempts, 0) + 1
   WHERE id = (
     SELECT id FROM public.ingest_jobs
      WHERE user_id = _user_id
        AND status = 'queued'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING * INTO v_job;
  RETURN v_job;
END $$;

-- Reset stuck jobs back to queued (running > 5 min with no update).
CREATE OR REPLACE FUNCTION public.requeue_stuck_ingest_jobs()
RETURNS TABLE(user_id uuid, requeued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH upd AS (
    UPDATE public.ingest_jobs
       SET status = 'queued', updated_at = now(), progress = 'Resuming after interruption'
     WHERE status = 'running' AND updated_at < now() - interval '5 minutes'
    RETURNING user_id
  )
  SELECT u.user_id, count(*)::int FROM upd u GROUP BY u.user_id;
END $$;
