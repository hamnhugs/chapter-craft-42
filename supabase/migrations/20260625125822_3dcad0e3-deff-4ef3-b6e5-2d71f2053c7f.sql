
DO $g$ BEGIN IF to_regprocedure('public.validate_wiki_log_operation()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.validate_wiki_log_operation() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.validate_knowledge_entry_enums()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.validate_knowledge_entry_enums() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.validate_knowledge_entry_atomicity()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.validate_knowledge_entry_atomicity() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.set_memory_graph_edge_class()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.set_memory_graph_edge_class() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.grant_admin_on_signup()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.grant_admin_on_signup() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.grant_owner_admin_on_signup()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.grant_owner_admin_on_signup() FROM authenticated, PUBLIC; END IF; END $g$;
DO $g$ BEGIN IF to_regprocedure('public.enforce_neuron_limit()') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.enforce_neuron_limit() FROM authenticated, PUBLIC; END IF; END $g$;
