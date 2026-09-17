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

/** Enqueue an existing entry for Sleep Cycle processing. */
export async function enqueueEntry(
  supabase: any,
  userId: string,
  entryId: string,
  reason: QueueReason,
): Promise<void> {
  await supabase.from("consolidation_queue").upsert(
    {
      user_id:  userId,
      entry_id: entryId,
      reason,
      priority: QUEUE_PRIORITY[reason],
    },
    { onConflict: "user_id,entry_id,reason" },
  );
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
