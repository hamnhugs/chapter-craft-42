import { supabase } from "@/integrations/supabase/client";

export interface RerouteSuggestion {
  id: string;
  entry_id: string;
  from_wiki_id: string;
  to_wiki_id: string;
  reason: string;
  status: "pending" | "accepted" | "dismissed";
  created_at: string;
  entry_title?: string;
  from_wiki_name?: string;
  to_wiki_name?: string;
}

export async function fetchPendingReroutes(): Promise<RerouteSuggestion[]> {
  const { data, error } = await supabase
    .from("reroute_suggestions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!data || data.length === 0) return [];

  // Hydrate titles
  const entryIds = Array.from(new Set(data.map((r: any) => r.entry_id)));
  const wikiIds = Array.from(new Set(data.flatMap((r: any) => [r.from_wiki_id, r.to_wiki_id])));
  const [{ data: entries }, { data: wikis }] = await Promise.all([
    supabase.from("knowledge_entries").select("id, title").in("id", entryIds),
    supabase.from("wikis").select("id, name").in("id", wikiIds),
  ]);
  const eMap = new Map((entries || []).map((e: any) => [e.id, e.title]));
  const wMap = new Map((wikis || []).map((w: any) => [w.id, w.name]));

  return data.map((r: any) => ({
    ...r,
    entry_title: eMap.get(r.entry_id) || "(untitled)",
    from_wiki_name: wMap.get(r.from_wiki_id) || "Unknown",
    to_wiki_name: wMap.get(r.to_wiki_id) || "Unknown",
  }));
}

export async function acceptReroute(id: string): Promise<void> {
  const { data: row, error: fetchErr } = await supabase
    .from("reroute_suggestions")
    .select("entry_id, to_wiki_id, user_id")
    .eq("id", id)
    .single();
  if (fetchErr || !row) throw fetchErr || new Error("Suggestion not found");

  const { error: updErr } = await supabase
    .from("knowledge_entries")
    .update({ wiki_id: row.to_wiki_id })
    .eq("id", row.entry_id);
  if (updErr) throw updErr;

  const { error: statusErr } = await supabase
    .from("reroute_suggestions")
    .update({ status: "accepted" })
    .eq("id", id);
  if (statusErr) throw statusErr;
}

export async function dismissReroute(id: string, kept = false): Promise<void> {
  const { error } = await supabase
    .from("reroute_suggestions")
    .update({ status: "dismissed" })
    .eq("id", id);
  if (error) throw error;
  // Log user correction so future learning knows the user kept it (phase 3).
  if (kept) {
    await supabase
      .from("routing_decisions")
      .update({ user_corrected: true })
      .eq("id", id);
  }
}

export async function getSmartFilingEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from("user_settings")
    .select("smart_filing_enabled")
    .maybeSingle();
  return !!(data as any)?.smart_filing_enabled;
}

export async function setSmartFilingEnabled(enabled: boolean): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: user.id, smart_filing_enabled: enabled }, { onConflict: "user_id" });
  if (error) throw error;
}

export async function recomputeCentroids(): Promise<{ recomputed: number; total_wikis: number }> {
  const { data, error } = await supabase.functions.invoke("recompute-centroids", { body: {} });
  if (error) throw error;
  return data as any;
}

// ── Phase 2: Wiki proposals ─────────────────────────────────────────────

export interface WikiProposal {
  id: string;
  proposed_name: string;
  rationale: string;
  sample_titles: string[];
  member_entry_ids: string[];
  status: "pending" | "accepted" | "dismissed" | "expired";
  created_at: string;
}

export async function fetchPendingProposals(): Promise<WikiProposal[]> {
  const { data, error } = await supabase
    .from("wiki_proposals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as any[]) || [];
}

export async function acceptProposal(p: WikiProposal): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  // Create the new wiki
  const { data: newWiki, error: wikiErr } = await supabase
    .from("wikis")
    .insert({
      user_id: user.id,
      name: p.proposed_name,
      description: p.rationale,
    })
    .select("id")
    .single();
  if (wikiErr || !newWiki) throw wikiErr || new Error("Wiki create failed");

  // Move member entries into the new wiki
  if (p.member_entry_ids.length > 0) {
    await supabase
      .from("knowledge_entries")
      .update({ wiki_id: newWiki.id })
      .in("id", p.member_entry_ids);

    // Clear them from incubator
    await supabase
      .from("incubator_entries")
      .update({ status: "promoted" })
      .in("entry_id", p.member_entry_ids);
  }

  // Mark proposal accepted
  await supabase
    .from("wiki_proposals")
    .update({ status: "accepted" })
    .eq("id", p.id);

  // Kick off centroid recompute (fire and forget)
  supabase.functions.invoke("recompute-centroids", { body: {} }).catch(() => {});
}

export async function dismissProposal(id: string): Promise<void> {
  const { error } = await supabase
    .from("wiki_proposals")
    .update({ status: "dismissed" })
    .eq("id", id);
  if (error) throw error;
}

export async function runIncubatorSweep(): Promise<any> {
  const { data, error } = await supabase.functions.invoke("incubator-sweep", { body: {} });
  if (error) throw error;
  return data;
}


// ── Phase 3: routing accuracy stat ──────────────────────────────────────

export async function fetchRoutingAccuracy(): Promise<{ accepted: number; total: number } | null> {
  const { data } = await supabase
    .from("reroute_suggestions")
    .select("status")
    .in("status", ["accepted", "dismissed"])
    .order("updated_at", { ascending: false })
    .limit(20);
  if (!data || data.length === 0) return null;
  const accepted = data.filter((d: any) => d.status === "accepted").length;
  return { accepted, total: data.length };
}
