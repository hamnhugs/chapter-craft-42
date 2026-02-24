import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { BookDocument, Chapter } from "@/types/library";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface AppState {
  books: BookDocument[];
  activeBookId: string | null;
  activeTab: "library" | "viewer";
  addBook: (book: BookDocument, sourceFile?: File) => Promise<void>;
  removeBook: (id: string) => void;
  setActiveBook: (id: string) => void;
  setActiveTab: (tab: "library" | "viewer") => void;
  addChapter: (bookId: string, chapter: Chapter) => void;
  getActiveBook: () => BookDocument | undefined;
  loadBookFile: (bookId: string) => Promise<string>;
  signOut: () => void;
}

const AppContext = createContext<AppState | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [books, setBooks] = useState<BookDocument[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"library" | "viewer">("library");
  const { user, signOut } = useAuth();

  useEffect(() => {
    if (!user) return;
    const loadBooks = async () => {
      const { data } = await supabase
        .from("books")
        .select("id, title, file_name, page_count, cover_image_url, created_at, chapters(id, name, start_page, end_page, text_content)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (data) {
        const dbBooks: BookDocument[] = data.map((b: any) => ({
          id: b.id,
          title: b.title,
          fileName: b.file_name,
          fileData: "",
          pageCount: b.page_count,
          coverImageUrl: b.cover_image_url || undefined,
          chapters: (b.chapters || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            startPage: c.start_page,
            endPage: c.end_page,
            textContent: c.text_content,
          })),
          addedAt: new Date(b.created_at).getTime(),
        }));
        setBooks(dbBooks);
      }
    };
    loadBooks();
  }, [user]);

  const addBook = useCallback(async (book: BookDocument, sourceFile?: File) => {
    if (!user) throw new Error("You must be signed in to upload books");

    const { data: existingRows, error: existingRowsError } = await supabase
      .from("books")
      .select("id, file_name")
      .eq("user_id", user.id)
      .limit(1000);

    if (existingRowsError) {
      console.error("Failed to look up existing book record:", existingRowsError);
      throw existingRowsError;
    }

    const normalizedFileName = book.fileName.trim().toLowerCase();
    const existingBookId = existingRows?.find(
      (row) => row.file_name?.trim().toLowerCase() === normalizedFileName,
    )?.id as string | undefined;
    let finalBookId = existingBookId || book.id;
    let createdNewBook = false;

    if (!existingBookId) {
      const { data, error } = await supabase
        .from("books")
        .insert({ id: book.id, title: book.title, file_name: book.fileName, page_count: book.pageCount, user_id: user.id })
        .select()
        .single();

      if (error || !data) {
        console.error("Failed to create book record:", error);
        throw error || new Error("Failed to create book record");
      }

      finalBookId = data.id;
      createdNewBook = true;
    } else {
      const { error: updateError } = await supabase
        .from("books")
        .update({ title: book.title, file_name: book.fileName, page_count: book.pageCount })
        .eq("id", existingBookId)
        .eq("user_id", user.id);

      if (updateError) {
        console.error("Failed to update existing book record:", updateError);
        throw updateError;
      }
    }

    if (!sourceFile && !book.fileData) {
      setBooks((prev) => {
        const existingIndex = prev.findIndex((b) => b.id === finalBookId);
        const nextBook = { ...book, id: finalBookId, fileData: "" };

        if (existingIndex === -1) return [nextBook, ...prev];

        return prev.map((b) => (b.id === finalBookId ? { ...b, ...nextBook } : b));
      });
      return;
    }

    try {
      const blob = sourceFile
        ? sourceFile
        : await (await fetch(book.fileData)).blob();

      const { error: uploadError } = await supabase.storage
        .from("book-pdfs")
        .upload(`${user.id}/${finalBookId}.pdf`, blob, { contentType: "application/pdf", upsert: true });

      if (uploadError) throw uploadError;

      const cachedFileUrl = sourceFile ? URL.createObjectURL(sourceFile) : book.fileData;

      setBooks((prev) => {
        const existingIndex = prev.findIndex((b) => b.id === finalBookId);
        const nextBook = { ...book, id: finalBookId, fileData: cachedFileUrl };

        if (existingIndex === -1) return [nextBook, ...prev];

        return prev.map((b) => (b.id === finalBookId ? { ...b, ...nextBook } : b));
      });
    } catch (err) {
      console.error("Failed to upload PDF to storage:", err);

      if (createdNewBook) {
        await supabase.from("books").delete().eq("id", finalBookId).eq("user_id", user.id);
        setBooks((prev) => prev.filter((b) => b.id !== finalBookId));
      }

      throw err instanceof Error ? err : new Error("PDF upload failed");
    }
  }, [user]);

  const removeBook = useCallback(async (id: string) => {
    if (user) {
      await supabase.storage.from("book-pdfs").remove([`${user.id}/${id}.pdf`]);
    }
    await supabase.from("books").delete().eq("id", id);
    setBooks((prev) => prev.filter((b) => b.id !== id));
    setActiveBookId((prev) => (prev === id ? null : prev));
  }, [user]);

  const setActiveBook = useCallback((id: string) => {
    setActiveBookId(id);
    setActiveTab("viewer");
  }, []);

  const addChapter = useCallback(async (bookId: string, chapter: Chapter) => {
    if (!user) return;
    const { data } = await supabase
      .from("chapters")
      .insert({
        id: chapter.id,
        book_id: bookId,
        name: chapter.name,
        start_page: chapter.startPage,
        end_page: chapter.endPage,
        text_content: chapter.textContent,
        user_id: user.id,
      })
      .select()
      .single();

    const finalChapter = data ? { ...chapter, id: data.id } : chapter;
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, chapters: [...b.chapters, finalChapter] } : b
      )
    );
  }, [user]);

  const getActiveBook = useCallback(() => {
    return books.find((b) => b.id === activeBookId);
  }, [books, activeBookId]);

  const loadBookFile = useCallback(async (bookId: string): Promise<string> => {
    // Check if already loaded in state
    const existing = books.find((b) => b.id === bookId);
    if (existing?.fileData) return existing.fileData;

    if (!user) return "";

    try {
      const { data, error } = await supabase.storage
        .from("book-pdfs")
        .download(`${user.id}/${bookId}.pdf`);

      if (error || !data) {
        console.error("Failed to download PDF:", error);
        return "";
      }

      const url = URL.createObjectURL(data);
      // Cache in state
      setBooks((prev) =>
        prev.map((b) => (b.id === bookId ? { ...b, fileData: url } : b))
      );
      return url;
    } catch (err) {
      console.error("Error loading book file:", err);
      return "";
    }
  }, [user, books]);

  return (
    <AppContext.Provider
      value={{
        books,
        activeBookId,
        activeTab,
        addBook,
        removeBook,
        setActiveBook,
        setActiveTab,
        addChapter,
        getActiveBook,
        loadBookFile,
        signOut,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
};
