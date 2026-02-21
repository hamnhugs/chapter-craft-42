import React, { createContext, useContext, useState, useCallback } from "react";
import { BookDocument, Chapter } from "@/types/library";

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

  const addBook = useCallback((book: BookDocument) => {
    setBooks((prev) => [...prev, book]);
  }, []);

  const removeBook = useCallback((id: string) => {
    setBooks((prev) => prev.filter((b) => b.id !== id));
    setActiveBookId((prev) => (prev === id ? null : prev));
  }, []);

  const setActiveBook = useCallback((id: string) => {
    setActiveBookId(id);
    setActiveTab("viewer");
  }, []);

  const addChapter = useCallback((bookId: string, chapter: Chapter) => {
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, chapters: [...b.chapters, chapter] } : b
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
