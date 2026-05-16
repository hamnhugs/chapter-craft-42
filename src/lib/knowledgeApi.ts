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

// ---- Phase 4: graph-aware retrieval ----
export interface RetrievedNode {
  id: string;
  title: string;
  content: string;
  entry_type: string | null;
  score: number;
  hop: number;
  via: string | null;
  from_seed: string;
}
export interface RetrievedEdge {
  source_entry_id: string;
  target_entry_id: string;
  relationship: string;
  edge_class: string;
}
export interface RetrievalResult {
  nodes: RetrievedNode[];
  edges: RetrievedEdge[];
  query_embedded?: boolean;
}

async function callEdge(fnName: string, body: unknown): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `Error ${resp.status}` }));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  return resp.json();
}

export async function retrieveKnowledge(
  query: string,
  opts: { depth?: number; match_count?: number; deep?: boolean } = {},
): Promise<RetrievalResult> {
  return callEdge("knowledge-retrieve", { query, ...opts });
}

export async function reindexEmbeddings(all_missing = true): Promise<{ updated: number; failed: number; total: number }> {
  return callEdge("knowledge-embed", { all_missing });
}

// ---- Conflict management ----
export interface KnowledgeConflict {
  id: string;
  user_id: string;
  entry_a: string;
  entry_b: string;
  kind: string;
  rationale: string;
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  created_at: string;
  updated_at: string;
}

export async function fetchConflicts(status?: KnowledgeConflict["status"]): Promise<KnowledgeConflict[]> {
  let q = supabase.from("knowledge_conflicts").select("*").order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as unknown as KnowledgeConflict[];
}

export async function updateConflictStatus(id: string, status: KnowledgeConflict["status"]): Promise<void> {
  const { error } = await supabase.from("knowledge_conflicts").update({ status }).eq("id", id);
  if (error) throw error;
}

