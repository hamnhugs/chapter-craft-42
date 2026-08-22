import { supabase } from "@/integrations/supabase/client";

// Shelves (UI name) are stored in the book_folders table; membership is the
// non-exclusive book_shelf_members junction (dual-mode with the legacy
// single-valued books.folder_id — see shelfMembership.ts). The table's
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

export async function renameFolder(id: string, name: string): Promise<void> {
  const { error } = await (supabase.from("book_folders" as any) as any)
    .update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

export async function deleteFolder(id: string): Promise<void> {
  const { error } = await (supabase.from("book_folders" as any) as any).delete().eq("id", id);
  if (error) throw error;
}

// Book→shelf membership changes go through AppContext.toggleBookShelf,
// which also patches the single client copy (books[].folderIds).
