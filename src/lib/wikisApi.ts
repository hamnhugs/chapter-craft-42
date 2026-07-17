import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export interface Wiki {
  id: string;
  user_id: string;
  name: string;
  description: string;
  cover_color: string;
  tags: string[];
  is_default: boolean;
  is_meta: boolean;
  last_loaded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WikiWithStats extends Wiki {
  entry_count: number;
}

export async function fetchWikis(): Promise<Wiki[]> {
  const { data, error } = await supabase
    .from("wikis" as any)
    .select("*")
    .order("last_loaded_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as Wiki[];
}

export async function fetchWikisWithStats(): Promise<WikiWithStats[]> {
  const [wikis, counts] = await Promise.all([
    fetchWikis(),
    supabase
      .from("knowledge_entries")
      .select("wiki_id" as any),
  ]);

  const countMap = new Map<string, number>();
  for (const row of ((counts.data || []) as unknown as Array<{ wiki_id: string | null }>)) {
    if (!row.wiki_id) continue;
    countMap.set(row.wiki_id, (countMap.get(row.wiki_id) || 0) + 1);
  }

  return wikis.map((w) => ({ ...w, entry_count: countMap.get(w.id) || 0 }));
}

export async function createWiki(input: {
  name: string;
  description?: string;
  cover_color?: string;
  tags?: string[];
  is_meta?: boolean;
}): Promise<Wiki> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("wikis" as any)
    .insert({
      user_id: userData.user.id,
      name: input.name,
      description: input.description || "",
      cover_color: input.cover_color || "#7C3AED",
      tags: input.tags || [],
      is_meta: !!input.is_meta,
    } as any)
    .select()
    .single();

  if (error || !data) throw error || new Error("Failed to create neuron");
  return data as unknown as Wiki;
}

export async function updateWiki(
  id: string,
  updates: { name?: string; description?: string; cover_color?: string; tags?: string[]; is_meta?: boolean }
): Promise<void> {
  const { error } = await supabase.from("wikis" as any).update(updates as any).eq("id", id);
  if (error) throw error;
}

export async function deleteWiki(id: string): Promise<void> {
  const { error } = await supabase.from("wikis" as any).delete().eq("id", id);
  if (error) throw error;
}

/**
 * Persist the loaded neuron set. ids[0] is the PRIMARY (written to
 * active_wiki_id — the value every existing single-neuron code path and the
 * ingest/extract edge functions read); the full ordered set goes to
 * active_wiki_ids. Until the neuron-chains migration is applied the array
 * column doesn't exist, so the upsert retries without it — the primary still
 * persists and multi-load degrades to session-only.
 */
export async function loadWikiSet(ids: string[]): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");

  const nowIso = new Date().toISOString();
  if (ids.length > 0) {
    await supabase.from("wikis" as any).update({ last_loaded_at: nowIso } as any).in("id", ids);
  }

  const payload: Record<string, unknown> = {
    user_id: userData.user.id,
    active_wiki_id: ids[0] ?? null,
    active_wiki_ids: ids,
  };
  let { error } = await supabase
    .from("user_settings")
    .upsert(payload as any, { onConflict: "user_id" });
  if (error && /active_wiki_ids/i.test(error.message || "")) {
    delete payload.active_wiki_ids;
    ({ error } = await supabase
      .from("user_settings")
      .upsert(payload as any, { onConflict: "user_id" }));
    // Multi-load "worked" in this session but won't survive a reload — say
    // so instead of silently degrading.
    if (!error && ids.length > 1) {
      toast.info(
        "Multi-neuron loading isn't fully set up yet — the database migration hasn't been applied, so only your primary neuron will persist.",
        { id: "multi-neuron-migration" },
      );
    }
  }
  if (error) throw error;
}

export async function loadWiki(id: string): Promise<void> {
  // Single-load = replace the whole set (Arc-style: activation replaces
  // visible context rather than appending to it).
  await loadWikiSet([id]);
}

export async function fetchActiveWikiId(): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("active_wiki_id" as any)
    .maybeSingle();
  if (error) throw error;
  return ((data as any)?.active_wiki_id as string | null) || null;
}

/**
 * The loaded neuron set: primary + full ordered set. Two queries on purpose —
 * a combined select would 400 (taking active_wiki_id down with it) while the
 * active_wiki_ids column doesn't exist yet.
 */
export async function fetchActiveWikiIds(): Promise<{ primary: string | null; set: string[] }> {
  const primary = await fetchActiveWikiId();
  let set: string[] = [];
  {
    const { data, error } = await supabase
      .from("user_settings")
      .select("active_wiki_ids" as any)
      .maybeSingle();
    if (!error) set = (((data as any)?.active_wiki_ids as string[]) || []).filter(Boolean);
  }
  if (primary && !set.includes(primary)) set = [primary, ...set];
  return { primary: primary ?? set[0] ?? null, set };
}
