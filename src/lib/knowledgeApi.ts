import { supabase } from "@/integrations/supabase/client";

export interface KnowledgeEntry {
  id: string;
  user_id: string;
  title: string;
  content: string;
  entry_type: string;
  source_book_id: string | null;
  tags: string[];
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryGraphEdge {
  id: string;
  user_id: string;
  source_entry_id: string;
  target_entry_id: string;
  relationship: string;
  created_at: string;
}

export interface ConversationMemory {
  id: string;
  user_id: string;
  summary: string;
  key_facts: string[];
  total_conversations: number;
  updated_at: string;
}

export interface LintResult {
  issues: { type: string; severity: string; description: string; affected_entries?: string[]; suggested_fix?: string }[];
  suggestions: { type: string; description: string; priority: string }[];
  health_score: number;
  stats: { total_entries: number; total_relationships: number; orphan_count: number; avg_confidence: number };
}

export async function fetchKnowledgeEntries(): Promise<KnowledgeEntry[]> {
  const { data, error } = await supabase
    .from("knowledge_entries")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as KnowledgeEntry[];
}

export async function fetchMemoryGraph(): Promise<MemoryGraphEdge[]> {
  const { data, error } = await supabase
    .from("memory_graph")
    .select("*");
  if (error) throw error;
  return (data || []) as unknown as MemoryGraphEdge[];
}

export async function fetchConversationMemory(): Promise<ConversationMemory | null> {
  const { data, error } = await supabase
    .from("conversation_memory")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data as unknown as ConversationMemory | null;
}

export async function deleteKnowledgeEntry(id: string): Promise<void> {
  const { error } = await supabase.from("knowledge_entries").delete().eq("id", id);
  if (error) throw error;
}

export async function updateKnowledgeEntry(id: string, updates: { title?: string; content?: string; tags?: string[]; confidence?: number }): Promise<void> {
  const { error } = await supabase.from("knowledge_entries").update(updates).eq("id", id);
  if (error) throw error;
}

export async function extractKnowledge(messages: { role: string; content: string }[], sourceBookId?: string): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ messages, source_book_id: sourceBookId }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Extraction failed" }));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  return resp.json();
}

export async function runLint(): Promise<LintResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-lint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Lint failed" }));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  return resp.json();
}

export async function ingestBook(bookId: string): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ book_id: bookId }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Ingest failed" }));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  return resp.json();
}
