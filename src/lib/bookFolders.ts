import { supabase } from "@/integrations/supabase/client";

export interface BookFolder {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  sort_index: number;
  /** Neuron this folder was last digested into. Null until first digest. */
  default_wiki_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function setFolderDefaultWiki(id: string, wikiId: string | null): Promise<void> {
  const { error } = await (supabase.from("book_folders" as any) as any)
    .update({ default_wiki_id: wikiId }).eq("id", id);
  if (error) throw error;
}

export async function listFolders(): Promise<BookFolder[]> {
  const { data, error } = await (supabase.from("book_folders" as any) as any)
    .select("*")
    .order("sort_index", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return (data as BookFolder[]) || [];
}

export async function createFolder(name: string, parentId?: string | null, color?: string | null): Promise<BookFolder> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) throw new Error("Not signed in");
  const { data, error } = await (supabase.from("book_folders" as any) as any)
    .insert({ user_id: uid, name: name.trim(), parent_id: parentId || null, color: color || null })
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

export async function moveBookToFolder(bookId: string, folderId: string | null): Promise<void> {
  const { error } = await (supabase.from("books" as any) as any)
    .update({ folder_id: folderId }).eq("id", bookId);
  if (error) throw error;
}

export async function setFolderColor(id: string, color: string | null): Promise<void> {
  const { error } = await (supabase.from("book_folders" as any) as any)
    .update({ color }).eq("id", id);
  if (error) throw error;
}
