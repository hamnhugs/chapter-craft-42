-- 1. Fixed search_path on the four routines that lacked one.
ALTER FUNCTION public.app_open_access() SET search_path = public, pg_catalog;
ALTER FUNCTION public.entries_due_for_review(uuid, integer) SET search_path = public, pg_catalog;
ALTER FUNCTION public.record_review(uuid, boolean) SET search_path = public, pg_catalog;
ALTER FUNCTION public.renormalize_vibrancy(uuid, double precision, uuid) SET search_path = public, pg_catalog;

-- 2. Internal trigger-only functions: not part of the API surface at all.
REVOKE ALL ON FUNCTION public.agent_programs_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_tools_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tool_runs_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_splat_quota() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_neuron_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_admin_lifetime_on_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_admin_on_signup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_owner_admin_on_signup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.keep_program_signing_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_memory_graph_edge_class() FROM PUBLIC, anon, authenticated;

-- 3. Privileged SECURITY DEFINER routines: never callable without signing in.
REVOKE EXECUTE ON FUNCTION public.approve_program(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.disable_program(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_fingerprint(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.approve_tool(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.tool_fingerprint(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accessible_wiki_ids(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.delete_entries_bulk(uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.scan_cleanup_flags(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.memory_edge_delete(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.memory_edge_upsert(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.memory_entry_upsert(uuid, uuid, text, text, text, text[], double precision) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_entitlements() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_grant_lifetime(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_revoke_lifetime(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_all_wikis() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_wiki_entries(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_user_settings(uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_user_daily_visits(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.app_open_access() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.entries_due_for_review(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_review(uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.renormalize_vibrancy(uuid, double precision, uuid) FROM PUBLIC, anon;

-- 4. Shelf membership removal must also prove ownership of shelf + document.
DROP POLICY IF EXISTS "Users can remove own shelf memberships" ON public.book_shelf_members;
CREATE POLICY "Users can remove own shelf memberships"
ON public.book_shelf_members FOR DELETE
USING (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.book_folders f WHERE f.id = book_shelf_members.folder_id AND f.user_id = auth.uid())
  AND EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_shelf_members.book_id AND b.user_id = auth.uid())
);