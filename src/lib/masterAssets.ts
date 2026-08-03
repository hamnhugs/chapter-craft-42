import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";
import { fetchImageById } from "@/lib/imageGen";
import type { Blueprint } from "@/lib/blueprint/schema";

// MasterAsset: a locked character/asset bundle that generate_video loads by id
// or @name so chat never re-describes the character. Design follows the
// evidence from the identity-preservation literature and shipping tools
// (Sora characters, Kling saved elements, Vidu "My References"):
//   - identity lives in IMAGES (hero + multi-view pack), never in prose;
//   - the prompt carries ONE short discriminative tag (assembly_tag) plus
//     motion + camera only — long appearance text fights image conditioning;
//   - the full tech pack drives the QC checklist and negatives, not the prompt.

export interface MasterAssetRow {
  id: string;
  user_id: string;
  name: string;
  hero_image_id: string | null;
  view_image_ids: string[];
  splat_id: string | null;
  entry_id: string | null;
  tech_pack_text: string;
  /** Structured tech pack — the machine-readable twin of tech_pack_text, which
   *  stays as prose for the human and the QC checklist. Views are PROJECTED
   *  from this, never drawn, so front/profile/top cannot disagree. Null on
   *  every master created before the blueprint migration. */
  blueprint: Blueprint | null;
  assembly_tag: string;
  negative_constraints: string[];
  banned_traits: string[];
  palette: string[];
  style_lock: string;
  front_azimuth_deg: number;
  ref_embeddings: {
    model_id: string;
    dims: number;
    vectors: Record<string, number[]>;
  } | null;
  created_at: string;
  updated_at?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/i;

/** Normalize a master handle ("@Robby" / "Robby " -> "robby"). Throws when the
 *  result isn't a usable @name. */
export function normalizeMasterName(raw: string): string {
  const name = String(raw || "").trim().replace(/^@/, "");
  if (!NAME_RE.test(name)) {
    throw new Error(
      "Master name must be 2-40 characters of letters, digits, '-' or '_' (it becomes the @handle used in prompts).",
    );
  }
  return name.toLowerCase();
}

/** Normalize a palette entry to "#rrggbb". Throws on anything that isn't hex. */
export function normalizeHex(raw: string): string {
  const s = String(raw || "").trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(s) && !/^[0-9a-f]{3}$/.test(s)) {
    throw new Error(`"${raw}" is not a hex color (expected #RRGGBB).`);
  }
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return `#${full}`;
}

/** True when the master_assets table exists (migration applied). */
export async function mastersMigrated(): Promise<boolean> {
  try {
    const { error } = await (supabase.from("master_assets" as any) as any)
      .select("id", { head: true, count: "exact" })
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

export async function fetchMasterById(id: string): Promise<MasterAssetRow | null> {
  const { data } = await (supabase.from("master_assets" as any) as any)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as MasterAssetRow) || null;
}

/** Look up a master by @name (case-insensitive; names are stored lowercase). */
export async function fetchMasterByName(name: string): Promise<MasterAssetRow | null> {
  const clean = String(name || "").trim().replace(/^@/, "").toLowerCase();
  if (!clean) return null;
  const { data } = await (supabase.from("master_assets" as any) as any)
    .select("*")
    .eq("name", clean)
    .maybeSingle();
  return (data as MasterAssetRow) || null;
}

/** Resolve a master from either an id (uuid) or an @name. */
export async function resolveMaster(idOrName: string): Promise<MasterAssetRow | null> {
  const s = String(idOrName || "").trim();
  if (!s) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return await fetchMasterById(s);
  }
  return await fetchMasterByName(s);
}

export async function listMasterAssets(): Promise<MasterAssetRow[]> {
  const { data } = await (supabase.from("master_assets" as any) as any)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  return (data as MasterAssetRow[]) || [];
}

/** Asset Factory neuron for a master — the memory system's handle on it. */
async function saveMasterNeuron(opts: {
  name: string;
  assemblyTag: string;
  techPack: string;
  palette: string[];
  negativeConstraints: string[];
  bannedTraits: string[];
  heroImageId: string | null;
  splatId: string | null;
  viewCount: number;
}): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data: settings } = await supabase
    .from("user_settings")
    .select("active_wiki_id" as any)
    .maybeSingle();
  const wikiId = (settings as any)?.active_wiki_id || null;
  const content = [
    `Locked master asset "@${opts.name}" for AI animation.`,
    opts.assemblyTag ? `Identity tag: ${opts.assemblyTag}` : "",
    opts.palette.length > 0 ? `Locked palette: ${opts.palette.join(", ")}` : "",
    opts.negativeConstraints.length > 0 ? `Hard bans: ${opts.negativeConstraints.join("; ")}` : "",
    opts.bannedTraits.length > 0 ? `Banned traits: ${opts.bannedTraits.join("; ")}` : "",
    opts.heroImageId ? `Hero image id: ${opts.heroImageId}` : "",
    opts.viewCount > 0 ? `${opts.viewCount} reference view(s) in the identity pack.` : "",
    opts.splatId ? `3D splat id: ${opts.splatId}` : "",
    opts.techPack ? `\nTech pack:\n${opts.techPack}` : "",
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title: `Master asset: @${opts.name}`,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: ["master-asset", "asset-factory", "generated"],
      confidence: 0.95,
      ...(wikiId ? { wiki_id: wikiId } : {}),
    } as any)
    .select("id")
    .single();
  if (error || !entry) return null;
  void reindexEmbeddings(true, wikiId).catch(() => {});
  return (entry as any).id;
}

export async function createMasterAsset(opts: {
  name: string;
  heroImageId?: string | null;
  viewImageIds?: string[];
  splatId?: string | null;
  assemblyTag?: string;
  techPack?: string;
  negativeConstraints?: string[];
  bannedTraits?: string[];
  palette?: string[];
  styleLock?: string;
  frontAzimuthDeg?: number;
}): Promise<MasterAssetRow> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");

  const name = normalizeMasterName(opts.name);
  const heroImageId = (opts.heroImageId || "").trim() || null;
  const viewImageIds = (opts.viewImageIds || []).map((s) => String(s).trim()).filter(Boolean);
  const splatId = (opts.splatId || "").trim() || null;
  if (!heroImageId && !splatId) {
    throw new Error("A master needs at least a hero image or a splat to lock identity to.");
  }
  // Verify the hero actually exists before locking to it — a master with a
  // dangling hero would silently degrade every future generation.
  if (heroImageId) {
    const hero = await fetchImageById(heroImageId);
    if (!hero) throw new Error(`Hero image ${heroImageId} was not found.`);
  }
  const palette = (opts.palette || []).map(normalizeHex);
  const styleLock = ["vector", "soft_3d", "live_action", "custom"].includes(opts.styleLock || "")
    ? (opts.styleLock as string)
    : "custom";

  const { data, error } = await (supabase.from("master_assets" as any) as any)
    .insert({
      user_id: uid,
      name,
      hero_image_id: heroImageId,
      view_image_ids: viewImageIds,
      splat_id: splatId,
      tech_pack_text: (opts.techPack || "").slice(0, 8000),
      assembly_tag: (opts.assemblyTag || "").slice(0, 300),
      negative_constraints: (opts.negativeConstraints || []).map((s) => String(s).slice(0, 200)).slice(0, 20),
      banned_traits: (opts.bannedTraits || []).map((s) => String(s).slice(0, 200)).slice(0, 20),
      palette,
      style_lock: styleLock,
      front_azimuth_deg: Number(opts.frontAzimuthDeg) || 0,
    })
    .select("*")
    .single();
  if (error) {
    if (/duplicate|unique/i.test(error.message || "")) {
      throw new Error(`A master named "@${name}" already exists — pick another name or delete the old one first.`);
    }
    throw new Error(`Master asset could not be saved: ${error.message}`);
  }

  // Neuron AFTER the row exists — a failed insert (duplicate name) must not
  // orphan an Asset Factory neuron describing a bundle that was never saved.
  // Conversely a failed neuron leaves a master with entry_id null: harmless.
  let saved = data as MasterAssetRow;
  const entryId = await saveMasterNeuron({
    name,
    assemblyTag: (opts.assemblyTag || "").trim(),
    techPack: (opts.techPack || "").trim(),
    palette,
    negativeConstraints: opts.negativeConstraints || [],
    bannedTraits: opts.bannedTraits || [],
    heroImageId,
    splatId,
    viewCount: viewImageIds.length,
  });
  if (entryId) {
    try {
      const updated = await updateMasterAsset(saved.id, { entry_id: entryId });
      if (updated) saved = updated;
    } catch { /* the master exists; the neuron link is best-effort */ }
  }
  return saved;
}

export async function updateMasterAsset(
  id: string,
  patch: Partial<Pick<MasterAssetRow,
    "view_image_ids" | "assembly_tag" | "tech_pack_text" | "negative_constraints" |
    "banned_traits" | "palette" | "front_azimuth_deg" | "ref_embeddings" | "hero_image_id" |
    "splat_id" | "entry_id" | "blueprint"
  >>,
): Promise<MasterAssetRow | null> {
  const { data, error } = await (supabase.from("master_assets" as any) as any)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    // The blueprint column arrives with its own migration. Retry without it
    // rather than failing the whole write, so a lagging database degrades to
    // "prose master, no blueprint" instead of "save is broken". Matched on the
    // Postgres error code (42703 = undefined column) the way persistMessage
    // does — the message text is server-owned prose and not a contract.
    if ("blueprint" in patch && ((error as any).code === "42703" || /blueprint/i.test(error.message || ""))) {
      const { blueprint: _dropped, ...rest } = patch;
      if (Object.keys(rest).length === 0) {
        throw new Error(
          "This master's blueprint could not be saved because the database hasn't been migrated yet — ask Lovable to apply the blueprint pipeline migration, then try again.",
        );
      }
      const retry = await (supabase.from("master_assets" as any) as any)
        .update({ ...rest, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (retry.error) throw new Error(`Master asset update failed: ${retry.error.message}`);
      return (retry.data as MasterAssetRow) || null;
    }
    throw new Error(`Master asset update failed: ${error.message}`);
  }
  return (data as MasterAssetRow) || null;
}

/** True when the blueprint column exists (migration applied). Probed the same
 *  way mastersMigrated() probes the table — a HEAD select that names only the
 *  column under test. */
export async function blueprintMigrated(): Promise<boolean> {
  try {
    const { error } = await (supabase.from("master_assets" as any) as any)
      .select("blueprint", { head: true, count: "exact" })
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

/** Delete a master. The linked images/splat/neuron are NOT deleted — the
 *  master is a bundle of references, not the owner of the underlying assets. */
export async function deleteMasterAsset(id: string): Promise<void> {
  const { data: deleted, error } = await (supabase.from("master_assets" as any) as any)
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!deleted || (deleted as any[]).length === 0) {
    throw new Error("Master asset could not be deleted (not found or no permission).");
  }
}

/** The identity pack for a generation: hero first, then views, deduped. */
export function masterImagePack(master: MasterAssetRow): string[] {
  const ids: string[] = [];
  if (master.hero_image_id) ids.push(master.hero_image_id);
  for (const v of master.view_image_ids || []) {
    if (v && !ids.includes(v)) ids.push(v);
  }
  return ids;
}

/** Merge the master's negative constraints and banned traits into one list. */
export function masterNegatives(master: MasterAssetRow): string[] {
  const out: string[] = [];
  for (const n of [...(master.negative_constraints || []), ...(master.banned_traits || [])]) {
    const s = String(n || "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
