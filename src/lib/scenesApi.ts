import { supabase } from "@/integrations/supabase/client";
import { reindexEmbeddings } from "@/lib/knowledgeApi";
import type { Scene } from "@/lib/blueprint/scene";
import { preserveShotNumbers } from "@/lib/blueprint/scene";

// Persistence for production scenes. Deliberately thin — the plan document is
// validated in scene.ts and drawn in planSheet.ts; this file only stores it.
//
// Table access goes through an untyped handle because the generated row type
// says `plan: Json` where the app needs `plan: Scene`; the cast lives here in
// one place rather than at every call site.

export interface SceneRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  book_id: string | null;
  chapter_index: number | null;
  entry_id: string | null;
  plan: Scene;
  /** Set when the shot list is locked: numbers become immutable, and shots
   *  removed from a revision are kept as omitted tombstones instead of
   *  disappearing — the film-set convention, and the same supersede-never-
   *  delete philosophy the memory stack already follows. */
  locked_at: string | null;
  created_at: string;
  updated_at?: string;
}

const db = () => supabase.from("production_scenes" as any) as any;

/** True when the scenes table exists (migration applied). */
export async function scenesMigrated(): Promise<boolean> {
  try {
    const { error } = await db().select("id", { head: true, count: "exact" }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

export async function listScenes(limit = 50): Promise<SceneRow[]> {
  const { data, error } = await db()
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Scenes could not be listed: ${error.message}`);
  return (data as SceneRow[]) || [];
}

/** Resolve by uuid or by name — case-insensitive but EXACT. The previous
 *  unescaped lookup let "forge_night" match "forgeXnight", and because
 *  saveScene resolves-by-name before deciding insert-vs-update, that could
 *  UPDATE an unrelated scene.
 *
 *  Exactness is guaranteed CLIENT-SIDE: ilike is only the case-folding probe.
 *  Escaping alone cannot make it exact — PostgREST additionally maps `*` to
 *  `%` after URL decoding, and no escape survives that (`\*` becomes `\%`, a
 *  literal-percent match). So `*` is mapped to `_` (matches the literal `*`
 *  character, one position) to keep such names resolvable, and the returned
 *  candidates are filtered by real case-insensitive equality. */
export async function resolveScene(idOrName: string): Promise<SceneRow | null> {
  const s = String(idOrName || "").trim();
  if (!s) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    const { data } = await db().select("*").eq("id", s).maybeSingle();
    return (data as SceneRow) || null;
  }
  const literal = s.replace(/([\\%_])/g, "\\$1").replace(/\*/g, "_");
  const { data } = await db().select("*").ilike("name", literal).limit(5);
  const rows = (data as SceneRow[]) || [];
  const want = s.toLowerCase();
  return rows.find((r) => String(r.name || "").toLowerCase() === want) ?? null;
}

/** Asset Factory neuron for a scene — mirrors saveMasterNeuron so a saved
 *  scene is retrievable by the memory system, not only by guessing its name. */
async function saveSceneNeuron(plan: Scene): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data: settings } = await supabase
    .from("user_settings")
    .select("active_wiki_id" as any)
    .maybeSingle();
  const wikiId = (settings as any)?.active_wiki_id || null;
  const d = plan.designator;
  const content = [
    `Production scene "${plan.name}"${plan.slug ? ` — ${plan.slug}` : ""}.`,
    d ? `Designator: ${[d.show, d.episode, d.sequence, d.scene].filter(Boolean).join(" / ")}` : "",
    `Stage: ${plan.extent.w}×${plan.extent.h} ${plan.unit}.`,
    plan.cameras.length > 0
      ? `Cameras: ${plan.cameras.map((c) => `${c.label} (${c.focalMm}mm)`).join(", ")}`
      : "",
    plan.blocking.length > 0 ? `Blocking: ${plan.blocking.map((b) => b.name).join(", ")}` : "",
    plan.shots.length > 0 ? `${plan.shots.length} shot(s) in the sequence.` : "",
    plan.notes.length > 0 ? `Notes: ${plan.notes.join(" · ")}` : "",
  ].filter(Boolean).join("\n");
  const { data: entry, error } = await supabase
    .from("knowledge_entries")
    .insert({
      user_id: uid,
      title: `Production scene: ${plan.name}`,
      content: content.slice(0, 4000),
      entry_type: "concept",
      tags: ["production-scene", "asset-factory", "generated"],
      confidence: 0.95,
      ...(wikiId ? { wiki_id: wikiId } : {}),
    } as any)
    .select("id")
    .single();
  if (error || !entry) return null;
  void reindexEmbeddings(true, wikiId).catch(() => {});
  return (entry as any).id;
}

/** Insert or replace a scene by name. Saving the same scene twice updates it
 *  rather than colliding on the unique index — a plan is revised constantly.
 *  On re-save, shots that match an existing shot by id KEEP their numbers and
 *  new shots take gap numbers (0015 between 0010 and 0020); once the scene is
 *  locked, shots dropped from a revision survive as omitted tombstones. */
export async function saveScene(
  plan: Scene,
  opts: { bookId?: string | null; chapterIndex?: number | null; existingId?: string | null } = {},
): Promise<SceneRow> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in");

  // `existingId` makes save-under-a-new-name a true RENAME of that row —
  // resolving by the new name would find nothing, insert a copy, and leave
  // the original (with its lock and tombstones) stranded under the old name.
  const existing = opts.existingId
    ? await resolveScene(opts.existingId)
    : await resolveScene(plan.name);
  const merged = existing
    ? preserveShotNumbers(existing.plan, plan, { locked: !!existing.locked_at })
    : plan;
  const row: Record<string, unknown> = {
    user_id: uid,
    name: merged.name,
    slug: merged.slug || "",
    book_id: opts.bookId ?? existing?.book_id ?? null,
    chapter_index: opts.chapterIndex ?? existing?.chapter_index ?? null,
    plan: merged,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await db().update(row).eq("id", existing.id).select("*").maybeSingle();
    if (error) throw new Error(`Scene could not be saved: ${error.message}`);
    return data as SceneRow;
  }

  // Neuron AFTER the row exists would orphan nothing, but the entry id has to
  // ride the insert; create it first and tolerate failure — a scene with
  // entry_id null is retrievable by name, just invisible to memory recall.
  const entryId = await saveSceneNeuron(merged).catch(() => null);
  if (entryId) row.entry_id = entryId;
  let { data, error } = await db().insert(row).select("*").single();
  if (error && entryId && /entry_id|column/i.test(error.message || "")) {
    // Pre-migration table without entry_id — retry without it.
    delete row.entry_id;
    ({ data, error } = await db().insert(row).select("*").single());
  }
  if (error) throw new Error(`Scene could not be saved: ${error.message}`);
  return data as SceneRow;
}

/** Lock (or unlock) a scene's shot list. Locking is the film-set convention:
 *  after lock, numbers never change and removals become omissions. */
export async function setSceneLocked(id: string, locked: boolean): Promise<SceneRow> {
  const { data, error } = await db()
    .update({ locked_at: locked ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    if (/locked_at/i.test(error.message || "")) {
      throw new Error(
        "Scene locking needs the production-ledger migration (20260802153000) — ask Lovable to apply it.",
      );
    }
    throw new Error(`Scene lock could not be changed: ${error.message}`);
  }
  if (!data) throw new Error("Scene not found (or no permission).");
  return data as SceneRow;
}

export async function deleteScene(id: string): Promise<void> {
  const { data: deleted, error } = await db().delete().eq("id", id).select("id");
  if (error) throw error;
  if (!deleted || (deleted as any[]).length === 0) {
    throw new Error("Scene could not be deleted (not found or no permission).");
  }
}
