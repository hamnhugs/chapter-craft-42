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
  /** Supersession lineage (bitemporal_supersession migration): id of the entry
   *  that replaced this one. NULL = this is the living version. */
  superseded_by?: string | null;
  supersede_reason?: string | null;
  /** Card Catalog Stage 2 (card_locators migration; absent pre-migration).
   *  Raw jsonb — parse with cardLocators.parseLocators, never trust shape. */
  locators?: unknown;
  aliases?: string[] | null;
  author?: string | null;
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
    rerank:      { updated: number; renormalized?: number };
    consolidate: { processed: number; edges_created: number; conflicts_inserted: number };
    prune:       { orphans: string[] };
    semanticize?: { created: number };
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
  // Unscoped view shows only LIVING entries (superseded ones live in history).
  // Feature-detected: before the supersession migration the column doesn't
  // exist (42703), so retry without the filter.
  const live = await supabase
    .from("knowledge_entries")
    .select("*")
    .is("superseded_by" as any, null)
    .order("updated_at", { ascending: false });
  if (!live.error) return (live.data || []) as unknown as KnowledgeEntry[];
  if ((live.error as any)?.code !== "42703") throw live.error;
  const { data, error } = await supabase
    .from("knowledge_entries")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as KnowledgeEntry[];
}

/**
 * Union of entries across a loaded neuron set (2-5 wikis), fetched via the
 * same per-wiki RPC the single view uses so bridged entries stay included.
 * Entries appearing in several wikis are deduped first-wins, so ordering the
 * ids primary-first attributes shared entries to the primary. Returns a
 * wiki-membership map so the UI can label each entry's source neuron.
 */
export async function fetchKnowledgeEntriesForSet(
  wikiIds: string[],
): Promise<{ entries: KnowledgeEntry[]; wikiByEntry: Record<string, string>; failedWikiIds: string[] }> {
  const results = await Promise.allSettled(wikiIds.map((id) => fetchKnowledgeEntries(id)));
  const failedWikiIds = wikiIds.filter((_, i) => results[i].status === "rejected");
  // Total failure must surface as an error, not render as "your neurons are
  // empty" — partial failures are returned so the caller can warn.
  if (failedWikiIds.length === wikiIds.length && wikiIds.length > 0) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  const wikiByEntry: Record<string, string> = {};
  const seen = new Map<string, KnowledgeEntry>();
  results.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    for (const e of res.value) {
      if (!seen.has(e.id)) {
        seen.set(e.id, e);
        wikiByEntry[e.id] = wikiIds[i];
      }
    }
  });
  const entries = [...seen.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return { entries, wikiByEntry, failedWikiIds };
}

export async function fetchMemoryGraphForSet(wikiIds: string[]): Promise<MemoryGraphEdge[]> {
  const results = await Promise.allSettled(wikiIds.map((id) => fetchMemoryGraph(id)));
  if (wikiIds.length > 0 && results.every((r) => r.status === "rejected")) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  const seen = new Map<string, MemoryGraphEdge>();
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    for (const edge of res.value) if (!seen.has(edge.id)) seen.set(edge.id, edge);
  }
  return [...seen.values()];
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

export async function runLint(wikiId?: string | null): Promise<LintResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-lint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ wiki_id: wikiId ?? null }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Lint failed" }));
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

export async function reindexEmbeddings(
  all_missing = true,
  wikiId?: string | null,
): Promise<{ updated: number; failed: number; total: number }> {
  return callEdge("knowledge-embed", { all_missing, wiki_id: wikiId ?? null });
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

export async function fetchConflicts(
  status?: KnowledgeConflict["status"],
  wikiId?: string | null,
): Promise<KnowledgeConflict[]> {
  if (wikiId) {
    const { data, error } = await supabase.rpc("conflicts_for_wiki" as any, {
      target_wiki_id: wikiId,
    } as any);
    if (error) throw error;
    let rows = (data || []) as unknown as KnowledgeConflict[];
    if (status) rows = rows.filter((c) => c.status === status);
    return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  let q = supabase.from("knowledge_conflicts").select("*").order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as unknown as KnowledgeConflict[];
}

export async function fetchConflictsForSet(
  wikiIds: string[],
  status?: KnowledgeConflict["status"],
): Promise<KnowledgeConflict[]> {
  const results = await Promise.allSettled(wikiIds.map((id) => fetchConflicts(status, id)));
  if (wikiIds.length > 0 && results.every((r) => r.status === "rejected")) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  const seen = new Map<string, KnowledgeConflict>();
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    for (const c of res.value) if (!seen.has(c.id)) seen.set(c.id, c);
  }
  return [...seen.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function updateConflictStatus(id: string, status: KnowledgeConflict["status"]): Promise<void> {
  const { error } = await supabase.from("knowledge_conflicts").update({ status }).eq("id", id);
  if (error) throw error;
}

// ── Layer 2: Episodic log ──────────────────────────────────────────────────────

export async function fetchEpisodicLog(
  limit = 20,
  wikiId?: string | null,
): Promise<EpisodicLogEntry[]> {
  let q = supabase
    .from("episodic_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (wikiId) {
    // Include rows tagged to this wiki, plus legacy untagged rows (wiki_id IS NULL)
    // so older episodes don't disappear when scoping.
    q = q.or(`wiki_id.eq.${wikiId},wiki_id.is.null`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as unknown as EpisodicLogEntry[];
}

export async function fetchEpisodicLogForSet(wikiIds: string[], limit = 20): Promise<EpisodicLogEntry[]> {
  const { data, error } = await supabase
    .from("episodic_log")
    .select("*")
    // Loaded-set scope plus legacy untagged rows, same policy as the single-wiki path.
    .or(`wiki_id.in.(${wikiIds.join(",")}),wiki_id.is.null`)
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

export async function fetchConsolidationQueue(
  includingProcessed = false,
  wikiId?: string | null,
): Promise<ConsolidationQueueItem[]> {
  if (wikiId) {
    const { data, error } = await supabase.rpc("consolidation_queue_for_wiki" as any, {
      target_wiki_id: wikiId,
    } as any);
    if (error) throw error;
    let rows = (data || []) as unknown as ConsolidationQueueItem[];
    if (!includingProcessed) rows = rows.filter((r) => !r.processed_at);
    return rows.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.created_at < b.created_at ? -1 : 1;
    });
  }
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

export async function fetchConsolidationQueueForSet(
  wikiIds: string[],
  includingProcessed = false,
): Promise<ConsolidationQueueItem[]> {
  const settled = await Promise.allSettled(
    wikiIds.map((id) => fetchConsolidationQueue(includingProcessed, id)),
  );
  if (wikiIds.length > 0 && settled.every((r) => r.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const seen = new Map<string, ConsolidationQueueItem>();
  for (const res of settled) {
    if (res.status !== "fulfilled") continue;
    for (const item of res.value) if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.created_at < b.created_at ? -1 : 1;
  });
}

// ── Sleep Cycle ────────────────────────────────────────────────────────────────

export async function triggerSleepCycle(wikiId?: string | null): Promise<SleepCycleReport> {
  return callEdge("knowledge-consolidate", { wiki_id: wikiId ?? null });
}

// ── Spaced retrieval-practice (spacing + testing effects) ───────────────────
// Backed by the entries_due_for_review / record_review RPCs (brain_memory
// migration). Callers treat an RPC-missing error as "feature not deployed yet"
// and hide the review surface, so the app degrades gracefully before migration.
export interface DueReview {
  id: string;
  title: string;
  content: string;
  entry_type: string;
  wiki_id: string | null;
  vibrancy: number | null;
  storage_strength: number | null;
  next_review_at: string | null;
}

export async function fetchDueReviews(wikiId: string | null, limit = 12): Promise<DueReview[]> {
  const { data, error } = await supabase.rpc("entries_due_for_review" as any, { _wiki_id: wikiId, _limit: limit });
  if (error) throw error;
  return (data as DueReview[]) || [];
}

/** Record an active-recall attempt. Strengthens storage (more when the memory
 *  was nearly forgotten — desirable difficulty) and schedules the next review. */
export async function recordReview(entryId: string, recalled: boolean): Promise<void> {
  const { error } = await supabase.rpc("record_review" as any, { _entry_id: entryId, _recalled: recalled });
  if (error) throw error;
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

// ── Bi-temporal supersession (VGMS 4D axis) ──────────────────────────────────
// Backed by the bitemporal_supersession migration. Corrections retire the old
// entry (valid_to + superseded_by + archived) and create the fixed one, so
// history survives and "what did I believe before?" is answerable. All callers
// feature-detect via isMissingSupersessionSchema and fall back to legacy
// behavior until the migration is applied.

export const SUPERSESSION_MIGRATION_MESSAGE =
  "The history-preserving memory upgrade (migration 20260728000000_bitemporal_supersession) isn't applied to the database yet. Apply it via a Lovable-chat prompt or the SQL editor; until then edits fall back to the legacy overwrite/delete behavior.";

/** True when an error means the supersession migration isn't applied yet
 *  (missing column or missing RPC), as opposed to a real failure. */
export function isMissingSupersessionSchema(err: unknown): boolean {
  const code = (err as any)?.code || "";
  const msg = ((err as any)?.message || String(err || "")).toLowerCase();
  return (
    code === "42703" ||   // column does not exist
    code === "PGRST204" ||// PostgREST: unknown column on write
    code === "42883" ||   // function does not exist
    code === "PGRST202" ||// PostgREST: unknown RPC
    (/supersede|superseded_by|entry_lineage/.test(msg) && /not exist|not find|schema cache|unknown/.test(msg))
  );
}

/** Replace an outdated entry with a corrected one, preserving history.
 *  Returns the new entry's id. `alsoSupersede` retires a second entry into the
 *  same successor (conflict merges). */
export async function supersedeKnowledgeEntry(
  oldId: string,
  updates: { title?: string | null; content: string; entry_type?: string | null; tags?: string[] | null; reason?: string | null; alsoSupersede?: string | null },
): Promise<string> {
  const { data, error } = await supabase.rpc("supersede_knowledge_entry" as any, {
    _old_id: oldId,
    _new_title: updates.title ?? null,
    _new_content: updates.content,
    _new_entry_type: updates.entry_type ?? null,
    _new_tags: updates.tags ?? null,
    _reason: updates.reason ?? null,
    _also_supersede: updates.alsoSupersede ?? null,
  } as any);
  if (error) throw error;
  return data as unknown as string;
}

export interface EntryLineageItem {
  id: string;
  title: string;
  content: string;
  entry_type: string | null;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  supersede_reason: string | null;
  is_current: boolean;
  depth: number;
}

/** Full supersession chain through an entry: ancestors (depth < 0), the entry
 *  itself (0), successors (> 0). Ordered oldest belief first. */
export async function fetchEntryLineage(entryId: string): Promise<EntryLineageItem[]> {
  const { data, error } = await supabase.rpc("entry_lineage" as any, { _entry_id: entryId } as any);
  if (error) throw error;
  return (data || []) as unknown as EntryLineageItem[];
}

/** Drop superseded/expired entries from a retrieval result. The deployed
 *  knowledge edge functions predate supersession and may still match retired
 *  rows — this client-side pass enforces "current truth only" in the prompt.
 *  Pre-migration (or on any error) it returns the input unchanged. */
export async function filterSupersededNodes<T extends { id: string }>(nodes: T[]): Promise<T[]> {
  if (nodes.length === 0) return nodes;
  try {
    const { data, error } = await supabase
      .from("knowledge_entries")
      .select("id, superseded_by, valid_to" as any)
      .in("id", nodes.map((n) => n.id));
    if (error || !data) return nodes;
    const nowMs = Date.now();
    const dead = new Set(
      (data as any[])
        .filter((r) => r.superseded_by != null || (r.valid_to != null && new Date(r.valid_to).getTime() <= nowMs))
        .map((r) => r.id as string),
    );
    if (dead.size === 0) return nodes;
    return nodes.filter((n) => !dead.has(n.id));
  } catch {
    return nodes;
  }
}

// ── Card pointers (Stage 2 enrichment) ──────────────────────────────────────
// The deployed knowledge-retrieve edge fn predates the locator columns, so
// the client enriches retrieved nodes with ONE batched select. Runs AFTER
// filterSupersededNodes (retired rows never enrich) and degrades exactly like
// it: any failure returns an empty map and the prompt renders as before.
// First-read-is-the-probe: a missing-schema error caches "missing" via
// cardLocators so later sends skip the fetch entirely.

export interface CardPointerRow {
  locators: import("@/lib/cardLocators").CardLocator[];
  aliases: string[];
  author: string | null;
}

export async function fetchCardPointers(ids: string[]): Promise<Map<string, CardPointerRow>> {
  const out = new Map<string, CardPointerRow>();
  if (ids.length === 0) return out;
  const { cardSchemaKnownMissing, noteCardSchema, isCardSchemaMissing, parseLocators } = await import("@/lib/cardLocators");
  if (cardSchemaKnownMissing()) return out;
  try {
    const { data, error } = await supabase
      .from("knowledge_entries")
      .select("id, locators, aliases, author" as any)
      .in("id", ids);
    if (error) {
      if (isCardSchemaMissing(error)) noteCardSchema("missing");
      return out;
    }
    noteCardSchema("present");
    for (const r of (data as any[]) || []) {
      const locators = parseLocators(r.locators);
      const aliases = Array.isArray(r.aliases) ? r.aliases.filter((a: unknown): a is string => typeof a === "string") : [];
      const author = typeof r.author === "string" ? r.author : null;
      if (locators.length > 0 || aliases.length > 0 || author) {
        out.set(r.id as string, { locators, aliases, author });
      }
    }
    return out;
  } catch {
    return out;
  }
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
