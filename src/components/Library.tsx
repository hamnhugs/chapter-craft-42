import VaultDropzone, { VaultDropOverlay, dragCarriesBooks } from "@/components/VaultDropzone";
import React, { useRef, useState, useMemo, useEffect, useCallback, lazy, Suspense } from "react";
import { useApp, TRASH_RETENTION_DAYS } from "@/context/AppContext";
import { BookDocument } from "@/types/library";
import { isAssistantBook } from "@/lib/bookProvenance";
import { Progress } from "@/components/ui/progress";
import { useChatSettings } from "@/hooks/useChatSettings";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { structureJobs, useStructureJobs } from "@/lib/structureJobs";
import { catalogJobs, useCatalogJobs } from "@/lib/catalogJobs";
import { figureJobs, useFigureJobs } from "@/lib/figureJobs";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { autoTagBooks } from "@/lib/autoTag";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { probePdf, resolveTitle, type PdfProbe } from "@/lib/bookIntake";
import LibraryDeck from "@/components/LibraryDeck";
import { bookHaystack, matchesAll, tokenize } from "@/lib/librarySearch";
import { seekLibrary, SEEK_FETCH_CAP, type SeekOutcome } from "@/lib/librarySeek";

import LibraryList from "@/components/LibraryList";
import LibraryShowcase from "@/components/LibraryShowcase";

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


type ViewMode = "cards" | "list" | "showcase" | "graph";
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

/** The views besides the cards, offered from the "more" menu. */
const OTHER_VIEWS: { id: ViewMode; icon: string; label: string; hint: string }[] = [
  { id: "list", icon: "view_list", label: "View as a list", hint: "A table you can sort by column" },
  { id: "showcase", icon: "play_circle", label: "Showcase", hint: "One book at a time, full screen" },
  { id: "graph", icon: "hub", label: "Mind map", hint: "Books linked by category and tag" },
];


const Library: React.FC = () => {
  const { books, addBook, setBookCover, removeBook, trashAvailable, trashedBooks, trashLoading, refreshTrash, restoreBook, purgeBook, emptyTrash, updateBookTitle, updateBookTags, addChapter, removeChapter, loadBookFile, applyChapterGists, applyBookSummary, loadChapterText,
    shelves, toggleBookShelf, booksLoading, booksError, retryLoadBooks, loadFocus } = useApp();
  // Reading is not a question about notebooks. Opening a book from here opens
  // the reader and leaves what Counsel has loaded alone; taking something to
  // Counsel is its own button ("Ask Counsel") on a book and on a shelf.
  const requestBookLoad = useCallback((bookId: string) => {
    void loadFocus({ kind: "book", bookId, neurons: { kind: "keep" }, alongside: true });
  }, [loadFocus]);
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
    // Cards — shelves included — are the default. The old Shelves view is
    // gone, so a stored "shelves" lands on the cards too.
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "graph" || v === "showcase" ? v : "cards";
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
        toast("Reel has moved — grab YouTube transcripts with the “From YouTube” button in your Library.");
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

  /**
   * Categorize and tag the books that just arrived, unasked.
   *
   * Tagging was a button, which is why most libraries are untagged and the
   * collection's filters and mind map had little to work with. It runs once
   * per batch, after the uploads settle, on the new books only. Silent on
   * failure: the manual Auto-tag button is still there, and an unrequested
   * background step has no business raising an error toast.
   */
  const autoTagArrivals = async (ids: string[]) => {
    if (ids.length === 0 || tagProgress) return;
    // Chapter detection finishes later and tags read better with chapter
    // names, but a title and the opening pages are enough to place a book —
    // and waiting would mean threading through the structure queue.
    const targets = ids
      .map((id) => booksRef.current.find((b) => b.id === id))
      .filter((b): b is BookDocument => !!b && !b.category && !isAssistantBook(b));
    if (targets.length === 0) return;
    try {
      const results = await autoTagBooks(targets, booksRef.current, { apiKey: apiKey || undefined });
      for (const r of results) {
        try { await updateBookTags(r.id, r.category, r.tags); } catch { /* next book */ }
      }
    } catch (e) {
      console.warn("Auto-tag on upload skipped:", e);
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

    /** Books handed to chapter detection; these are tagged when it finishes. */
    const structuring = new Set<string>();
    const processQueueItem = async (item: { id: string; file: File }) => {
      const isEpub = item.file.name.toLowerCase().endsWith(".epub");
      let fileToUpload = item.file;
      let pageCount = 0;
      // One pass over the PDF yields the page count, the title candidates and
      // the cover (lib/bookIntake.ts) — nothing here is left for the reader
      // to fill in by hand afterwards.
      let probe: PdfProbe | null = null;

      if (isEpub) {
        updateUploadState(item.id, { status: "uploading", attempts: 0, error: "Converting EPUB…" });
        try {
          // Loaded on demand: the converter drags in JSZip + jsPDF, which only EPUB uploads need
          const { convertEpubToPdf } = await import("@/lib/epubToPdf");
          const result = await convertEpubToPdf(item.file);
          fileToUpload = result.file;
          pageCount = result.pageCount;
          // The converted PDF's first page is the EPUB's opening page.
          probe = await probePdf(result.file);
        } catch {
          updateUploadState(item.id, { status: "failed", attempts: 0, error: "EPUB conversion failed" });
          return;
        }
      } else {
        const isPdf = item.file.name.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          updateUploadState(item.id, { status: "uploading", attempts: 0, error: "Reading title and cover…" });
          probe = await probePdf(item.file);
          pageCount = probe.pageCount;
        }
      }

      // A re-upload replaces the FILE of a book already in the library. Its
      // title may have been edited since — keep it, rather than resetting it
      // to whatever the file says (which is what this used to do).
      const reupload = booksRef.current.find((b) => b.fileName.toLowerCase() === fileToUpload.name.toLowerCase());
      const title = reupload?.title
        ?? resolveTitle({
          fileName: item.file.name,
          // An EPUB's generated PDF carries no metadata of its own.
          metadataTitle: isEpub ? null : probe?.metadataTitle,
          headingTitle: isEpub ? null : probe?.headingTitle,
        });

      let attempt = 0;
      let uploaded = false;
      let lastError: unknown = null;

      while (attempt < MAX_UPLOAD_ATTEMPTS && !uploaded) {
        attempt += 1;
        updateUploadState(item.id, { status: "uploading", attempts: attempt, error: undefined });

        try {
          const newBook: BookDocument = {
            id: crypto.randomUUID(),
            title,
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
          // Cover: page one, stored beside the book. Not awaited — a cover
          // arriving a second late must not hold up the next file.
          if (probe?.cover) void setBookCover(finalBookId, probe.cover);

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
              // Tag once the chapters exist: their names place a book far
              // better than its title alone.
              onComplete: () => { enqueueCatalog(finalBookId); void autoTagArrivals([finalBookId]); },
            });
            structuring.add(finalBookId);
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
    // Books with no chapter run ahead of them are tagged now, from the title.
    void autoTagArrivals(addedIds.filter((id) => !structuring.has(id)));
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

  /** What is running on each book, in a few words, for its card. */
  const busyByBook = useMemo(() => {
    const m = new Map<string, string>();
    const live = (st?: string) => st === "queued" || st === "running";
    for (const [id, j] of Object.entries(catJobs)) if (live((j as { status?: string })?.status)) m.set(id, "Writing summary…");
    for (const [id, j] of Object.entries(figJobs)) if (live((j as { status?: string })?.status)) m.set(id, "Finding figures…");
    for (const [id, j] of Object.entries(jobs)) if (live((j as { status?: string })?.status)) m.set(id, "Finding chapters…");
    return m;
  }, [jobs, figJobs, catJobs]);

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
        {/* The dock already says where you are, so the page opens on its
            tools. The heading stays for screen readers and the outline. */}
        <h1 className="sr-only">My Library</h1>
        <p className="sr-only" aria-live="polite">{librarySummary}</p>

        {/* Tools, one row: find, order, add, and the rare things behind "more".
            Sort, Auto-tag and Trash used to be three equal-weight buttons on a
            row of their own above the view switcher, which wrapped the header
            into two ragged rows. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {view !== "cards" && (
              <button
                onClick={() => setView("cards")}
                className="cc-tap-44 shrink-0 flex items-center gap-1.5 px-3 py-3 bg-surface-container-high rounded-xl text-foreground text-sm font-bold border border-outline-variant/10 hover:bg-surface-container-highest transition-all"
              >
                <span className="material-symbols-outlined text-lg leading-none" aria-hidden>arrow_back</span>
                <span className="hidden sm:inline">Cards</span>
                <span className="sr-only sm:hidden">Back to cards</span>
              </button>
            )}
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
            {books.length > 1 && view === "showcase" && (
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
                    Or drop files anywhere on the Library, or paste a YouTube link.
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
                {/* Three other ways to look at the same books. Rarely used,
                    so they live here instead of on a five-icon switch. */}
                {OTHER_VIEWS.map((v) => (
                  <DropdownMenuItem
                    key={v.id}
                    onSelect={() => setView(view === v.id ? "cards" : v.id)}
                    onMouseEnter={() => { if (v.id === "graph") void import("@/components/LibraryGraph"); }}
                  >
                    <span className="material-symbols-outlined text-base mr-2" aria-hidden>{view === v.id ? "check" : v.icon}</span>
                    <span className="flex flex-col">
                      <span>{v.label}</span>
                      <span className="text-[11px] text-on-surface-variant">{v.hint}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
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

        {/* File-on-arrival. An offer, never a gate — see fileJustAdded. */}
        {justAdded.length > 0 && !isUploading && (
          <div className="flex items-center gap-3 flex-wrap bg-surface-container-low rounded-xl px-5 py-4 border border-outline-variant/10">
            <span className="material-symbols-outlined text-primary" aria-hidden>inbox</span>
            <p className="flex-1 min-w-[12rem] text-sm text-foreground">
              {justAdded.length} book{justAdded.length === 1 ? "" : "s"} added.
              {shelves.length > 0
                ? " Put them on a shelf while they're fresh?"
                : " Make a shelf with “New shelf” to file them."}
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
              Extracting {activeVideoJobs} YouTube transcript{activeVideoJobs === 1 ? "" : "s"}… the book lands in your Library when done.
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
                    {/* Before the first attempt the row carries a step name
                        ("Converting EPUB…", "Reading title and cover…") — it
                        used to read "Uploading (try 0/3)" through both. */}
                    {item.status === "uploading"
                      ? item.attempts === 0 && item.error
                        ? item.error
                        : `Uploading (try ${item.attempts}/${MAX_UPLOAD_ATTEMPTS})`
                      : item.status}
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
        ) : view === "cards" ? (
          <LibraryDeck
            books={filteredBooks}
            allBooks={sortedBooks}
            shelves={shelves}
            filtered={query.trim().length > 0}
            softDelete={softDelete}
            busyByBook={busyByBook}
            handlers={cardHandlers}
            highlight={(text) => <Highlight text={text} query={query} />}
          />
        ) : view === "showcase" ? (
          <LibraryShowcase
            books={filteredBooks}
            shelves={shelves}
            onOpenBook={(id) => requestBookLoad(id)}
            highlight={(text) => <Highlight text={text} query={query} />}
          />
        ) : (
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
        )}

        {/* A line from something already on the shelves, under the books
            rather than above them: a nice thing to come across, not something
            to get past on the way to a book. One line, in the
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
                Paste a YouTube URL to extract the full transcript as a readable book — it lands in your Library automatically.
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

export default Library;
