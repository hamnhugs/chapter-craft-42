/**
 * Prompt routing: persistence, and the loop that lets the router be wrong
 * without becoming a nuisance.
 *
 * Every decision is logged — including "keep". An accuracy read that only saw
 * the switches would flatter the router by construction. `user_corrected` is
 * written by the Undo on a reply's prompt receipt, and `routingAccuracy()` is
 * what a future auto-pause reads: a router the user keeps overruling should
 * stop routing rather than keep arguing. Smart Filing already works exactly
 * this way (src/lib/smartFilingApi.ts).
 *
 * NOTHING here throws. Routing is a convenience layered on top of a reply that
 * has already been assembled; a failed insert must never cost the user their
 * message. Pre-migration every call is a silent no-op.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingPromptRoutingSchema } from "@/hooks/usePromptPresets";
import type { RouteDecision } from "@/lib/promptRouting";

export interface PromptProposal {
  id: string;
  proposed_name: string;
  proposed_body: string;
  when_to_use: string;
  rationale: string;
  sample_gists: string[];
  member_turn_ids: string[];
  created_at: string;
}

/** Fire-and-forget. Returns false when nothing was written, for tests. */
export async function logPromptRoute(decision: RouteDecision, finalPromptId: string | null): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { error } = await supabase.from("prompt_routing_decisions").insert({
      user_id: user.id,
      s_max: decision.scores.s_max,
      s_active: decision.scores.s_active,
      s_2nd: decision.scores.s_2nd,
      novelty: decision.scores.novelty,
      proposed_prompt_id: decision.promptId,
      proposed_action: decision.action,
      final_prompt_id: finalPromptId,
    });
    if (error && !isMissingPromptRoutingSchema(error)) {
      console.warn("Failed to log prompt routing decision:", error.message);
    }
    return !error;
  } catch {
    return false;
  }
}

/**
 * Mark the most recent decision as one the user overruled.
 *
 * "Most recent" rather than an exact id on purpose: the insert above is
 * deliberately not awaited (awaiting it would put a database round trip
 * between the user pressing send and the first token), so the row id does not
 * exist yet when the reply is stamped. Undo is pressed on the reply that just
 * arrived, so the newest row for this user IS that decision. The cost of the
 * race — two sends in flight at once — is one mislabelled telemetry row, which
 * is a price worth paying to keep the send path free of a blocking write.
 */
export async function markLastPromptRouteCorrected(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from("prompt_routing_decisions")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return;
    await supabase
      .from("prompt_routing_decisions")
      .update({ user_corrected: true })
      .eq("id", (data[0] as { id: string }).id);
  } catch {
    /* telemetry only */
  }
}

/** Share of recent switches the user overruled, or null when there is not
 *  enough evidence to say anything honest. */
export async function promptRoutingAccuracy(): Promise<{ switches: number; corrected: number } | null> {
  try {
    const { data, error } = await supabase
      .from("prompt_routing_decisions")
      .select("user_corrected")
      .eq("proposed_action", "switch")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error || !data || data.length < 5) return null;
    const rows = data as Array<{ user_corrected: boolean }>;
    return { switches: rows.length, corrected: rows.filter((r) => r.user_corrected).length };
  } catch {
    return null;
  }
}

// ── The incubator: evidence that a prompt is missing ────────────────────────

/**
 * Park a turn nothing fit. The gist is a short prefix of the user's own words,
 * kept so the proposal card can show what it was drafted FROM — a proposal you
 * cannot trace back to your own messages is one you cannot judge.
 */
export async function parkIncubatorTurn(gist: string): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const trimmed = (gist || "").trim().slice(0, 200);
    if (!trimmed) return;
    const { error } = await supabase.from("prompt_incubator_turns").insert({
      user_id: user.id,
      gist: trimmed,
    });
    if (error && !isMissingPromptRoutingSchema(error)) {
      console.warn("Failed to park incubator turn:", error.message);
    }
  } catch {
    /* best effort */
  }
}

// ── Proposals ───────────────────────────────────────────────────────────────

export async function fetchPromptProposals(): Promise<PromptProposal[]> {
  try {
    const { data, error } = await supabase
      .from("prompt_proposals")
      .select("id, proposed_name, proposed_body, when_to_use, rationale, sample_gists, member_turn_ids, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/**
 * Turn a proposal into a real prompt.
 *
 * THE GATE. Until this runs, the proposed text lives only in
 * `prompt_proposals` — a table the prompt builder never reads — so nothing the
 * assistant drafted has ever been in front of the model. This function is
 * reachable only from a button, and `origin: "assistant"` is recorded so the
 * prompt can never afterwards be mistaken for one the user wrote.
 *
 * Created INACTIVE and with routing off: approving a suggestion means "this is
 * worth keeping", not "start using this on my next message".
 */
export async function acceptPromptProposal(p: PromptProposal): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { error: insErr } = await supabase.from("prompt_presets").insert({
    user_id: user.id,
    name: p.proposed_name,
    body: p.proposed_body,
    when_to_use: p.when_to_use,
    scope: "both",
    is_active: false,
    routing_enabled: false,
    origin: "assistant",
    approved_at: new Date().toISOString(),
  });
  if (insErr) throw insErr;

  const { error: updErr } = await supabase
    .from("prompt_proposals")
    .update({ status: "accepted" })
    .eq("id", p.id);
  if (updErr) throw updErr;

  // The turns that justified THIS proposal are spent — they must not seed a
  // second, near-identical one on the next sweep. Scoped to its own members:
  // retiring every clustered row would also silently consume the evidence
  // behind the other proposals still sitting in the list unapproved.
  const members = p.member_turn_ids || [];
  if (members.length > 0) {
    await supabase
      .from("prompt_incubator_turns")
      .update({ status: "promoted" })
      .in("id", members);
  }
}

export async function dismissPromptProposal(id: string): Promise<void> {
  const { error } = await supabase
    .from("prompt_proposals")
    .update({ status: "dismissed" })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Run the incubator sweep, at most once every few hours per device.
 *
 * Called when the Prompt Library is opened rather than on a timer: the sweep
 * costs a model call, and the only place its output is visible is the panel
 * the user just opened. A background schedule would spend money drafting
 * suggestions nobody is there to read.
 */
const SWEEP_THROTTLE_MS = 6 * 60 * 60 * 1000;
const SWEEP_KEY = "prompt_incubator_last_sweep";

export async function runPromptIncubatorSweep(): Promise<void> {
  try {
    const last = Number(localStorage.getItem(SWEEP_KEY) || 0);
    if (Number.isFinite(last) && Date.now() - last < SWEEP_THROTTLE_MS) return;
    localStorage.setItem(SWEEP_KEY, String(Date.now()));
  } catch {
    // No storage (private mode): run it, but do not loop on every render —
    // the caller only invokes this on mount.
  }
  try {
    await supabase.functions.invoke("prompt-incubator-sweep", { body: {} });
  } catch {
    // Pre-deploy, offline, or no key configured. There is nothing to tell the
    // user: they did not ask for this, they opened a settings panel.
  }
}
