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

  if (error || !data) throw error || new Error("Failed to create wiki");
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

export async function loadWiki(id: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");

  const nowIso = new Date().toISOString();

  // Touch last_loaded_at
  await supabase.from("wikis" as any).update({ last_loaded_at: nowIso } as any).eq("id", id);

  // Upsert active_wiki_id in user_settings
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: userData.user.id, active_wiki_id: id } as any,
      { onConflict: "user_id" }
    );
  if (error) throw error;
}

export async function fetchActiveWikiId(): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("active_wiki_id" as any)
    .maybeSingle();
  if (error) throw error;
  return ((data as any)?.active_wiki_id as string | null) || null;
}
