import { supabase } from "@/integrations/supabase/client";
import { deleteImageAttachment, deleteImageMemory } from "@/lib/imageGen";

// The single canonical projection of "every image the app has stored".
// Two tables can describe one storage file: image_attachments (the library —
// generated, uploaded, extracted) and image_memories (captions + OCR for
// recall; also legacy uploads and rows stranded by partial deletes). They
// share `storage_path` in the private generated-images bucket, so that path
// is the merge key.

export type ImageProvenance =
  | "generated"
  | "upload"
  | "figure"
  | "sheet"
  | "splat-views"
  | "edit"
  | "memory-only";

/** Metadata subset of an image_attachments row the library reads. */
export interface LibraryAttachmentRow {
  id: string;
  entry_id?: string | null;
  prompt?: string | null;
  caption?: string | null;
  model?: string | null;
  kind?: string | null;
  book_id?: string | null;
  storage_path: string;
  created_at: string;
}

/** Metadata subset of an image_memories row the library reads. */
export interface LibraryMemoryRow {
  id: string;
  storage_path: string;
  caption?: string | null;
  ocr_text?: string | null;
  tags?: string[] | null;
  width?: number | null;
  height?: number | null;
  created_at: string;
}

export interface UnifiedImage {
  /** storage_path — the merge key shared by both tables. */
  key: string;
  attachmentId?: string;
  memoryId?: string;
  storagePath: string;
  title: string;
  prompt?: string;
  caption?: string;
  ocrText?: string;
  tags?: string[];
  model?: string;
  kind?: string;
  width?: number;
  height?: number;
  createdAt: string;
  sources: { attachment: boolean; memory: boolean };
  provenance: ImageProvenance;
}

/** Where an image came from, derived from the model/kind strings the writers
 *  actually use (imageUpload: "upload"; chatTools: "blueprint-sheet";
 *  splatViews: "splat-turntable"; figureJobs: kind="figure" + book_id).
 *  Edits store the generator's model id, indistinguishable from a fresh
 *  generation, so they stay under "generated" rather than an unverifiable
 *  "edit" bucket. `null` means the row exists only in image_memories. */
export function deriveProvenance(att: LibraryAttachmentRow | null | undefined): ImageProvenance {
  if (!att) return "memory-only";
  if (att.model === "upload") return "upload";
  if (att.kind === "figure" || att.book_id) return "figure";
  if (att.model === "blueprint-sheet") return "sheet";
  if (att.model === "splat-turntable") return "splat-views";
  return "generated";
}

const bestTitle = (...candidates: Array<string | null | undefined>): string => {
  for (const c of candidates) {
    const t = (c || "").trim();
    if (t) return t;
  }
  return "Untitled";
};

/** Merge both tables' rows into one deduped list, newest first. The
 *  attachment row is primary when both describe the same file (its id,
 *  prompt, model and created_at win); the memory row folds in what only it
 *  knows: memoryId, caption, OCR text, tags and pixel dimensions. */
export function mergeImageRows(
  attachmentRows: LibraryAttachmentRow[],
  memoryRows: LibraryMemoryRow[],
): UnifiedImage[] {
  const byPath = new Map<string, UnifiedImage>();
  for (const att of attachmentRows) {
    if (!att?.storage_path || byPath.has(att.storage_path)) continue;
    byPath.set(att.storage_path, {
      key: att.storage_path,
      attachmentId: att.id,
      storagePath: att.storage_path,
      title: bestTitle(att.prompt, att.caption),
      prompt: att.prompt || undefined,
      caption: att.caption || undefined,
      model: att.model || undefined,
      kind: att.kind || undefined,
      createdAt: att.created_at,
      sources: { attachment: true, memory: false },
      provenance: deriveProvenance(att),
    });
  }
  for (const mem of memoryRows) {
    if (!mem?.storage_path) continue;
    const existing = byPath.get(mem.storage_path);
    if (existing) {
      if (existing.sources.memory) continue;
      existing.memoryId = mem.id;
      existing.caption = existing.caption || mem.caption || undefined;
      existing.ocrText = mem.ocr_text || undefined;
      existing.tags = mem.tags || undefined;
      existing.width = mem.width ?? undefined;
      existing.height = mem.height ?? undefined;
      existing.sources.memory = true;
      existing.title = bestTitle(existing.prompt, existing.caption);
      continue;
    }
    byPath.set(mem.storage_path, {
      key: mem.storage_path,
      memoryId: mem.id,
      storagePath: mem.storage_path,
      title: bestTitle(mem.caption),
      caption: mem.caption || undefined,
      ocrText: mem.ocr_text || undefined,
      tags: mem.tags || undefined,
      width: mem.width ?? undefined,
      height: mem.height ?? undefined,
      createdAt: mem.created_at,
      sources: { attachment: false, memory: true },
      provenance: "memory-only",
    });
  }
  return Array.from(byPath.values()).sort((a, b) => {
    const at = Date.parse(a.createdAt) || 0;
    const bt = Date.parse(b.createdAt) || 0;
    if (at !== bt) return bt - at;
    const aid = a.attachmentId || a.memoryId || a.key;
    const bid = b.attachmentId || b.memoryId || b.key;
    return bid.localeCompare(aid);
  });
}

/** Case-insensitive substring match across every text field — including OCR
 *  text and tags, which the old prompt-only server search could never see. */
export function filterImages(list: UnifiedImage[], query: string): UnifiedImage[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((img) => {
    if (img.title.toLowerCase().includes(q)) return true;
    if (img.prompt?.toLowerCase().includes(q)) return true;
    if (img.caption?.toLowerCase().includes(q)) return true;
    if (img.ocrText?.toLowerCase().includes(q)) return true;
    if (img.tags?.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  });
}

// PostgREST silently caps un-ranged selects at its server-side max-rows
// (1000 on hosted Supabase — no override in this project's config). An
// "All images" view built on a silently capped query would recreate the
// exact 25-row bug this module exists to kill, at 1000. Drain in pages; the
// id tiebreaker keeps offset pages stable when created_at collides.
const DRAIN_PAGE = 1000;

async function fetchAllRows(table: string, columns: string, label: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += DRAIN_PAGE) {
    const { data, error } = await (supabase.from(table as any) as any)
      .select(columns)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + DRAIN_PAGE - 1);
    // Builders resolve {error} — they never throw. Surface it readably.
    if (error) throw new Error(`Could not load ${label}: ${error.message}`);
    const page = (data as any[]) || [];
    out.push(...page);
    if (page.length < DRAIN_PAGE) return out;
  }
}

/** Load ALL image metadata (no pixels — RLS scopes both tables to the
 *  signed-in user), paging past the server row cap, and merge into the
 *  unified projection. */
export async function fetchAllImageMeta(): Promise<UnifiedImage[]> {
  const [attRows, memRows] = await Promise.all([
    fetchAllRows(
      "image_attachments",
      "id, entry_id, prompt, caption, model, kind, book_id, storage_path, created_at",
      "images",
    ),
    fetchAllRows(
      "image_memories",
      "id, storage_path, caption, ocr_text, tags, width, height, created_at",
      "image memories",
    ),
  ]);
  return mergeImageRows(
    attRows as LibraryAttachmentRow[],
    memRows as LibraryMemoryRow[],
  );
}

/** Delete a unified image through the existing single-table delete paths,
 *  which own the shared-file bookkeeping (deleteImageAttachment also clears
 *  memory rows sharing the file; deleteImageMemory keeps the file while a
 *  library image still references it). */
export async function deleteUnifiedImage(img: UnifiedImage): Promise<void> {
  if (img.attachmentId) {
    await deleteImageAttachment({ id: img.attachmentId, storage_path: img.storagePath });
    return;
  }
  if (img.memoryId) {
    await deleteImageMemory({ id: img.memoryId, storage_path: img.storagePath });
    return;
  }
  throw new Error("Image has no backing record to delete");
}
