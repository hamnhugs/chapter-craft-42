import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Neuron chains: named, ordered sets of neurons (wikis) that activate
// together. Stored as wiki_chains + wiki_chain_members (join table with
// position — 0 = the chain's primary neuron). The tables ship in the
// 20260711090000_neuron_chains migration, which the user applies manually
// (Lovable does not run pushed migration files), so every read/write here
// must degrade gracefully while the tables don't exist yet.

export interface NeuronChain {
  id: string;
  user_id: string;
  name: string;
  description: string;
  cover_color: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  /** Ordered member wiki ids — [0] is the chain's primary neuron. */
  wiki_ids: string[];
}

export const CHAINS_CHANGED_EVENT = "neuron-chains-changed";

export function emitChainsChanged() {
  try { window.dispatchEvent(new CustomEvent(CHAINS_CHANGED_EVENT)); } catch { /* SSR/no-window */ }
}

/** True when the error means the chains migration hasn't been applied yet. */
export function isChainsMigrationMissing(err: unknown): boolean {
  const msg = ((err as any)?.message || String(err || "")).toLowerCase();
  const code = (err as any)?.code || "";
  return (
    code === "PGRST205" || code === "42P01" ||
    /wiki_chains|wiki_chain_members/.test(msg) && /not exist|not find|schema cache|unknown/.test(msg) ||
    /relation .* does not exist/.test(msg)
  );
}

export const CHAINS_MIGRATION_MESSAGE =
  "The neuron-chains database migration hasn't been applied yet — give the deploy a minute and try again.";

interface ChainRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  cover_color: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  wiki_chain_members: { position: number; wiki_id: string }[];
}

export async function fetchChains(): Promise<NeuronChain[]> {
  const { data, error } = await (supabase.from("wiki_chains" as any) as any)
    .select("id, user_id, name, description, cover_color, last_used_at, created_at, updated_at, wiki_chain_members(position, wiki_id)")
    .order("last_used_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("position", { referencedTable: "wiki_chain_members", ascending: true });
  if (error) throw error;
  return ((data || []) as ChainRow[]).map((row) => ({
    ...row,
    wiki_ids: [...(row.wiki_chain_members || [])]
      .sort((a, b) => a.position - b.position)
      .map((m) => m.wiki_id),
  }));
}

// Add-then-prune (never delete-then-insert): if the write fails midway the
// chain keeps its old members (or a superset) — never ends up emptied.
async function replaceMembers(chainId: string, wikiIds: string[]): Promise<void> {
  if (wikiIds.length > 0) {
    const { error: upErr } = await (supabase.from("wiki_chain_members" as any) as any)
      .upsert(
        wikiIds.map((wiki_id, i) => ({ chain_id: chainId, wiki_id, position: i })),
        { onConflict: "chain_id,wiki_id" },
      );
    if (upErr) throw upErr;
    const { error: delErr } = await (supabase.from("wiki_chain_members" as any) as any)
      .delete()
      .eq("chain_id", chainId)
      .not("wiki_id", "in", `(${wikiIds.join(",")})`);
    if (delErr) throw delErr;
  } else {
    const { error: delErr } = await (supabase.from("wiki_chain_members" as any) as any)
      .delete()
      .eq("chain_id", chainId);
    if (delErr) throw delErr;
  }
}

export async function createChain(input: {
  name: string;
  description?: string;
  cover_color?: string;
  wikiIds: string[];
}): Promise<NeuronChain> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");
  const { data, error } = await (supabase.from("wiki_chains" as any) as any)
    .insert({
      user_id: userData.user.id,
      name: input.name,
      description: input.description || "",
      cover_color: input.cover_color || "#7C3AED",
    })
    .select()
    .single();
  if (error || !data) throw error || new Error("Failed to create chain");
  try {
    await replaceMembers((data as any).id, input.wikiIds);
  } catch (e) {
    // Don't leave a memberless chain behind if the member insert failed.
    await (supabase.from("wiki_chains" as any) as any).delete().eq("id", (data as any).id);
    throw e;
  }
  return { ...(data as any), wiki_ids: input.wikiIds };
}

export async function updateChain(
  id: string,
  updates: { name?: string; description?: string; cover_color?: string },
  wikiIds?: string[],
): Promise<void> {
  const { error } = await (supabase.from("wiki_chains" as any) as any)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  if (wikiIds) await replaceMembers(id, wikiIds);
}

export async function deleteChain(id: string): Promise<void> {
  const { error } = await (supabase.from("wiki_chains" as any) as any).delete().eq("id", id);
  if (error) throw error;
}

/** Best-effort recency bump so chain lists stay sorted by use. */
export async function touchChainUsed(id: string): Promise<void> {
  try {
    await (supabase.from("wiki_chains" as any) as any)
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", id);
  } catch { /* recency is cosmetic */ }
}

/**
 * Chains for UI consumers. Loads on mount and refreshes on the
 * CHAINS_CHANGED_EVENT window event (fired after any chain CRUD, including
 * the AI's chain tools). `migrationMissing` flags the not-yet-migrated state
 * so panels can show the "give the deploy a minute" notice instead of a
 * broken list.
 */
export function useChains(): { chains: NeuronChain[]; loaded: boolean; migrationMissing: boolean; refresh: () => void } {
  const [chains, setChains] = useState<NeuronChain[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchChains();
        if (!cancelled) { setChains(list); setMigrationMissing(false); }
      } catch (err) {
        if (!cancelled) {
          setChains([]);
          setMigrationMissing(isChainsMigrationMissing(err));
          if (!isChainsMigrationMissing(err)) console.warn("fetchChains failed:", err);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  useEffect(() => {
    const handler = () => setNonce((n) => n + 1);
    window.addEventListener(CHAINS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHAINS_CHANGED_EVENT, handler);
  }, []);

  return { chains, loaded, migrationMissing, refresh: () => setNonce((n) => n + 1) };
}
