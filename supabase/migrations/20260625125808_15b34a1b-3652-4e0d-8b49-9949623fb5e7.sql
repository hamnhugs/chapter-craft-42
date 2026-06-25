
ALTER FUNCTION public.entries_for_wiki(uuid) SECURITY INVOKER;
ALTER FUNCTION public.memory_graph_for_wiki(uuid) SECURITY INVOKER;
ALTER FUNCTION public.conflicts_for_wiki(uuid) SECURITY INVOKER;
ALTER FUNCTION public.consolidation_queue_for_wiki(uuid) SECURITY INVOKER;
ALTER FUNCTION public.score_entry_against_wikis(extensions.halfvec) SECURITY INVOKER;
ALTER FUNCTION public.find_contradictions(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_neighbors(uuid[], integer, text[]) SECURITY INVOKER;
ALTER FUNCTION public.hybrid_search_knowledge(text, extensions.vector, integer, double precision, double precision, integer) SECURITY INVOKER;
ALTER FUNCTION public.match_knowledge(extensions.vector, integer, uuid) SECURITY INVOKER;
ALTER FUNCTION public.match_knowledge_entries(extensions.halfvec, double precision, integer, uuid[]) SECURITY INVOKER;
