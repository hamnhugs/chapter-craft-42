
ALTER FUNCTION public.match_knowledge(extensions.vector, int, uuid) SECURITY INVOKER;
ALTER FUNCTION public.hybrid_search_knowledge(text, extensions.vector, int, double precision, double precision, int) SECURITY INVOKER;
ALTER FUNCTION public.get_neighbors(uuid[], int, text[]) SECURITY INVOKER;
ALTER FUNCTION public.find_contradictions(uuid) SECURITY INVOKER;
