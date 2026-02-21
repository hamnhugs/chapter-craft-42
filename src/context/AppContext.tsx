import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { BookDocument, Chapter } from "@/types/library";
import { supabase } from "@/integrations/supabase/client";

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
}

const AppContext = createContext<AppState | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [books, setBooks] = useState<BookDocument[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"library" | "viewer">("library");

  // Load books metadata from DB on mount
  useEffect(() => {
    const loadBooks = async () => {
      const { data } = await supabase
        .from("books")
        .select("id, title, file_name, page_count, created_at, chapters(id, name, start_page, end_page, text_content)")
        .order("created_at", { ascending: false });

      if (data) {
        // We store DB books but without fileData (they need to re-upload to read)
        const dbBooks: BookDocument[] = data.map((b: any) => ({
          id: b.id,
          title: b.title,
          fileName: b.file_name,
          fileData: "", // Will be populated when user uploads again
          pageCount: b.page_count,
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
  }, []);

  const addBook = useCallback(async (book: BookDocument) => {
    // Insert into DB
    const { data, error } = await supabase
      .from("books")
      .insert({ id: book.id, title: book.title, file_name: book.fileName, page_count: book.pageCount })
      .select()
      .single();

    if (!error && data) {
      setBooks((prev) => [...prev, { ...book, id: data.id }]);
    } else {
      // Still add locally even if DB fails
      setBooks((prev) => [...prev, book]);
    }
  }, []);

  const removeBook = useCallback(async (id: string) => {
    await supabase.from("books").delete().eq("id", id);
    setBooks((prev) => prev.filter((b) => b.id !== id));
    setActiveBookId((prev) => (prev === id ? null : prev));
  }, []);

  const setActiveBook = useCallback((id: string) => {
    setActiveBookId(id);
    setActiveTab("viewer");
  }, []);

  const addChapter = useCallback(async (bookId: string, chapter: Chapter) => {
    // Insert into DB
    const { data } = await supabase
      .from("chapters")
      .insert({
        id: chapter.id,
        book_id: bookId,
        name: chapter.name,
        start_page: chapter.startPage,
        end_page: chapter.endPage,
        text_content: chapter.textContent,
      })
      .select()
      .single();

    const finalChapter = data
      ? { ...chapter, id: data.id }
      : chapter;

    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, chapters: [...b.chapters, finalChapter] } : b
      )
    );
  }, []);

  const getActiveBook = useCallback(() => {
    return books.find((b) => b.id === activeBookId);
  }, [books, activeBookId]);

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
