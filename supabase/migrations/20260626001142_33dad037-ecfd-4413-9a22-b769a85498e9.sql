
DROP POLICY IF EXISTS "book-covers owner read" ON storage.objects;
DROP POLICY IF EXISTS "book-covers owner write" ON storage.objects;
DROP POLICY IF EXISTS "book-covers owner update" ON storage.objects;
DROP POLICY IF EXISTS "book-covers owner delete" ON storage.objects;

CREATE POLICY "book-covers owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'book-covers' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "book-covers owner write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'book-covers' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "book-covers owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'book-covers' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "book-covers owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'book-covers' AND auth.uid()::text = (storage.foldername(name))[1]);

-- subscribers: tighten SELECT
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT polname FROM pg_policy WHERE polrelid = 'public.subscribers'::regclass LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.subscribers', pol.polname);
  END LOOP;
END$$;

CREATE POLICY "subscribers_select_own" ON public.subscribers
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "subscribers_service_all" ON public.subscribers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_settings DELETE policy
DROP POLICY IF EXISTS "user_settings_delete_own" ON public.user_settings;
CREATE POLICY "user_settings_delete_own" ON public.user_settings
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Lock down SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.validate_wiki_log_operation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_knowledge_entry_enums() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_knowledge_entry_atomicity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_admin_on_signup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_owner_admin_on_signup() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_admin_lifetime_on_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_memory_graph_edge_class() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_neuron_limit() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE fn text;
DECLARE fns text[] := ARRAY[
  'public.is_admin()',
  'public.has_role(uuid, public.app_role)',
  'public.my_entitlements()',
  'public.accessible_wiki_ids(uuid)',
  'public.match_knowledge(extensions.vector, integer, uuid)',
  'public.match_knowledge_entries(extensions.halfvec, double precision, integer, uuid[])',
  'public.match_image_memories(extensions.halfvec, double precision, integer, uuid)',
  'public.hybrid_search_knowledge(text, extensions.vector, integer, double precision, double precision, integer)',
  'public.get_neighbors(uuid[], integer, text[])',
  'public.find_contradictions(uuid)',
  'public.entries_for_wiki(uuid)',
  'public.memory_graph_for_wiki(uuid)',
  'public.conflicts_for_wiki(uuid)',
  'public.consolidation_queue_for_wiki(uuid)',
  'public.score_entry_against_wikis(extensions.halfvec)',
  'public.admin_list_users()',
  'public.admin_list_all_wikis()',
  'public.admin_list_wiki_entries(uuid, integer)',
  'public.admin_user_daily_visits(uuid, integer)',
  'public.admin_update_user_settings(uuid, text, text, text, text, text, text, text)',
  'public.admin_grant_lifetime(uuid, text)',
  'public.admin_revoke_lifetime(uuid)',
  'public.admin_delete_user(uuid)'
];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END$$;
