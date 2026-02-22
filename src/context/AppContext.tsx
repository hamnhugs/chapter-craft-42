import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { BookDocument, Chapter } from "@/types/library";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface AppState {
  books: BookDocument[];
  activeBookId: string | null;
  activeTab: "library" | "viewer";
  addBook: (book: BookDocument) => void;
  removeBook: (id: string) => void;
  setActiveBook: (id: string) => void;
  setActiveTab: (tab: "library" | "viewer") => void;
  addChapter: (bookId: string, chapter: Chapter) => void;
  getActiveBook: () => BookDocument | undefined;
  loadBookFile: (bookId: string) => Promise<string>;
  reuploadBookFile: (bookId: string, file: File) => Promise<string>;
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

  const addBook = useCallback(async (book: BookDocument) => {
    if (!user) return;
    const { data, error } = await supabase
      .from("books")
      .insert({ id: book.id, title: book.title, file_name: book.fileName, page_count: book.pageCount, user_id: user.id })
      .select()
      .single();

    const bookId = data?.id || book.id;

    // Upload PDF to storage
    if (book.fileData) {
      try {
        const res = await fetch(book.fileData);
        const blob = await res.blob();
        await supabase.storage
          .from("book-pdfs")
          .upload(`${user.id}/${bookId}.pdf`, blob, { contentType: "application/pdf", upsert: true });
      } catch (err) {
        console.error("Failed to upload PDF to storage:", err);
      }
    }

    if (!error && data) {
      setBooks((prev) => [...prev, { ...book, id: data.id }]);
    } else {
      setBooks((prev) => [...prev, book]);
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

  const reuploadBookFile = useCallback(async (bookId: string, file: File): Promise<string> => {
    if (!user) return "";
    try {
      await supabase.storage
        .from("book-pdfs")
        .upload(`${user.id}/${bookId}.pdf`, file, { contentType: "application/pdf", upsert: true });

      const { data, error } = await supabase.storage
        .from("book-pdfs")
        .download(`${user.id}/${bookId}.pdf`);

      if (error || !data) return "";

      const url = URL.createObjectURL(data);
      setBooks((prev) =>
        prev.map((b) => (b.id === bookId ? { ...b, fileData: url } : b))
      );
      return url;
    } catch (err) {
      console.error("Failed to re-upload PDF:", err);
      return "";
    }
  }, [user]);

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
        reuploadBookFile,
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
