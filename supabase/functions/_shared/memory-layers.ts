/**
 * Layered Memory Stack — shared constants and utilities.
 *
 * Five layers, each with a distinct storage target and access pattern:
 *   L1  Working      – volatile, session-scoped, in-memory / sessionStorage
 *   L2  Episodic     – episodic_log table; one row per conversation session
 *   L3  Semantic     – knowledge_entries + memory_graph (pgvector + graph)
 *   L4  Procedural   – knowledge_entries WHERE entry_type = 'procedure'
 *   L5  Consolidation– consolidation_queue table; Sleep Cycle staging area
 */

// ── Layer constants ────────────────────────────────────────────────────────────

export const LAYER = {
  WORKING:       1,
  EPISODIC:      2,
  SEMANTIC:      3,
  PROCEDURAL:    4,
  CONSOLIDATION: 5,
} as const;

/** Vibrancy floor — nodes never decay below this value so they remain findable. */
export const VIBRANCY_FLOOR = 0.10;
/** Vibrancy ceiling. */
export const VIBRANCY_CEIL  = 1.00;
/** Boost applied on a deliberate dereference (read_span). Injecting a card
 *  into the prompt no longer boosts anything — see knowledge-retrieve. */
export const RETRIEVAL_BOOST = 0.04;
/**
 * Legacy knob kept for the rerank_vibrancy RPC signature: the SQL derives the
 * base half-life as 15 / ACT_R_DECAY days, so 0.5 → 30 days.
 */
export const ACT_R_DECAY = 0.5;
/** Idle days after which a never-used node's above-floor vibrancy halves. */
export const VIBRANCY_HALF_LIFE_DAYS = 15 / ACT_R_DECAY;

/** Minimum queue depth before the Sleep Cycle is considered overdue. */
export const SLEEP_CYCLE_QUEUE_THRESHOLD = 10;
/** Maximum number of consolidation_queue items processed per Sleep Cycle run. */
export const SLEEP_CYCLE_BATCH_SIZE = 25;
/**
 * Minimum edges the LLM must propose per consolidated node. 0 — forcing edges
 * (it used to be 2) made the model invent links between unrelated cards just
 * to satisfy the schema.
 */
export const MIN_EDGES_PER_CONSOLIDATION = 0;
/** A conflict-staged (not yet inserted) entry is inserted only once it earns ≥ this many edges. */
export const STAGED_INSERT_MIN_EDGES = 1;

// ── Vibrancy (idle-days half-life, stretched by use) ──────────────────────────
//
// Mirror of rerank_vibrancy (migration 20260917130300_vibrancy_idle_days):
//   H(n) = VIBRANCY_HALF_LIFE_DAYS · (1 + ln(1 + n))       n = retrieval_count
//   v    = FLOOR + (CEIL − FLOOR) · 2^(−idle_days / H(n))
// The part above the floor halves every H(n) days — 30 days for a never-used
// node, ~72d at n=3, ~102d at n=10. Fresh nodes start at CEIL.
//
//   v(n, idle)   0d    1h    1d    7d    30d   60d   90d   180d
//   n = 0       1.00  1.00  0.98  0.87  0.55  0.33  0.21  0.11
//   n = 1       1.00  1.00  0.99  0.92  0.70  0.50  0.36  0.18
//   n = 3       1.00  1.00  0.99  0.94  0.77  0.60  0.48  0.26
//   n = 10      1.00  1.00  0.99  0.96  0.83  0.70  0.59  0.36
//   n = 30      1.00  1.00  1.00  0.97  0.87  0.76  0.66  0.45
//
// (Asserted in src/test/vibrancy.test.ts.) The old formula — ln(n+1) −
// 0.5·ln(idle_SECONDS+1) through a sigmoid — put a never-used node at 0.115
// after ONE HOUR and a 10×-used node at 0.13 after a day: everything sat at
// the floor, so no node was ever "core".

/** Vibrancy for a node with `retrievalCount` uses, idle for `secondsIdle`. */
export function computeVibrancy(retrievalCount: number, secondsIdle: number): number {
  const idleDays = Math.max(0, secondsIdle) / 86400;
  const halfLife = VIBRANCY_HALF_LIFE_DAYS * (1 + Math.log(1 + Math.max(0, retrievalCount)));
  const v = VIBRANCY_FLOOR + (VIBRANCY_CEIL - VIBRANCY_FLOOR) * Math.pow(2, -idleDays / halfLife);
  return Math.max(VIBRANCY_FLOOR, Math.min(VIBRANCY_CEIL, v));
}

/** Compute boosted vibrancy after a deliberate use. */
export function boostVibrancy(current: number): number {
  return Math.min(VIBRANCY_CEIL, current + RETRIEVAL_BOOST);
}

/** A node is "Core" when its vibrancy is high enough to anchor new edges. */
export function isCoreNode(vibrancy: number): boolean {
  return vibrancy >= 0.70;
}

/**
 * Rank Sleep Cycle anchor candidates for one queued node: semantic closeness
 * dominates, vibrancy breaks ties toward live, used knowledge. Candidates
 * below `minSimilarity` are dropped outright — an unrelated node is not an
 * anchor however vibrant it is.
 */
export function rankAnchorCandidates<T extends { id: string; similarity: number; vibrancy: number | null }>(
  candidates: T[],
  opts: { limit?: number; minSimilarity?: number; similarityWeight?: number; excludeId?: string | null } = {},
): Array<T & { anchor_score: number }> {
  const limit = opts.limit ?? 8;
  const minSim = opts.minSimilarity ?? 0.3;
  const w = opts.similarityWeight ?? 0.75;
  return candidates
    .filter((c) => c.id !== opts.excludeId && typeof c.similarity === "number" && c.similarity >= minSim)
    .map((c) => ({ ...c, anchor_score: w * c.similarity + (1 - w) * (typeof c.vibrancy === "number" ? c.vibrancy : 0.5) }))
    .sort((a, b) => b.anchor_score - a.anchor_score)
    .slice(0, limit);
}

// ── Consolidation-queue reasons ────────────────────────────────────────────────

export type QueueReason = "conflict_staged" | "new_entry" | "orphan";

/** Priority assigned to each queue reason. Lower = processed first. */
export const QUEUE_PRIORITY: Record<QueueReason, number> = {
  conflict_staged: 2,
  new_entry:       5,
  orphan:          8,
};

// ── Encoding-mode check ────────────────────────────────────────────────────────

/**
 * Returns { allowed: true } or { allowed: false, reason } based on user settings.
 * Call this at the top of any write-path edge function.
 */
export async function checkRecordingMode(
  supabase: any,
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const { data } = await supabase
    .from("user_settings")
    .select("is_recording_mode")
    .eq("user_id", userId)
    .maybeSingle();

  // Default to allowed if the row/column doesn't exist yet.
  if (!data || data.is_recording_mode !== false) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "System is in Retrieval Mode. Switch to Recording Mode in Wiki settings to write new knowledge.",
  };
}

// ── Episodic log helpers ───────────────────────────────────────────────────────

/** Append one session to the episodic_log table. */
export async function logEpisode(
  supabase: any,
  userId: string,
  sessionId: string,
  summary: string,
  keyFacts: string[],
  entryCount: number,
  wikiId: string | null = null,
): Promise<void> {
  await supabase.from("episodic_log").insert({
    user_id:     userId,
    session_id:  sessionId,
    summary:     summary.slice(0, 2000),
    key_facts:   keyFacts.slice(0, 30),
    entry_count: entryCount,
    wiki_id:     wikiId,
  });
}

// ── Consolidation queue helpers ────────────────────────────────────────────────

/** PostgREST / Postgres codes meaning "this RPC isn't deployed yet". */
export function isMissingRpc(error: unknown): boolean {
  const code = (error as any)?.code;
  return code === "PGRST202" || code === "42883";
}

/**
 * Enqueue existing entries for Sleep Cycle processing — ONE round trip for
 * any number of ids. Returns how many rows were inserted/re-armed, or -1 on
 * failure (logged, never thrown: enqueueing is advisory).
 *
 * Why an RPC: the queue's uniqueness is a PARTIAL index
 * (… WHERE entry_id IS NOT NULL), and PostgREST's upsert can't emit the
 * predicate Postgres needs to match it, so the old `.upsert(onConflict:
 * "user_id,entry_id,reason")` failed with 42P10 on every call — silently.
 * enqueue_consolidation_entries (migration 20260917130400) does
 * INSERT … ON CONFLICT (cols) WHERE entry_id IS NOT NULL. Before that
 * migration: plain inserts, where a duplicate (23505) just means "already
 * queued".
 */
export async function enqueueEntries(
  supabase: any,
  userId: string,
  entryIds: string[],
  reason: QueueReason,
): Promise<number> {
  const ids = [...new Set(entryIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  const { data, error } = await supabase.rpc("enqueue_consolidation_entries", {
    p_entry_ids: ids,
    p_reason:    reason,
    p_priority:  QUEUE_PRIORITY[reason],
  });
  if (!error) return typeof data === "number" ? data : 0;
  if (!isMissingRpc(error)) {
    console.error("enqueue_consolidation_entries failed:", error.message);
    return -1;
  }
  let inserted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const { error: insErr } = await supabase.from("consolidation_queue").insert(
      ids.slice(i, i + 200).map((entryId) => ({
        user_id: userId, entry_id: entryId, reason, priority: QUEUE_PRIORITY[reason],
      })),
    );
    if (!insErr) { inserted += Math.min(200, ids.length - i); continue; }
    if ((insErr as any).code !== "23505") {
      console.error("consolidation_queue insert failed:", insErr.message);
      return -1;
    }
    // A duplicate aborts the whole multi-row insert — retry this chunk row by row.
    for (const entryId of ids.slice(i, i + 200)) {
      const { error: oneErr } = await supabase.from("consolidation_queue").insert({
        user_id: userId, entry_id: entryId, reason, priority: QUEUE_PRIORITY[reason],
      });
      if (!oneErr) inserted++;
    }
  }
  return inserted;
}

/** Enqueue one existing entry for Sleep Cycle processing. */
export async function enqueueEntry(
  supabase: any,
  userId: string,
  entryId: string,
  reason: QueueReason,
): Promise<void> {
  await enqueueEntries(supabase, userId, [entryId], reason);
}

/**
 * Read every row of a PostgREST query, page by page. PostgREST caps responses
 * at the project's max-rows (1000 by default) WITHOUT an error, so a plain
 * select on a big table silently returns the first 1000 rows — e.g. orphan
 * detection that only sees 1000 edges flags connected nodes as orphans.
 * `build` must return a fresh, deterministically ordered query each call.
 */
export async function selectAllPages<T = any>(
  build: () => any,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<{ rows: T[]; error: any | null }> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 50_000;
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { rows, error };
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, error: null };
}

/** Enqueue a not-yet-inserted entry (conflict_staged) with its full data. */
export async function enqueueConflictStaged(
  supabase: any,
  userId: string,
  pendingData: object,
): Promise<void> {
  await supabase.from("consolidation_queue").insert({
    user_id:      userId,
    entry_id:     null,    // no DB row yet
    reason:       "conflict_staged" satisfies QueueReason,
    priority:     QUEUE_PRIORITY.conflict_staged,
    pending_data: pendingData,
  });
}

/** Mark queue items as processed. */
export async function markProcessed(supabase: any, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabase
    .from("consolidation_queue")
    .update({ processed_at: new Date().toISOString() })
    .in("id", ids);
}
