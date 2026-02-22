import React, { useRef, useState } from "react";
import { Upload, BookOpen, Trash2, BookMarked, Key } from "lucide-react";
import { useApp } from "@/context/AppContext";
import ApiKeyManager from "@/components/ApiKeyManager";
import { BookDocument } from "@/types/library";
import { pdfjs } from "react-pdf";

const Library: React.FC = () => {
  const { books, addBook, removeBook, setActiveBook } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showApiKeys, setShowApiKeys] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (file.type !== "application/pdf") continue;

      const reader = new FileReader();
      reader.onload = async (ev) => {
        const dataUrl = ev.target?.result as string;

        // Get page count
        let pageCount = 0;
        try {
          const loadingTask = pdfjs.getDocument(dataUrl);
          const pdf = await loadingTask.promise;
          pageCount = pdf.numPages;
        } catch {
          pageCount = 0;
        }

        const newBook: BookDocument = {
          id: crypto.randomUUID(),
          title: file.name.replace(/\.pdf$/i, ""),
          fileName: file.name,
          fileData: dataUrl,
          pageCount,
          chapters: [],
          addedAt: Date.now(),
        };

        addBook(newBook);
      };
      reader.readAsDataURL(file);
    }

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border bg-viewer-toolbar">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-display font-semibold">Library</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {books.length} {books.length === 1 ? "document" : "documents"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowApiKeys((v) => !v)}
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              title="Manage API Keys"
            >
              <Key className="w-4 h-4" />
              API Keys
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity shadow-sm"
            >
              <Upload className="w-4 h-4" />
              Upload PDF
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            multiple
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>
      </div>

      {/* API Key Manager Panel */}
      {showApiKeys && (
        <div className="px-6 py-4 border-b border-border bg-card">
          <ApiKeyManager />
        </div>
      )}

      {/* Book grid */}
      <div className="flex-1 overflow-auto p-6 scrollbar-thin">
        {books.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <BookMarked className="w-16 h-16 mb-4 opacity-25" />
            <p className="text-lg font-display">Your library is empty</p>
            <p className="text-sm mt-1">Upload a PDF to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {books.map((book, i) => (
              <BookCard
                key={book.id}
                book={book}
                index={i}
                onRead={() => setActiveBook(book.id)}
                onRemove={() => removeBook(book.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const BookCard: React.FC<{
  book: BookDocument;
  index: number;
  onRead: () => void;
  onRemove: () => void;
}> = ({ book, index, onRead, onRemove }) => {
  // Generate a warm hue based on index for visual variety
  const hues = [24, 18, 30, 12, 36, 6];
  const hue = hues[index % hues.length];

  return (
    <div
      className="group relative bg-card border border-border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 animate-slide-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Book cover area */}
      <div
        className="h-40 flex items-center justify-center relative overflow-hidden"
        style={{
          background: book.coverImageUrl
            ? undefined
            : `linear-gradient(135deg, hsl(${hue}, 35%, 82%), hsl(${hue}, 25%, 72%))`,
        }}
      >
        {book.coverImageUrl ? (
          <img
            src={book.coverImageUrl}
            alt={book.title}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <>
            {/* Spine accent */}
            <div
              className="absolute left-0 top-0 bottom-0 w-2"
              style={{ backgroundColor: `hsl(${hue}, 40%, 40%)` }}
            />
            <BookOpen className="w-10 h-10 text-white/60" />
          </>
        )}

        {/* Remove button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-black/20 text-white/70 opacity-0 group-hover:opacity-100 hover:bg-black/40 transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Info */}
      <div className="p-4">
        <h3 className="font-display font-semibold text-sm leading-tight line-clamp-2 mb-1">
          {book.title}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {book.pageCount} pages · {book.chapters.length} chapters
        </p>
        <button
          onClick={onRead}
          className="w-full py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
        >
          Read
        </button>
      </div>
    </div>
  );
};

export default Library;
