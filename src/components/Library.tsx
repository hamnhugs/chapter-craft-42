import React, { useRef, useState, useMemo, useEffect, lazy, Suspense } from "react";
import { useApp } from "@/context/AppContext";
import ApiKeyManager from "@/components/ApiKeyManager";
import { BookDocument } from "@/types/library";
import { pdfjs } from "react-pdf";
import { Progress } from "@/components/ui/progress";
import { convertEpubToPdf } from "@/lib/epubToPdf";
import { useChatSettings } from "@/hooks/useChatSettings";
import { structureJobs, useStructureJobs, StructureJob } from "@/lib/structureJobs";
import { autoTagBooks } from "@/lib/autoTag";
import { toast } from "sonner";
import LibraryFolders from "@/components/LibraryFolders";
import LibraryList from "@/components/LibraryList";

// The 3D mind map pulls in three.js (~300KB gzip); lazy-load so that chunk is
// only fetched when the user actually toggles the graph view on.
const LibraryGraph = lazy(() => import("@/components/LibraryGraph"));

// Chunk-load failures (offline mid-session, deploy in between) and WebGL
// crashes degrade to a message instead of taking down the Library.
class GraphErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant">
          <span className="material-symbols-outlined text-5xl mb-3 opacity-30">error</span>
          <p className="font-headline text-lg">The mind map couldn't load</p>
          <p className="text-sm mt-1">Check your connection and try toggling it again.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// Search matching is case- and diacritic-insensitive; every typed token must
// appear somewhere in the book's title, category, or tags (AND semantics).
const normalizeText = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wraps the parts of `text` matching any query token in <mark>. */
const Highlight: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (tokens.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${tokens.join("|")})`, "ig"));
  return (
    <>
      {parts.map((part, i) =>
        // split with a capture group alternates non-match / match
        i % 2 === 1 ? (
          <mark key={i} className="bg-accent/30 text-inherit rounded-sm">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
};

type UploadState = {
  id: string;
  fileName: string;
  status: "queued" | "uploading" | "success" | "failed";
  attempts: number;
  error?: string;
};

const SUPPORTED_UPLOAD_EXTENSIONS = ["pdf", "doc", "docx", "txt", "rtf", "odt", "epub", "html"] as const;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_CONCURRENT_UPLOADS = 3;

type ViewMode = "grid" | "folders" | "list" | "graph";
const VIEW_KEY = "vault_view_mode";

const VIEW_OPTIONS: { id: ViewMode; icon: string; label: string }[] = [
  { id: "grid", icon: "grid_view", label: "Grid" },
  { id: "folders", icon: "folder", label: "Folders" },
  { id: "list", icon: "view_list", label: "List" },
  { id: "graph", icon: "hub", label: "Mind map" },
];

const Library: React.FC = () => {
  const { books, addBook, removeBook, setActiveBook, updateBookTitle, updateBookTags, addChapter, removeChapter, loadBookFile } = useApp();
  const { apiKey } = useChatSettings();
  const jobs = useStructureJobs();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [sortBy, setSortBy] = useState<"date" | "name">("date");
  const [uploadStates, setUploadStates] = useState<UploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [currentBatchIds, setCurrentBatchIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  // Last-used view persists across sessions (Finder/Drive convention).
  const [view, setView] = useState<ViewMode>(() => {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "folders" || v === "list" || v === "graph" ? v : "grid";
  });
  const [tagProgress, setTagProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => {
      if (sortBy === "name") return a.title.localeCompare(b.title);
      return b.addedAt - a.addedAt;
    });
  }, [books, sortBy]);

  // Instant filter-as-you-type — at library scale this is microseconds, so no
  // debounce (a delay here only adds perceived lag). Matches title, category,
  // and tags so typing "sci-fi" finds tagged books without a separate filter.
  const filteredBooks = useMemo(() => {
    const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return sortedBooks;
    return sortedBooks.filter((b) => {
      const hay = normalizeText([b.title, b.category || "", ...(b.tags || [])].join(" "));
      return tokens.every((t) => hay.includes(t));
    });
  }, [sortedBooks, query]);

  // "/" focuses search (GitHub/Gmail convention), Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-tag: categorize/tag books via the same model that chapterizes
  // uploads. Only untagged books are sent unless everything is already tagged
  // (then offer a full re-tag). Each book costs ~1k input tokens.
  const handleAutoTag = async () => {
    if (tagProgress || books.length === 0) return;
    const untagged = books.filter((b) => !b.category);
    const targets = untagged.length > 0 ? untagged : books;
    if (
      untagged.length === 0 &&
      !window.confirm("All books are already tagged. Re-tag the whole library?")
    ) {
      return;
    }
    setTagProgress({ done: 0, total: targets.length });
    try {
      const results = await autoTagBooks(targets, books, {
        apiKey: apiKey || undefined,
        onProgress: (done, total) => setTagProgress({ done, total }),
      });
      for (const r of results) {
        await updateBookTags(r.id, r.category, r.tags);
      }
      if (results.length === 0) {
        toast.error("No tags came back — try again in a moment.");
      } else {
        toast.success(`Tagged ${results.length} book${results.length === 1 ? "" : "s"}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Auto-tag failed");
    } finally {
      setTagProgress(null);
    }
  };

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

          const finalBookId = await addBook(newBook, fileToUpload);
          updateUploadState(item.id, { status: "success", attempts: attempt, error: undefined });
          uploaded = true;

          // Auto-detect the table of contents / sections as soon as the upload
          // lands (PDFs only — EPUBs were already converted to PDF above).
          // Skip re-uploads of books that already have chapters; the manual
          // Detect button on the card handles those (with replacement).
          const priorBook = books.find((b) => b.id === finalBookId);
          const isPdfUpload = fileToUpload.name.toLowerCase().endsWith(".pdf");
          if (isPdfUpload && (!priorBook || priorBook.chapters.length === 0)) {
            structureJobs.enqueue({
              bookId: finalBookId,
              load: async () => ({ file: fileToUpload }),
              apiKey: apiKey || undefined,
              deps: { addChapter, removeChapter },
            });
          }
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

  const runDetect = (book: BookDocument) => {
    if (!book.fileName.toLowerCase().endsWith(".pdf")) return;
    if (
      book.chapters.length > 0 &&
      !window.confirm(
        `Re-detect chapters for "${book.title}"? This will replace its ${book.chapters.length} existing chapter${book.chapters.length === 1 ? "" : "s"}.`,
      )
    ) {
      return;
    }
    structureJobs.enqueue({
      bookId: book.id,
      load: async () => {
        const url = await loadBookFile(book.id);
        if (!url) throw new Error("Could not load this book's file from storage.");
        return { fileUrl: url };
      },
      apiKey: apiKey || undefined,
      replaceChapters: book.chapters.length > 0 ? book.chapters : undefined,
      deps: { addChapter, removeChapter },
    });
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
      <main className="cc-container max-w-7xl mx-auto px-6 py-12 flex flex-col gap-12 w-full">
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
          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={() => setSortBy((v) => (v === "date" ? "name" : "date"))}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
            >
              <span className="material-symbols-outlined text-xs">sort</span>
              {sortBy === "date" ? "Recently Added" : "By Name"}
              <span className="material-symbols-outlined text-xs">expand_more</span>
            </button>
            <button
              onClick={handleAutoTag}
              disabled={!!tagProgress || books.length === 0}
              title={
                tagProgress
                  ? "Tagging in progress…"
                  : "Assign categories and tags to your books with AI (powers the mind map)"
              }
              className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className={`material-symbols-outlined text-xs ${tagProgress ? "animate-spin" : ""}`}>
                {tagProgress ? "progress_activity" : "sell"}
              </span>
              {tagProgress ? `Tagging ${tagProgress.done}/${tagProgress.total}…` : "Auto-tag"}
            </button>
            {/* View switcher — segmented control, icons + label on wide screens */}
            <div
              role="group"
              aria-label="Library view"
              className="flex items-center rounded-xl border border-outline-variant/10 bg-surface-container-high p-1"
            >
              {VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setView(opt.id)}
                  onMouseEnter={
                    opt.id === "graph"
                      ? () => {
                          // Warm the three.js chunk on hover so the switch feels instant.
                          void import("@/components/LibraryGraph");
                        }
                      : undefined
                  }
                  title={opt.label}
                  aria-pressed={view === opt.id}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all ${
                    view === opt.id
                      ? "bg-primary/15 text-primary font-semibold"
                      : "text-on-surface-variant hover:text-primary"
                  }`}
                >
                  <span
                    className="material-symbols-outlined text-base"
                    style={view === opt.id ? { fontVariationSettings: "'FILL' 1" } : undefined}
                    aria-hidden
                  >
                    {opt.icon}
                  </span>
                  <span className="hidden xl:inline">{opt.label}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowApiKeys((v) => !v)}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
            >
              <span className="material-symbols-outlined text-xs">key</span>
              API Keys
            </button>
          </div>
        </section>

        {/* Search */}
        {books.length > 0 && (
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant text-xl pointer-events-none">
              search
            </span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Search your library…  ( / )"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search your library by title, category, or tag"
              className="w-full pl-12 pr-12 py-3.5 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-on-surface-variant/60 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest transition-colors"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            )}
            {query && (
              <p className="mt-2 text-xs text-on-surface-variant" role="status">
                {filteredBooks.length} of {books.length} book{books.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
        )}

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

        {/* Upload Area (hidden in mind-map view to give the graph room) */}
        {view !== "graph" && (
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
          <p className="text-on-surface-variant text-sm mb-6">Max file size 50MB. Supports PDF, EPUB, HTML, DOC, TXT.</p>
          <button
            className="px-8 py-3 bg-primary-container text-on-primary-container font-bold rounded-xl active:scale-95 transition-transform"
            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            disabled={isUploading}
          >
            Browse files
          </button>
        </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.epub,.html"
          multiple
          onChange={handleFileUpload}
          className="hidden"
        />

        {/* Book grid / 3D mind map (search filters both the same way) */}
        {books.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-6xl mb-4 opacity-25">library_books</span>
            <p className="text-lg font-headline">Your library is empty</p>
            <p className="text-sm mt-1">Upload documents to get started</p>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-6xl mb-4 opacity-25">search_off</span>
            <p className="text-lg font-headline">No books match “{query}”</p>
            <p className="text-sm mt-1">Check the spelling or try fewer words</p>
            <button
              onClick={() => setQuery("")}
              className="mt-4 px-5 py-2 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
            >
              Clear search
            </button>
          </div>
        ) : view === "graph" ? (
          <GraphErrorBoundary>
            <Suspense
              fallback={
                <div className="flex flex-col items-center justify-center h-[60vh] min-h-[420px] rounded-2xl bg-surface-container-low border border-outline-variant/10 text-on-surface-variant">
                  <span className="material-symbols-outlined text-4xl animate-spin mb-3">progress_activity</span>
                  <p className="text-sm">Loading mind map…</p>
                </div>
              }
            >
              <LibraryGraph books={filteredBooks} onOpenBook={(id) => setActiveBook(id)} />
            </Suspense>
          </GraphErrorBoundary>
        ) : view === "folders" ? (
          <LibraryFolders
            books={filteredBooks}
            renderBook={(book, i) => (
              <BookCard
                key={book.id}
                book={book}
                index={i}
                query={query}
                job={jobs[book.id]}
                onDetect={() => runDetect(book)}
                onRead={() => setActiveBook(book.id)}
                onRemove={() => removeBook(book.id)}
                onRename={(newTitle) => updateBookTitle(book.id, newTitle)}
              />
            )}
          />
        ) : view === "list" ? (
          <LibraryList
            books={filteredBooks}
            sortBy={sortBy}
            onSortBy={setSortBy}
            onOpenBook={(id) => setActiveBook(id)}
            onRemove={(id) => removeBook(id)}
            highlight={(text) => <Highlight text={text} query={query} />}
          />
        ) : (
          <div className="book-grid">
            {filteredBooks.map((book, i) => (
              <BookCard
                key={book.id}
                book={book}
                index={i}
                query={query}
                job={jobs[book.id]}
                onDetect={() => runDetect(book)}
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
  query?: string;
  job?: StructureJob;
  onDetect: () => void;
  onRead: () => void;
  onRemove: () => void;
  onRename: (newTitle: string) => void;
}> = ({ book, index, query = "", job, onDetect, onRead, onRemove, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(book.title);
  const isPdf = book.fileName.toLowerCase().endsWith(".pdf");
  const detecting = job?.status === "queued" || job?.status === "running";
  const isHtml = book.fileName.toLowerCase().endsWith(".html");
  const metadataText = isPdf
    ? `${book.pageCount} pages · ${book.chapters.length} chapters · PDF`
    : isHtml
    ? `${book.chapters.length > 0 ? `${book.chapters.length} sections · ` : ""}HTML`
    : "Document file";

  // Warm gradient hues
  const hues = [35, 25, 40, 15, 45, 20];
  const hue = hues[index % hues.length];

  return (
    <div
      data-book-card
      className="group bg-surface-container-high rounded-2xl overflow-hidden flex flex-col transition-all hover:-translate-y-1 hover:shadow-2xl hover:shadow-black/40 animate-slide-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Cover */}
      <div
        data-book-cover-placeholder={book.coverImageUrl ? undefined : ""}
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
            {isPdf ? "auto_stories" : isHtml ? "article" : "description"}
          </span>
        )}
        <div data-book-cover-overlay className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />
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
            <Highlight text={book.title} query={query} />
          </h4>
        )}
        <p className="text-on-surface-variant text-xs font-medium uppercase tracking-wider mb-2">
          {metadataText}
        </p>

        {/* Category + tags (set by Auto-tag; they drive the mind map) */}
        {(book.category || (book.tags?.length ?? 0) > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {book.category && (
              <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium">
                {book.category}
              </span>
            )}
            {(book.tags || []).slice(0, 3).map((t) => (
              <span
                key={t}
                className="px-2 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant text-[11px]"
              >
                #{t}
              </span>
            ))}
            {(book.tags?.length ?? 0) > 3 && (
              <span className="px-1 py-0.5 text-on-surface-variant/60 text-[11px]">
                +{book.tags!.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Auto-structure status */}
        <div className="min-h-5 mb-4">
          {detecting ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
              <span className="truncate">{job?.progress || "Detecting chapters…"}</span>
            </p>
          ) : job?.status === "done" ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <span className="material-symbols-outlined text-sm">check_circle</span>
              {job.savedCount} chapter{job.savedCount === 1 ? "" : "s"} detected
              {job.method === "outline" ? " (from PDF outline)" : ""}
            </p>
          ) : job?.status === "error" ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <span className="material-symbols-outlined text-sm">error</span>
              <span className="truncate" title={job.error}>{job.error || "Detection failed"}</span>
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onRead}
            className="flex-1 py-3 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
          >
            Open
          </button>
          {isPdf && (
            <button
              onClick={(e) => { e.stopPropagation(); onDetect(); }}
              disabled={detecting}
              title={
                detecting
                  ? "Detecting chapters…"
                  : job?.status === "error"
                    ? "Retry chapter detection"
                    : book.chapters.length > 0
                      ? "Re-detect chapters with AI"
                      : "Auto-detect chapters with AI"
              }
              className="p-3 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className={`material-symbols-outlined text-xl ${detecting ? "animate-spin" : ""}`}>
                {detecting ? "progress_activity" : "auto_awesome"}
              </span>
            </button>
          )}
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
