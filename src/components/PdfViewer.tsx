import React, { useState, useCallback, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { useApp } from "@/context/AppContext";
import { Chapter } from "@/types/library";
import ChapterNameDialog from "@/components/ChapterNameDialog";
import ChapterManageDialog from "@/components/ChapterManageDialog";
import CaptureQuoteDialog from "@/components/CaptureQuoteDialog";
import HighlightActions from "@/components/HighlightActions";
import { toast } from "sonner";
import ReadAlong from "@/components/ReadAlong";
import YoutubeTranscriptBadge from "@/components/YoutubeTranscriptBadge";
import { isYoutubeTranscript } from "@/lib/bookProvenance";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ReadAlongStatus } from "@/lib/readAlongPlayer";
import type { SwipeDirection } from "@/lib/readerGestures";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePageSwipe } from "@/hooks/usePageSwipe";
import { useReaderFocus } from "@/hooks/useReaderFocus";
import { loadLastPage, saveLastPage, useReaderPrefs } from "@/hooks/useReaderPrefs";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useReaderHighlights, type HighlightHit } from "@/hooks/useReaderHighlights";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
/** "Fit" on a wide desktop would blow a page up to poster size. */
const MAX_FIT_ZOOM = 1.5;
/** Focus mode hides its controls this long after the last touch while reading. */
const FOCUS_CHROME_HIDE_MS = 3000;
// 3x phone screens cost ~2.25x the canvas memory of 2x for no visible gain.
const renderPixelRatio = () => Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

const iconBtn =
  "grid place-items-center w-11 h-11 rounded-full transition-colors hover:bg-surface-container-high active:scale-95 disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

const PdfViewer: React.FC = () => {
  const { getActiveBook, addChapter, updateChapter, removeChapter, updateBookTitle, activeBookId, loadBookFile, loadChapterTextStrict, setActiveTab } = useApp();
  const book = getActiveBook();
  const isPdfBook = book?.fileName.toLowerCase().endsWith(".pdf") ?? false;
  const isHtmlBook = book?.fileName.toLowerCase().endsWith(".html") ?? false;

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const { zoom, setZoom, swipeEnabled, setSwipeEnabled, autoHighlight, setAutoHighlight } = useReaderPrefs();
  /** Width of the current page at scale 1, for fit-to-width. */
  const [pageWidth, setPageWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [chapterStart, setChapterStart] = useState<number | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [namingDialog, setNamingDialog] = useState<{ open: boolean; endPage: number; defaultName: string }>({
    open: false, endPage: 0, defaultName: "",
  });
  const [fileUrl, setFileUrl] = useState<string>("");
  const [htmlContent, setHtmlContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [manageChaptersOpen, setManageChaptersOpen] = useState(false);
  const [readStatus, setReadStatus] = useState<ReadAlongStatus>("idle");
  const readAlongActive = readStatus !== "idle";
  // Bumps when the page's text layer (PDF) or the iframe document (HTML)
  // renders, so read-along can re-map words onto fresh DOM.
  const [textVersion, setTextVersion] = useState(0);
  const bumpTextVersion = useCallback(() => setTextVersion((v) => v + 1), []);
  const [isSavingChapter, setIsSavingChapter] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setContainer = useCallback((node: HTMLDivElement | null) => {
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    setScrollEl(node);
  }, []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageHostRef = useRef<HTMLDivElement>(null);
  const htmlHostRef = useRef<HTMLDivElement>(null);
  /** Last rendered page height: holds the layout steady while the next page renders. */
  const [pageMinHeight, setPageMinHeight] = useState(0);
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [swipeHint, setSwipeHint] = useState<{ dir: SwipeDirection; progress: number } | null>(null);

  const { focused, enter: enterFocus, exit: exitFocus, toggle: toggleFocus } = useReaderFocus();
  useWakeLock(focused || readStatus === "playing");

  // ── Quote capture (Card Catalog Stage 2 — PDF text layer only) ──────────
  // A selection in the page container surfaces a "Save quote" affordance;
  // the dialog anchors it into the chapter's extracted text as a verified
  // locator (or says honestly that it couldn't). HTML books render in a
  // sandboxed iframe with no pdf.js text layer — scoped out (design §6).
  const [selectionCapture, setSelectionCapture] = useState<string>("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const readSelection = useCallback(() => {
    if (captureOpen) return;
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    // 12+ chars: below that, anchoring is ambiguous noise (QUOTE_MIN is 8;
    // a little headroom keeps accidental drags from flashing the affordance).
    setSelectionCapture(text.length >= 12 && containerRef.current?.contains(sel?.anchorNode ?? null) ? text : "");
  }, [captureOpen]);

  // ── Highlights: saved marks with their own glow, made from selections ───
  const [highlightHit, setHighlightHit] = useState<HighlightHit | null>(null);
  /** "Save as card" from a highlight: the dialog anchors that quote instead of the live selection. */
  const [cardSource, setCardSource] = useState<{ quote: string; page: number; chapterId: string | null } | null>(null);
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
  const closeHighlightMenu = useCallback(() => setHighlightHit(null), []);
  const askAboutHighlight = () => {
    if (!highlightHit || !book) return;
    const h = highlightHit.highlight;
    const quote = h.quote.length > 1200 ? `${h.quote.slice(0, 1200)}…` : h.quote;
    const source = `— highlighted in “${book.title || "Untitled"}”${h.page ? `, p. ${h.page}` : ""}`;
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

  // Reset on book change, reopening where this book was left.
  useEffect(() => {
    setCurrentPage(activeBookId ? loadLastPage(activeBookId) : 1);
    setNumPages(0);
    setPageWidth(0);
    setPageMinHeight(0);
    setChapterStart(null);
    setSelectedChapterId(null);
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

  // Track the reading column's width for fit-to-width.
  useEffect(() => {
    if (!scrollEl) return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(Math.round(entry.contentRect.width)));
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  const onDocumentLoadSuccess = useCallback((pdf: PDFDocumentProxy) => {
    setNumPages(pdf.numPages);
    setCurrentPage((p) => Math.min(Math.max(1, p), pdf.numPages));
    // Measure a page up front so the first render is already fitted.
    pdf.getPage(1).then((p) => setPageWidth((w) => w || p.getViewport({ scale: 1 }).width)).catch(() => {});
  }, []);

  const gutter = containerWidth < 640 ? 8 : 32;
  const fitScale = pageWidth > 0 && containerWidth > 0
    ? Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, (containerWidth - gutter * 2) / pageWidth))
    : 0;
  const scale = zoom === "fit" ? fitScale : zoom;

  const goToPage = useCallback((page: number) => {
    setCurrentPage((p) => (page >= 1 && page <= numPages ? page : p));
  }, [numPages]);
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

  // ── Keyboard: ←/→ turn pages, F toggles focus mode ──────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      const el = containerRef.current;
      if (isPdfBook && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        // Arrows still pan a zoomed page until it reaches its edge.
        const max = el ? el.scrollWidth - el.clientWidth : 0;
        if (e.key === "ArrowRight" && el && el.scrollLeft < max - 1) return;
        if (e.key === "ArrowLeft" && el && el.scrollLeft > 1) return;
        e.preventDefault();
        if (e.key === "ArrowRight") goToNextPage();
        else goToPrevPage();
      } else if ((e.key === "f" || e.key === "F") && !e.shiftKey) {
        e.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPdfBook, goToNextPage, goToPrevPage, toggleFocus]);

  // ── Focus mode controls: tap to show/hide, auto-hide while reading ──────
  const [chromeVisible, setChromeVisible] = useState(true);
  const [chromePoke, setChromePoke] = useState(0);
  const showChrome = useCallback(() => {
    setChromeVisible(true);
    setChromePoke((n) => n + 1);
  }, []);
  useEffect(() => {
    if (focused) showChrome();
  }, [focused, showChrome]);
  useEffect(() => {
    if (!focused || readStatus !== "playing" || !chromeVisible) return;
    const t = window.setTimeout(() => setChromeVisible(false), FOCUS_CHROME_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [focused, readStatus, chromeVisible, chromePoke]);

  const onReadingSurfaceClick = () => {
    if (!focused) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    // While reading, a tap may be a jump-to-word: always reveal, never hide.
    if (chromeVisible && !readAlongActive) setChromeVisible(false);
    else showChrome();
  };

  const onReadingSurfaceClickRef = useRef(onReadingSurfaceClick);
  onReadingSurfaceClickRef.current = onReadingSurfaceClick;

  // HTML books: taps land inside the iframe document.
  useEffect(() => {
    if (!focused || !isHtmlBook) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const onTap = () => onReadingSurfaceClickRef.current();
    doc.addEventListener("click", onTap);
    return () => doc.removeEventListener("click", onTap);
  }, [focused, isHtmlBook, textVersion]);

  const markChapterStart = () => setChapterStart(currentPage);
  const markChapterEnd = () => {
    if (chapterStart === null || !book) return;
    const endPage = currentPage;
    if (endPage < chapterStart) {
      toast.error(`Go to page ${chapterStart} or later to end the chapter.`);
      return;
    }
    const defaultName = `Chapter ${book.chapters.length + 1} (pp. ${chapterStart}–${endPage})`;
    setNamingDialog({ open: true, endPage, defaultName });
  };

  const handleChapterConfirm = async (name: string) => {
    if (chapterStart === null || !book) return;
    const endPage = namingDialog.endPage;
    setIsSavingChapter(true);
    try {
      let textContent = "";
      const loadingTask = pdfjs.getDocument(fileUrl);
      const pdf = await loadingTask.promise;
      for (let i = chapterStart; i <= endPage; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item: any) => item.str).join(" ");
        textContent += pageText + "\n\n";
      }
      const chapter: Chapter = { id: crypto.randomUUID(), name, startPage: chapterStart, endPage, textContent };
      await addChapter(book.id, chapter);
      setNamingDialog({ open: false, endPage: 0, defaultName: "" });
      setChapterStart(null);
      toast.success("Chapter saved");
    } catch (err) {
      console.error("Failed to save isolated chapter:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to save chapter. Please try again.";
      toast.error(errorMessage);
    } finally {
      setIsSavingChapter(false);
    }
  };

  const handleChapterSelect = (chapterId: string) => {
    if (!book) return;
    const chapter = book.chapters.find((c) => c.id === chapterId);
    if (!chapter) return;
    setSelectedChapterId(chapterId);
    if (isHtmlBook) {
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        const el = iframe.contentWindow.document.getElementById(`section-${chapter.startPage}`);
        el?.scrollIntoView({ behavior: "smooth" });
      }
      return;
    }
    setCurrentPage(chapter.startPage);
  };

  const submitPageInput = () => {
    const n = Number(pageInput);
    if (Number.isInteger(n) && n >= 1 && n <= numPages) goToPage(n);
    else if (pageInput) toast.error(`Enter a page from 1 to ${numPages}.`);
    setPageInput(null);
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
  const selectedChapter = selectedChapterId ? book.chapters.find((c) => c.id === selectedChapterId) : undefined;
  const chromeShown = !focused || chromeVisible || readStatus !== "playing";

  const pageIndicator = (compact: boolean) =>
    pageInput !== null ? (
      <form
        onSubmit={(e) => { e.preventDefault(); submitPageInput(); }}
        className="flex items-center gap-1.5"
      >
        <input
          autoFocus
          type="number"
          inputMode="numeric"
          min={1}
          max={numPages}
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onBlur={submitPageInput}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setPageInput(null); } }}
          aria-label={`Go to page (1–${numPages})`}
          className="w-16 h-9 rounded-lg bg-surface-container-highest text-center font-headline font-bold text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-sm text-on-surface-variant">of {numPages}</span>
      </form>
    ) : (
      <button
        type="button"
        onClick={() => setPageInput(String(currentPage))}
        disabled={!numPages}
        className="flex flex-col items-center px-3 py-1 rounded-lg hover:bg-surface-container-high transition-colors"
        aria-label={`Page ${currentPage} of ${numPages}. Tap to jump to a page.`}
        title="Jump to page"
      >
        {!compact && (
          <span className="font-label text-[10px] uppercase tracking-[0.2em] text-on-surface-variant">Tap to jump</span>
        )}
        <span className={`font-headline font-bold text-primary italic ${compact ? "text-sm" : "text-lg"}`}>
          Page {currentPage} of {numPages || "…"}
        </span>
      </button>
    );

  return (
    <div
      className={focused ? "fixed inset-0 z-[60] flex flex-col bg-background" : "flex flex-col h-full animate-fade-in"}
      style={focused ? { height: "100dvh" } : undefined}
      data-reader-focus={focused || undefined}
    >
      {/* Pagination toolbar — PDF only */}
      {!isHtmlBook && !focused && (
        <div className="relative flex items-center justify-between px-2 sm:px-4 h-14 bg-surface-container-low">
          <button type="button" onClick={goToPrevPage} disabled={!canPrev} className={iconBtn} aria-label="Previous page">
            <span className="material-symbols-outlined text-primary">arrow_back</span>
          </button>
          {pageIndicator(false)}
          <button type="button" onClick={goToNextPage} disabled={!canNext} className={iconBtn} aria-label="Next page">
            <span className="material-symbols-outlined text-primary">arrow_forward</span>
          </button>
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-container-highest" aria-hidden>
            <div className="h-full bg-primary/70 transition-[width] duration-300" style={{ width: `${bookProgress}%` }} />
          </div>
        </div>
      )}

      {/* Secondary Toolbar — stays mounted in focus mode (it hosts Read Along) */}
      <div className={`${focused ? "hidden" : "flex"} items-center justify-start px-4 sm:px-6 py-2.5 bg-surface-container-high overflow-x-auto hide-scrollbar gap-3 border-t border-outline-variant/10 max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-sm:pr-10`}>
        {/* Read Along — word-highlighted read-aloud with XP/streaks */}
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
          focusMode={focused}
          controlsVisible={chromeShown}
          onToggleFocus={toggleFocus}
          onInteract={showChrome}
        />

        <button
          type="button"
          onClick={enterFocus}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg shrink-0 bg-surface-container-highest text-foreground hover:text-primary active:scale-95 transition-all"
          title="Focus mode: just the page (F)"
        >
          <span className="material-symbols-outlined text-xl text-primary" aria-hidden>fullscreen</span>
          <span className="font-label text-sm font-semibold">Focus</span>
        </button>

        {/* Zoom (PDF only) + reading options */}
        <div className="flex items-center shrink-0 gap-1">
          {!isHtmlBook && (
            <div className="flex items-center bg-surface-container-highest rounded-full">
              <button type="button" onClick={() => changeZoom(-0.2)} disabled={scale <= MIN_ZOOM} className="grid place-items-center w-10 h-10 rounded-full text-secondary hover:text-primary disabled:opacity-30" aria-label="Zoom out">
                <span className="material-symbols-outlined">remove</span>
              </button>
              <button
                type="button"
                onClick={() => setZoom("fit")}
                className={`min-w-[3.5rem] h-10 px-1 font-label text-sm font-bold ${zoom === "fit" ? "text-primary" : "text-foreground"}`}
                title="Fit page to width"
                aria-label={zoom === "fit" ? "Fitted to width" : `Zoom ${Math.round(scale * 100)}% — fit to width`}
              >
                {zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`}
              </button>
              <button type="button" onClick={() => changeZoom(0.2)} disabled={scale >= MAX_ZOOM} className="grid place-items-center w-10 h-10 rounded-full text-secondary hover:text-primary disabled:opacity-30" aria-label="Zoom in">
                <span className="material-symbols-outlined">add</span>
              </button>
            </div>
          )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="grid place-items-center w-10 h-10 rounded-full text-on-surface-variant hover:text-primary hover:bg-surface-container-highest" aria-label="Reading options">
                  <span className="material-symbols-outlined">tune</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Reading options</DropdownMenuLabel>
                {!isHtmlBook && (
                  <DropdownMenuCheckboxItem checked={swipeEnabled} onCheckedChange={(v) => setSwipeEnabled(!!v)}>
                    Swipe to turn pages
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuCheckboxItem checked={autoHighlight} onCheckedChange={(v) => setAutoHighlight(!!v)}>
                  Highlight when I select text
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-xs text-muted-foreground leading-relaxed">
                  Highlights glow gold on the page and chat can see them: ask about “my highlights”, or they come up when you ask about something you marked. Tap one to ask about it, save it as a card, or remove it.
                  {highlights.total > 0 && (
                    <><br />{isHtmlBook ? `${highlights.total} in this book` : `${highlights.pageCount} on this page · ${highlights.total} in this book`}</>
                  )}
                </div>
                {!isHtmlBook && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1.5 text-xs text-muted-foreground leading-relaxed">
                      Swipe firmly across the page to turn it; scrolling, zoomed panning and selecting text never turn pages.
                      <br />Keyboard: ← → turn pages · F focus mode
                    </div>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
        </div>

        {/* Chapter Isolation — PDF only */}
        {!isHtmlBook && (
          <div className="flex items-center gap-2 shrink-0">
            {chapterStart === null ? (
              <button
                onClick={markChapterStart}
                disabled={isSavingChapter}
                className="flex items-center gap-2 px-4 py-2 bg-primary-container text-on-primary-container rounded-lg shadow-sm font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
                title="Mark this page as the start of a chapter"
              >
                <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>bolt</span>
                <span>Chapter Isolation</span>
              </button>
            ) : (
              <>
                <span className="text-xs text-accent font-bold px-2">Started p.{chapterStart}</span>
                <button
                  onClick={markChapterEnd}
                  disabled={isSavingChapter}
                  className="flex items-center gap-2 px-4 py-2 bg-accent text-on-primary-container rounded-lg font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
                >
                  <span className="material-symbols-outlined">flag</span>
                  End on p.{currentPage}
                </button>
                <button
                  onClick={() => setChapterStart(null)}
                  disabled={isSavingChapter}
                  className="text-xs text-on-surface-variant hover:text-foreground disabled:opacity-50 px-2 py-2"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}

        {/* Chapter select */}
        {book.chapters.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant text-sm" aria-hidden>bookmark</span>
            <select
              value={selectedChapterId || ""}
              onChange={(e) => handleChapterSelect(e.target.value)}
              aria-label={isHtmlBook ? "Jump to section" : "Jump to chapter"}
              className="text-xs font-body bg-surface-container-highest border-none rounded-lg px-3 h-10 text-foreground focus:ring-1 focus:ring-primary/40"
            >
              <option value="">{isHtmlBook ? "Jump to section…" : "Jump to chapter…"}</option>
              {book.chapters.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
            <button
              onClick={() => setManageChaptersOpen(true)}
              className="grid place-items-center w-10 h-10 rounded-lg hover:bg-surface-container-highest transition-colors"
              aria-label="Manage chapters"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-sm">settings</span>
            </button>
          </div>
        )}
      </div>

      {/* Focus mode: top bar (auto-hides while reading) and an always-on hairline progress */}
      {focused && (
        <>
          {!isHtmlBook && (
            <div className="absolute inset-x-0 top-0 h-0.5 z-[2] bg-transparent" style={{ marginTop: "env(safe-area-inset-top)" }} aria-hidden>
              <div className="h-full bg-primary/60 transition-[width] duration-300" style={{ width: `${bookProgress}%` }} />
            </div>
          )}
          <div
            className={`absolute inset-x-0 top-0 z-[3] transition-all duration-300 ${chromeShown ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-full pointer-events-none"}`}
            style={{ paddingTop: "env(safe-area-inset-top)" }}
            aria-hidden={!chromeShown}
          >
            <div className="mx-2 mt-2 flex items-center gap-1 rounded-2xl bg-surface-container-high/90 backdrop-blur-xl shadow-xl border border-outline-variant/20 px-1 py-1">
              <button type="button" onClick={exitFocus} className={iconBtn} aria-label="Exit focus mode" title="Exit focus mode (Esc)">
                <span className="material-symbols-outlined text-primary">close_fullscreen</span>
              </button>
              <div className="flex-1 min-w-0 px-1">
                <p className="truncate font-headline font-bold text-sm text-foreground">{book.title}</p>
                {isYoutubeTranscript(book) ? (
                  <YoutubeTranscriptBadge book={book} />
                ) : (
                  selectedChapter && <p className="truncate text-[11px] text-on-surface-variant">{selectedChapter.name}</p>
                )}
              </div>
              {!isHtmlBook && (
                <>
                  <button type="button" onClick={goToPrevPage} disabled={!canPrev} className={iconBtn} aria-label="Previous page">
                    <span className="material-symbols-outlined text-primary">chevron_left</span>
                  </button>
                  {pageIndicator(true)}
                  <button type="button" onClick={goToNextPage} disabled={!canNext} className={iconBtn} aria-label="Next page">
                    <span className="material-symbols-outlined text-primary">chevron_right</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* YouTube transcripts say so above the text (hidden in focus mode, whose top bar carries it) */}
      {!focused && <YoutubeTranscriptBadge book={book} variant="banner" />}

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
            className={`flex-1 overflow-auto overscroll-contain bg-background flex [justify-content:safe_center] scrollbar-thin ${focused ? "pt-[calc(env(safe-area-inset-top)+4.5rem)] pb-40" : "py-4 sm:py-6"}`}
            onClick={onReadingSurfaceClick}
            onTouchEnd={() => { setTimeout(readSelection, 50); }}
            onMouseUp={() => setTimeout(readSelection, 0)}
          >
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

      {/* Floating selection affordances: Highlight (when highlighting isn't
          automatic) and quote capture (PDF only). Their own lane ABOVE the
          chapter chip and read-along dock. */}
      {!captureOpen && ((!autoHighlight && highlights.pendingSelection) || (!isHtmlBook && !focused && selectionCapture)) && (
        <div className={`fixed bottom-52 md:bottom-32 left-1/2 -translate-x-1/2 flex items-center gap-2 ${focused ? "z-[70]" : "z-50"}`}>
          {!autoHighlight && highlights.pendingSelection && (
            <button
              onClick={() => { void highlights.commitSelection(); }}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container-high text-foreground rounded-full shadow-xl font-bold text-sm active:scale-95 transition-all border border-outline-variant/30"
            >
              <span className="material-symbols-outlined text-base text-primary" aria-hidden>ink_highlighter</span>
              Highlight
            </button>
          )}
          {!isHtmlBook && !focused && selectionCapture && (
            <button
              onClick={() => { setCardSource(null); setCaptureOpen(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-primary-container text-on-primary-container rounded-full shadow-xl font-bold text-sm active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>bookmark_add</span>
              Save quote to neuron
            </button>
          )}
        </div>
      )}

      {highlightHit && (
        <HighlightActions
          hit={highlightHit}
          onClose={closeHighlightMenu}
          onAsk={askAboutHighlight}
          onSaveCard={() => {
            const h = highlightHit.highlight;
            setCardSource({ quote: h.quote, page: h.page ?? currentPage, chapterId: h.chapter_id });
            setHighlightHit(null);
            setCaptureOpen(true);
          }}
          onRemove={() => {
            void highlights.remove(highlightHit.highlight);
            setHighlightHit(null);
          }}
        />
      )}

      {/* Current chapter — a compact chip so it doesn't cover the page */}
      {!isHtmlBook && !focused && !readAlongActive && selectedChapter && (
        <div className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-[90vw]">
          <div className="flex items-center gap-2 pl-3 pr-1 py-1 bg-surface-container-high/90 backdrop-blur-xl rounded-full shadow-xl border border-outline-variant/20">
            <span className="material-symbols-outlined text-primary text-lg" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>auto_stories</span>
            <span className="truncate font-headline font-bold text-sm text-primary">{selectedChapter.name}</span>
            <button onClick={() => setSelectedChapterId(null)} className="grid place-items-center w-9 h-9 shrink-0 hover:bg-surface-container-highest rounded-full transition-colors" aria-label="Dismiss current chapter">
              <span className="material-symbols-outlined text-secondary text-lg">close</span>
            </button>
          </div>
        </div>
      )}

      <ChapterNameDialog
        open={namingDialog.open}
        defaultName={namingDialog.defaultName}
        onConfirm={handleChapterConfirm}
        onCancel={() => setNamingDialog({ open: false, endPage: 0, defaultName: "" })}
      />
      <ChapterManageDialog
        open={manageChaptersOpen}
        chapters={book.chapters}
        onEdit={(chapterId, newName) => updateChapter(book.id, chapterId, newName)}
        onDelete={(chapterId) => removeChapter(book.id, chapterId)}
        onClose={() => setManageChaptersOpen(false)}
      />
      <CaptureQuoteDialog
        open={captureOpen}
        onClose={() => { setCaptureOpen(false); setSelectionCapture(""); setCardSource(null); }}
        book={book}
        page={cardSource?.page ?? currentPage}
        selectionText={cardSource?.quote ?? selectionCapture}
        chapterId={cardSource?.chapterId ?? null}
      />
    </div>
  );
};

export default PdfViewer;
