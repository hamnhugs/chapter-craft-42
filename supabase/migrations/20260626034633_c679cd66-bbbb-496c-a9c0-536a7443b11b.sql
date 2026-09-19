
REVOKE EXECUTE ON FUNCTION public.claim_next_ingest_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.requeue_stuck_ingest_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_ingest_job(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_stuck_ingest_jobs() TO service_role;
