REVOKE ALL ON FUNCTION public.delete_program_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_program_schedule(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.pause_program_schedule(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pause_program_schedule(uuid, boolean) TO authenticated;