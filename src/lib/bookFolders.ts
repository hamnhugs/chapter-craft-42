import { supabase } from "@/integrations/supabase/client";

// Shelves (UI name) are stored in the book_folders table; membership is the
// non-exclusive book_shelf_members junction, which is now the only store —
// the legacy books.folder_id mirror is no longer read or written by any
// client path (see shelfMembership.ts). The table's
// dormant parent_id/color/default_wiki_id columns are dropped by the
// 20260821120000_shelf_membership migration; this module never names them
// (select * / explicit writes), so it works on either side of it.
export interface BookFolder {
  id: string;
  user_id: string;
  name: string;
  sort_index: number;
  created_at: string;
  updated_at: string;
  /** Model-authored shelf digest (the catalog's third level), rolled up from
   *  member books' summaries. Undefined until the 20260902120000 migration is
   *  applied — listFolders does `select *`, so a missing column simply never
   *  appears rather than erroring. Untrusted text, sanitized at read doors. */
  summary?: string | null;
  summary_model?: string | null;
  summarized_at?: string | null;
}

export async function listFolders(): Promise<BookFolder[]> {
  const { data, error } = await (supabase.from("book_folders" as any) as any)
    .select("*")
    .order("sort_index", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return (data as BookFolder[]) || [];
}

export async function createFolder(name: string): Promise<BookFolder> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) throw new Error("Not signed in");
  const { data, error } = await (supabase.from("book_folders" as any) as any)
    .insert({ user_id: uid, name: name.trim() })
    .select("*")
    .single();
  if (error) throw error;
  return data as BookFolder;
}

// Rename and delete RETURN the affected row. RLS hides another user's shelf,
// and PostgREST answers a filtered update/delete that matched nothing with
// success and zero rows — so without `.select()` a call against an unknown or
// foreign id "succeeded", the caller mirrored the change locally, and the AI
// tool built on it would report a shelf as renamed or deleted that never was
// (review finding). Zero rows is an error here, never a no-op.
export async function renameFolder(id: string, name: string): Promise<void> {
  const { data, error } = await (supabase.from("book_folders" as any) as any)
    .update({ name: name.trim() }).eq("id", id).select("id");
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) throw new Error("Shelf not found");
}

export async function deleteFolder(id: string): Promise<void> {
  const { data, error } = await (supabase.from("book_folders" as any) as any)
    .delete().eq("id", id).select("id");
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) throw new Error("Shelf not found");
}

// Book→shelf membership changes go through AppContext.toggleBookShelf,
// which also patches the single client copy (books[].folderIds).
