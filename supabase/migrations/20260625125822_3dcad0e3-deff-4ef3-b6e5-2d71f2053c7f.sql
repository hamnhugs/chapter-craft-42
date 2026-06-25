
REVOKE EXECUTE ON FUNCTION public.validate_wiki_log_operation() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_knowledge_entry_enums() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_knowledge_entry_atomicity() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_memory_graph_edge_class() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_admin_on_signup() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_owner_admin_on_signup() FROM authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_neuron_limit() FROM authenticated, PUBLIC;
