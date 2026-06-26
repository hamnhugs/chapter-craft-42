import { supabase } from "@/integrations/supabase/client";

export type CleanupReason =
  | "duplicate"
  | "low_confidence"
  | "stale"
  | "contradicted"
  | "empty_or_trivial"
  | "atomicity_violation"
  | "user_marked"
  | "ai_marked";

export interface CleanupFlagRow {
  id: string;
  user_id: string;
  wiki_id: string | null;
  entry_id: string;
  reason: CleanupReason;
  note: string | null;
  confidence: number;
  flagged_by: "scan" | "chat" | "user";
  dismissed_at: string | null;
  created_at: string;
}

export interface CleanupItem {
  flag: CleanupFlagRow;
  entry: {
    id: string;
    title: string;
    content: string;
    entry_type: string;
    tags: string[];
    confidence: number;
    wiki_id: string | null;
    updated_at: string;
  };
  wikiName: string | null;
}

export const REASON_LABEL: Record<CleanupReason, string> = {
  duplicate: "Duplicate",
  low_confidence: "Low confidence",
  stale: "Stale",
  contradicted: "Contradicted",
  empty_or_trivial: "Empty / trivial",
  atomicity_violation: "Too broad",
  user_marked: "You marked it",
  ai_marked: "AI flagged",
};

/** Load every active flag for the signed-in user, joined with its entry + wiki name. */
export async function listCleanupItems(
  wikiId: string | null,
  search?: string,
): Promise<CleanupItem[]> {
  let q = supabase
    .from("cleanup_flags" as any)
    .select("*")
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (wikiId) q = q.eq("wiki_id", wikiId);
  const { data: flags, error } = await q;
  if (error) throw error;
  const rows = ((flags as unknown) as CleanupFlagRow[]) || [];
  if (rows.length === 0) return [];

  const entryIds = Array.from(new Set(rows.map((r) => r.entry_id)));
  const { data: entries } = await supabase
    .from("knowledge_entries")
    .select("id, title, content, entry_type, tags, confidence, wiki_id, updated_at")
    .in("id", entryIds);
  const entryMap = new Map<string, any>((entries || []).map((e: any) => [e.id, e]));

  const wikiIds = Array.from(
    new Set(rows.map((r) => r.wiki_id).filter((x): x is string => !!x)),
  );
  let wikiMap = new Map<string, string>();
  if (wikiIds.length > 0) {
    const { data: ws } = await supabase
      .from("wikis" as any)
      .select("id, name")
      .in("id", wikiIds);
    wikiMap = new Map<string, string>(((ws as any[]) || []).map((w: any) => [w.id, w.name]));
  }

  const items: CleanupItem[] = rows
    .map((flag) => {
      const entry = entryMap.get(flag.entry_id);
      if (!entry) return null;
      return {
        flag,
        entry,
        wikiName: flag.wiki_id ? wikiMap.get(flag.wiki_id) || null : null,
      } as CleanupItem;
    })
    .filter((x): x is CleanupItem => !!x);

  if (!search || !search.trim()) return items;
  const needle = search.trim().toLowerCase();
  return items.filter(
    (i) =>
      i.entry.title.toLowerCase().includes(needle) ||
      i.entry.content.toLowerCase().includes(needle) ||
      (i.flag.note || "").toLowerCase().includes(needle),
  );
}

/** A lightweight set of currently-flagged entry ids, scoped to a wiki. */
export async function fetchFlaggedEntryIds(wikiId: string | null): Promise<Set<string>> {
  let q = supabase
    .from("cleanup_flags" as any)
    .select("entry_id")
    .is("dismissed_at", null)
    .limit(2000);
  if (wikiId) q = q.eq("wiki_id", wikiId);
  const { data, error } = await q;
  if (error) throw error;
  return new Set(((data as any[]) || []).map((r: any) => r.entry_id));
}

export async function dismissFlag(flagId: string): Promise<void> {
  const { error } = await supabase
    .from("cleanup_flags" as any)
    .update({ dismissed_at: new Date().toISOString() } as any)
    .eq("id", flagId);
  if (error) throw error;
}

export async function dismissFlagsForEntry(entryId: string): Promise<void> {
  const { error } = await supabase
    .from("cleanup_flags" as any)
    .update({ dismissed_at: new Date().toISOString() } as any)
    .eq("entry_id", entryId)
    .is("dismissed_at", null);
  if (error) throw error;
}

export async function bulkDeleteEntries(entryIds: string[]): Promise<number> {
  if (entryIds.length === 0) return 0;
  const { data, error } = await supabase.rpc("delete_entries_bulk" as any, {
    entry_ids: entryIds,
  });
  if (error) throw error;
  return Number(data) || 0;
}

export interface ScanSummary {
  reason: CleanupReason;
  added: number;
}

export async function rescanCleanup(wikiId: string | null): Promise<ScanSummary[]> {
  const { data, error } = await supabase.rpc("scan_cleanup_flags" as any, {
    target_wiki_id: wikiId,
  });
  if (error) throw error;
  return ((data as any[]) || []).map((r: any) => ({
    reason: r.reason as CleanupReason,
    added: Number(r.added) || 0,
  }));
}

/** Insert (or no-op if already there) a single user/AI-driven flag from chat. */
export async function flagEntry(input: {
  entry_id: string;
  reason: CleanupReason;
  note?: string;
  flagged_by?: "chat" | "user";
}): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) throw new Error("Not signed in");
  const { data: entry } = await supabase
    .from("knowledge_entries")
    .select("wiki_id, user_id")
    .eq("id", input.entry_id)
    .maybeSingle();
  if (!entry) throw new Error("Entry not found");
  if ((entry as any).user_id !== uid) throw new Error("Not allowed");
  const { error } = await supabase
    .from("cleanup_flags" as any)
    .upsert(
      {
        user_id: uid,
        wiki_id: (entry as any).wiki_id,
        entry_id: input.entry_id,
        reason: input.reason,
        note: input.note ?? null,
        confidence: 0.9,
        flagged_by: input.flagged_by || "chat",
        dismissed_at: null,
      } as any,
      { onConflict: "entry_id,reason" },
    );
  if (error) throw error;
}
