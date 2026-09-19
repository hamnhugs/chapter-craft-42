import { supabase } from "@/integrations/supabase/client";

/**
 * Memory Lens — display policy + state for images attached to recalled
 * memories.
 *
 * Policy (research-backed: picture-superiority, Krugman exposure theory,
 * wear-in/wear-out, banner blindness; Facebook/Google/Apple resurfacing):
 *  • never seen → auto-show full, once, max ONE per assistant turn
 *  • seen within RESHOW_AFTER_DAYS → collapsed chip (tap to expand)
 *  • quiet for RESHOW_AFTER_DAYS+ → eligible to auto-show again (no lifetime cap)
 *  • user asks → always show, never consumes auto-show state
 *  • suppressed ("don't show this again") → nothing auto-renders, ever
 *  • unknown/unreadable state → chip, never auto-expand (fail closed)
 *
 * A display only COUNTS when the card was actually visible on-screen
 * (IntersectionObserver ≥50% for ≥1s, document visible, hands-free inactive) —
 * recorded via recordShown() from the card component, not at render time.
 *
 * State lives in image_attachments.recall_* columns (migration
 * 20260730*_memory_lens_tool_foundry.sql). Before the migration is applied,
 * a per-device localStorage map keeps the policy working; it is merged into
 * the DB (max counts, suppression wins) the first time the columns respond.
 */

export const RESHOW_AFTER_DAYS = 30;
const LS_KEY = "memory-lens-state-v1";
const SESSION_KEY = "memory-lens-session";

export interface RecallState {
  shownCount: number;
  lastShownAt: string | null;
  lastSession: string | null;
  suppressed: boolean;
  /** true when the state came from the DB columns (positive record). */
  fromDb: boolean;
}

export interface MemoryImageCandidate {
  entryId: string;
  entryTitle: string;
  imageId: string;
  storagePath: string;
  prompt: string;
  state: RecallState | null; // null = state unknown (fail closed → chip)
}

export type LensVerdict = "expand" | "chip" | "hide";

// ── session id (per-tab; the app has no conversation ids) ────────────────────
export function lensSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return "no-session";
  }
}

// ── localStorage fallback store ──────────────────────────────────────────────
type LocalMap = Record<string, { c: number; t?: string; s?: 1; sess?: string }>;

function readLocal(): LocalMap {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as LocalMap;
  } catch {
    return {};
  }
}

function writeLocal(map: LocalMap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch { /* private mode — best effort */ }
}

// ── DB availability (single probe per session) ───────────────────────────────
let dbColumnsAvailable: boolean | null = null;
let mergedLocal = false;

function isMissingColumn(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42703" || code === "PGRST204" || code === "42P01";
}

async function mergeLocalIntoDb(): Promise<void> {
  if (mergedLocal) return;
  mergedLocal = true;
  const local = readLocal();
  const ids = Object.keys(local);
  if (ids.length === 0) return;
  try {
    for (const id of ids) {
      const l = local[id];
      const patch: Record<string, unknown> = {};
      if (l.c > 0) patch.recall_shown_count = l.c;
      if (l.t) patch.recall_last_shown_at = l.t;
      if (l.s) patch.recall_suppressed = true;
      if (Object.keys(patch).length === 0) continue;
      // Merge semantics: only fill values the DB doesn't already have higher.
      const { data } = await (supabase.from("image_attachments" as any) as any)
        .select("id, recall_shown_count, recall_suppressed")
        .eq("id", id)
        .maybeSingle();
      if (!data) continue;
      const dbCount = Number((data as any).recall_shown_count) || 0;
      if (dbCount >= l.c) delete patch.recall_shown_count;
      if ((data as any).recall_suppressed === true) delete patch.recall_suppressed;
      if (Object.keys(patch).length === 0) continue;
      await (supabase.from("image_attachments" as any) as any).update(patch).eq("id", id);
    }
    writeLocal({});
  } catch { /* keep local copy; retry next session */ }
}

// ── state reads ──────────────────────────────────────────────────────────────
export async function getRecallStates(imageIds: string[]): Promise<Map<string, RecallState>> {
  const out = new Map<string, RecallState>();
  if (imageIds.length === 0) return out;
  if (dbColumnsAvailable !== false) {
    try {
      const { data, error } = await (supabase.from("image_attachments" as any) as any)
        .select("id, recall_shown_count, recall_last_shown_at, recall_last_session, recall_suppressed")
        .in("id", imageIds);
      if (error) throw error;
      dbColumnsAvailable = true;
      void mergeLocalIntoDb();
      for (const r of (data as any[]) || []) {
        out.set(r.id, {
          shownCount: Number(r.recall_shown_count) || 0,
          lastShownAt: r.recall_last_shown_at || null,
          lastSession: r.recall_last_session || null,
          suppressed: r.recall_suppressed === true,
          fromDb: true,
        });
      }
      return out;
    } catch (e) {
      if (isMissingColumn(e)) dbColumnsAvailable = false;
      else return out; // transient error → all unknown → fail closed
    }
  }
  // Pre-migration fallback: this device's history. An id with no entry is
  // treated as never-shown ON THIS DEVICE (accepted pre-migration tradeoff —
  // the harmless direction: an image may auto-show once per device).
  const local = readLocal();
  for (const id of imageIds) {
    const l = local[id];
    out.set(id, {
      shownCount: l?.c || 0,
      lastShownAt: l?.t || null,
      lastSession: l?.sess || null,
      suppressed: l?.s === 1,
      fromDb: false,
    });
  }
  return out;
}

// ── policy ───────────────────────────────────────────────────────────────────
function daysSince(iso: string | null): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

/** The display decision for one candidate. autoShow=false (settings toggle)
 *  demotes every would-be expand to a chip. */
export function lensVerdict(state: RecallState | null, autoShow: boolean): LensVerdict {
  if (!state) return "chip"; // unknown → fail closed
  if (state.suppressed) return "hide";
  if (!autoShow) return "chip";
  if (state.lastSession && state.lastSession === lensSessionId()) return "hide"; // already rendered this session
  if (state.shownCount === 0) return "expand";
  if (daysSince(state.lastShownAt) >= RESHOW_AFTER_DAYS) return "expand";
  return "chip";
}

// ── state writes ─────────────────────────────────────────────────────────────
async function bumpLocal(imageId: string, mut: (l: LocalMap[string]) => void): Promise<void> {
  const map = readLocal();
  const cur = map[imageId] || { c: 0 };
  mut(cur);
  map[imageId] = cur;
  writeLocal(map);
}

/** Record a REAL display (viewability-confirmed). Idempotent-ish: callers
 *  guard with wasRecentlyRecorded(). */
export async function recordShown(imageId: string): Promise<void> {
  const now = new Date().toISOString();
  const sess = lensSessionId();
  await bumpLocal(imageId, (l) => { l.c = (l.c || 0) + 1; l.t = now; l.sess = sess; });
  if (dbColumnsAvailable === false) return;
  try {
    const { data } = await (supabase.from("image_attachments" as any) as any)
      .select("id, recall_shown_count")
      .eq("id", imageId)
      .maybeSingle();
    if (!data) return;
    await (supabase.from("image_attachments" as any) as any)
      .update({
        recall_shown_count: (Number((data as any).recall_shown_count) || 0) + 1,
        recall_last_shown_at: now,
        recall_last_session: sess,
      })
      .eq("id", imageId);
    dbColumnsAvailable = true;
  } catch (e) {
    if (isMissingColumn(e)) dbColumnsAvailable = false;
  }
}

/** A user-initiated display ("show me") — tracked separately, consumes nothing. */
export async function recordRequested(imageId: string): Promise<void> {
  if (dbColumnsAvailable === false) return;
  try {
    const { data } = await (supabase.from("image_attachments" as any) as any)
      .select("id, recall_requested_count")
      .eq("id", imageId)
      .maybeSingle();
    if (!data) return;
    await (supabase.from("image_attachments" as any) as any)
      .update({ recall_requested_count: (Number((data as any).recall_requested_count) || 0) + 1 })
      .eq("id", imageId);
  } catch (e) {
    if (isMissingColumn(e)) dbColumnsAvailable = false;
  }
}

export async function setSuppressed(imageId: string, suppressed: boolean): Promise<void> {
  await bumpLocal(imageId, (l) => { if (suppressed) l.s = 1; else delete l.s; });
  if (dbColumnsAvailable === false) return;
  try {
    await (supabase.from("image_attachments" as any) as any)
      .update({ recall_suppressed: suppressed })
      .eq("id", imageId);
    dbColumnsAvailable = true;
  } catch (e) {
    if (isMissingColumn(e)) dbColumnsAvailable = false;
  }
}

export interface SuppressedImage { id: string; prompt: string; storage_path: string }

/** For the Settings undo list. */
export async function listSuppressed(): Promise<SuppressedImage[]> {
  try {
    const { data, error } = await (supabase.from("image_attachments" as any) as any)
      .select("id, prompt, storage_path")
      .eq("recall_suppressed", true)
      .limit(50);
    if (error) throw error;
    return ((data as any[]) || []).map((r) => ({ id: r.id, prompt: r.prompt || "", storage_path: r.storage_path }));
  } catch {
    const local = readLocal();
    return Object.keys(local).filter((id) => local[id].s === 1).map((id) => ({ id, prompt: "", storage_path: "" }));
  }
}

/** Guard against double-recording a display (e.g. re-render after reload). */
export function wasRecentlyRecorded(state: RecallState | null): boolean {
  if (!state) return false;
  if (state.lastSession && state.lastSession === lensSessionId()) return true;
  return state.shownCount > 0 && daysSince(state.lastShownAt) < 1;
}
