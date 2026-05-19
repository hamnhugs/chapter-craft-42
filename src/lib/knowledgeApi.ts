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
  /** ACT-R vibrancy score [0.1, 1.0] — decays with idle time, boosted on retrieval. */
  vibrancy?: number;
  last_retrieved_at?: string | null;
  retrieval_count?: number;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

// ── Layer 2: Episodic log ──────────────────────────────────────────────────────

export interface EpisodicLogEntry {
  id: string;
  user_id: string;
  session_id: string;
  summary: string | null;
  key_facts: string[];
  entry_count: number;
  created_at: string;
}

// ── Layer 5: Consolidation queue ──────────────────────────────────────────────

export interface ConsolidationQueueItem {
  id: string;
  user_id: string;
  entry_id: string | null;
  reason: "conflict_staged" | "new_entry" | "orphan";
  priority: number;
  pending_data: Record<string, unknown> | null;
  processed_at: string | null;
  created_at: string;
}

// ── Sleep Cycle result ─────────────────────────────────────────────────────────

export interface SleepCycleReport {
  ok: boolean;
  elapsed_ms: number;
  phases: {
    rerank:      { updated: number };
    consolidate: { processed: number; edges_created: number; conflicts_inserted: number };
    prune:       { orphans: string[] };
  };
}

// ── Recording mode ─────────────────────────────────────────────────────────────

export type MemoryMode = "recording" | "retrieval";

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

export async function fetchKnowledgeEntries(wikiId?: string | null): Promise<KnowledgeEntry[]> {
  // When a wiki is selected we want both native entries AND bridged-in entries.
  // The entries_for_wiki RPC handles the union and keeps RLS clean.
  if (wikiId) {
    const { data, error } = await supabase.rpc("entries_for_wiki" as any, {
      target_wiki_id: wikiId,
    } as any);
    if (error) throw error;
    return (data || []) as unknown as KnowledgeEntry[];
  }
  const { data, error } = await supabase
    .from("knowledge_entries")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as KnowledgeEntry[];
}

export async function fetchMemoryGraph(wikiId?: string | null): Promise<MemoryGraphEdge[]> {
  if (wikiId) {
    const { data, error } = await supabase.rpc("memory_graph_for_wiki" as any, {
      target_wiki_id: wikiId,
    } as any);
    if (error) throw error;
    return (data || []) as unknown as MemoryGraphEdge[];
  }
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

export async function extractKnowledge(messages: { role: string; content: string }[], sourceBookId?: string, wikiId?: string | null): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ messages, source_book_id: sourceBookId, wiki_id: wikiId }),
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

export async function ingestBook(bookId: string, wikiId?: string | null): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ book_id: bookId, wiki_id: wikiId }),
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
  opts: { depth?: number; match_count?: number; deep?: boolean; wiki_id?: string | null } = {},
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

// ── Layer 2: Episodic log ──────────────────────────────────────────────────────

export async function fetchEpisodicLog(limit = 20): Promise<EpisodicLogEntry[]> {
  const { data, error } = await supabase
    .from("episodic_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []) as unknown as EpisodicLogEntry[];
}

// ── Recording / Retrieval mode ─────────────────────────────────────────────────

export async function getMemoryMode(): Promise<MemoryMode> {
  const { data } = await supabase
    .from("user_settings")
    .select("is_recording_mode")
    .maybeSingle();
  return data?.is_recording_mode === false ? "retrieval" : "recording";
}

export async function setMemoryMode(mode: MemoryMode): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: user.id, is_recording_mode: mode === "recording" }, { onConflict: "user_id" });
  if (error) throw error;
}

// ── Layer 5: Consolidation queue ──────────────────────────────────────────────

export async function fetchConsolidationQueue(includingProcessed = false): Promise<ConsolidationQueueItem[]> {
  let q = supabase
    .from("consolidation_queue")
    .select("*")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (!includingProcessed) q = q.is("processed_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as unknown as ConsolidationQueueItem[];
}

// ── Sleep Cycle ────────────────────────────────────────────────────────────────

export async function triggerSleepCycle(): Promise<SleepCycleReport> {
  return callEdge("knowledge-consolidate", {});
}


// ─── Multi-wiki additions ────────────────────────────────────────────────────

export interface SemanticSearchMatch {
  id: string;
  wiki_id: string | null;
  title: string;
  content: string;
  entry_type: string;
  tags: string[];
  confidence: number;
  source_book_id: string | null;
  similarity: number;
  wiki_name: string | null;
  wiki_color: string | null;
}

export async function searchKnowledge(input: {
  query: string;
  wiki_ids?: string[] | null;
  threshold?: number;
  limit?: number;
}): Promise<SemanticSearchMatch[]> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/search-knowledge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Search failed" }));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  const data = await resp.json();
  return (data.matches || []) as SemanticSearchMatch[];
}

export async function embedEntries(input: { entry_ids?: string[]; backfill?: boolean; limit?: number }): Promise<{ embedded: number; attempted: number }> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/embed-entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Embedding failed" }));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  return resp.json();
}

export interface EntryBridge {
  id: string;
  user_id: string;
  entry_id: string;
  wiki_id: string;
  created_at: string;
}

export async function fetchBridgesForEntry(entryId: string): Promise<EntryBridge[]> {
  const { data, error } = await supabase
    .from("entry_bridges" as any)
    .select("*")
    .eq("entry_id", entryId);
  if (error) throw error;
  return (data || []) as unknown as EntryBridge[];
}

export async function bridgeEntryToWiki(entryId: string, wikiId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");
  const { error } = await supabase
    .from("entry_bridges" as any)
    .insert({ entry_id: entryId, wiki_id: wikiId, user_id: userData.user.id } as any);
  if (error) throw error;
}

export async function unbridgeEntryFromWiki(entryId: string, wikiId: string): Promise<void> {
  const { error } = await supabase
    .from("entry_bridges" as any)
    .delete()
    .eq("entry_id", entryId)
    .eq("wiki_id", wikiId);
  if (error) throw error;
}

export async function createWikiPointerEntry(input: {
  wiki_id: string;
  linked_wiki_id: string;
  title: string;
  content?: string;
  tags?: string[];
}): Promise<KnowledgeEntry> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");
  const { data, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: userData.user.id,
      wiki_id: input.wiki_id,
      linked_wiki_id: input.linked_wiki_id,
      title: input.title,
      content: input.content || "",
      entry_type: "concept",
      tags: input.tags || [],
      confidence: 1,
    } as any)
    .select()
    .single();
  if (error || !data) throw error || new Error("Failed to create pointer");
  return data as unknown as KnowledgeEntry;
}
