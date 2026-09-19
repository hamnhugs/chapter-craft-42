import { supabase } from "@/integrations/supabase/client";

// The production ledger: every generation is a CANDIDATE until someone
// accepts it. This is the Version/PublishedFile split every real pipeline
// runs (ShotGrid/Flow convention): candidates are disposable review objects,
// acceptance promotes with lineage, and the metric that actually governs
// spend — cost per ACCEPTED shot, per model — falls out of the record. The
// 2026 production data is blunt: teams keep ~25% of clips and iterate ~3x per
// usable shot, so sticker price per generation says nothing; this table says
// everything.

export type LedgerKind = "image" | "video" | "splat";
export type LedgerStatus = "candidate" | "accepted" | "rejected";

/** One-tap rejection taxonomy, from published production post-mortems. The
 *  reason is what turns a ledger from bookkeeping into a steering wheel:
 *  "this model fails structurally, that one fails on identity". */
export const REJECTION_REASONS = [
  "structural",     // anatomy/geometry wrong, extra limbs, broken set
  "identity",       // doesn't match the master
  "temporal",       // flicker, morphing, motion breaks (video)
  "compositional",  // framing/staging wrong for the shot
  "prompt_miss",    // ignored the instruction
  "policy",         // provider refused or watermarked
  "aesthetic",      // technically fine, just not good
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface LedgerRow {
  id: string;
  user_id: string;
  kind: LedgerKind;
  provider: string;
  model: string;
  prompt_excerpt: string;
  params: Record<string, unknown> | null;
  cost_estimate: number | null;
  status: LedgerStatus;
  rejection_reason: RejectionReason | null;
  master_id: string | null;
  scene_id: string | null;
  shot_number: string | null;
  output_id: string | null;
  /** Lineage: the accepted generation this one re-anchored from, if any. */
  source_generation_id: string | null;
  created_at: string;
  decided_at: string | null;
}

const db = () => supabase.from("generation_ledger" as any) as any;

export async function ledgerMigrated(): Promise<boolean> {
  try {
    const { error } = await db().select("id", { head: true, count: "exact" }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

/** Record a generation as a candidate. Best-effort by design — a ledger miss
 *  must never fail the generation itself — but a miss is REPORTED via the
 *  return value so callers can surface it instead of silently under-counting. */
export async function recordGeneration(opts: {
  kind: LedgerKind;
  provider: string;
  model: string;
  prompt?: string;
  params?: Record<string, unknown>;
  costEstimate?: number | null;
  masterId?: string | null;
  sceneId?: string | null;
  shotNumber?: string | null;
  outputId?: string | null;
  sourceGenerationId?: string | null;
}): Promise<{ id: string | null; note?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return { id: null, note: "not signed in" };
  const { data, error } = await db()
    .insert({
      user_id: uid,
      kind: opts.kind,
      provider: opts.provider.slice(0, 40),
      model: String(opts.model || "").slice(0, 120),
      prompt_excerpt: String(opts.prompt || "").slice(0, 300),
      params: opts.params ?? null,
      cost_estimate: typeof opts.costEstimate === "number" ? opts.costEstimate : null,
      master_id: opts.masterId ?? null,
      scene_id: opts.sceneId ?? null,
      shot_number: opts.shotNumber ? String(opts.shotNumber).slice(0, 60) : null,
      output_id: opts.outputId ?? null,
      source_generation_id: opts.sourceGenerationId ?? null,
    })
    .select("id")
    .single();
  if (error) {
    return { id: null, note: `ledger write failed: ${error.message}` };
  }
  return { id: (data as any).id };
}

/** Accept or reject a candidate. `id` may be a ledger row id, or "latest" for
 *  the newest undecided candidate — the common chat gesture is "keep that one". */
export async function decideGeneration(
  id: string,
  verdict: "accepted" | "rejected",
  reason?: RejectionReason,
): Promise<LedgerRow> {
  let rowId = id;
  if (id === "latest") {
    const { data: latest, error: lErr } = await db()
      .select("id")
      .eq("status", "candidate")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lErr || !latest) throw new Error("No undecided candidate found in the ledger.");
    rowId = (latest as any).id;
  }
  const { data, error } = await db()
    .update({
      status: verdict,
      rejection_reason: verdict === "rejected" ? (reason ?? "aesthetic") : null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", rowId)
    .eq("status", "candidate")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Ledger update failed: ${error.message}`);
  if (!data) throw new Error("That generation is not an undecided candidate (already decided, or not found).");
  return data as LedgerRow;
}

export interface ModelStats {
  provider: string;
  model: string;
  kind: LedgerKind;
  candidates: number;
  accepted: number;
  rejected: number;
  undecided: number;
  acceptance_rate: number | null;
  est_spend: number | null;
  /** The industry's unit of account: spend divided by ACCEPTED outputs. Null
   *  until at least one acceptance — never fake a number. */
  est_cost_per_accepted: number | null;
  top_rejection_reasons: string[];
}

/** Per-model scorecard. Computed client-side from the raw rows — the volumes
 *  here are personal-studio scale, not analytics scale. */
export async function ledgerStats(limit = 500): Promise<ModelStats[]> {
  const { data, error } = await db()
    .select("provider, model, kind, status, rejection_reason, cost_estimate")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Ledger read failed: ${error.message}`);
  const groups = new Map<string, ModelStats & { reasons: Map<string, number> }>();
  for (const r of (data as any[]) || []) {
    const key = `${r.provider}·${r.model}·${r.kind}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        provider: r.provider, model: r.model, kind: r.kind,
        candidates: 0, accepted: 0, rejected: 0, undecided: 0,
        acceptance_rate: null, est_spend: null, est_cost_per_accepted: null,
        top_rejection_reasons: [], reasons: new Map(),
      };
      groups.set(key, g);
    }
    g.candidates += 1;
    if (r.status === "accepted") g.accepted += 1;
    else if (r.status === "rejected") {
      g.rejected += 1;
      if (r.rejection_reason) g.reasons.set(r.rejection_reason, (g.reasons.get(r.rejection_reason) || 0) + 1);
    } else g.undecided += 1;
    if (typeof r.cost_estimate === "number") g.est_spend = (g.est_spend || 0) + r.cost_estimate;
  }
  return [...groups.values()].map((g) => {
    const decided = g.accepted + g.rejected;
    return {
      provider: g.provider, model: g.model, kind: g.kind,
      candidates: g.candidates, accepted: g.accepted, rejected: g.rejected, undecided: g.undecided,
      acceptance_rate: decided > 0 ? g.accepted / decided : null,
      est_spend: g.est_spend,
      est_cost_per_accepted: g.est_spend !== null && g.accepted > 0 ? g.est_spend / g.accepted : null,
      top_rejection_reasons: [...g.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`),
    };
  }).sort((a, b) => b.candidates - a.candidates);
}
