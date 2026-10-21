import { SegmentedControl } from "@/components/ui/segmented-control";
import VaultDropzone, { VaultDropOverlay, dragCarriesBooks } from "@/components/VaultDropzone";
import React, { useRef, useState, useMemo, useEffect, useCallback, lazy, Suspense } from "react";
import { useApp, TRASH_RETENTION_DAYS } from "@/context/AppContext";
import { BookDocument } from "@/types/library";
import { pdfjs } from "react-pdf";
import { isAssistantBook, isYoutubeTranscript, topicTags } from "@/lib/bookProvenance";
import YoutubeTranscriptBadge from "@/components/YoutubeTranscriptBadge";
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
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import LibraryShelves from "@/components/LibraryShelves";
import { bookHaystack, chapterMatch, matchesAll, normalizeText, tokenize } from "@/lib/librarySearch";
import { seekLibrary, SEEK_FETCH_CAP, type SeekOutcome } from "@/lib/librarySeek";

import LibraryList from "@/components/LibraryList";
import LibraryShowcase from "@/components/LibraryShowcase";
import { seedOf } from "@/lib/bookProfile";
import { jacketLayout, titleDate } from "@/lib/bookJacket";
import { marksForBook, markStripes, useShelfMarks, type ShelfMark } from "@/lib/shelfMarks";
import type { BookFolder } from "@/lib/bookFolders";

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


type ViewMode = "shelves" | "list" | "showcase" | "graph";
const VIEW_KEY = "vault_view_mode";
/**
 * Everything below is state the Vault used to throw away.
 *
 * `Index.tsx` unmounts `Library` on every tab switch, and opening a book is a
 * tab switch — so searching, finding a book, reading it and coming back meant
 * retyping the query, re-picking the sort, re-opening the shelf and scrolling
 * four hundred books again. View mode was already persisted; the controls
 * sitting next to it were not, which is the inconsistency users actually feel.
 *
 * The query goes in sessionStorage rather than localStorage: coming back to a
 * filtered library minutes later is helpful, coming back to one next week is
 * baffling.
 */
const SORT_KEY = "vault_sort_by";
const QUERY_KEY = "vault_query";
const SCROLL_KEY = "vault_scroll";
/** Dismissal for the resurfaced line, stamped with the day it was dismissed. */
const RESURFACE_DISMISS_KEY = "vault_resurface_dismissed_day";
/** Below this, a "from your library" line is just showing you what you can
 *  already see — resurfacing needs a library big enough to forget things in. */
const RESURFACE_MIN_BOOKS = 6;

const VIEW_OPTIONS: { id: ViewMode; icon: string; label: string }[] = [
  { id: "shelves", icon: "shelves", label: "Shelves" },
  { id: "list", icon: "view_list", label: "List" },
  { id: "showcase", icon: "play_circle", label: "Showcase" },
  { id: "graph", icon: "hub", label: "Mind map" },
];


const Library: React.FC = () => {
  const { books, addBook, removeBook, trashAvailable, trashedBooks, trashLoading, refreshTrash, restoreBook, purgeBook, emptyTrash, requestBookLoad, updateBookTitle, updateBookTags, addChapter, removeChapter, loadBookFile, applyChapterGists, applyBookSummary, loadChapterText,
    shelves, toggleBookShelf, booksLoading, booksError, retryLoadBooks } = useApp();
  const { apiKey, imageExtractionModel, selectedModel, geminiApiKey, nvidiaKeyLast4, autoCatalogOnUpload } = useChatSettings();
  const { user } = useAuth();
  const shelfMarks = useShelfMarks();
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
  /**
   * Scroll restoration.
   *
   * Written on scroll (throttled by rAF so it costs nothing) and replayed once
   * the first page of books is on screen. Without it, opening a book from four
   * hundred rows down and pressing back returns you to the top of the library
   * — the single most-repeated loss in the Vault, because it happens on every
   * book you read.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTickRef = useRef(0);
  const scrollRestoredRef = useRef(false);
  const rememberScroll = useCallback(() => {
    if (scrollTickRef.current) return;
    scrollTickRef.current = requestAnimationFrame(() => {
      scrollTickRef.current = 0;
      const top = scrollRef.current?.scrollTop ?? 0;
      try {
        if (top > 0) sessionStorage.setItem(SCROLL_KEY, String(top));
        else sessionStorage.removeItem(SCROLL_KEY);
      } catch { /* private mode */ }
    });
  }, []);
  useEffect(() => () => { if (scrollTickRef.current) cancelAnimationFrame(scrollTickRef.current); }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sortBy, setSortBy] = useState<"date" | "name">(() => {
    try { return localStorage.getItem(SORT_KEY) === "name" ? "name" : "date"; } catch { return "date"; }
  });
  const [uploadStates, setUploadStates] = useState<UploadState[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [currentBatchIds, setCurrentBatchIds] = useState<string[]>([]);
  const [query, setQuery] = useState(() => {
    try { return sessionStorage.getItem(QUERY_KEY) ?? ""; } catch { return ""; }
  });
  // Last-used view persists across sessions (Finder/Drive convention).
  // Values from retired views (grid/folders/collections) fall back to
  // Shelves, which absorbed all three.
  const [view, setView] = useState<ViewMode>(() => {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "graph" || v === "showcase" ? v : "shelves";
  });
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sortBy); } catch { /* private mode */ }
  }, [sortBy]);
  useEffect(() => {
    try {
      if (query) sessionStorage.setItem(QUERY_KEY, query); else sessionStorage.removeItem(QUERY_KEY);
    } catch { /* private mode */ }
  }, [query]);

  useEffect(() => {
    if (scrollRestoredRef.current || books.length === 0 || !scrollRef.current) return;
    scrollRestoredRef.current = true;
    let top = 0;
    try { top = Number(sessionStorage.getItem(SCROLL_KEY)) || 0; } catch { /* private mode */ }
    // Next frame: the grid has to have laid out before it can be scrolled.
    if (top > 0) requestAnimationFrame(() => scrollRef.current?.scrollTo({ top }));
  }, [books.length]);


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
  // Deleting a book: a MOVE to the Trash (undoable from the toast that
  // follows — the research this feature came from says a reversible action
  // beats a confirmation), or, in a library without the Trash, the old
  // permanent delete, which then earns the confirmation the list view never
  // had.
  const softDelete = trashAvailable !== false;
  const [dragOver, setDragOver] = useState(false);
  const closeDragOver = useCallback(() => setDragOver(false), []);
  /** The line under the title: what is here, at a glance. */
  const librarySummary = booksLoading && books.length === 0
    ? "Opening your library…"
    : books.length === 0
      ? "Nothing on the shelves yet"
      : [
          `${books.length} book${books.length === 1 ? "" : "s"}`,
          shelves.length > 0 ? `${shelves.length} shel${shelves.length === 1 ? "f" : "ves"}` : null,
          tagProgress ? `tagging ${tagProgress.done}/${tagProgress.total}…` : null,
        ].filter(Boolean).join(" · ");
  const [trashOpen, setTrashOpen] = useState(false);
  const [busyTrashId, setBusyTrashId] = useState<string | null>(null);

  const handleRemove = async (book: BookDocument) => {
    if (!softDelete && !window.confirm(
      `Permanently delete “${book.title}”? Its PDF and ${book.chapters.length} chapter${book.chapters.length === 1 ? "" : "s"} go with it. This library has no Trash, so this cannot be undone.`,
    )) return;
    const out = await removeBook(book.id);
    if (!out.ok) return; // removeBook already surfaced the failure
    if (out.trashed) {
      toast(`“${book.title}” moved to the Trash`, {
        action: {
          label: "Undo",
          onClick: () => {
            void restoreBook(book.id).then((r) => {
              if (r.ok) toast.success(`“${r.title}” is back in your library`);
              else toast.error((r as { ok: false; error: string }).error);
            });
          },
        },
      });
    } else {
      toast.success(`“${book.title}” deleted`);
    }
  };

  const openTrash = () => {
    setTrashOpen(true);
    void refreshTrash();
  };

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
   * Why a book matched, precomputed for the filtered set.
   *
   * This used to be called inline in the render prop — `chapterMatch(book,
   * queryTokens)` once per card, on every render. `chapterMatch` normalizes
   * (lowercase + NFD + a diacritic regex) every chapter of every book that did
   * not match on its spine, so sixty cards of a thirty-chapter book was
   * roughly eighteen hundred Unicode normalizations per keystroke, thrown away
   * and redone on the next one. The haystack map above was memoized for
   * exactly this reason; this was simply left out of it.
   */
  const matchByBook = useMemo(() => {
    const map = new Map<string, { name: string; gist?: string | null } | null>();
    if (queryTokens.length === 0) return map;
    for (const b of filteredBooks) map.set(b.id, chapterMatch(b, queryTokens));
    return map;
  }, [filteredBooks, queryTokens]);

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
    // Assistant-written books are never auto-tagged: their provenance rides
    // on a reserved tag until the source column lands, and a re-tag would
    // otherwise replace it (bookProvenance.ts).
    const taggable = books.filter((b) => !isAssistantBook(b));
    const untagged = taggable.filter((b) => !b.category);
    const targets = untagged.length > 0 ? untagged : taggable;
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

  /**
   * One set of card handlers, stable for the lifetime of the Vault.
   *
   * The card is memoized, and a memo is only worth anything if its props hold
   * still. Passing `onDetect={() => runDetect(book)}` and four more like it
   * built five new function identities per card per render, so every card
   * re-rendered on every parent render regardless — a catalog job ticking, an
   * upload progressing, a tag run counting up.
   *
   * The latest-ref indirection is what lets these be created once: the
   * handlers below close over nothing, and read the current implementations
   * at call time instead.
   */
  const latestHandlers = useRef({ runDetect, runExtractFigures, requestBookLoad, handleRemove, updateBookTitle });
  latestHandlers.current = { runDetect, runExtractFigures, requestBookLoad, handleRemove, updateBookTitle };
  const cardHandlers = useMemo(() => ({
    onDetect: (b: BookDocument) => latestHandlers.current.runDetect(b),
    onExtractFigures: (b: BookDocument) => latestHandlers.current.runExtractFigures(b),
    onRead: (b: BookDocument) => latestHandlers.current.requestBookLoad(b.id),
    onRemove: (b: BookDocument) => { void latestHandlers.current.handleRemove(b); },
    onRename: (b: BookDocument, title: string) => latestHandlers.current.updateBookTitle(b.id, title),
  }), []);

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
    <div
      ref={scrollRef}
      onScroll={rememberScroll}
      onDragEnter={(e) => {
        // Only a populated Vault needs the overlay — the empty one IS a dropzone.
        if (books.length > 0 && !dragOver && dragCarriesBooks(e)) setDragOver(true);
      }}
      onDragOver={(e) => { if (dragCarriesBooks(e)) e.preventDefault(); }}
      className="h-full flex flex-col overflow-auto"
    >
      <main className="cc-vault-main cc-page-main max-w-7xl mx-auto px-6 py-10 flex flex-col gap-6 w-full">
        {/* Masthead. What this is and how much is in it on the left; how you
            are looking at it on the right. The tagline that used to sit under
            the title said nothing a reader could use — the count does. */}
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="cc-vault-title cc-page-title font-headline text-4xl md:text-5xl font-bold tracking-tighter text-primary italic">
              My Library
            </h1>
            <p className="mt-1.5 text-sm text-on-surface-variant" aria-live="polite">
              {librarySummary}
            </p>
          </div>
          <SegmentedControl<ViewMode>
            ariaLabel="Library view"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
            labelClassName="hidden lg:inline"
            onOptionHover={(id) => {
              // Warm the three.js chunk on hover so the switch feels instant.
              if (id === "graph") void import("@/components/LibraryGraph");
            }}
          />
        </header>

        {/* Tools, one row: find, order, add, and the rare things behind "more".
            Sort, Auto-tag and Trash used to be three equal-weight buttons on a
            row of their own above the view switcher, which wrapped the header
            into two ragged rows. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {books.length > 0 ? (
              <div className="relative flex-1 min-w-0">
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
              </div>
            ) : (
              <span className="flex-1" />
            )}
            {books.length > 1 && (
              <button
                onClick={() => setSortBy((v) => (v === "date" ? "name" : "date"))}
                title={sortBy === "date" ? "Sorted by date added — switch to A–Z" : "Sorted A–Z — switch to date added"}
                aria-label={sortBy === "date" ? "Sort: recently added. Switch to by name" : "Sort: by name. Switch to recently added"}
                className="cc-tap-44 shrink-0 flex items-center gap-1.5 px-3 py-3 bg-surface-container-high rounded-xl text-foreground text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
              >
                <span className="material-symbols-outlined text-lg leading-none" aria-hidden>
                  {sortBy === "date" ? "schedule" : "sort_by_alpha"}
                </span>
                <span className="hidden md:inline">{sortBy === "date" ? "Recent" : "A–Z"}</span>
              </button>
            )}
            {/* Add: one click to the file picker, the arrow for YouTube. */}
            <div className="shrink-0 flex items-stretch rounded-xl">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="flex items-center gap-1.5 pl-4 pr-3 py-3 rounded-l-xl bg-primary-container text-on-primary-container text-sm font-bold active:scale-95 transition-transform disabled:opacity-60"
              >
                <span className={`material-symbols-outlined text-lg leading-none ${isUploading ? "animate-spin" : ""}`} aria-hidden>
                  {isUploading ? "progress_activity" : "add"}
                </span>
                <span className="hidden sm:inline">{isUploading ? "Uploading…" : "Add books"}</span>
                <span className="sr-only sm:hidden">Add books</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="More ways to add"
                    onMouseEnter={() => void import("@/components/VideoTranscript")}
                    className="flex items-center px-2 rounded-r-xl bg-primary-container text-on-primary-container border-l border-on-primary-container/20"
                  >
                    <span className="material-symbols-outlined text-lg leading-none" aria-hidden>expand_more</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                    <span className="material-symbols-outlined text-base mr-2" aria-hidden>upload_file</span>
                    Upload files…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openYoutube()}>
                    <span className="material-symbols-outlined text-base mr-2" aria-hidden>smart_display</span>
                    From YouTube…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <p className="px-2 py-1.5 text-[11px] leading-snug text-on-surface-variant">
                    Or drop files anywhere on the Vault, or paste a YouTube link.
                  </p>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="More library actions"
                  title="More"
                  className="cc-tap-44 shrink-0 relative flex items-center justify-center w-11 h-11 bg-surface-container-high rounded-xl text-foreground border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
                >
                  <span className={`material-symbols-outlined text-xl leading-none ${tagProgress ? "animate-spin" : ""}`} aria-hidden>
                    {tagProgress ? "progress_activity" : "more_horiz"}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-60">
                <DropdownMenuItem onSelect={handleAutoTag} disabled={!!tagProgress || books.length === 0}>
                  <span className="material-symbols-outlined text-base mr-2" aria-hidden>sell</span>
                  <span className="flex flex-col">
                    <span>{tagProgress ? `Tagging ${tagProgress.done}/${tagProgress.total}…` : "Auto-tag books"}</span>
                    <span className="text-[11px] text-on-surface-variant">Categories and tags with AI — powers the mind map</span>
                  </span>
                </DropdownMenuItem>
                {softDelete && (
                  <DropdownMenuItem onSelect={openTrash}>
                    <span className="material-symbols-outlined text-base mr-2" aria-hidden>delete</span>
                    <span className="flex flex-col">
                      <span>Trash{trashedBooks.length > 0 ? ` (${trashedBooks.length})` : ""}</span>
                      <span className="text-[11px] text-on-surface-variant">Deleted books, restorable for {TRASH_RETENTION_DAYS} days</span>
                    </span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
            {query && (
              <div className=" flex items-center gap-3 flex-wrap">
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

        {/* A line from something already on the shelves. One line, in the
            reader's case — it is a quotation, not a control label, so it opts
            out of the themes that capitalise every button. */}
        {resurfaced && view !== "graph" && (
          <div className="flex items-center gap-3 rounded-xl pl-4 pr-1.5 py-1.5 bg-surface-container-low/60 border border-outline-variant/10">
            <span className="material-symbols-outlined text-on-surface-variant/70 text-lg" aria-hidden>
              auto_stories
            </span>
            <button
              data-no-sticker
              onClick={() => requestBookLoad(resurfaced.book.id)}
              title={`${resurfaced.book.title} — ${resurfaced.line}`}
              style={{ textTransform: "none", letterSpacing: "normal", fontWeight: 400 }}
              className="group/res min-w-0 flex-1 truncate text-left text-sm py-1"
            >
              <span className="text-[11px] uppercase tracking-widest text-on-surface-variant/70 mr-2">From your library</span>
              <span className="font-semibold text-primary group-hover/res:underline underline-offset-2">
                {resurfaced.book.title}
              </span>
              <span className="text-on-surface-variant"> — {resurfaced.line}</span>
            </button>
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

        {/* Adding books. With books on the shelves, adding is the Add button
            and the whole-window overlay a drag raises — the old foot-tall
            dropzone above the shelves is only the empty Vault's welcome now. */}
        {dragOver && <VaultDropOverlay onDrop={handleDrop} onClose={closeDragOver} />}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.epub,.html"
          multiple
          onChange={handleFileUpload}
          className="hidden"
        />

        {/* Shelves / list / 3D mind map (search filters all views the same way) */}
        {booksError ? (
          /* A failed read used to be indistinguishable from an empty library:
             the only trace was a console.error, and the upsell stayed up
             forever. Say what happened and offer the retry. */
          <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-6xl mb-4 opacity-25">cloud_off</span>
            <p className="text-lg font-headline text-foreground">Couldn’t load your library</p>
            <p className="text-sm mt-1 max-w-sm text-center">{booksError}</p>
            <button
              onClick={retryLoadBooks}
              className="mt-4 px-5 py-2 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
            >
              Try again
            </button>
          </div>
        ) : booksLoading && books.length === 0 ? (
          /* Skeletons, not a spinner and definitely not the empty state: the
             shapes are the shapes the books will land in, so nothing moves
             when they do. */
          <div className="book-grid" aria-busy="true" aria-label="Loading your library">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-surface-container-high rounded-2xl overflow-hidden">
                <div className="aspect-[3/2] bg-surface-container-highest motion-safe:animate-pulse" />
                <div className="p-6 space-y-2">
                  <div className="h-5 w-3/4 rounded bg-surface-container-highest motion-safe:animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-surface-container-highest motion-safe:animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : books.length === 0 ? (
          <VaultDropzone
            title="Your library is empty — add your first book"
            isUploading={isUploading}
            onBrowse={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onYoutube={() => openYoutube()}
            onYoutubeHover={() => void import("@/components/VideoTranscript")}
          />
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
        ) : view === "showcase" ? (
          <LibraryShowcase
            books={filteredBooks}
            shelves={shelves}
            onOpenBook={(id) => requestBookLoad(id)}
            highlight={(text) => <Highlight text={text} query={query} />}
          />
        ) : view === "list" ? (

          <LibraryList
            books={filteredBooks}
            sortBy={sortBy}
            onSortBy={setSortBy}
            onOpenBook={(id) => requestBookLoad(id)}
            softDelete={softDelete}
            onRemove={(id) => {
              const b = books.find((x) => x.id === id);
              if (b) void handleRemove(b);
            }}
            highlight={(text) => <Highlight text={text} query={query} />}
          />
        ) : (
          <LibraryShelves
            books={filteredBooks}
            allBooks={sortedBooks}
            filtered={query.trim().length > 0}
            renderBook={(book) => (
              <BookCard
                key={book.id}
                book={book}
                query={query}
                job={jobs[book.id]}
                figJob={figJobs[book.id]}
                catJob={catJobs[book.id]}
                match={matchByBook.get(book.id) ?? null}
                softDelete={softDelete}
                shelves={shelves}
                shelfMarks={shelfMarks}
                {...cardHandlers}
              />
            )}
          />
        )}

        {/* The Trash: deleted books, restorable for 30 days. The only hard
            deletes left in the app live here, behind a second deliberate
            step, which is what lets every other delete be a one-click move. */}
        <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="font-headline text-2xl text-primary">Trash</DialogTitle>
              <DialogDescription>
                Deleted books wait here. Restoring one brings it back with its chapters,
                shelves and saved anchors. Anything older than {TRASH_RETENTION_DAYS} days is
                deleted forever the next time you open this.
              </DialogDescription>
            </DialogHeader>
            {trashLoading && trashedBooks.length === 0 ? (
              <p className="py-8 text-center text-sm text-on-surface-variant">Loading…</p>
            ) : trashedBooks.length === 0 ? (
              <p className="py-8 text-center text-sm text-on-surface-variant">The Trash is empty.</p>
            ) : (
              <>
                <ul className="flex flex-col gap-1 py-1">
                  {trashedBooks.map((t) => {
                    const daysLeft = Math.max(
                      0,
                      TRASH_RETENTION_DAYS - Math.floor((Date.now() - t.deletedAt) / 86_400_000),
                    );
                    return (
                      <li
                        key={t.id}
                        className="flex items-center gap-3 rounded-lg border border-outline-variant/15 bg-surface-container-high px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{t.title}</p>
                          <p className="text-[11px] text-on-surface-variant">
                            {t.pageCount > 0 ? `${t.pageCount} pages · ` : ""}
                            {Number.isFinite(t.deletedAt) ? `deleted ${new Date(t.deletedAt).toLocaleDateString()} · ` : ""}
                            {daysLeft === 0 ? "deleted forever soon" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
                          </p>
                        </div>
                        <button
                          disabled={busyTrashId === t.id}
                          onClick={async () => {
                            setBusyTrashId(t.id);
                            const r = await restoreBook(t.id);
                            setBusyTrashId(null);
                            if (r.ok) toast.success(`“${r.title}” is back in your library`);
                            else toast.error((r as { ok: false; error: string }).error);
                          }}
                          className="cc-tap-44 shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
                        >
                          Restore
                        </button>
                        <button
                          disabled={busyTrashId === t.id}
                          onClick={async () => {
                            if (!window.confirm(`Delete “${t.title}” forever? This cannot be undone.`)) return;
                            setBusyTrashId(t.id);
                            const r = await purgeBook(t.id);
                            setBusyTrashId(null);
                            if (r.ok) toast.success(`“${t.title}” deleted forever`);
                            else toast.error(r.error || "Could not delete it");
                          }}
                          title={`Delete “${t.title}” forever`}
                          aria-label={`Delete “${t.title}” forever`}
                          className="cc-tap-44 shrink-0 rounded-lg px-2 py-1.5 text-on-surface-variant hover:text-destructive hover:bg-error-container/20 disabled:opacity-50"
                        >
                          <span className="material-symbols-outlined text-lg" aria-hidden>delete_forever</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button
                  onClick={async () => {
                    if (!window.confirm(
                      `Delete all ${trashedBooks.length} book${trashedBooks.length === 1 ? "" : "s"} in the Trash forever? This cannot be undone.`,
                    )) return;
                    const r = await emptyTrash();
                    if (r.failed > 0) toast.error(`${r.purged} deleted, ${r.failed} could not be`);
                    else toast.success(`Trash emptied (${r.purged} book${r.purged === 1 ? "" : "s"})`);
                  }}
                  className="self-start rounded-lg px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-error-container/20"
                >
                  Empty trash
                </button>
              </>
            )}
          </DialogContent>
        </Dialog>

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

/**
 * A card's secondary actions (detect chapters, extract figures, delete) rest
 * invisible and appear on hover or keyboard focus. Twenty-five cards each
 * showing three icon buttons put ~75 identical controls on the page, which
 * is what made the grid read as noise; Open stays, always. The space stays
 * reserved (opacity, not display), so nothing shifts when they appear, and
 * `.cc-hover-reveal` shows them for good where there is no hover.
 */
const quietUntilHover = "cc-hover-reveal opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100";

const BookCardImpl: React.FC<{
  book: BookDocument;
  query?: string;
  job?: StructureJob;
  figJob?: FigureJob;
  catJob?: CatalogJob;
  /** The chapter that answered the search, when the title did not. */
  match?: { name: string; gist?: string | null } | null;
  /* These take the book rather than closing over it. Closures would be new
     on every render of Library, which silently defeats React.memo below —
     the memo would compare five fresh function identities and re-render
     every card anyway. */
  onDetect: (book: BookDocument) => void;
  onExtractFigures: (book: BookDocument) => void;
  onRead: (book: BookDocument) => void;
  onRemove: (book: BookDocument) => void;
  /** True while books go to the Trash rather than being destroyed. */
  softDelete?: boolean;
  onRename: (book: BookDocument, newTitle: string) => void;
  /** The shelf roster and every shelf's mark (src/lib/shelfMarks.ts). Both
   *  are stable identities from context, so they don't defeat the memo. */
  shelves?: BookFolder[];
  shelfMarks?: Map<string, ShelfMark>;
}> = ({ book, query = "", job, figJob, catJob, match, onDetect, onExtractFigures, onRead, onRemove, onRename, softDelete = false, shelves = [], shelfMarks }) => {
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
    if (touch) onRead(book);
    else startRename();
  };
  const isPdf = book.fileName.toLowerCase().endsWith(".pdf");
  const detecting = job?.status === "queued" || job?.status === "running";
  const extracting = figJob?.status === "queued" || figJob?.status === "running";
  const isHtml = book.fileName.toLowerCase().endsWith(".html");
  const metadataText = isPdf
    ? `${book.pageCount} pages · ${book.chapters.length} chapters · PDF`
    : isHtml
    ? `${book.chapters.length > 0 ? `${book.chapters.length} sections · ` : ""}${isYoutubeTranscript(book) ? "Video transcript" : "HTML"}`
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
      : "Extract figures (signs, diagrams, charts) into your Images, tagged with their chapter — and paired with this book's notebooks where they exist";
  const removeLabel = softDelete ? `Move “${book.title}” to the Trash` : `Delete “${book.title}”`;

  // Warm gradient hues, chosen by the book's id rather than its position.
  // Keying on the array index meant a book was olive in one sort order and
  // amber in another, and every card restained when a search narrowed the
  // list. A cover should be the book's face, not its seat number.
  const hues = [35, 25, 40, 15, 45, 20];
  const hue = hues[seedOf(book.id) % hues.length];

  // The shelves this book is on, wearing their marks: ribbons on the cover, a
  // spine down the card's edge, and — with no cover image — a jacket in the
  // first shelf's color, so a shelf's books read as a set across the grid.
  const onShelves = shelfMarks ? marksForBook(book.folderIds, shelves, shelfMarks) : [];
  const jacket = !book.coverImageUrl && onShelves.length > 0 ? onShelves[0] : null;
  const jacketLook = jacket ? jacketLayout(seedOf(book.id), jacket.mark.color) : null;
  const dated = jacket ? titleDate(book.title) : null;

  return (
    <div
      data-book-card
      /* No entry animation. It was `animate-slide-up` with a per-card
         animationDelay and no animation-fill-mode: backwards, so during the
         delay each card sat fully visible, then snapped to opacity 0 and faded
         back in — every card flashed, on every search keystroke. It was also
         not covered by the reduced-motion block. Removing it fixes the flash,
         the stagger cost, and a standing request for less motion at once. */
      className="group relative h-full bg-surface-container-high rounded-xl overflow-hidden flex flex-col transition-all hover:-translate-y-1 hover:shadow-2xl hover:shadow-black/40"
    >
      {/* The spine: one stripe per shelf, full height of the card. */}
      {onShelves.length > 0 && (
        <div
          data-shelf-spine
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-1.5 z-10"
          style={{ background: markStripes(onShelves.map((s) => s.mark.color)) }}
        />
      )}
      {/* Cover */}
      <div
        data-book-cover-placeholder={book.coverImageUrl || jacket ? undefined : ""}
        className="cc-book-cover aspect-[5/2] relative overflow-hidden bg-surface-container-highest flex items-center justify-center"
        style={{
          background: book.coverImageUrl
            ? undefined
            : `linear-gradient(135deg, hsl(${hue}, 30%, 18%), hsl(${hue}, 25%, 12%))`,
        }}
      >
        {book.coverImageUrl ? (
          <img src={book.coverImageUrl} alt={book.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : jacket ? (
          // Its own layer, not the placeholder's background: themes restyle
          // the placeholder with !important, and the jacket must win.
          // Composition varies per book (src/lib/bookJacket.ts) so a shelf of
          // jackets reads as a series, not one picture repeated.
          <div
            data-shelf-jacket
            className="absolute inset-0"
            style={{ background: jacketLook!.background }}
          >
            <span
              className="material-symbols-outlined absolute leading-none transition-transform duration-500 group-hover:scale-110"
              style={{
                ...jacketLook!.glyph,
                color: jacket.mark.color,
                fontVariationSettings: "'FILL' 1",
                filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5)) brightness(1.25)",
              }}
              aria-hidden
            >
              {jacket.mark.glyph}
            </span>
            <span className="absolute bottom-1.5 left-3 right-3 flex items-baseline gap-2 text-[10px] font-bold uppercase tracking-widest text-white/85 drop-shadow">
              <span className="truncate">{jacket.name}</span>
              {dated && <span className="ml-auto shrink-0 text-white/70">{dated}</span>}
            </span>
          </div>
        ) : (
          <span className="material-symbols-outlined text-4xl text-primary/30">
            {isPdf ? "auto_stories" : isHtml ? "article" : "description"}
          </span>
        )}
        {!jacket && (
          <div data-book-cover-overlay className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />
        )}
        <YoutubeTranscriptBadge book={book} className={`absolute ${onShelves.length > 0 ? "bottom-2 right-2" : "top-3 left-3"} shadow-lg`} />
        {/* Ribbons: a bookmark per shelf hanging from the top edge, each in
            its shelf's color with its glyph. Hover names the shelf. */}
        {onShelves.length > 0 && (
          <div data-shelf-ribbons className="absolute top-0 left-3 flex gap-1 z-10">
            {onShelves.slice(0, 5).map(({ id, name, mark }) => (
              <span
                key={id}
                title={`On “${name}”`}
                aria-label={`On shelf ${name}`}
                className="flex h-7 w-5 items-start justify-center pt-0.5 shadow-md"
                style={{
                  background: mark.color,
                  color: mark.ink,
                  clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%)",
                }}
              >
                <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>
                  {mark.glyph}
                </span>
              </span>
            ))}
            {onShelves.length > 5 && (
              <span className="self-start mt-1 rounded bg-black/60 px-1 text-[10px] font-bold text-white">
                +{onShelves.length - 5}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="cc-book-info p-4 flex flex-col flex-1">
        {editing ? (
          <input
            className="cc-book-title w-full text-base font-headline font-bold bg-transparent border border-outline-variant rounded-lg px-2 py-1 mb-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) { onRename(book, draft.trim()); setEditing(false); }
              if (e.key === "Escape") { setDraft(book.title); setEditing(false); }
            }}
            onBlur={() => {
              if (draft.trim() && draft.trim() !== book.title) onRename(book, draft.trim());
              setEditing(false);
            }}
          />
        ) : (
          <h4
            className="cc-book-title font-headline text-base leading-snug font-bold text-primary mb-1 cursor-pointer hover:text-accent transition-colors line-clamp-2"
            onClick={onTitleClick}
          >
            <Highlight text={book.title} query={query} />
          </h4>
        )}
        <p className="cc-book-meta text-on-surface-variant text-[10px] font-medium uppercase tracking-wider mb-2">
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
            <p className="text-xs leading-relaxed text-on-surface-variant line-clamp-2" title={book.summary}>
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
        {(book.category || topicTags(book.tags).length > 0) && (
          <div className="cc-book-tags flex flex-wrap gap-1.5 mb-2">
            {book.category && (
              <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium">
                {book.category}
              </span>
            )}
            {topicTags(book.tags).slice(0, 3).map((t) => (
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
        <div className="cc-book-status mb-3 space-y-1 empty:mb-0">
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
        <div className="cc-book-actions mt-auto flex items-center gap-2">
          <button
            onClick={() => onRead(book)}
            className="cc-book-open mr-auto flex items-center gap-1 pl-4 pr-3 py-2 text-sm bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
          >
            Open
            <span className="material-symbols-outlined text-base leading-none" aria-hidden>arrow_forward</span>
          </button>
          {isPdf && (
            <button
              data-cc-wide
              onClick={(e) => { e.stopPropagation(); onDetect(book); }}
              disabled={detecting}
              title={detectLabel}
              aria-label={detectLabel}
              className={`${detecting ? "" : quietUntilHover} p-2 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span className={`material-symbols-outlined text-lg leading-none ${detecting ? "animate-spin" : ""}`}>
                {detecting ? "progress_activity" : "auto_awesome"}
              </span>
            </button>
          )}
          {isPdf && (
            <button
              data-cc-wide
              onClick={(e) => { e.stopPropagation(); onExtractFigures(book); }}
              disabled={extracting}
              title={extractLabel}
              aria-label={extractLabel}
              className={`${extracting ? "" : quietUntilHover} p-2 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-primary/10 hover:text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span className={`material-symbols-outlined text-lg leading-none ${extracting ? "animate-spin" : ""}`}>
                {extracting ? "progress_activity" : "image_search"}
              </span>
            </button>
          )}
          <button
            data-cc-wide
            onClick={(e) => { e.stopPropagation(); onRemove(book); }}
            title={removeLabel}
            aria-label={removeLabel}
            className={`${quietUntilHover} p-2 bg-surface-container-highest text-on-surface-variant rounded-lg hover:bg-error-container/20 hover:text-destructive transition-all`}
          >
            <span className="material-symbols-outlined text-lg leading-none">delete</span>
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
                <DropdownMenuItem disabled={detecting} aria-label={detectLabel} onSelect={() => onDetect(book)}>
                  <span className={`material-symbols-outlined text-base mr-2 shrink-0 ${detecting ? "animate-spin" : ""}`} aria-hidden>
                    {detecting ? "progress_activity" : "auto_awesome"}
                  </span>
                  <span className="truncate">{detecting ? "Detecting chapters…" : "Detect chapters"}</span>
                </DropdownMenuItem>
              )}
              {isPdf && (
                <DropdownMenuItem disabled={extracting} aria-label={extractLabel} onSelect={() => onExtractFigures(book)}>
                  <span className={`material-symbols-outlined text-base mr-2 shrink-0 ${extracting ? "animate-spin" : ""}`} aria-hidden>
                    {extracting ? "progress_activity" : "image_search"}
                  </span>
                  <span className="truncate">{extracting ? "Extracting figures…" : "Extract figures"}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                aria-label={removeLabel}
                onSelect={() => onRemove(book)}
              >
                <span className="material-symbols-outlined text-base mr-2 shrink-0" aria-hidden>delete</span>
                <span className="truncate">{softDelete ? "Move to Trash" : "Delete"}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
};

/**
 * Memoized, because the Vault renders up to sixty of these at once and each
 * one mounts two Radix dropdown roots. Every keystroke in the search box
 * re-renders `Library`, and without this that re-rendered every card on
 * screen — about a hundred and twenty menu roots — to change nothing.
 *
 * The props are all primitives, stable objects from context, or callbacks; the
 * one that used to defeat this was `match`, which was a fresh object from
 * `chapterMatch` on every render. It comes from a memoized map now.
 */
const BookCard = React.memo(BookCardImpl);

export default Library;
