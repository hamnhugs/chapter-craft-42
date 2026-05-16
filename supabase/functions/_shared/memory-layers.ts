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
/** Boost applied to a node on each retrieval hit. */
export const RETRIEVAL_BOOST = 0.15;
/**
 * ACT-R Base-Level Learning decay parameter (Anderson et al., d = 0.5).
 * Activation: A_i = ln(Σ t_j^{-d}) where t_j = seconds since j-th retrieval.
 * Single-access approximation used here:
 *   raw = ln(retrieval_count + 1) − d × ln(seconds_idle + 1)
 *   vibrancy = clamp(sigmoid(raw) × 0.9 + 0.1, FLOOR, CEIL)
 * 30-day half-life at retrieval_count=1, which means a node at vibrancy=1.0
 * decays to ~0.55 after 30 days without access and to FLOOR after ~90 days.
 */
export const ACT_R_DECAY = 0.5;

/** Minimum queue depth before the Sleep Cycle is considered overdue. */
export const SLEEP_CYCLE_QUEUE_THRESHOLD = 10;
/** Maximum number of consolidation_queue items processed per Sleep Cycle run. */
export const SLEEP_CYCLE_BATCH_SIZE = 25;
/** Minimum edges the LLM must propose per orphaned node during re-consolidation. */
export const MIN_EDGES_PER_CONSOLIDATION = 2;

// ── Vibrancy helpers (ACT-R d=0.5) ────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute ACT-R vibrancy for a node.
 * raw  = ln(retrievalCount + 1) − d × ln(secondsIdle + 1)
 * Maps raw activation → [FLOOR, CEIL] via sigmoid.
 */
export function computeVibrancy(retrievalCount: number, secondsIdle: number): number {
  const raw = Math.log(retrievalCount + 1) - ACT_R_DECAY * Math.log(secondsIdle + 1);
  const v = sigmoid(raw) * 0.9 + 0.1;
  return Math.max(VIBRANCY_FLOOR, Math.min(VIBRANCY_CEIL, v));
}

/** Compute boosted vibrancy after a retrieval hit. */
export function boostVibrancy(current: number): number {
  return Math.min(VIBRANCY_CEIL, current + RETRIEVAL_BOOST);
}

/** A node is "Core" when its vibrancy is high enough to anchor new edges. */
export function isCoreNode(vibrancy: number): boolean {
  return vibrancy >= 0.70;
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
): Promise<void> {
  await supabase.from("episodic_log").insert({
    user_id:     userId,
    session_id:  sessionId,
    summary:     summary.slice(0, 2000),
    key_facts:   keyFacts.slice(0, 30),
    entry_count: entryCount,
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
