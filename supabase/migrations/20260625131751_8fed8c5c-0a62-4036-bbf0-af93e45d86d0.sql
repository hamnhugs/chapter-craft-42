GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_daily_visits(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_user_settings(uuid, text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_wiki_entries(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_all_wikis() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;