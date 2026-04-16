
-- Knowledge entries: wiki-style pages that grow over time
CREATE TABLE public.knowledge_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  entry_type TEXT NOT NULL DEFAULT 'concept' CHECK (entry_type IN ('concept', 'entity', 'synthesis', 'fact', 'comparison', 'summary')),
  source_book_id UUID REFERENCES public.books(id) ON DELETE SET NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  confidence FLOAT NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  valid_from TIMESTAMP WITH TIME ZONE DEFAULT now(),
  valid_to TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own knowledge entries" ON public.knowledge_entries FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own knowledge entries" ON public.knowledge_entries FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own knowledge entries" ON public.knowledge_entries FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own knowledge entries" ON public.knowledge_entries FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_knowledge_entries_user ON public.knowledge_entries(user_id);
CREATE INDEX idx_knowledge_entries_type ON public.knowledge_entries(entry_type);
CREATE INDEX idx_knowledge_entries_tags ON public.knowledge_entries USING GIN(tags);
CREATE INDEX idx_knowledge_entries_source ON public.knowledge_entries(source_book_id);

-- Memory graph: relationships between knowledge entries
CREATE TABLE public.memory_graph (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  source_entry_id UUID NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  target_entry_id UUID NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'relates_to' CHECK (relationship IN ('relates_to', 'contradicts', 'extends', 'supports', 'derived_from', 'prerequisite')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(source_entry_id, target_entry_id, relationship)
);

ALTER TABLE public.memory_graph ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own memory graph" ON public.memory_graph FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own memory graph" ON public.memory_graph FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own memory graph" ON public.memory_graph FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own memory graph" ON public.memory_graph FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_memory_graph_user ON public.memory_graph(user_id);
CREATE INDEX idx_memory_graph_source ON public.memory_graph(source_entry_id);
CREATE INDEX idx_memory_graph_target ON public.memory_graph(target_entry_id);

-- Conversation memory: rolling summaries for cross-session continuity
CREATE TABLE public.conversation_memory (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  key_facts JSONB NOT NULL DEFAULT '[]',
  total_conversations INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own conversation memory" ON public.conversation_memory FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own conversation memory" ON public.conversation_memory FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own conversation memory" ON public.conversation_memory FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own conversation memory" ON public.conversation_memory FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_knowledge_entries_updated_at BEFORE UPDATE ON public.knowledge_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_conversation_memory_updated_at BEFORE UPDATE ON public.conversation_memory FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
