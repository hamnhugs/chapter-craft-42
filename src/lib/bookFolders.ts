import { supabase } from "@/integrations/supabase/client";

// Shelves (UI name) are stored in the book_folders table; membership is the
// single-valued books.folder_id. The table's dormant parent_id/color/
// default_wiki_id columns are legacy — nothing reads or writes them, and they
// are dropped in the shelf-membership migration.
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

// Book→shelf moves go through AppContext.updateBookFolder, which also patches
// the single client copy of the membership (books[].folderId).
