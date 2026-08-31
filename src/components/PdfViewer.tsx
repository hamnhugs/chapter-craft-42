import React, { useState, useCallback, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { useApp } from "@/context/AppContext";
import { Chapter } from "@/types/library";
import ChapterNameDialog from "@/components/ChapterNameDialog";
import ChapterManageDialog from "@/components/ChapterManageDialog";
import CaptureQuoteDialog from "@/components/CaptureQuoteDialog";
import { toast } from "sonner";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const PdfViewer: React.FC = () => {
  const { getActiveBook, addChapter, updateChapter, removeChapter, updateBookTitle, activeBookId, loadBookFile } = useApp();
  const book = getActiveBook();
  const isPdfBook = book?.fileName.toLowerCase().endsWith(".pdf") ?? false;
  const isHtmlBook = book?.fileName.toLowerCase().endsWith(".html") ?? false;

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [chapterStart, setChapterStart] = useState<number | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [namingDialog, setNamingDialog] = useState<{ open: boolean; endPage: number; defaultName: string }>({
    open: false, endPage: 0, defaultName: "",
  });
  const [fileUrl, setFileUrl] = useState<string>("");
  const [htmlContent, setHtmlContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [manageChaptersOpen, setManageChaptersOpen] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSavingChapter, setIsSavingChapter] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

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

  // --- Read aloud ---
  const readCurrentPage = useCallback(async () => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    if (isHtmlBook) {
      const text = htmlContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!text) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      setIsSpeaking(true);
      window.speechSynthesis.speak(utterance);
      return;
    }
    if (!fileUrl) return;
    try {
      const loadingTask = pdfjs.getDocument(fileUrl);
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(currentPage);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str).join(" ");
      if (!text.trim()) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      setIsSpeaking(true);
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error("Read aloud failed:", err);
    }
  }, [fileUrl, currentPage, isSpeaking, isHtmlBook, htmlContent]);

  useEffect(() => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, [currentPage, activeBookId]);

  // --- Swipe gestures (PDF only) ---
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && currentPage < numPages) setCurrentPage((p) => p + 1);
      else if (dx > 0 && currentPage > 1) setCurrentPage((p) => p - 1);
    }
  }, [currentPage, numPages]);

  // Reset on book change
  useEffect(() => {
    setCurrentPage(1);
    setChapterStart(null);
    setSelectedChapterId(null);
    setFileUrl("");
    setHtmlContent("");
  }, [activeBookId]);

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

  const onDocumentLoadSuccess = useCallback(({ numPages }: any) => { setNumPages(numPages); }, []);
  const goToPage = (page: number) => { if (page >= 1 && page <= numPages) setCurrentPage(page); };
  const zoom = (delta: number) => { setScale((s) => Math.max(0.5, Math.min(3, s + delta))); };

  const markChapterStart = () => setChapterStart(currentPage);
  const markChapterEnd = () => {
    if (chapterStart === null || !book) return;
    const endPage = currentPage;
    if (endPage < chapterStart) return;
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

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Pagination toolbar — PDF only */}
      {!isHtmlBook && (
        <div className="flex items-center justify-between px-4 h-14 bg-surface-container-low">
          <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="p-2 hover:bg-surface-container-high rounded-full transition-colors disabled:opacity-30">
            <span className="material-symbols-outlined text-primary">arrow_back</span>
          </button>
          <div className="flex flex-col items-center">
            <span className="font-label text-[10px] uppercase tracking-[0.2em] text-on-surface-variant">Current Progress</span>
            <span className="font-headline font-bold text-lg text-primary italic">Page {currentPage} of {numPages}</span>
          </div>
          <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} className="p-2 hover:bg-surface-container-high rounded-full transition-colors disabled:opacity-30">
            <span className="material-symbols-outlined text-primary">arrow_forward</span>
          </button>
        </div>
      )}

      {/* Secondary Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 bg-surface-container-high overflow-x-auto hide-scrollbar gap-4 border-t border-outline-variant/10">
        {/* Read Aloud */}
        <button
          onClick={readCurrentPage}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg shrink-0 active:scale-95 transition-all ${
            isSpeaking
              ? "bg-accent text-on-primary-container"
              : "bg-primary-container/10 border border-primary-container/20 text-primary-container"
          }`}
        >
          <span className="material-symbols-outlined">{isSpeaking ? "volume_off" : "volume_up"}</span>
          <span className="font-label text-sm font-semibold">{isSpeaking ? "Stop" : "Read Aloud"}</span>
        </button>

        {/* Zoom — PDF only */}
        {!isHtmlBook && (
          <div className="flex items-center bg-surface-container-highest px-3 py-1.5 rounded-full gap-4 shrink-0">
            <button onClick={() => zoom(-0.2)} className="material-symbols-outlined text-secondary hover:text-primary transition-colors">remove</button>
            <span className="font-label text-sm font-bold text-foreground w-10 text-center">{Math.round(scale * 100)}%</span>
            <button onClick={() => zoom(0.2)} className="material-symbols-outlined text-secondary hover:text-primary transition-colors">add</button>
          </div>
        )}

        {/* Chapter Isolation — PDF only */}
        {!isHtmlBook && (
          <div className="flex items-center gap-2 shrink-0">
            {chapterStart === null ? (
              <button
                onClick={markChapterStart}
                disabled={isSavingChapter}
                className="flex items-center gap-2 px-5 py-2 bg-primary-container text-on-primary-container rounded-lg shadow-sm font-bold text-sm active:scale-95 transition-all disabled:opacity-50"
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
                  End
                </button>
                <button
                  onClick={() => setChapterStart(null)}
                  disabled={isSavingChapter}
                  className="text-xs text-on-surface-variant hover:text-foreground disabled:opacity-50 px-2"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}

        {/* Chapter select */}
        {book.chapters.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant text-sm">bookmark</span>
            <select
              value={selectedChapterId || ""}
              onChange={(e) => handleChapterSelect(e.target.value)}
              className="text-xs font-body bg-surface-container-highest border-none rounded-lg px-3 py-2 text-foreground focus:ring-1 focus:ring-primary/40"
            >
              <option value="">{isHtmlBook ? "Jump to section…" : "Jump to chapter…"}</option>
              {book.chapters.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
            <button
              onClick={() => setManageChaptersOpen(true)}
              className="p-1.5 rounded-lg hover:bg-surface-container-highest transition-colors"
            >
              <span className="material-symbols-outlined text-on-surface-variant text-sm">settings</span>
            </button>
          </div>
        )}
      </div>

      {/* Document content */}
      {isHtmlBook ? (
        <iframe
          ref={iframeRef}
          srcDoc={htmlContent}
          sandbox="allow-same-origin"
          className="flex-1 w-full border-0 bg-background"
          title={book.title}
        />
      ) : (
        <div
          ref={containerRef}
          className="flex-1 overflow-auto bg-background flex justify-center py-6 scrollbar-thin"
          onTouchStart={handleTouchStart}
          onTouchEnd={(e) => { handleTouchEnd(e); setTimeout(readSelection, 50); }}
          onMouseUp={() => setTimeout(readSelection, 0)}
        >
          <Document
            file={fileUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={<div className="flex items-center justify-center py-20"><div className="animate-pulse text-on-surface-variant text-sm">Loading document…</div></div>}
            error={<div className="text-destructive text-sm text-center py-20">Failed to load the document.</div>}
          >
            <Page pageNumber={currentPage} scale={scale} renderTextLayer={true} renderAnnotationLayer={true} />
          </Document>
        </div>
      )}

      {/* Floating quote-capture affordance — PDF only, selection active.
          Its own lane ABOVE the "Currently Reading" card (which is
          bottom-24/md:bottom-6 and ~88px tall) and a higher z-index: the two
          floaters previously shared a bottom band with this one painted
          first, so the card covered the entry point to the whole capture
          flow (review finding — it was unclickable in the normal reading
          state, where a chapter is selected). */}
      {!isHtmlBook && selectionCapture && !captureOpen && (
        <div className="fixed bottom-52 md:bottom-32 left-1/2 -translate-x-1/2 z-50">
          <button
            onClick={() => setCaptureOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary-container text-on-primary-container rounded-full shadow-xl font-bold text-sm active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>bookmark_add</span>
            Save quote to neuron
          </button>
        </div>
      )}

      {/* Floating chapter info — PDF only */}
      {!isHtmlBook && book.chapters.length > 0 && selectedChapterId && (() => {
        const ch = book.chapters.find(c => c.id === selectedChapterId);
        if (!ch) return null;
        return (
          <div className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-md z-40">
            <div className="bg-surface-container-high/90 backdrop-blur-xl p-5 rounded-2xl shadow-2xl border border-outline-variant/20 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-primary-container rounded-xl flex items-center justify-center text-on-primary-container">
                  <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>auto_stories</span>
                </div>
                <div>
                  <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Currently Reading</p>
                  <h4 className="font-headline font-bold text-lg text-primary">{ch.name}</h4>
                </div>
              </div>
              <button onClick={() => setSelectedChapterId(null)} className="p-2 hover:bg-surface-container-highest rounded-lg transition-colors">
                <span className="material-symbols-outlined text-secondary">close</span>
              </button>
            </div>
          </div>
        );
      })()}

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
        onClose={() => { setCaptureOpen(false); setSelectionCapture(""); }}
        book={book}
        page={currentPage}
        selectionText={selectionCapture}
      />
    </div>
  );
};

export default PdfViewer;
