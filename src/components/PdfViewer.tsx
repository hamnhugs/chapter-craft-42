import React, { useState, useCallback, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { useApp } from "@/context/AppContext";
import { renderCover } from "@/lib/bookIntake";
import { Chapter } from "@/types/library";
import ReaderContents from "@/components/ReaderContents";
import CaptureQuoteDialog from "@/components/CaptureQuoteDialog";
import HighlightActions, { type ReaderAction } from "@/components/HighlightActions";
import { toast } from "sonner";
import ReadAlong from "@/components/ReadAlong";
import YoutubeTranscriptBadge from "@/components/YoutubeTranscriptBadge";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ReadAlongStatus } from "@/lib/readAlongPlayer";
import type { SwipeDirection } from "@/lib/readerGestures";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePageSwipe } from "@/hooks/usePageSwipe";
import { usePinchZoom } from "@/hooks/usePinchZoom";
import { useReaderFocus } from "@/hooks/useReaderFocus";
import { loadLastPage, saveLastPage, useReaderPrefs } from "@/hooks/useReaderPrefs";
import { READER_GO_TO_PAGE } from "@/lib/openPassage";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useReaderHighlights, type HighlightHit } from "@/hooks/useReaderHighlights";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
/** "Fit" on a wide desktop would blow a page up to poster size. */
const MAX_FIT_ZOOM = 1.5;
/** A phone's controls hide this long after the last touch while listening, and once after a book opens. */
const CHROME_HIDE_MS = 3000;
const FIRST_CHROME_HIDE_MS = 3500;
/** A phone: touch, and small in either direction (so a phone on its side counts). */
const PHONE_QUERY = "(pointer: coarse) and (max-width: 639px), (pointer: coarse) and (max-height: 500px)";
/** Below this the bar's controls stack icon over label. */
const COMPACT_BAR_WIDTH = 640;
/** A tap in the outer thirds of a phone's screen turns the page. */
const TAP_ZONE = 0.3;
const TAP_HINT_KEY = "cc_reader_tap_hint";
// 3x phone screens cost ~2.25x the canvas memory of 2x for no visible gain.
const renderPixelRatio = () => Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";
const iconBtn =
  `grid place-items-center w-11 h-11 shrink-0 rounded-full transition-colors hover:bg-surface-container-high active:scale-95 disabled:opacity-30 disabled:pointer-events-none ${focusRing}`;
/** One control in the reader bar: always an icon AND a word. */
const slotWide =
  `flex items-center gap-1.5 h-10 px-3 shrink-0 rounded-lg text-foreground transition-colors hover:bg-surface-container-high active:scale-95 disabled:opacity-40 ${focusRing}`;
const slotWideLabel = "font-label text-sm font-semibold";
const slotCompact =
  `flex flex-col items-center justify-center gap-0.5 min-w-[3.25rem] h-12 px-1.5 shrink-0 rounded-xl text-foreground transition-colors hover:bg-surface-container-highest active:scale-95 disabled:opacity-40 ${focusRing}`;
const slotCompactLabel = "font-label text-[11px] leading-none font-semibold";

/** Books whose cover backfill already ran this session (one attempt each). */
const coverBackfilled = new Set<string>();

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

function readTapHintSeen(): boolean {
  try { return localStorage.getItem(TAP_HINT_KEY) === "seen"; } catch { return true; }
}

/**
 * The Read tab.
 *
 * The page is the screen. Everything else is ONE bar of five labelled
 * controls — Contents, Listen, Page, View, More — at the top with a mouse and
 * at the bottom, under the thumb, on a phone. Rarely used things (making a
 * chapter, options, full screen) are one tap down, inside Contents and More.
 *
 * On a phone the reader takes the whole screen: the app bar, the dock and the
 * reader bar slide away, a tap in the middle of the page brings them back, and
 * a tap on either side turns the page.
 */
const PdfViewer: React.FC = () => {
  const { getActiveBook, addChapter, updateChapter, removeChapter, setBookCover, activeBookId, loadBookFile, loadChapterTextStrict, setActiveTab } = useApp();
  const book = getActiveBook();
  const isPdfBook = book?.fileName.toLowerCase().endsWith(".pdf") ?? false;
  const isHtmlBook = book?.fileName.toLowerCase().endsWith(".html") ?? false;

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const { zoom, setZoom, swipeEnabled, setSwipeEnabled, autoHighlight, setAutoHighlight } = useReaderPrefs();
  /** Width of the current page at scale 1, for fit-to-width. */
  const [pageWidth, setPageWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  /** HTML books: the section last jumped to (PDF chapters follow the page). */
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [contentsOpen, setContentsOpen] = useState(false);
  /** Page range for a new chapter; kept while Contents is closed. */
  const [chapterRange, setChapterRange] = useState<{ from: number | null; to: number | null }>({ from: null, to: null });
  const [fileUrl, setFileUrl] = useState<string>("");
  const [htmlContent, setHtmlContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [readStatus, setReadStatus] = useState<ReadAlongStatus>("idle");
  const readAlongActive = readStatus !== "idle";
  // Bumps when the page's text layer (PDF) or the iframe document (HTML)
  // renders, so read-along can re-map words onto fresh DOM.
  const [textVersion, setTextVersion] = useState(0);
  const bumpTextVersion = useCallback(() => setTextVersion((v) => v + 1), []);
  const [isSavingChapter, setIsSavingChapter] = useState(false);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setContainer = useCallback((node: HTMLDivElement | null) => {
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    setScrollEl(node);
  }, []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageHostRef = useRef<HTMLDivElement>(null);
  const htmlHostRef = useRef<HTMLDivElement>(null);
  /** The bar's row that the listening player takes over. */
  const [playerHost, setPlayerHost] = useState<HTMLDivElement | null>(null);
  /** Last rendered page height: holds the layout steady while the next page renders. */
  const [pageMinHeight, setPageMinHeight] = useState(0);
  const [pageInput, setPageInput] = useState("");
  /** The page the slider is being dragged to, before release. */
  const [pageDraft, setPageDraft] = useState<number | null>(null);
  const [swipeHint, setSwipeHint] = useState<{ dir: SwipeDirection; progress: number } | null>(null);

  const phone = useMediaQuery(PHONE_QUERY);
  const { focused, enter: enterFocus, exit: exitFocus, toggle: toggleFocus } = useReaderFocus();
  useWakeLock(focused || readStatus === "playing");

  // ── Highlights: saved marks with their own glow, made from selections ───
  const [highlightHit, setHighlightHit] = useState<HighlightHit | null>(null);
  /** "Save as card": the quote the dialog anchors into the book. */
  const [cardSource, setCardSource] = useState<{ quote: string; page: number; chapterId: string | null } | null>(null);
  const captureOpen = cardSource !== null;
  const highlights = useReaderHighlights({
    mode: isHtmlBook ? "html" : "pdf",
    book: book ?? null,
    page: currentPage,
    pageHostRef,
    iframeRef,
    textVersion,
    autoHighlight,
    readAlongActive,
    loadChapterTextStrict,
    onTapHighlight: setHighlightHit,
  });
  /** When a text menu last closed: the tap that closed it must not also turn the page. */
  const menuClosedAtRef = useRef(0);
  const closeHighlightMenu = useCallback(() => {
    menuClosedAtRef.current = performance.now();
    setHighlightHit(null);
  }, []);

  const askInChat = (quoteText: string, page: number | null) => {
    if (!book) return;
    const quote = quoteText.length > 1200 ? `${quoteText.slice(0, 1200)}…` : quoteText;
    const source = `— from “${book.title || "Untitled"}”${page ? `, p. ${page}` : ""}`;
    const text = `${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n${source}\n\n`;
    // The composer picks this up whether or not it's mounted right now.
    try {
      const draft = sessionStorage.getItem("counsel_draft") || "";
      sessionStorage.setItem("counsel_draft", draft ? `${draft}\n\n${text}` : text);
    } catch { /* storage unavailable: the live event below still works */ }
    window.dispatchEvent(new CustomEvent("chat-composer-insert", { detail: { text } }));
    setHighlightHit(null);
    if (focused) exitFocus();
    setActiveTab("chat");
  };

  // ── The menu on a live text selection ───────────────────────────────────
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; rect: DOMRect } | null>(null);
  const readSelectionBox = useCallback(() => {
    const doc = isHtmlBook ? iframeRef.current?.contentDocument : document;
    const sel = doc?.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const frame = isHtmlBook ? iframeRef.current?.getBoundingClientRect() : null;
    return { text, rect: new DOMRect(r.left + (frame?.left ?? 0), r.top + (frame?.top ?? 0), r.width, r.height) };
  }, [isHtmlBook]);
  useEffect(() => {
    if (!highlights.pendingSelection || captureOpen) {
      setSelectionMenu(null);
      return;
    }
    setSelectionMenu(readSelectionBox());
    // The menu follows its text when the page scrolls under it.
    const scroller: EventTarget | null | undefined = isHtmlBook ? iframeRef.current?.contentDocument : scrollEl;
    let raf = 0;
    const follow = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSelectionMenu(readSelectionBox()));
    };
    scroller?.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(raf);
      scroller?.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
    };
  }, [highlights.pendingSelection, highlights.selectionTick, captureOpen, readSelectionBox, isHtmlBook, scrollEl]);
  const clearSelection = useCallback(() => {
    menuClosedAtRef.current = performance.now();
    (isHtmlBook ? iframeRef.current?.contentDocument : document)?.getSelection()?.removeAllRanges();
    setSelectionMenu(null);
  }, [isHtmlBook]);

  // Reset on book change, reopening where this book was left.
  useEffect(() => {
    setCurrentPage(activeBookId ? loadLastPage(activeBookId) : 1);
    setNumPages(0);
    setPageWidth(0);
    setPageMinHeight(0);
    setChapterRange({ from: null, to: null });
    setSelectedChapterId(null);
    setContentsOpen(false);
    setFileUrl("");
    setHtmlContent("");
  }, [activeBookId]);

  useEffect(() => {
    if (activeBookId && numPages > 0) saveLastPage(activeBookId, currentPage);
  }, [activeBookId, currentPage, numPages]);

  // Load file
  useEffect(() => {
    if (!activeBookId) return;

    if (!isPdfBook && !isHtmlBook) {
      setFileUrl("");
      setHtmlContent("");
      setLoading(false);
      return;
    }

    if (isHtmlBook) {
      setLoading(true);
      const loadHtml = async (objectUrl: string) => {
        try {
          const res = await fetch(objectUrl);
          setHtmlContent(await res.text());
        } catch {
          setHtmlContent("");
        }
        setLoading(false);
      };
      if (book?.fileData) { loadHtml(book.fileData); return; }
      loadBookFile(activeBookId)
        .then((url) => { if (url) loadHtml(url); else { setHtmlContent(""); setLoading(false); } })
        .catch(() => { setHtmlContent(""); setLoading(false); });
      return;
    }

    // PDF path
    if (book?.fileData) { setFileUrl(book.fileData); setLoading(false); return; }
    setLoading(true);
    loadBookFile(activeBookId)
      .then((url) => { setFileUrl(url); setLoading(false); })
      .catch(() => { setFileUrl(""); setLoading(false); });
  }, [activeBookId, isPdfBook, isHtmlBook, book?.fileData, loadBookFile]);

  // Track the reader's width: fit-to-width, and how much room the bar has.
  useEffect(() => {
    if (!rootEl) return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(Math.round(entry.contentRect.width)));
    ro.observe(rootEl);
    return () => ro.disconnect();
  }, [rootEl]);

  const coverBackfillRef = useRef<{ id: string; hasCover: boolean } | null>(null);
  {
    const b = getActiveBook();
    coverBackfillRef.current = b ? { id: b.id, hasCover: !!b.coverImageUrl } : null;
  }
  const onDocumentLoadSuccess = useCallback((pdf: PDFDocumentProxy) => {
    setNumPages(pdf.numPages);
    setCurrentPage((p) => Math.min(Math.max(1, p), pdf.numPages));
    // Measure a page up front so the first render is already fitted.
    pdf.getPage(1).then((p) => setPageWidth((w) => w || p.getViewport({ scale: 1 }).width)).catch(() => {});
    // Books uploaded before covers were automatic get theirs the first time
    // they are opened — the document is already in memory, so it costs one
    // small render and no download.
    const open = coverBackfillRef.current;
    if (open && !open.hasCover && !coverBackfilled.has(open.id)) {
      coverBackfilled.add(open.id);
      void renderCover(pdf as any).then((blob) => { if (blob) void setBookCover(open.id, blob); });
    }
  }, [setBookCover]);

  const gutter = containerWidth < 640 ? 8 : 32;
  const fitScale = pageWidth > 0 && containerWidth > 0
    ? Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, (containerWidth - gutter * 2) / pageWidth))
    : 0;
  const scale = zoom === "fit" ? fitScale : zoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const goToPage = useCallback((page: number) => {
    setCurrentPage((p) => (page >= 1 && page <= numPages ? page : p));
  }, [numPages]);

  // A note's "open page" link (lib/openPassage.ts) for the book already open.
  useEffect(() => {
    const onGo = (e: Event) => {
      const d = (e as CustomEvent<{ bookId: string; page: number }>).detail;
      if (!d || d.bookId !== activeBookId) return;
      // Before the document loads numPages is 0; onDocumentLoadSuccess clamps.
      setCurrentPage((p) => (d.page >= 1 && (numPages === 0 || d.page <= numPages) ? d.page : p));
    };
    window.addEventListener(READER_GO_TO_PAGE, onGo);
    return () => window.removeEventListener(READER_GO_TO_PAGE, onGo);
  }, [activeBookId, numPages]);
  const goToNextPage = useCallback(() => setCurrentPage((p) => (p < numPages ? p + 1 : p)), [numPages]);
  const goToPrevPage = useCallback(() => setCurrentPage((p) => (p > 1 ? p - 1 : p)), []);
  const changeZoom = (delta: number) => {
    const base = scale || 1;
    setZoom(Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base + delta)) * 100) / 100);
  };

  // A new page starts at its top, like turning a real one.
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [currentPage]);

  // ── Swipe to turn (deliberate gestures only — see readerGestures) ────────
  usePageSwipe(scrollEl, {
    enabled: swipeEnabled && isPdfBook,
    onSwipe: (dir) => (dir === "next" ? goToNextPage() : goToPrevPage()),
    onProgress: setSwipeHint,
  });

  // ── Pinch to zoom the page (not the whole app) ──────────────────────────
  usePinchZoom(scrollEl, {
    enabled: isPdfBook,
    targetRef: pageHostRef,
    getScale: () => scaleRef.current,
    min: MIN_ZOOM,
    max: MAX_ZOOM,
    onZoom: setZoom,
  });

  // ── Keyboard: ←/→ turn pages, Space/PageDown read on, F full screen ─────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      // Space on a focused button presses that button.
      if (e.key === " " && target?.closest("button, a")) return;
      const el = containerRef.current;
      if (isPdfBook && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        // Arrows still pan a zoomed page until it reaches its edge.
        const max = el ? el.scrollWidth - el.clientWidth : 0;
        if (e.key === "ArrowRight" && el && el.scrollLeft < max - 1) return;
        if (e.key === "ArrowLeft" && el && el.scrollLeft > 1) return;
        e.preventDefault();
        if (e.key === "ArrowRight") goToNextPage();
        else goToPrevPage();
      } else if (isPdfBook && el && (e.key === "PageDown" || e.key === "PageUp" || (e.key === " " && !readAlongActive))) {
        // Read on: down a screen, and over the page's edge to the next one.
        const back = e.key === "PageUp" || (e.key === " " && e.shiftKey);
        e.preventDefault();
        if (back) {
          if (el.scrollTop <= 2) goToPrevPage();
          else el.scrollBy({ top: -el.clientHeight * 0.9 });
        } else if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) goToNextPage();
        else el.scrollBy({ top: el.clientHeight * 0.9 });
      } else if ((e.key === "f" || e.key === "F") && !e.shiftKey) {
        e.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPdfBook, readAlongActive, goToNextPage, goToPrevPage, toggleFocus]);

  // ── A phone's controls: shown by a tap, out of the way while reading ────
  const readerLive = !!book && !loading && (isPdfBook ? !!fileUrl : isHtmlBook ? !!htmlContent : false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [chromePoke, setChromePoke] = useState(0);
  const firstHideTimer = useRef(0);
  const showChrome = useCallback(() => {
    window.clearTimeout(firstHideTimer.current);
    setChromeVisible(true);
    setChromePoke((n) => n + 1);
  }, []);
  const [tapHint, setTapHint] = useState(() => !readTapHintSeen());
  const dismissTapHint = () => {
    try { localStorage.setItem(TAP_HINT_KEY, "seen"); } catch { /* shown again next time */ }
    setTapHint(false);
    setChromeVisible(false);
  };
  // Opening a book shows the controls for a moment, then gets out of the way.
  useEffect(() => {
    if (!phone || !readerLive) return;
    setChromeVisible(true);
    firstHideTimer.current = window.setTimeout(() => {
      if (!document.querySelector("[role='menu'], [role='dialog']")) setChromeVisible(false);
    }, FIRST_CHROME_HIDE_MS);
    return () => window.clearTimeout(firstHideTimer.current);
  }, [phone, readerLive, activeBookId]);
  // While the voice is reading they hide again after each touch.
  useEffect(() => {
    if (!phone || readStatus !== "playing" || !chromeVisible) return;
    const t = window.setTimeout(() => {
      if (!document.querySelector("[role='menu'], [role='dialog']")) setChromeVisible(false);
    }, CHROME_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [phone, readStatus, chromeVisible, chromePoke]);

  /** The reader lies over the whole app (phones always, full screen anywhere). */
  const overlay = readerLive && (phone || focused);
  /** First time on a phone: the where-to-tap sheet has the screen to itself. */
  const hinting = phone && isPdfBook && tapHint;
  /** The app bar and the dock are out of the way. */
  const shellHidden = readerLive && (focused || (phone && (!chromeVisible || hinting)));
  useEffect(() => {
    if (!shellHidden) return;
    document.documentElement.classList.add("cc-reader-shell-hidden");
    return () => document.documentElement.classList.remove("cc-reader-shell-hidden");
  }, [shellHidden]);

  /** What the finger was doing when it came down, for the tap that follows. */
  const pressRef = useRef({ hadSelection: false });
  const onReadingSurfacePress = () => {
    const sel = (isHtmlBook ? iframeRef.current?.contentDocument : document)?.getSelection();
    pressRef.current.hadSelection = !!sel && !sel.isCollapsed;
  };
  const onReadingSurfaceTap = (tap?: { clientX: number; target: EventTarget | null }) => {
    if (!phone) return;
    const sel = (isHtmlBook ? iframeRef.current?.contentDocument : document)?.getSelection();
    if (sel && !sel.isCollapsed) return;
    // The tap that dismissed a selection or a text menu does only that.
    if (pressRef.current.hadSelection || performance.now() - menuClosedAtRef.current < 400) return;
    if (tap?.target instanceof Element && tap.target.closest("a, button")) return;
    // While listening, a tap may be a jump-to-word: always reveal, never hide.
    if (readAlongActive) { showChrome(); return; }
    if (chromeVisible) { setChromeVisible(false); return; }
    if (isPdfBook && tap) {
      const x = tap.clientX / window.innerWidth;
      if (x < TAP_ZONE && currentPage > 1) { goToPrevPage(); return; }
      if (x > 1 - TAP_ZONE && currentPage < numPages) { goToNextPage(); return; }
    }
    showChrome();
  };
  const tapRef = useRef({ press: onReadingSurfacePress, tap: onReadingSurfaceTap });
  tapRef.current = { press: onReadingSurfacePress, tap: onReadingSurfaceTap };

  // HTML books: taps land inside the iframe document.
  useEffect(() => {
    if (!phone || !isHtmlBook) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const onDown = () => tapRef.current.press();
    const onTap = (e: MouseEvent) => tapRef.current.tap({ clientX: window.innerWidth / 2, target: e.target });
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("click", onTap);
    return () => {
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("click", onTap);
    };
  }, [phone, isHtmlBook, textVersion]);

  const createChapter = async (name: string): Promise<boolean> => {
    const { from, to } = chapterRange;
    if (!book || from == null || to == null || from < 1 || to < from || to > numPages) return false;
    setIsSavingChapter(true);
    try {
      let textContent = "";
      const loadingTask = pdfjs.getDocument(fileUrl);
      const pdf = await loadingTask.promise;
      for (let i = from; i <= to; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item: any) => item.str).join(" ");
        textContent += pageText + "\n\n";
      }
      const chapter: Chapter = { id: crypto.randomUUID(), name, startPage: from, endPage: to, textContent };
      await addChapter(book.id, chapter);
      setChapterRange({ from: null, to: null });
      toast.success("Chapter saved");
      return true;
    } catch (err) {
      console.error("Failed to save chapter:", err);
      toast.error(err instanceof Error ? err.message : "Failed to save chapter. Please try again.");
      return false;
    } finally {
      setIsSavingChapter(false);
    }
  };

  const handleChapterSelect = (chapter: Chapter) => {
    setContentsOpen(false);
    setSelectedChapterId(chapter.id);
    if (isHtmlBook) {
      iframeRef.current?.contentWindow?.document.getElementById(`section-${chapter.startPage}`)?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    setCurrentPage(chapter.startPage);
  };

  const submitPageInput = () => {
    const n = Number(pageInput);
    if (Number.isInteger(n) && n >= 1 && n <= numPages) goToPage(n);
    else if (pageInput) toast.error(`Enter a page from 1 to ${numPages}.`);
    setPageInput("");
  };

  if (!book) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant animate-fade-in">
        <span className="material-symbols-outlined text-6xl mb-4 opacity-30">auto_stories</span>
        <p className="text-lg font-headline">No document selected</p>
        <p className="text-sm mt-1">Choose a book from your library to start reading</p>
      </div>
    );
  }

  if (!isPdfBook && !isHtmlBook) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant animate-fade-in">
        <span className="material-symbols-outlined text-6xl mb-4 opacity-30">description</span>
        <p className="text-lg font-headline">Preview unavailable</p>
        <p className="text-sm mt-1">Reader supports PDF and HTML files.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant animate-fade-in">
        <span className="material-symbols-outlined text-6xl mb-4 opacity-30 animate-pulse">auto_stories</span>
        <p className="text-lg font-headline">Loading document…</p>
      </div>
    );
  }

  if (isHtmlBook && !htmlContent) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant animate-fade-in">
        <span className="material-symbols-outlined text-6xl mb-4 opacity-30">article</span>
        <p className="text-lg font-headline">HTML file not found</p>
        <p className="text-sm mt-1">Please re-upload this file.</p>
      </div>
    );
  }

  if (!isHtmlBook && !fileUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant animate-fade-in">
        <span className="material-symbols-outlined text-6xl mb-4 opacity-30">auto_stories</span>
        <p className="text-lg font-headline">PDF file not found</p>
        <p className="text-sm mt-1">Please re-upload this book.</p>
      </div>
    );
  }

  const bookProgress = numPages ? (currentPage / numPages) * 100 : 0;
  const canPrev = currentPage > 1;
  const canNext = currentPage < numPages;
  // PDF: the chapter this page is in. HTML: the section last jumped to.
  const currentChapter = isHtmlBook
    ? book.chapters.find((c) => c.id === selectedChapterId)
    : [...book.chapters].reverse().find((c) => currentPage >= c.startPage && currentPage <= c.endPage);
  const compact = phone || (containerWidth > 0 && containerWidth < COMPACT_BAR_WIDTH);
  const barShown = !phone || (chromeVisible && !hinting);
  // With a mouse the narrow bar is a row in the window, not a floating card: a touch shorter.
  const slot = compact ? (phone ? slotCompact : `${slotCompact} !h-11`) : slotWide;
  const slotLabel = compact ? slotCompactLabel : slotWideLabel;
  const slotIcon = "material-symbols-outlined text-[22px] text-primary";
  const hasContents = !isHtmlBook || book.chapters.length > 0;

  const zoomControls = (
    <div className="flex items-center bg-surface-container-highest rounded-full">
      <button type="button" onClick={() => changeZoom(-0.2)} disabled={scale <= MIN_ZOOM} className={`grid place-items-center w-11 h-11 rounded-full text-secondary hover:text-primary disabled:opacity-30 ${focusRing}`} aria-label="Zoom out" title="Zoom out">
        <span className="material-symbols-outlined" aria-hidden>remove</span>
      </button>
      <button
        type="button"
        onClick={() => setZoom("fit")}
        className={`min-w-[3.5rem] h-11 px-1 rounded-full font-label text-sm font-bold ${focusRing} ${zoom === "fit" ? "text-primary" : "text-foreground"}`}
        title="Fit the page to the width"
        aria-label={zoom === "fit" ? "Fitted to width" : `Zoom ${Math.round(scale * 100)}%. Press to fit the page to the width.`}
      >
        {zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`}
      </button>
      <button type="button" onClick={() => changeZoom(0.2)} disabled={scale >= MAX_ZOOM} className={`grid place-items-center w-11 h-11 rounded-full text-secondary hover:text-primary disabled:opacity-30 ${focusRing}`} aria-label="Zoom in" title="Zoom in">
        <span className="material-symbols-outlined" aria-hidden>add</span>
      </button>
    </div>
  );

  // Typing and dragging inside a menu must not be read as its type-ahead.
  const keepKeys = (e: React.KeyboardEvent) => { if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation(); };

  /** Page: type a number, step, or drag through the book. */
  const pageMenu = (
    <DropdownMenu onOpenChange={(open) => { if (open) { setPageInput(""); setPageDraft(null); } showChrome(); }}>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button type="button" className={slot} disabled={!numPages} aria-label={`Page ${currentPage} of ${numPages}. Go to a page.`}>
            <span className="font-headline font-bold text-sm leading-[22px] text-primary tabular-nums whitespace-nowrap">{currentPage} / {numPages || "…"}</span>
            <span className={slotLabel}>Page</span>
          </button>
        ) : (
          <button type="button" className={`${slotWide} px-2`} disabled={!numPages} title="Go to a page" aria-label={`Page ${currentPage} of ${numPages}. Go to a page.`}>
            <span className="font-headline font-bold text-base text-primary italic tabular-nums whitespace-nowrap">Page {currentPage} of {numPages || "…"}</span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-72 p-3 space-y-3">
        <div className="flex items-center justify-between gap-1">
          <button type="button" onClick={goToPrevPage} disabled={!canPrev} className={iconBtn} aria-label="Previous page">
            <span className="material-symbols-outlined text-primary" aria-hidden>chevron_left</span>
          </button>
          <form onSubmit={(e) => { e.preventDefault(); submitPageInput(); }} className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={numPages}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={keepKeys}
              placeholder={String(currentPage)}
              aria-label={`Go to page (1–${numPages})`}
              className="w-16 h-11 rounded-lg bg-surface-container-highest text-center font-headline font-bold text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-sm text-on-surface-variant whitespace-nowrap">of {numPages}</span>
            <button type="submit" className={`h-11 px-3 rounded-lg bg-primary-container text-on-primary-container font-label text-sm font-bold ${focusRing}`}>Go</button>
          </form>
          <button type="button" onClick={goToNextPage} disabled={!canNext} className={iconBtn} aria-label="Next page">
            <span className="material-symbols-outlined text-primary" aria-hidden>chevron_right</span>
          </button>
        </div>
        {numPages > 1 && (
          <div onKeyDown={keepKeys} className="px-1 py-2">
            <Slider
              min={1}
              max={numPages}
              step={1}
              value={[pageDraft ?? currentPage]}
              onValueChange={([v]) => setPageDraft(v)}
              onValueCommit={([v]) => { goToPage(v); setPageDraft(null); }}
              aria-label="Move through the book"
            />
          </div>
        )}
        <p className="text-xs text-center text-muted-foreground truncate">
          {pageDraft != null ? `Release to open page ${pageDraft}` : currentChapter ? currentChapter.name : "Drag to move through the book"}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const moreMenu = (
    <DropdownMenu onOpenChange={() => showChrome()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={slot} aria-label="More reading options">
          <span className={slotIcon} aria-hidden>more_horiz</span>
          <span className={slotLabel}>More</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={() => toggleFocus()}>
          <span className="material-symbols-outlined text-lg mr-2" aria-hidden>{focused ? "close_fullscreen" : "fullscreen"}</span>
          <span className="flex-1">{focused ? "Leave full screen" : "Full screen"}</span>
          {!phone && <span className="text-xs text-muted-foreground">F</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!isHtmlBook && (
          <DropdownMenuCheckboxItem checked={swipeEnabled} onCheckedChange={(v) => setSwipeEnabled(!!v)}>
            Swipe to turn pages
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuCheckboxItem checked={autoHighlight} onCheckedChange={(v) => setAutoHighlight(!!v)}>
          Highlight as soon as I select text
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-xs text-muted-foreground leading-relaxed">
          Select text to highlight it, ask about it, save it as a card or copy it. Chat can see your highlights.
          {highlights.total > 0 && (
            <><br />{isHtmlBook ? `${highlights.total} highlights in this book` : `${highlights.pageCount} on this page · ${highlights.total} in this book`}</>
          )}
          {!isHtmlBook && (
            phone
              ? <><br />Tap the sides of the page to turn it, the middle for these controls. Pinch to zoom.</>
              : <><br />Keys: ← → turn pages · Space reads on · F full screen</>
          )}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const contentsButton = hasContents && (
    <button type="button" className={slot} onClick={() => { setContentsOpen(true); showChrome(); }} aria-label="Contents: chapters">
      <span className={slotIcon} aria-hidden>toc</span>
      <span className={slotLabel}>Contents</span>
    </button>
  );

  const listenSlot = (
    <ReadAlong
      mode={isHtmlBook ? "html" : "pdf"}
      bookId={book.id}
      bookTitle={book.title}
      pageHostRef={pageHostRef}
      scrollRef={containerRef}
      iframeRef={iframeRef}
      htmlHostRef={htmlHostRef}
      textVersion={textVersion}
      page={currentPage}
      hasNextPage={!isHtmlBook && canNext}
      onNextPage={goToNextPage}
      onStatusChange={setReadStatus}
      playerHost={playerHost}
      compact={compact}
      barAtBottom={phone}
      slotClass={slot}
      slotLabelClass={slotLabel}
      onInteract={showChrome}
    />
  );

  const viewSlot = !isHtmlBook && (
    compact || containerWidth < 768 ? (
      <DropdownMenu onOpenChange={() => showChrome()}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={slot} aria-label={`View: zoom ${zoom === "fit" ? "fitted to width" : `${Math.round(scale * 100)}%`}`}>
            <span className={slotIcon} aria-hidden>zoom_in</span>
            <span className={slotLabel}>View</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="p-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground text-center">Zoom</p>
          {zoomControls}
          {phone && <p className="text-xs text-muted-foreground text-center">Or pinch the page</p>}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : zoomControls
  );

  // The bar. While listening its one row is the player's (ReadAlong portals
  // into `playerHost`); the Listen button stays mounted, hidden, under it.
  const bar = (
    <>
      <div ref={setPlayerHost} className={readAlongActive ? "w-full" : "hidden"} />
      {compact ? (
        <div className={readAlongActive ? "hidden" : "flex items-center justify-around w-full"}>
          {contentsButton}
          {listenSlot}
          {!isHtmlBook && (
            <div className="flex items-center">
              {!phone && (
                <button type="button" onClick={goToPrevPage} disabled={!canPrev} className={`${iconBtn} w-9`} aria-label="Previous page" title="Previous page (←)">
                  <span className="material-symbols-outlined text-primary" aria-hidden>chevron_left</span>
                </button>
              )}
              {pageMenu}
              {!phone && (
                <button type="button" onClick={goToNextPage} disabled={!canNext} className={`${iconBtn} w-9`} aria-label="Next page" title="Next page (→)">
                  <span className="material-symbols-outlined text-primary" aria-hidden>chevron_right</span>
                </button>
              )}
            </div>
          )}
          {viewSlot}
          {moreMenu}
        </div>
      ) : (
        <div className={readAlongActive ? "hidden" : "flex items-center w-full gap-1"}>
          <div className="flex-1 basis-0 min-w-0 flex items-center gap-2">
            {contentsButton}
            <div className="min-w-0 max-md:hidden">
              <p className="truncate font-headline font-bold text-sm text-foreground leading-tight">{book.title}</p>
              {currentChapter && <p className="truncate text-[11px] text-on-surface-variant leading-tight">{currentChapter.name}</p>}
            </div>
          </div>
          {!isHtmlBook && (
            <div className="flex items-center shrink-0">
              <button type="button" onClick={goToPrevPage} disabled={!canPrev} className={`${iconBtn} [@media(max-height:640px)]:h-10`} aria-label="Previous page" title="Previous page (←)">
                <span className="material-symbols-outlined text-primary" aria-hidden>arrow_back</span>
              </button>
              {pageMenu}
              <button type="button" onClick={goToNextPage} disabled={!canNext} className={`${iconBtn} [@media(max-height:640px)]:h-10`} aria-label="Next page" title="Next page (→)">
                <span className="material-symbols-outlined text-primary" aria-hidden>arrow_forward</span>
              </button>
            </div>
          )}
          <div className="flex-1 basis-0 min-w-0 flex items-center justify-end gap-1">
            {listenSlot}
            {viewSlot}
            {moreMenu}
            {focused && (
              <button type="button" className={slotWide} onClick={exitFocus} title="Leave full screen (Esc)">
                <span className={slotIcon} aria-hidden>close_fullscreen</span>
                <span className={slotWideLabel}>Exit</span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );

  const selectionActions: ReaderAction[] = selectionMenu ? [
    ...(!autoHighlight ? [{
      icon: "ink_highlighter", label: "Highlight",
      onClick: () => { void highlights.commitSelection().then(clearSelection); },
    }] : []),
    { icon: "forum", label: "Ask", onClick: () => { const t = selectionMenu.text; clearSelection(); askInChat(t, isHtmlBook ? null : currentPage); } },
    {
      icon: "bookmark_add", label: "Save card",
      onClick: () => { setCardSource({ quote: selectionMenu.text, page: currentPage, chapterId: null }); },
    },
    {
      icon: "content_copy", label: "Copy",
      onClick: () => {
        const t = selectionMenu.text;
        navigator.clipboard?.writeText(t).then(() => toast("Copied"), () => toast.error("Couldn't copy."));
        clearSelection();
      },
    },
  ] : [];

  const highlightActions: ReaderAction[] = highlightHit ? [
    { icon: "forum", label: "Ask", onClick: () => askInChat(highlightHit.highlight.quote, highlightHit.highlight.page ?? null) },
    {
      icon: "bookmark_add", label: "Save card",
      onClick: () => {
        const h = highlightHit.highlight;
        setCardSource({ quote: h.quote, page: h.page ?? currentPage, chapterId: h.chapter_id });
        setHighlightHit(null);
      },
    },
    {
      icon: "content_copy", label: "Copy",
      onClick: () => {
        navigator.clipboard?.writeText(highlightHit.highlight.quote).then(() => toast("Copied"), () => toast.error("Couldn't copy."));
        closeHighlightMenu();
      },
    },
    {
      icon: "ink_eraser", label: "Remove", destructive: true,
      onClick: () => { void highlights.remove(highlightHit.highlight); closeHighlightMenu(); },
    },
  ] : [];

  return (
    <div
      ref={setRootEl}
      className={overlay ? "fixed inset-0 z-40 flex flex-col bg-background" : "relative flex flex-col h-full animate-fade-in"}
      style={overlay ? { height: "100dvh" } : undefined}
      data-reader-focus={focused || undefined}
    >
      {/* The bar with a mouse: one row above the page. */}
      {!phone && (
        <div
          data-reader-bar
          className="relative z-[3] flex items-center px-2 sm:px-4 h-12 shrink-0 bg-surface-container-low border-b border-outline-variant/10"
        >
          {bar}
          {!isHtmlBook && !readAlongActive && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-container-highest" aria-hidden>
              <div className="h-full bg-primary/70 transition-[width] duration-300" style={{ width: `${bookProgress}%` }} />
            </div>
          )}
        </div>
      )}

      {/* A phone: a hairline of progress that never leaves, and the bar under the thumb. */}
      {phone && !isHtmlBook && (
        <div className="absolute inset-x-0 top-0 h-0.5 z-[2]" style={{ marginTop: "env(safe-area-inset-top)" }} aria-hidden>
          <div className="h-full bg-primary/60 transition-[width] duration-300" style={{ width: `${bookProgress}%` }} />
        </div>
      )}
      {phone && (
        <div
          data-reader-bar
          className={`absolute inset-x-0 z-[3] px-2 transition-all duration-200 ${barShown ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[150%] pointer-events-none"}`}
          style={{ bottom: "calc(var(--cc-dock-h) + env(safe-area-inset-bottom) + 0.5rem)" }}
          aria-hidden={!barShown}
          onPointerDown={showChrome}
        >
          <div className="mx-auto max-w-xl rounded-2xl bg-surface-container-high/95 backdrop-blur-xl shadow-xl border border-outline-variant/20 px-1.5 py-1.5">
            {bar}
          </div>
        </div>
      )}

      {/* YouTube transcripts say so above the text (Contents carries it when the reader has the whole screen) */}
      {!overlay && <YoutubeTranscriptBadge book={book} variant="banner" />}

      {/* Document content */}
      {isHtmlBook ? (
        <div ref={htmlHostRef} className="relative flex-1 flex min-h-0">
          <iframe
            ref={iframeRef}
            srcDoc={htmlContent}
            sandbox="allow-same-origin"
            className="flex-1 w-full border-0 bg-background"
            title={book.title}
            onLoad={bumpTextVersion}
          />
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 flex">
          <div
            ref={setContainer}
            className={`flex-1 flex overflow-auto overscroll-contain bg-background scrollbar-thin ${phone ? "py-2" : "py-4 sm:py-6"}`}
            style={{
              // Pinch belongs to the page (usePinchZoom), not the browser.
              touchAction: "pan-x pan-y",
              ...(phone ? { paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)", paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" } : null),
            }}
            onPointerDownCapture={onReadingSurfacePress}
            onClick={(e) => onReadingSurfaceTap({ clientX: e.clientX, target: e.target })}
          >
            {/* `m-auto` centres the page when it is smaller than the window and
                falls back to the start when it overflows (a zoomed page). */}
            <div className="m-auto flex flex-col">
              <Document
                file={fileUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                loading={<div className="flex items-center justify-center py-20"><div className="animate-pulse text-on-surface-variant text-sm">Loading document…</div></div>}
                error={<div className="text-destructive text-sm text-center py-20">Failed to load the document.</div>}
              >
                <div ref={pageHostRef} className="relative shadow-lg" style={{ minHeight: pageMinHeight || undefined }}>
                  {scale > 0 && (
                    <Page
                      pageNumber={currentPage}
                      scale={scale}
                      devicePixelRatio={renderPixelRatio()}
                      renderTextLayer={true}
                      renderAnnotationLayer={true}
                      loading={null}
                      onLoadSuccess={(p) => setPageWidth(p.getViewport({ scale: 1 }).width)}
                      onRenderSuccess={() => setPageMinHeight(pageHostRef.current?.firstElementChild?.clientHeight ?? 0)}
                      onRenderTextLayerSuccess={bumpTextVersion}
                    />
                  )}
                </div>
              </Document>

              {/* With a mouse the way on is where the reading ends: at the foot
                  of the page, not back up in the bar. */}
              {!phone && numPages > 0 && (
                <div
                  className="sticky self-start flex items-center justify-between gap-2 pt-4"
                  style={{ left: gutter, width: Math.max(0, containerWidth - gutter * 2) }}
                >
                  <button type="button" onClick={goToPrevPage} disabled={!canPrev} className={`${slotWide} disabled:invisible`}>
                    <span className={slotIcon} aria-hidden>arrow_back</span>
                    <span className={slotWideLabel}>Previous page</span>
                  </button>
                  <span className="text-xs text-on-surface-variant">{canNext ? `Page ${currentPage} of ${numPages}` : "End of the book"}</span>
                  <button type="button" onClick={goToNextPage} disabled={!canNext} className={`${slotWide} bg-surface-container-high disabled:invisible`}>
                    <span className={slotWideLabel}>Next page</span>
                    <span className={slotIcon} aria-hidden>arrow_forward</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Swipe feedback: fills as the drag nears a page turn */}
          {swipeHint && (swipeHint.dir === "next" ? canNext : canPrev) && (
            <div
              className={`pointer-events-none absolute top-1/2 -translate-y-1/2 z-10 ${swipeHint.dir === "next" ? "right-3" : "left-3"}`}
              style={{ opacity: 0.35 + swipeHint.progress * 0.65 }}
              aria-hidden
            >
              <div
                className={`grid place-items-center w-12 h-12 rounded-full shadow-xl transition-colors ${swipeHint.progress >= 1 ? "bg-primary text-primary-foreground" : "bg-surface-container-high text-primary"}`}
                style={{ transform: `scale(${0.75 + swipeHint.progress * 0.25})` }}
              >
                <span className="material-symbols-outlined">{swipeHint.dir === "next" ? "chevron_right" : "chevron_left"}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* First time on a phone: where to tap. Shown once. */}
      {hinting && (
        <div
          role="dialog"
          aria-label="How to turn pages"
          className="absolute inset-0 z-[5] flex flex-col bg-background/90 backdrop-blur-sm text-foreground"
          onClick={dismissTapHint}
        >
          <div className="flex-1 grid grid-cols-[3fr_4fr_3fr] divide-x divide-dashed divide-outline-variant/60">
            {[
              { icon: "arrow_back", text: "Tap here to go back a page" },
              { icon: "touch_app", text: "Tap the middle to show or hide the controls" },
              { icon: "arrow_forward", text: "Tap here for the next page" },
            ].map((z) => (
              <div key={z.icon} className="flex flex-col items-center justify-center gap-3 px-2 text-center">
                <span className="material-symbols-outlined text-4xl text-primary" aria-hidden>{z.icon}</span>
                <p className="font-label text-sm font-semibold leading-snug">{z.text}</p>
              </div>
            ))}
          </div>
          <div className="p-4 text-center" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}>
            <button type="button" className={`h-12 px-8 rounded-full bg-primary-container text-on-primary-container font-label font-bold ${focusRing}`}>
              Got it
            </button>
          </div>
        </div>
      )}

      {/* One menu for marked text: a live selection, or a saved highlight. */}
      {selectionMenu && !highlightHit && (
        <HighlightActions rect={selectionMenu.rect} actions={selectionActions} label="Selected text" onClose={clearSelection} forSelection />
      )}
      {highlightHit && (
        <HighlightActions rect={highlightHit.rect} actions={highlightActions} label="Highlight" onClose={closeHighlightMenu} />
      )}

      <ReaderContents
        open={contentsOpen}
        onOpenChange={setContentsOpen}
        book={book}
        isHtml={isHtmlBook}
        side={phone ? "bottom" : "left"}
        currentPage={currentPage}
        numPages={numPages}
        currentChapterId={currentChapter?.id ?? null}
        onSelect={handleChapterSelect}
        onRename={(chapterId, name) => updateChapter(book.id, chapterId, name)}
        onDelete={(chapterId) => removeChapter(book.id, chapterId)}
        range={chapterRange}
        onRangeChange={setChapterRange}
        onCreate={createChapter}
        saving={isSavingChapter}
      />
      <CaptureQuoteDialog
        open={captureOpen}
        onClose={() => { setCardSource(null); clearSelection(); }}
        book={book}
        page={cardSource?.page ?? currentPage}
        selectionText={cardSource?.quote ?? ""}
        chapterId={cardSource?.chapterId ?? null}
      />
    </div>
  );
};

export default PdfViewer;
