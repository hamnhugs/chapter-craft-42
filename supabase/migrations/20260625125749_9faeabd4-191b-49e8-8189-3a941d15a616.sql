
-- Drop anon read policies exposing private data
DROP POLICY IF EXISTS "Anon can read all books" ON public.books;
DROP POLICY IF EXISTS "Anon can read all chapters" ON public.chapters;
DROP POLICY IF EXISTS "Anon can read all notes" ON public.notes;

-- Stop the public book-covers bucket from being listable via broad SELECT policy.
-- The bucket is marked public, so public URLs continue to work without an RLS SELECT policy.
DROP POLICY IF EXISTS "Public can read book covers" ON storage.objects;

-- Revoke EXECUTE on SECURITY DEFINER functions from anon / PUBLIC
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC, anon', r.nspname, r.proname, r.args);
  END LOOP;
END $$;

-- Revoke EXECUTE on admin-only SECURITY DEFINER RPCs from authenticated.
-- They internally check is_admin(); revoking blocks unprivileged signed-in callers entirely.
REVOKE EXECUTE ON FUNCTION public.admin_list_users() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_user_daily_visits(uuid, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_update_user_settings(uuid, text, text, text, text, text, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_list_wiki_entries(uuid, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_list_all_wikis() FROM authenticated;
