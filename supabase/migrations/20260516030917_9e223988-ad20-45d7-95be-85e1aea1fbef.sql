ALTER TABLE public.knowledge_conflicts REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.knowledge_conflicts;