import React, { useRef, useState, useMemo } from "react";
import { useApp } from "@/context/AppContext";
import ApiKeyManager from "@/components/ApiKeyManager";
import { BookDocument } from "@/types/library";
import { pdfjs } from "react-pdf";
import { Progress } from "@/components/ui/progress";
import { convertEpubToPdf } from "@/lib/epubToPdf";

type UploadState = {
  id: string;
  fileName: string;
  status: "queued" | "uploading" | "success" | "failed";
  attempts: number;
  error?: string;
};

const SUPPORTED_UPLOAD_EXTENSIONS = ["pdf", "doc", "docx", "txt", "rtf", "odt", "epub"] as const;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_CONCURRENT_UPLOADS = 3;

const Library: React.FC = () => {
  const { books, addBook, removeBook, setActiveBook, updateBookTitle } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [sortBy, setSortBy] = useState<"date" | "name">("date");
  const [uploadStates, setUploadStates] = useState<UploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [currentBatchIds, setCurrentBatchIds] = useState<string[]>([]);

  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => {
      if (sortBy === "name") return a.title.localeCompare(b.title);
      return b.addedAt - a.addedAt;
    });
  }, [books, sortBy]);

  const currentBatchStateMap = useMemo(() => {
    const ids = new Set(currentBatchIds);
    return uploadStates.filter((state) => ids.has(state.id));
  }, [currentBatchIds, uploadStates]);

  const currentBatchCompletedCount = currentBatchStateMap.filter(
    (state) => state.status === "success" || state.status === "failed",
  ).length;

  const currentBatchProgress = currentBatchIds.length
    ? Math.round((currentBatchCompletedCount / currentBatchIds.length) * 100)
    : 0;

  const isSupportedDocument = (file: File) => {
    const extension = file.name.toLowerCase().split(".").pop();
    return !!extension && SUPPORTED_UPLOAD_EXTENSIONS.includes(extension as (typeof SUPPORTED_UPLOAD_EXTENSIONS)[number]);
  };

  const getDisplayTitle = (fileName: string) => {
    return fileName.replace(/\.[^/.]+$/i, "");
  };

  const getPdfPageCount = async (file: File) => {
    try {
      const data = await file.arrayBuffer();
      const loadingTask = pdfjs.getDocument({ data });
      const pdf = await loadingTask.promise;
      return pdf.numPages;
    } catch {
      return 0;
    }
  };

  const updateUploadState = (id: string, patch: Partial<UploadState>) => {
    setUploadStates((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const getErrorMessage = (error: unknown) => {
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message: string }).message);
    }
    return "Upload failed";
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const selectedFiles = Array.from(files);
    const supportedFiles = selectedFiles.filter(isSupportedDocument);
    const unsupportedFiles = selectedFiles.filter((file) => !isSupportedDocument(file));

    if (unsupportedFiles.length > 0) {
      const skippedStates: UploadState[] = unsupportedFiles.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-unsupported`,
        fileName: file.name,
        status: "failed",
        attempts: 0,
        error: "Unsupported file type",
      }));
      setUploadStates((prev) => [...skippedStates, ...prev].slice(0, 80));
    }

    if (supportedFiles.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const queue = supportedFiles.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
    }));

    setCurrentBatchIds(queue.map((item) => item.id));
    setUploadStates((prev) => [
      ...queue.map(({ id, file }) => ({
        id,
        fileName: file.name,
        status: "queued" as const,
        attempts: 0,
      })),
      ...prev,
    ].slice(0, 80));

    setIsUploading(true);

    const processQueueItem = async (item: { id: string; file: File }) => {
      const isEpub = item.file.name.toLowerCase().endsWith(".epub");
      let fileToUpload = item.file;
      let pageCount = 0;

      if (isEpub) {
        updateUploadState(item.id, { status: "uploading", attempts: 0, error: "Converting EPUB…" });
        try {
          const result = await convertEpubToPdf(item.file);
          fileToUpload = result.file;
          pageCount = result.pageCount;
        } catch {
          updateUploadState(item.id, { status: "failed", attempts: 0, error: "EPUB conversion failed" });
          return;
        }
      } else {
        const isPdf = item.file.name.toLowerCase().endsWith(".pdf");
        pageCount = isPdf ? await getPdfPageCount(item.file) : 0;
      }

      let attempt = 0;
      let uploaded = false;
      let lastError: unknown = null;

      while (attempt < MAX_UPLOAD_ATTEMPTS && !uploaded) {
        attempt += 1;
        updateUploadState(item.id, { status: "uploading", attempts: attempt, error: undefined });

        try {
          const newBook: BookDocument = {
            id: crypto.randomUUID(),
            title: getDisplayTitle(item.file.name),
            fileName: fileToUpload.name,
            fileData: "",
            pageCount,
            chapters: [],
            addedAt: Date.now(),
          };

          await addBook(newBook, fileToUpload);
          updateUploadState(item.id, { status: "success", attempts: attempt, error: undefined });
          uploaded = true;
        } catch (error) {
          lastError = error;
          if (attempt < MAX_UPLOAD_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
          }
        }
      }

      if (!uploaded) {
        updateUploadState(item.id, {
          status: "failed",
          attempts: attempt,
          error: getErrorMessage(lastError),
        });
      }
    };

    let nextIndex = 0;
    const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, queue.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < queue.length) {
          const item = queue[nextIndex];
          nextIndex += 1;
          await processQueueItem(item);
        }
      }),
    );

    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt.files.length > 0) {
      const input = fileInputRef.current;
      if (input) {
        const dataTransfer = new DataTransfer();
        Array.from(dt.files).forEach(f => dataTransfer.items.add(f));
        input.files = dataTransfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  };

  return (
    <div className="h-full flex flex-col animate-fade-in overflow-auto">
      <main className="max-w-7xl mx-auto px-6 py-12 flex flex-col gap-12 w-full">
        {/* Header Section */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <h1 className="font-headline text-5xl md:text-7xl font-bold tracking-tighter text-primary italic">
              My Library
            </h1>
            <p className="text-on-surface-variant font-body max-w-md">
              Your curated sanctuary of knowledge and thought.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSortBy((v) => (v === "date" ? "name" : "date"))}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
            >
              <span className="material-symbols-outlined text-xs">sort</span>
              {sortBy === "date" ? "Recently Added" : "By Name"}
              <span className="material-symbols-outlined text-xs">expand_more</span>
            </button>
            <button
              onClick={() => setShowApiKeys((v) => !v)}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
            >
              <span className="material-symbols-outlined text-xs">key</span>
              API Keys
            </button>
          </div>
        </section>

        {/* API Key Manager */}
        {showApiKeys && (
          <div className="bg-surface-container-low rounded-2xl p-6 border border-outline-variant/10">
            <ApiKeyManager />
          </div>
        )}

        {/* Upload Progress */}
        {uploadStates.length > 0 && (
          <div className="bg-surface-container-low rounded-xl p-6 flex flex-col gap-3 border border-outline-variant/5">
            {currentBatchIds.length > 0 && (
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-primary-container/20 rounded-lg flex items-center justify-center">
                  <span className="material-symbols-outlined text-primary-container">upload_file</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    {isUploading ? "Uploading..." : "Upload complete"}
                  </p>
                  <div className="w-full max-w-xs">
                    <Progress value={currentBatchProgress} className="h-2 mt-2" />
                  </div>
                </div>
                <span className="text-xs font-bold text-primary-container uppercase tracking-widest">
                  {currentBatchProgress}%
                </span>
              </div>
            )}
            <div className="max-h-28 overflow-auto space-y-1 scrollbar-thin">
              {uploadStates.slice(0, 20).map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-4 text-xs">
                  <span className="truncate text-foreground">{item.fileName}</span>
                  <span
                    className={
                      item.status === "failed"
                        ? "text-destructive"
                        : item.status === "success"
                          ? "text-primary"
                          : "text-muted-foreground"
                    }
                  >
                    {item.status === "uploading" ? `Uploading (try ${item.attempts}/${MAX_UPLOAD_ATTEMPTS})` : item.status}
                    {item.status === "failed" && item.error ? ` · ${item.error}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload Area */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="group relative bg-surface-container-low border-2 border-dashed border-outline-variant/30 rounded-2xl p-12 flex flex-col items-center justify-center text-center transition-all hover:border-primary/40 hover:bg-surface-container-high cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="mb-4 w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-primary text-3xl">cloud_upload</span>
          </div>
          <h3 className="text-xl font-headline font-bold text-primary mb-1">
            {isUploading ? "Uploading…" : "Drop PDF or EPUB"}
          </h3>
          <p className="text-on-surface-variant text-sm mb-6">Max file size 50MB. Supports PDF, EPUB, DOC, TXT.</p>
          <button
            className="px-8 py-3 bg-primary-container text-on-primary-container font-bold rounded-xl active:scale-95 transition-transform"
            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            disabled={isUploading}
          >
            Browse files
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.epub"
          multiple
          onChange={handleFileUpload}
          className="hidden"
        />

        {/* Book grid */}
        {books.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-6xl mb-4 opacity-25">library_books</span>
            <p className="text-lg font-headline">Your library is empty</p>
            <p className="text-sm mt-1">Upload documents to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sortedBooks.map((book, i) => (
              <BookCard
                key={book.id}
                book={book}
                index={i}
                onRead={() => setActiveBook(book.id)}
                onRemove={() => removeBook(book.id)}
                onRename={(newTitle) => updateBookTitle(book.id, newTitle)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

const BookCard: React.FC<{
  book: BookDocument;
  index: number;
  onRead: () => void;
  onRemove: () => void;
  onRename: (newTitle: string) => void;
}> = ({ book, index, onRead, onRemove, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(book.title);
  const isPdf = book.fileName.toLowerCase().endsWith(".pdf");
  const metadataText = isPdf ? `${book.pageCount} pages · ${book.chapters.length} chapters · PDF` : "Document file";

  // Warm gradient hues
  const hues = [35, 25, 40, 15, 45, 20];
  const hue = hues[index % hues.length];

  return (
    <div
      className="group bg-surface-container-high rounded-2xl overflow-hidden flex flex-col transition-all hover:-translate-y-1 hover:shadow-2xl hover:shadow-black/40 animate-slide-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Cover */}
      <div
        className="aspect-[3/2] relative overflow-hidden bg-surface-container-highest flex items-center justify-center"
        style={{
          background: book.coverImageUrl
            ? undefined
            : `linear-gradient(135deg, hsl(${hue}, 30%, 18%), hsl(${hue}, 25%, 12%))`,
        }}
      >
        {book.coverImageUrl ? (
          <img src={book.coverImageUrl} alt={book.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <span className="material-symbols-outlined text-5xl text-primary/30">
            {isPdf ? "auto_stories" : "description"}
          </span>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />
      </div>

      {/* Info */}
      <div className="p-6">
        {editing ? (
          <input
            className="w-full text-xl font-headline font-bold bg-transparent border border-outline-variant rounded-lg px-2 py-1 mb-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) { onRename(draft.trim()); setEditing(false); }
              if (e.key === "Escape") { setDraft(book.title); setEditing(false); }
            }}
            onBlur={() => {
              if (draft.trim() && draft.trim() !== book.title) onRename(draft.trim());
              setEditing(false);
            }}
          />
        ) : (
          <h4
            className="font-headline text-2xl font-bold text-primary mb-1 cursor-pointer hover:text-accent transition-colors line-clamp-2"
            onClick={() => { setDraft(book.title); setEditing(true); }}
          >
            {book.title}
          </h4>
        )}
        <p className="text-on-surface-variant text-xs font-medium uppercase tracking-wider mb-6">
          {metadataText}
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={onRead}
            className="flex-1 py-3 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
          >
            Open
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="p-3 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-error-container/20 hover:text-destructive transition-all"
          >
            <span className="material-symbols-outlined text-xl">delete</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default Library;
