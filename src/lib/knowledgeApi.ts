import { supabase } from "@/integrations/supabase/client";
import { createIdBatcher } from "@/lib/idBatcher";

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
  /** One-line, search-snippet description shown in the chat's notes index
   *  (memory_redesign migration). NULL until the save tool or the Sleep
   *  Cycle writes one; display falls back to fallbackHook(content). */
  hook?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Sleep Cycle result ─────────────────────────────────────────────────────────

export interface SleepCycleReport {
  ok: boolean;
  elapsed_ms: number;
  phases: {
    /** Phase 0 embed-missing sweep (absent from older deployments). */
    embed?:      { embedded: number };
    rerank:      { updated: number; renormalized?: number };
    consolidate: { processed: number; edges_created: number; conflicts_inserted: number };
    prune:       { orphans: string[]; enqueued?: number };
    hooks?:      { written: number };
  };
  /** The run-log row (memory_sleep_runs) when the run changed something. */
  run_id?: string | null;
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

export interface LintResult {
  issues: { type: string; severity: string; description: string; affected_entries?: string[]; suggested_fix?: string }[];
  suggestions: { type: string; description: string; priority: string }[];
  health_score: number;
  /** sampled_entries: how many entries the LLM actually audited (capped at 150). */
  stats: { total_entries: number; total_relationships: number; orphan_count: number; avg_confidence: number; sampled_entries?: number };
}

// ── Entry list reads: explicit columns, every page ─────────────────────────────
// `select("*")` on knowledge_entries shipped the vector column (768 floats,
// serialized as text) and the tsvector
// for EVERY row the WikiPanel or chat prompt listed — typically >90% of the
// payload, for data no client reads. And PostgREST silently caps a response
// at max-rows (1000): a big neuron just "lost" its oldest entries.
//
// ENTRY_LIST_COLUMNS is every column except embedding / tsv.
// PostgREST applies `select` and `range` to set-returning RPCs too, so the
// entries_for_wiki RPC is narrowed the same way — no new SQL function needed.
// If a listed column doesn't exist yet (an unapplied optional migration →
// 42703) the read retries with "*", exactly the old behaviour.
export const ENTRY_LIST_COLUMNS = [
  "id", "user_id", "wiki_id", "linked_wiki_id", "title", "content", "entry_type",
  "source_book_id", "tags", "confidence", "folder", "maturity", "subject", "is_index",
  "pending_changes", "atomicity_warning", "embedding_model", "vibrancy",
  "last_retrieved_at", "retrieval_count", "storage_strength", "review_count",
  "next_review_at", "archived", "valid_from", "valid_to", "superseded_by",
  "supersede_reason", "locators", "aliases", "author", "hook",
  "created_at", "updated_at",
].join(", ");

const LIST_PAGE_SIZE = 1000;
const LIST_MAX_ROWS = 20_000;

/** Page through a PostgREST read until a short page. `build` must return a
 *  fresh, deterministically ordered query each call. */
export async function fetchAllPages<T>(
  build: () => any,
  pageSize = LIST_PAGE_SIZE,
  maxRows = LIST_MAX_ROWS,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data || []) as T[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

const isMissingColumn = (err: unknown) => (err as any)?.code === "42703";

export async function fetchKnowledgeEntries(wikiId?: string | null): Promise<KnowledgeEntry[]> {
  // When a wiki is selected we want both native entries AND bridged-in entries.
  // The entries_for_wiki RPC handles the union and keeps RLS clean.
  if (wikiId) {
    const scoped = (cols: string) => () =>
      (supabase.rpc("entries_for_wiki" as any, { target_wiki_id: wikiId } as any) as any)
        .select(cols)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true });
    try {
      return await fetchAllPages<KnowledgeEntry>(scoped(ENTRY_LIST_COLUMNS));
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
      return fetchAllPages<KnowledgeEntry>(scoped("*"));
    }
  }
  // Unscoped view shows only LIVING entries (superseded ones live in history).
  // Feature-detected: before the supersession migration the column doesn't
  // exist (42703), so retry without the filter (and with "*").
  const unscoped = (cols: string, liveOnly: boolean) => () => {
    let q: any = supabase.from("knowledge_entries").select(cols as "*");
    if (liveOnly) q = q.is("superseded_by" as any, null);
    return q.order("updated_at", { ascending: false }).order("id", { ascending: true });
  };
  try {
    return await fetchAllPages<KnowledgeEntry>(unscoped(ENTRY_LIST_COLUMNS, true));
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
  }
  try {
    return await fetchAllPages<KnowledgeEntry>(unscoped("*", true));
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
  }
  return fetchAllPages<KnowledgeEntry>(unscoped("*", false));
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
  // Paged: PostgREST's silent 1000-row cap dropped edges from dense graphs.
  if (wikiId) {
    return fetchAllPages<MemoryGraphEdge>(() =>
      (supabase.rpc("memory_graph_for_wiki" as any, { target_wiki_id: wikiId } as any) as any)
        .select("*")
        .order("id", { ascending: true }),
    );
  }
  return fetchAllPages<MemoryGraphEdge>(() =>
    supabase.from("memory_graph").select("*").order("id", { ascending: true }),
  );
}

export async function deleteKnowledgeEntry(id: string): Promise<void> {
  const { error } = await supabase.from("knowledge_entries").delete().eq("id", id);
  if (error) throw error;
}

export async function updateKnowledgeEntry(id: string, updates: { title?: string; content?: string; tags?: string[]; confidence?: number; hook?: string | null }): Promise<void> {
  const { error } = await supabase.from("knowledge_entries").update(updates).eq("id", id);
  if (error) throw error;
  // A text edit clears the stale vectors (embedding_staleness trigger) — re-embed.
  if (updates.title !== undefined || updates.content !== undefined) embedEntriesSoon([id]);
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
  /** Raw query cosine (knowledge-retrieve ≥ 20260917 deploy); null when unknown. */
  similarity?: number | null;
  vibrancy?: number;
  confidence?: number;
  /** Owning wiki (v2 search path). */
  wiki_id?: string | null;
  /** Seed also matched full text (v2 search path). */
  ft_match?: boolean;
  /** Card pointer fields, raw (v2 search path) — parse with cardLocators. */
  locators?: unknown;
  aliases?: string[] | null;
  author?: string | null;
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
  search?: "v2";
  scoped_wiki_ids?: string[] | null;
  dropped?: { seeds_below_cosine: number; below_relative_floor: number };
  /** Prompt routing, returned only when the caller asked for it. Absent or
   *  null means the feature is off, the migration is unapplied, or no prompt
   *  has routing enabled — never an error. */
  routing?: {
    candidates: Array<{ id: string; name: string; similarity: number }>;
    active_similarity: number | null;
    top_memory_score: number | null;
  } | null;
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
  /** wiki_ids: all loaded neurons in ONE call (server fuses); wiki_id: legacy
   *  single scope. limit: max nodes (default 18, deep 30, max 50). */
  opts: {
    depth?: number; match_count?: number; deep?: boolean;
    wiki_id?: string | null; wiki_ids?: string[] | null; limit?: number;
    /** Score the user's routing-enabled prompts against this same query. Rides
     *  on the embedding this call already computes, so it costs nothing extra
     *  — which is why it belongs here and not in its own request. */
    route_prompts?: boolean;
    active_prompt_id?: string | null;
  } = {},
): Promise<RetrievalResult> {
  return callEdge("knowledge-retrieve", { query, ...opts });
}

// ── Targeted embedding for freshly written entries ──────────────────────────
// Only the media generators used to trigger embedding (a wiki-wide
// all_missing sweep), so cards created or edited from chat, the quote-capture
// dialog, the Toolshed mirror or a supersede had NO vector until someone
// pressed "Rebuild search" — invisible to semantic retrieval. Every successful
// entry write now calls embedEntriesSoon(ids): ids from a burst of writes are
// debounced (~2s quiet, 6s max) and sent as ONE knowledge-embed { entry_ids }
// call, fire-and-forget. Failures are swallowed on purpose: the row stays
// embedding IS NULL and the next all_missing reindex / Sleep Cycle pass picks
// it up, so a hiccup here never surfaces as a failed save.
const EMBED_DEBOUNCE_MS = 2000;
const EMBED_BATCH_MAX = 50; // knowledge-embed accepts ≤100 ids per call

async function postEmbedBatch(ids: string[]): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return; // signed out: nothing we could embed anyway
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/knowledge-embed`, {
      method: "POST",
      // keepalive lets a flush triggered by pagehide finish after navigation.
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ entry_ids: ids }),
    });
  } catch {
    /* best-effort — see block comment */
  }
}

const embedBatcher = createIdBatcher({
  delayMs: EMBED_DEBOUNCE_MS,
  maxWaitMs: EMBED_DEBOUNCE_MS * 3,
  maxBatch: EMBED_BATCH_MAX,
  onFlush: (ids) => { void postEmbedBatch(ids); },
});

if (typeof window !== "undefined") {
  try { window.addEventListener("pagehide", () => embedBatcher.flush()); } catch { /* non-browser */ }
}

/** Queue entry ids for (re-)embedding after a successful create/edit. Never throws. */
export function embedEntriesSoon(ids: Array<string | null | undefined> | string | null | undefined): void {
  try {
    embedBatcher.add(Array.isArray(ids) ? ids : [ids]);
  } catch {
    /* never let embedding bookkeeping break a save */
  }
}

// ── Ranked keyword search (chat tool executors) ──────────────────────────────
// search_wiki / memory_search used `title.ilike.%<whole query>%` — a sequential
// scan that only matches when the ENTIRE phrase appears verbatim, so "memory
// palace technique" missed a card titled "Palace technique for memory".
// hybrid_search_knowledge_v2 with no embedding is a ranked, GIN-indexed
// full-text search with OR semantics over the stemmed query words, already
// restricted to living entries and (optionally) the loaded wikis — native,
// bridged, or legacy wiki-less. Returns null (caller falls back to its ilike
// path) when the RPC isn't deployed, errors, or finds nothing.
let rankedKeywordSearchMissing = false;

export async function rankedKeywordSearch(
  query: string,
  limit: number,
  wikiIds: string[] | null,
): Promise<{ data: any[]; error: null } | null> {
  const q = (query || "").trim();
  if (!q || rankedKeywordSearchMissing) return null;
  try {
    const { data, error } = await supabase.rpc("hybrid_search_knowledge_v2" as any, {
      query_text: q.slice(0, 500),
      query_embedding: null,
      match_count: Math.max(1, Math.min(50, limit)),
      filter_wiki_ids: wikiIds && wikiIds.length > 0 ? wikiIds : null,
    } as any);
    if (error) {
      const code = (error as any)?.code;
      if (code === "PGRST202" || code === "42883") rankedKeywordSearchMissing = true;
      return null;
    }
    const rows = Array.isArray(data) ? (data as any[]) : [];
    return rows.length > 0 ? { data: rows, error: null } : null;
  } catch {
    return null;
  }
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

// ── Recording / Retrieval mode ─────────────────────────────────────────────────

export async function getMemoryMode(): Promise<MemoryMode> {
  const { data } = await supabase
    .from("user_settings")
    .select("is_recording_mode")
    .maybeSingle();
  return data?.is_recording_mode === false ? "retrieval" : "recording";
}

/** Off the record: the user asked that nothing new be saved to their notes.
 *  Every path that creates a note checks this (chat save tools, generated
 *  images, videos and 3D models). A read failure means "not off the record". */
export async function isOffTheRecord(): Promise<boolean> {
  return (await getMemoryMode().catch(() => "recording" as MemoryMode)) === "retrieval";
}

export async function setMemoryMode(mode: MemoryMode): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: user.id, is_recording_mode: mode === "recording" }, { onConflict: "user_id" });
  if (error) throw error;
}

// ── Sleep Cycle ────────────────────────────────────────────────────────────────

export async function triggerSleepCycle(wikiId?: string | null): Promise<SleepCycleReport> {
  return callEdge("knowledge-consolidate", { wiki_id: wikiId ?? null });
}

/** One Sleep Cycle run that changed something (memory_sleep_runs). */
export interface SleepRun {
  id: string;
  wiki_id: string | null;
  edge_ids: string[];
  hook_entry_ids: string[];
  created_at: string;
  undone_at: string | null;
}

export async function fetchSleepRuns(limit = 5): Promise<SleepRun[]> {
  const { data, error } = await supabase
    .from("memory_sleep_runs" as any)
    .select("id, wiki_id, edge_ids, hook_entry_ids, created_at, undone_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []) as unknown as SleepRun[];
}

/** Reverse a run: removes the links it added and the hooks it wrote. */
export async function undoSleepRun(runId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("undo_sleep_run" as any, { _run_id: runId } as any);
  if (error) throw error;
  return data === true;
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
  hook: string | null;
  /** Raw jsonb — parse with cardLocators.parseLocators. */
  locators: unknown;
  review_count: number;
  next_review_at: string | null;
}

/** Notes to ask about: due ones first, then never-reviewed ones. */
export async function fetchDueReviews(wikiId: string | null, limit = 3): Promise<DueReview[]> {
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


// ── Search every note (the Notebooks tab's search box) ─────────────────────
// The same engine the chat uses (knowledge-retrieve: hybrid full-text +
// vector + link walk), unscoped — one search path for the whole app.
export interface NoteSearchMatch {
  id: string;
  wiki_id: string | null;
  title: string;
  content: string;
  hook: string | null;
  score: number;
}

export async function searchAllNotes(query: string, limit = 20): Promise<NoteSearchMatch[]> {
  const r = await retrieveKnowledge(query, { wiki_id: null, limit, depth: 0 });
  const nodes = (r.nodes || []).filter((n) => n.entry_type !== "tool" && n.entry_type !== "program");
  if (nodes.length === 0) return [];
  const hooks = await fetchCardPointers(nodes.map((n) => n.id)).catch(() => new Map<string, CardPointerRow>());
  return nodes.map((n) => ({
    id: n.id,
    wiki_id: n.wiki_id ?? null,
    title: n.title,
    content: n.content,
    hook: hooks.get(n.id)?.hook ?? null,
    score: typeof n.similarity === "number" ? n.similarity : n.score,
  }));
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
  // The successor row is born without a vector.
  embedEntriesSoon(data as unknown as string);
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
  hook: string | null;
}

export async function fetchCardPointers(ids: string[]): Promise<Map<string, CardPointerRow>> {
  const out = new Map<string, CardPointerRow>();
  if (ids.length === 0) return out;
  const { cardSchemaKnownMissing, noteCardSchema, isCardSchemaMissing, parseLocators } = await import("@/lib/cardLocators");
  if (cardSchemaKnownMissing()) return out;
  try {
    const { data, error } = await supabase
      .from("knowledge_entries")
      .select("id, locators, aliases, author, hook" as any)
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
      const hook = typeof r.hook === "string" && r.hook.trim() ? r.hook.trim() : null;
      if (locators.length > 0 || aliases.length > 0 || author || hook) {
        out.set(r.id as string, { locators, aliases, author, hook });
      }
    }
    return out;
  } catch {
    return out;
  }
}
