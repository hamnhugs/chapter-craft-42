import React, { useRef, useState, useMemo, useEffect, lazy, Suspense } from "react";
import { useApp } from "@/context/AppContext";
import { BookDocument } from "@/types/library";
import { pdfjs } from "react-pdf";
import { Progress } from "@/components/ui/progress";
import { useChatSettings } from "@/hooks/useChatSettings";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { structureJobs, useStructureJobs, StructureJob } from "@/lib/structureJobs";
import { catalogJobs, useCatalogJobs, CatalogJob } from "@/lib/catalogJobs";
import { figureJobs, useFigureJobs, FigureJob } from "@/lib/figureJobs";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { autoTagBooks } from "@/lib/autoTag";
import { isTouchPrimary } from "@/lib/focusPolicy";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import LibraryShelves from "@/components/LibraryShelves";
import { bookHaystack, chapterMatch, matchesAll, normalizeText, tokenize } from "@/lib/librarySearch";
import { seekLibrary, SEEK_FETCH_CAP, type SeekOutcome } from "@/lib/librarySeek";

import LibraryList from "@/components/LibraryList";

// The 3D mind map pulls in three.js (~300KB gzip); lazy-load so that chunk is
// only fetched when the user actually toggles the graph view on.
const LibraryGraph = lazy(() => import("@/components/LibraryGraph"));

// YouTube import (the former Reel tab) — lazy so its chunk loads only when
// the dialog opens.
const VideoTranscript = lazy(() => import("@/components/VideoTranscript"));

// Chunk-load failures (offline mid-session, deploy in between) and WebGL
// crashes degrade to a message instead of taking down the Library.
class LazyErrorBoundary extends React.Component<
  { children: React.ReactNode; title?: string; hint?: string },
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
          <p className="font-headline text-lg">{this.props.title || "This view couldn't load"}</p>
          <p className="text-sm mt-1">{this.props.hint || "Check your connection and try again."}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// Matches YouTube watch/short/share links pasted or dropped onto the Vault.
const YOUTUBE_URL_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+/i;

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

/** Cards past this index all share the last delay (see BookCard). */
const STAGGER_MAX_STEPS = 12;

type ViewMode = "shelves" | "list" | "graph";
const VIEW_KEY = "vault_view_mode";
/** Dismissal for the resurfaced line, stamped with the day it was dismissed. */
const RESURFACE_DISMISS_KEY = "vault_resurface_dismissed_day";
/** Below this, a "from your library" line is just showing you what you can
 *  already see — resurfacing needs a library big enough to forget things in. */
const RESURFACE_MIN_BOOKS = 6;

const VIEW_OPTIONS: { id: ViewMode; icon: string; label: string }[] = [
  { id: "shelves", icon: "shelves", label: "Shelves" },
  { id: "list", icon: "view_list", label: "List" },
  { id: "graph", icon: "hub", label: "Mind map" },
];


const Library: React.FC = () => {
  const { books, addBook, removeBook, requestBookLoad, updateBookTitle, updateBookTags, addChapter, removeChapter, loadBookFile, applyChapterGists, applyBookSummary, loadChapterText,
    shelves, toggleBookShelf } = useApp();
  const { apiKey, imageExtractionModel, selectedModel, geminiApiKey, nvidiaKeyLast4, autoCatalogOnUpload } = useChatSettings();
  const { user } = useAuth();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { isAdmin, loaded: adminLoaded } = useIsAdmin();
  const jobs = useStructureJobs();
  const catJobs = useCatalogJobs();
  const figJobs = useFigureJobs();
  // The catalog run resolves the book at RUN time, not enqueue time —
  // chapters land in between, and a captured object would summarize an empty
  // book.
  const booksRef = useRef(books);
  useEffect(() => { booksRef.current = books; }, [books]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sortBy, setSortBy] = useState<"date" | "name">("date");
  const [uploadStates, setUploadStates] = useState<UploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [currentBatchIds, setCurrentBatchIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  // Last-used view persists across sessions (Finder/Drive convention).
  // Values from retired views (grid/folders/collections) fall back to
  // Shelves, which absorbed all three.
  const [view, setView] = useState<ViewMode>(() => {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "graph" ? v : "shelves";
  });
  const [tagProgress, setTagProgress] = useState<{ done: number; total: number } | null>(null);
  // "Where did I read that?" — the exact-text seek across every book.
  const [seek, setSeek] = useState<SeekOutcome | null>(null);
  const [seeking, setSeeking] = useState(false);
  // Books from the last completed upload batch, offered a shelf while the
  // user is still thinking about them.
  const [justAdded, setJustAdded] = useState<string[]>([]);
  const [filing, setFiling] = useState(false);
  const [resurfaceDismissedDay, setResurfaceDismissedDay] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(RESURFACE_DISMISS_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  });

  // "From YouTube" import dialog (the former Reel tab). The dialog remounts
  // VideoTranscript each open, so initialUrl is re-read every time.
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const [youtubeInitialUrl, setYoutubeInitialUrl] = useState("");
  const [activeVideoJobs, setActiveVideoJobs] = useState(0);
  const openYoutube = (initialUrl = "") => {
    setYoutubeInitialUrl(initialUrl);
    setYoutubeOpen(true);
  };

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // Transcript extractions run 1–3 minutes and finish server-side — the book
  // then pops into the grid via the realtime INSERT subscription. While any
  // job is in flight, show a status row here (status belongs where the result
  // will appear). Poll only while something is active; re-check when the
  // dialog closes since that's when new jobs get submitted.
  useEffect(() => {
    if (!user || youtubeOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      const { data, error } = await supabase
        .from("video_jobs")
        .select("id")
        .eq("user_id", user.id)
        .in("status", ["pending", "processing"]);
      if (cancelled) return;
      if (error) {
        // Transient failure ≠ zero jobs — keep the row and retry.
        timer = setTimeout(check, 8000);
        return;
      }
      const n = data?.length ?? 0;
      setActiveVideoJobs(n);
      if (n > 0) timer = setTimeout(check, 8000);
    };
    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user, youtubeOpen]);

  // One-time signpost, shown only to users who actually used the Reel tab —
  // having any video_jobs row is the precise signal for that. Brand-new
  // accounts never see this.
  useEffect(() => {
    if (!user || localStorage.getItem("reel_moved_notice")) return;
    supabase
      .from("video_jobs")
      .select("id")
      .eq("user_id", user.id)
      .limit(1)
      .then(({ data }) => {
        if (!data || data.length === 0) return;
        if (localStorage.getItem("reel_moved_notice")) return;
        localStorage.setItem("reel_moved_notice", "1");
        toast("Reel has moved — grab YouTube transcripts with the “From YouTube” button in your Vault.");
      });
  }, [user]);

  // Pasting a YouTube link anywhere in the Vault (outside a text field) jumps
  // straight into the import flow with the URL pre-filled.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Don't hijack paste while any modal layer is open (pricing, onboarding,
      // quick switcher, ads, or this dialog itself) — the import dialog would
      // stack on top of it. Dialog content only exists in the DOM while open.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const text = e.clipboardData?.getData("text") || "";
      const match = text.match(YOUTUBE_URL_RE);
      if (match) openYoutube(match[0]);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  /**
   * Queue chapter gists + a book summary for a freshly chapterized book.
   *
   * Opt-in (Settings → auto-catalog): the run spends the user's own model
   * key, so nothing starts it unasked. This is the fix for catalog generation
   * being manual and buried in the chat picker, which is why most books carry
   * no catalog at all.
   */
  const enqueueCatalog = (bookId: string) => {
    if (!autoCatalogOnUpload) return;
    catalogJobs.enqueue({
      bookId,
      getBook: () => booksRef.current.find((b) => b.id === bookId),
      settings: {
        model: selectedModel,
        keys: { apiKey: apiKey || undefined, geminiApiKey: geminiApiKey || undefined, nvidiaKeyLast4: nvidiaKeyLast4 || undefined },
      },
      onGists: applyChapterGists,
      onSummary: applyBookSummary,
    });
  };

  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => {
      if (sortBy === "name") return a.title.localeCompare(b.title);
      return b.addedAt - a.addedAt;
    });
  }, [books, sortBy]);

  // Search reaches the CATALOG, not just the spine label. It used to match
  // title/category/tags only, so the chapter names and the summaries the app
  // spends the user's key generating were invisible to it — leaving exactly
  // two ways to find anything: recall the title, or ask the assistant. Teevan
  // et al. (CHI 2004) measured 61% of real re-finding as orienteering, the
  // stepwise middle this had none of.
  //
  // Haystacks are memoized per book rather than rebuilt per keystroke: with
  // chapter names and gists folded in, the naive version rebuilds thousands
  // of strings on every character.
  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of books) map.set(b.id, bookHaystack(b));
    return map;
  }, [books]);

  // Instant filter-as-you-type — no debounce; a delay here only adds
  // perceived lag now that the matching itself is a map lookup.
  const filteredBooks = useMemo(() => {
    const tokens = tokenize(query);
    if (tokens.length === 0) return sortedBooks;
    return sortedBooks.filter((b) => matchesAll(haystacks.get(b.id) || "", tokens));
  }, [sortedBooks, query, haystacks]);

  const queryTokens = useMemo(() => tokenize(query), [query]);

  /**
   * One line from something you already own.
   *
   * A summary corpus that is only ever read when you go looking for it is
   * still keeping, not exploitation (Whittaker, ARIST 2011) — and the books
   * most worth resurfacing are precisely the ones you have stopped scrolling
   * to. Deterministic per day so it is a quiet fixture rather than a slot
   * machine that re-rolls on every render, and biased toward the OLDEST
   * books, which are the ones the date-sorted grid buries.
   */
  const resurfaced = useMemo(() => {
    if (query.trim() || books.length < RESURFACE_MIN_BOOKS) return null;
    const day = Math.floor(Date.now() / 86_400_000);
    if (resurfaceDismissedDay === day) return null;
    const candidates = books
      .filter((b) => (b.summary || "").trim() || b.chapters.some((c) => (c.gist || "").trim()))
      .sort((a, b) => a.addedAt - b.addedAt)
      .slice(0, Math.max(3, Math.ceil(books.length / 2)));
    if (candidates.length === 0) return null;
    const pick = candidates[day % candidates.length];
    const line =
      (pick.summary || "").trim() ||
      (pick.chapters.find((c) => (c.gist || "").trim())?.gist || "").trim();
    return line ? { book: pick, line } : null;
  }, [books, query, resurfaceDismissedDay]);

  const dismissResurfaced = () => {
    const day = Math.floor(Date.now() / 86_400_000);
    setResurfaceDismissedDay(day);
    try {
      localStorage.setItem(RESURFACE_DISMISS_KEY, String(day));
    } catch {
      // Private mode / blocked storage: the line simply returns tomorrow.
    }
  };

  // A seek is about the query that produced it; editing the box invalidates
  // it rather than leaving stale passages under a new search.
  useEffect(() => { setSeek(null); }, [query]);

  /**
   * Search INSIDE the books, not just their metadata.
   *
   * bookSearch.ts has carried a reviewed, property-tested exact-text seek for
   * a while — reachable only as a chat tool, so finding a half-remembered
   * passage required a conversation. This is the same predicate, run from the
   * Vault. It is a deliberate second action rather than part of the
   * filter-as-you-type: it costs round trips and reads chapter text, which
   * the instant filter never does.
   */
  const runSeek = async () => {
    if (!user || seeking) return;
    setSeeking(true);
    try {
      const outcome = await seekLibrary(books, user.id, query, { loadChapterText });
      setSeek(outcome);
      if (!outcome.normalizedQuery) {
        toast("Type at least 3 characters to search inside your books.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't search inside your books");
    } finally {
      setSeeking(false);
    }
  };

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
          // Loaded on demand: the converter drags in JSZip + jsPDF, which only EPUB uploads need
          const { convertEpubToPdf } = await import("@/lib/epubToPdf");
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
            folderIds: [],
          };

          const finalBookId = await addBook(newBook, fileToUpload);
          updateUploadState(item.id, { status: "success", attempts: attempt, error: undefined });
          addedIds.push(finalBookId);
          uploaded = true;

          // Auto-detect the table of contents / sections as soon as the upload
          // lands (PDFs only — EPUBs were already converted to PDF above).
          // Skip re-uploads of books that already have chapters; the manual
          // Detect button on the card handles those (with replacement).
          const priorBook = books.find((b) => b.id === finalBookId);
          const isPdfUpload = fileToUpload.name.toLowerCase().endsWith(".pdf");
          // Auto-chapterize is a Pro feature (also enforced in the edge function).
          if (planLoaded && !isPaid) {
            if (isPdfUpload) {
              toast("Auto-chapterize is a Pro feature — upgrade to detect chapters automatically.", { id: "auto-structure-pro" });
            }
          } else if (isPdfUpload && (!priorBook || priorBook.chapters.length === 0)) {
            structureJobs.enqueue({
              bookId: finalBookId,
              load: async () => ({ file: fileToUpload }),
              apiKey: apiKey || undefined,
              deps: { addChapter, removeChapter },
              onComplete: () => enqueueCatalog(finalBookId),
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

    // Collected across workers; surfaced once the whole batch settles.
    const addedIds: string[] = [];
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
    setJustAdded(addedIds);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  /**
   * File the batch that just landed.
   *
   * Malone (TOIS 1983) and Mander et al. (CHI 1992): people under-file, and
   * forcing classification at capture is where these systems get abandoned.
   * So this is an OFFER at the one moment the books are still in mind, not a
   * gate — dismissing it costs nothing and they stay in the Unshelved pile,
   * which is now a real place rather than silent absorption into All-books.
   */
  const fileJustAdded = async (shelfId: string) => {
    if (filing) return;
    setFiling(true);
    const ids = justAdded;
    try {
      // Sequential: toggleBookShelf patches optimistically and rolls back by
      // inverse delta, and one failure should not abandon the rest.
      let failed = 0;
      for (const id of ids) {
        try {
          const book = booksRef.current.find((b) => b.id === id);
          if (book && !book.folderIds.includes(shelfId)) await toggleBookShelf(id, shelfId);
        } catch {
          failed += 1;
        }
      }
      const shelfName = shelves.find((f) => f.id === shelfId)?.name ?? "that shelf";
      if (failed === 0) {
        toast.success(`Filed ${ids.length} book${ids.length === 1 ? "" : "s"} on “${shelfName}”`);
        setJustAdded([]);
      } else {
        toast.error(`${failed} of ${ids.length} couldn't be filed — the rest are on “${shelfName}”.`);
      }
    } finally {
      setFiling(false);
    }
  };

  const runDetect = (book: BookDocument) => {
    if (!book.fileName.toLowerCase().endsWith(".pdf")) return;
    if (planLoaded && !isPaid) {
      openPricing("auto-structure");
      return;
    }
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
      // A re-detect INSERTS new chapter ids, so whatever gists existed no
      // longer point at anything. Re-cataloging is the only way back.
      onComplete: () => enqueueCatalog(book.id),
    });
  };

  // Manual figure extraction — digestion-free: books need no neurons. When
  // the book has any (chat extraction still creates them), figures are
  // paired with them; every figure carries book/page/chapter provenance
  // either way.
  const runExtractFigures = (book: BookDocument) => {
    if (!book.fileName.toLowerCase().endsWith(".pdf")) {
      toast("Figure extraction works on PDF books (EPUBs are converted to PDF at upload).");
      return;
    }
    // Without an OpenRouter key, describe-figures takes the gateway path,
    // which requires a subscription open-access mode never grants (admins
    // exempt) — the run could only end in a 402 AFTER the minutes-long PDF
    // scan. Say what actually unblocks it, before any scanning; the retired
    // paywall (openPricing no-ops under OPEN_ACCESS) is not the answer.
    if (!apiKey && adminLoaded && !isAdmin) {
      toast("Figure extraction needs your OpenRouter API key — add one in Settings → AI Models & Keys.");
      return;
    }
    figureJobs.enqueue({
      bookId: book.id,
      bookTitle: book.title,
      model: imageExtractionModel || undefined,
      chapters: book.chapters.map((c) => ({ name: c.name, startPage: c.startPage, endPage: c.endPage })),
      load: async () => {
        const url = await loadBookFile(book.id);
        if (!url) throw new Error("Could not load this book's file from storage.");
        return { fileUrl: url };
      },
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
      return;
    }
    // No files: a link dragged from another tab arrives as text — YouTube
    // links open the import dialog pre-filled.
    const text = dt.getData("text/uri-list") || dt.getData("text/plain");
    const match = text.match(YOUTUBE_URL_RE);
    if (match) openYoutube(match[0]);
  };

  return (
    <div className="h-full flex flex-col animate-fade-in overflow-auto">
      <main className="cc-vault-main max-w-7xl mx-auto px-6 py-12 flex flex-col gap-12 w-full">
        {/* Header Section */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <h1 className="cc-vault-title font-headline text-5xl md:text-7xl font-bold tracking-tighter text-primary italic">
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
                  aria-label={opt.label}
                  aria-pressed={view === opt.id}
                  className={`cc-tap-44 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all ${
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
              placeholder="Search titles, chapters, summaries…  ( / )"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search your library by title, category, tag, chapter name, or summary"
              className="w-full pl-12 pr-12 py-3.5 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-on-surface-variant/60 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="cc-tap-44 absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest transition-colors"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            )}
            {query && (
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                <p className="text-xs text-on-surface-variant" role="status">
                  {filteredBooks.length} of {books.length} book{books.length === 1 ? "" : "s"}
                </p>
                <button
                  onClick={runSeek}
                  disabled={seeking}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline underline-offset-2 disabled:opacity-50"
                  title="Search the full text of every book for this exact wording"
                >
                  <span className={`material-symbols-outlined text-sm ${seeking ? "animate-spin" : ""}`} aria-hidden>
                    {seeking ? "progress_activity" : "manage_search"}
                  </span>
                  {seeking ? "Reading your books…" : "Search inside books"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* A line from something already on the shelves. */}
        {resurfaced && view !== "graph" && (
          <div className="flex items-start gap-3 rounded-xl px-5 py-3 bg-surface-container-low/60 border border-outline-variant/10">
            <span className="material-symbols-outlined text-on-surface-variant/70 text-lg mt-0.5" aria-hidden>
              auto_stories
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] uppercase tracking-widest text-on-surface-variant/70">
                From your library
              </p>
              <button
                onClick={() => requestBookLoad(resurfaced.book.id)}
                className="text-left mt-0.5 group/res"
              >
                <span className="text-sm font-headline font-bold text-primary group-hover/res:underline underline-offset-2">
                  {resurfaced.book.title}
                </span>
                <span className="text-sm text-on-surface-variant"> — {resurfaced.line}</span>
              </button>
            </div>
            <button
              onClick={dismissResurfaced}
              aria-label="Hide this for today"
              title="Hide this for today"
              className="cc-tap-44 shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>close</span>
            </button>
          </div>
        )}

        {/* File-on-arrival. An offer, never a gate — see fileJustAdded. */}
        {justAdded.length > 0 && !isUploading && (
          <div className="flex items-center gap-3 flex-wrap bg-surface-container-low rounded-xl px-5 py-4 border border-outline-variant/10">
            <span className="material-symbols-outlined text-primary" aria-hidden>inbox</span>
            <p className="flex-1 min-w-[12rem] text-sm text-foreground">
              {justAdded.length} book{justAdded.length === 1 ? "" : "s"} added.
              {shelves.length > 0
                ? " Put them on a shelf while they're fresh?"
                : " Create a shelf in Shelves view to file them."}
            </p>
            {shelves.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    disabled={filing}
                    className="px-4 py-2 rounded-lg bg-primary/10 text-primary text-sm font-bold hover:bg-primary hover:text-on-primary-container transition-all disabled:opacity-50"
                  >
                    {filing ? "Filing…" : "Choose a shelf"}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44 max-h-72 overflow-y-auto">
                  {shelves.map((f) => (
                    <DropdownMenuItem key={f.id} onSelect={() => fileJustAdded(f.id)}>
                      <span className="material-symbols-outlined text-base mr-2 shrink-0" aria-hidden>shelves</span>
                      <span className="truncate">{f.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              onClick={() => setJustAdded([])}
              className="text-sm text-on-surface-variant hover:text-primary px-2"
            >
              Not now
            </button>
          </div>
        )}

        {/* Passages found inside the books — the orienteering result: not
            "this book matched" but "this sentence, on this page". */}
        {seek && seek.normalizedQuery && (
          <section className="bg-surface-container-low rounded-xl border border-outline-variant/10 p-5 flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs uppercase tracking-widest text-on-surface-variant">
                {seek.hits.length === 0
                  ? "No passages found"
                  : `${seek.hits.length} passage${seek.hits.length === 1 ? "" : "s"} inside your books`}
              </p>
              <button
                onClick={() => setSeek(null)}
                className="text-xs text-on-surface-variant hover:text-primary"
              >
                Dismiss
              </button>
            </div>

            {/* Coverage honesty: a capped or un-narrowed search must never let
                an empty result read as "it isn't in your library". */}
            {(seek.degraded || seek.notSearched > 0) && (
              <p className="text-[11px] text-on-surface-variant/80">
                {seek.note || `${seek.notSearched} more chapter${seek.notSearched === 1 ? "" : "s"} matched but weren't read — only ${SEEK_FETCH_CAP} are fetched per search.`}
                {" "}Narrow the wording to see the rest.
              </p>
            )}

            {seek.hits.length === 0 ? (
              <p className="text-sm text-on-surface-variant">
                Nothing matched that exact wording. The search is literal — it won't
                correct spelling or cross a hyphenated line break.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {seek.hits.map((h, i) => (
                  <li key={`${h.chapterId}-${h.charStart}-${i}`}>
                    <button
                      onClick={() => requestBookLoad(h.bookId)}
                      className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface-container-high transition-colors"
                    >
                      <p className="text-[11px] text-primary font-semibold truncate">
                        {h.bookTitle} · {h.chapterName} · p.{h.page}
                      </p>
                      <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-2">
                        …<Highlight text={h.excerpt} query={query} />…
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* In-flight YouTube transcript extractions — the finished book pops
            into the grid below via the realtime subscription */}
        {activeVideoJobs > 0 && (
          <button
            onClick={() => openYoutube()}
            className="flex items-center gap-3 bg-surface-container-low rounded-xl px-6 py-4 border border-outline-variant/5 text-left hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
            <span className="flex-1 text-sm text-foreground">
              Extracting {activeVideoJobs} YouTube transcript{activeVideoJobs === 1 ? "" : "s"}… the book lands in your Vault when done.
            </span>
            <span className="text-sm font-bold text-primary">View</span>
          </button>
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
          className="cc-vault-dropzone group relative bg-surface-container-low border-2 border-dashed border-outline-variant/30 rounded-2xl p-12 flex flex-col items-center justify-center text-center transition-all hover:border-primary/40 hover:bg-surface-container-high cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="cc-dropzone-icon mb-4 w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-primary text-3xl">cloud_upload</span>
          </div>
          <h3 className="cc-dropzone-title text-xl font-headline font-bold text-primary mb-1">
            {isUploading ? "Uploading…" : "Drop PDF or EPUB"}
          </h3>
          <p className="cc-dropzone-hint text-on-surface-variant text-sm mb-6">Max file size 50MB. Supports PDF, EPUB, HTML, DOC, TXT.</p>
          <div className="cc-dropzone-actions flex items-center gap-3 flex-wrap justify-center">
            <button
              className="px-8 py-3 bg-primary-container text-on-primary-container font-bold rounded-xl active:scale-95 transition-transform"
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              disabled={isUploading}
            >
              Browse files
            </button>
            <button
              className="flex items-center gap-2 px-8 py-3 bg-surface-container-high text-foreground font-bold rounded-xl border border-outline-variant/20 hover:bg-surface-container-highest active:scale-95 transition-all"
              onClick={(e) => { e.stopPropagation(); openYoutube(); }}
              onMouseEnter={() => {
                // Warm the chunk on hover so the dialog opens instantly.
                void import("@/components/VideoTranscript");
              }}
            >
              <span className="material-symbols-outlined text-xl" aria-hidden>smart_display</span>
              From YouTube
            </button>
          </div>
        </div>
        )}
        {/* The dropzone (and its From YouTube button) is hidden in mind-map
            view — keep a compact entry point so the importer stays reachable */}
        {view === "graph" && (
          <button
            onClick={() => openYoutube()}
            onMouseEnter={() => {
              void import("@/components/VideoTranscript");
            }}
            className="self-start flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>smart_display</span>
            From YouTube
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.epub,.html"
          multiple
          onChange={handleFileUpload}
          className="hidden"
        />

        {/* Shelves / list / 3D mind map (search filters all views the same way) */}
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
            <p className="text-sm mt-1">Titles, chapters and summaries were all searched — try fewer words</p>
            <button
              onClick={() => setQuery("")}
              className="mt-4 px-5 py-2 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
            >
              Clear search
            </button>
          </div>
        ) : view === "graph" ? (
          <LazyErrorBoundary title="The mind map couldn't load" hint="Check your connection and try toggling it again.">
            <Suspense
              fallback={
                <div className="flex flex-col items-center justify-center h-[60vh] min-h-[min(420px,60dvh)] rounded-2xl bg-surface-container-low border border-outline-variant/10 text-on-surface-variant">
                  <span className="material-symbols-outlined text-4xl animate-spin mb-3">progress_activity</span>
                  <p className="text-sm">Loading mind map…</p>
                </div>
              }
            >
              <LibraryGraph books={filteredBooks} onOpenBook={(id) => requestBookLoad(id)} />
            </Suspense>
          </LazyErrorBoundary>
        ) : view === "list" ? (

          <LibraryList
            books={filteredBooks}
            sortBy={sortBy}
            onSortBy={setSortBy}
            onOpenBook={(id) => requestBookLoad(id)}
            onRemove={(id) => removeBook(id)}
            highlight={(text) => <Highlight text={text} query={query} />}
          />
        ) : (
          <LibraryShelves
            books={filteredBooks}
            allBooks={sortedBooks}
            filtered={query.trim().length > 0}
            renderBook={(book, i) => (
              <BookCard
                key={book.id}
                book={book}
                index={i}
                query={query}
                job={jobs[book.id]}
                figJob={figJobs[book.id]}
                catJob={catJobs[book.id]}
                match={chapterMatch(book, queryTokens)}
                onDetect={() => runDetect(book)}
                onExtractFigures={() => runExtractFigures(book)}
                onRead={() => requestBookLoad(book.id)}
                onRemove={() => removeBook(book.id)}
                onRename={(newTitle) => updateBookTitle(book.id, newTitle)}
              />
            )}
          />
        )}

        {/* YouTube import (the former Reel tab) */}
        <Dialog open={youtubeOpen} onOpenChange={setYoutubeOpen}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="font-headline text-2xl text-primary">Import from YouTube</DialogTitle>
              <DialogDescription>
                Paste a YouTube URL to extract the full transcript as a readable book — it lands in your Vault automatically.
              </DialogDescription>
            </DialogHeader>
            <LazyErrorBoundary title="The YouTube importer couldn't load" hint="Check your connection, close this dialog, and try again.">
              <Suspense
                fallback={
                  <div className="flex items-center justify-center py-16 text-on-surface-variant">
                    <span className="material-symbols-outlined animate-spin text-3xl">progress_activity</span>
                  </div>
                }
              >
                <VideoTranscript initialUrl={youtubeInitialUrl} />
              </Suspense>
            </LazyErrorBoundary>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
};

const BookCard: React.FC<{
  book: BookDocument;
  index: number;
  query?: string;
  job?: StructureJob;
  figJob?: FigureJob;
  catJob?: CatalogJob;
  /** The chapter that answered the search, when the title did not. */
  match?: { name: string; gist?: string | null } | null;
  onDetect: () => void;
  onExtractFigures: () => void;
  onRead: () => void;
  onRemove: () => void;
  onRename: (newTitle: string) => void;
}> = ({ book, index, query = "", job, figJob, catJob, match, onDetect, onExtractFigures, onRead, onRemove, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(book.title);
  const renameFromMenu = useRef(false);

  const startRename = () => { setDraft(book.title); setEditing(true); };
  /**
   * The title is the biggest, most obvious target on the card, and on a touch
   * screen tapping it opened an inline rename and raised the keyboard — when
   * what a tap on a book plainly means is "open this book". Pointer capability
   * decides the AFFORDANCE here, never the layout; rename stays reachable on
   * touch through the card's overflow menu.
   */
  const onTitleClick = (e: React.MouseEvent) => {
    const pointerType = (e.nativeEvent as Partial<PointerEvent>).pointerType;
    const touch = pointerType ? pointerType === "touch" || pointerType === "pen" : isTouchPrimary();
    if (touch) onRead();
    else startRename();
  };
  const isPdf = book.fileName.toLowerCase().endsWith(".pdf");
  const detecting = job?.status === "queued" || job?.status === "running";
  const extracting = figJob?.status === "queued" || figJob?.status === "running";
  const isHtml = book.fileName.toLowerCase().endsWith(".html");
  const metadataText = isPdf
    ? `${book.pageCount} pages · ${book.chapters.length} chapters · PDF`
    : isHtml
    ? `${book.chapters.length > 0 ? `${book.chapters.length} sections · ` : ""}HTML`
    : "Document file";

  // One label per action, shared by the wide icon button's tooltip, its
  // aria-label, and the narrow card's menu item — so the only description of
  // what a control does cannot be a `title` a touch screen never shows.
  // Every branch CONTAINS the visible menu-item text ("Detect chapters" /
  // "Extract figures") — WCAG 2.5.3 label-in-name: a speech-input user invokes
  // a control by the label they can SEE, and an aria-label that drops it makes
  // the command silently match nothing. The error branches are the ones casual
  // testing never renders.
  const detectLabel = detecting
    ? "Detecting chapters…"
    : job?.status === "error"
      ? "Detect chapters (retry)"
      : book.chapters.length > 0
        ? "Re-detect chapters with AI"
        : "Auto-detect chapters with AI";
  const extractLabel = extracting
    ? "Extracting figures…"
    : figJob?.status === "error"
      ? "Extract figures (retry)"
      : "Extract figures (signs, diagrams, charts) into your Images, tagged with their chapter — and paired with this book's neurons where they exist";
  const removeLabel = `Delete “${book.title}”`;

  // Warm gradient hues
  const hues = [35, 25, 40, 15, 45, 20];
  const hue = hues[index % hues.length];

  return (
    <div
      data-book-card
      className="group bg-surface-container-high rounded-2xl overflow-hidden flex flex-col transition-all hover:-translate-y-1 hover:shadow-2xl hover:shadow-black/40 animate-slide-up"
      /* The stagger is a flourish for the first screenful, not a schedule for
         the whole library: `index * 60` meant the 100th card appeared six
         seconds after the first, and the 300th eighteen. Clamp it so the
         effect survives and the wait does not. */
      style={{ animationDelay: `${Math.min(index, STAGGER_MAX_STEPS) * 60}ms` }}
    >
      {/* Cover */}
      <div
        data-book-cover-placeholder={book.coverImageUrl ? undefined : ""}
        className="cc-book-cover aspect-[3/2] relative overflow-hidden bg-surface-container-highest flex items-center justify-center"
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
      <div className="cc-book-info p-6">
        {editing ? (
          <input
            className="cc-book-title w-full text-xl font-headline font-bold bg-transparent border border-outline-variant rounded-lg px-2 py-1 mb-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
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
            className="cc-book-title font-headline text-2xl font-bold text-primary mb-1 cursor-pointer hover:text-accent transition-colors line-clamp-2"
            onClick={onTitleClick}
          >
            <Highlight text={book.title} query={query} />
          </h4>
        )}
        <p className="cc-book-meta text-on-surface-variant text-xs font-medium uppercase tracking-wider mb-2">
          {metadataText}
        </p>

        {/* The book summary. Generated with the user's own key and, until
            now, displayed nowhere — the only way to read one was to send a
            chat message. Attributed rather than presented as book metadata:
            readers can't reliably tell model-written summaries apart, but
            their beliefs about authorship move their judgement of it
            (CHI 2026), so the label is not optional. */}
        {book.summary && (
          <div className="cc-book-summary mb-2">
            <p className="text-xs leading-relaxed text-on-surface-variant line-clamp-3" title={book.summary}>
              <Highlight text={book.summary} query={query} />
            </p>
            <p className="text-[10px] text-on-surface-variant/60 mt-1">
              AI summary{book.summaryModel ? ` · ${book.summaryModel}` : ""}
            </p>
          </div>
        )}

        {/* Why this book matched, when the title didn't say. */}
        {match && (
          <p className="cc-book-match text-[11px] text-primary/90 mb-2 line-clamp-2">
            <span className="material-symbols-outlined text-[13px] align-[-2px] mr-1" aria-hidden>subdirectory_arrow_right</span>
            <Highlight text={match.gist ? `${match.name} — ${match.gist}` : match.name} query={query} />
          </p>
        )}

        {/* Category + tags (set by Auto-tag; they drive the mind map) */}
        {(book.category || (book.tags?.length ?? 0) > 0) && (
          <div className="cc-book-tags flex flex-wrap gap-1.5 mb-2">
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

        {/* Auto-structure + figure-extraction status */}
        <div className="cc-book-status min-h-5 mb-4 space-y-1">
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
          {/* Catalog run (chapter gists + book summary). Shown here because
              this is where its result appears — the summary lands on this
              card. A missing migration reads as a note, not an error: the
              gists did land and are useful without it. */}
          {catJob?.status === "queued" || catJob?.status === "running" ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
              <span className="truncate">{catJob.progress || "Building catalog…"}</span>
            </p>
          ) : catJob?.status === "done" ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <span className="material-symbols-outlined text-sm">menu_book</span>
              <span className="truncate" title={catJob.note}>
                {catJob.note
                  ? catJob.note
                  : `Catalog ready${catJob.gistsWritten ? ` · ${catJob.gistsWritten} chapter${catJob.gistsWritten === 1 ? "" : "s"}` : ""}` +
                    (catJob.gistsRejected ? ` · ${catJob.gistsRejected} summary check${catJob.gistsRejected === 1 ? "" : "s"} failed` : "")}
              </span>
            </p>
          ) : catJob?.status === "error" ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <span className="material-symbols-outlined text-sm">error</span>
              <span className="truncate" title={catJob.error}>{catJob.error || "Catalog failed"}</span>
            </p>
          ) : null}
          {extracting ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
              <span className="truncate">{figJob?.progress || "Extracting figures…"}</span>
            </p>
          ) : figJob?.status === "done" ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <span className="material-symbols-outlined text-sm">imagesmode</span>
              {figJob.kept === 0
                ? "No usable figures found"
                : `${figJob.kept} figure${figJob.kept === 1 ? "" : "s"} saved to Images${(figJob.skipped ?? 0) > 0 ? ` (${figJob.skipped} skipped)` : ""}`}
            </p>
          ) : figJob?.status === "error" ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <span className="material-symbols-outlined text-sm">error</span>
              <span className="truncate" title={figJob.error}>{figJob.error || "Figure extraction failed"}</span>
            </p>
          ) : null}
        </div>

        {/* Actions. Both the wide row and the narrow overflow menu are always
            in the DOM; `[data-cc-wide]` / `[data-cc-narrow]` in index.css pick
            one from the CARD's own width. Rendering them as two JSX branches
            instead would remount the subtree on every column-count change and
            drop the dropdown's open state mid-interaction. */}
        <div className="cc-book-actions flex items-center gap-3">
          <button
            onClick={onRead}
            className="cc-book-open flex-1 min-w-0 py-3 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
          >
            Open
          </button>
          {isPdf && (
            <button
              data-cc-wide
              onClick={(e) => { e.stopPropagation(); onDetect(); }}
              disabled={detecting}
              title={detectLabel}
              aria-label={detectLabel}
              className="p-3 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className={`material-symbols-outlined text-xl ${detecting ? "animate-spin" : ""}`}>
                {detecting ? "progress_activity" : "auto_awesome"}
              </span>
            </button>
          )}
          {isPdf && (
            <button
              data-cc-wide
              onClick={(e) => { e.stopPropagation(); onExtractFigures(); }}
              disabled={extracting}
              title={extractLabel}
              aria-label={extractLabel}
              className="p-3 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className={`material-symbols-outlined text-xl ${extracting ? "animate-spin" : ""}`}>
                {extracting ? "progress_activity" : "image_search"}
              </span>
            </button>
          )}
          <button
            data-cc-wide
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title={removeLabel}
            aria-label={removeLabel}
            className="p-3 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-error-container/20 hover:text-destructive transition-all"
          >
            <span className="material-symbols-outlined text-xl">delete</span>
          </button>

          {/* Narrow cards: the same three actions behind one 44px target. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                data-cc-narrow
                onClick={(e) => e.stopPropagation()}
                aria-label={`More actions for “${book.title}”`}
                className="shrink-0 w-11 h-11 items-center justify-center bg-surface-container-highest text-on-surface-variant rounded-lg transition-all"
              >
                <span className={`material-symbols-outlined text-xl ${detecting || extracting ? "animate-spin" : ""}`}>
                  {detecting || extracting ? "progress_activity" : "more_vert"}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              /* Items are one flex row of nowrap text, so a long label makes
                 the MENU that wide — `removeLabel` embeds the book title and
                 rendered a 600px menu in a 375px viewport. Bound it to the
                 screen and let long text truncate. */
              className="min-w-52 max-w-[min(18rem,calc(100vw-2rem))]"
              onCloseAutoFocus={(e) => {
                // Radix restores focus to the trigger on close, which would
                // pull it straight back out of the rename input.
                if (renameFromMenu.current) { renameFromMenu.current = false; e.preventDefault(); }
              }}
            >
              <DropdownMenuItem
                aria-label={`Rename “${book.title}”`}
                onSelect={() => { renameFromMenu.current = true; startRename(); }}
              >
                <span className="material-symbols-outlined text-base mr-2 shrink-0" aria-hidden>edit</span>
                <span className="truncate">Rename</span>
              </DropdownMenuItem>
              {isPdf && (
                <DropdownMenuItem disabled={detecting} aria-label={detectLabel} onSelect={() => onDetect()}>
                  <span className={`material-symbols-outlined text-base mr-2 shrink-0 ${detecting ? "animate-spin" : ""}`} aria-hidden>
                    {detecting ? "progress_activity" : "auto_awesome"}
                  </span>
                  <span className="truncate">{detecting ? "Detecting chapters…" : "Detect chapters"}</span>
                </DropdownMenuItem>
              )}
              {isPdf && (
                <DropdownMenuItem disabled={extracting} aria-label={extractLabel} onSelect={() => onExtractFigures()}>
                  <span className={`material-symbols-outlined text-base mr-2 shrink-0 ${extracting ? "animate-spin" : ""}`} aria-hidden>
                    {extracting ? "progress_activity" : "image_search"}
                  </span>
                  <span className="truncate">{extracting ? "Extracting figures…" : "Extract figures"}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                aria-label={removeLabel}
                onSelect={() => onRemove()}
              >
                <span className="material-symbols-outlined text-base mr-2 shrink-0" aria-hidden>delete</span>
                <span className="truncate">Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
};

export default Library;
