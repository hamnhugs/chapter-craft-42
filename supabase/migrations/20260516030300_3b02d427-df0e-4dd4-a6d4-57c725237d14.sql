
REVOKE EXECUTE ON FUNCTION public.match_knowledge(extensions.vector, int, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_knowledge(text, extensions.vector, int, double precision, double precision, int) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_neighbors(uuid[], int, text[]) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.find_contradictions(uuid) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.match_knowledge(extensions.vector, int, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_knowledge(text, extensions.vector, int, double precision, double precision, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_neighbors(uuid[], int, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_contradictions(uuid) TO authenticated;
