import React, { useState, useCallback, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { useApp } from "@/context/AppContext";
import { Chapter } from "@/types/library";
import ChapterNameDialog from "@/components/ChapterNameDialog";
import ChapterManageDialog from "@/components/ChapterManageDialog";
import { toast } from "sonner";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const PdfViewer: React.FC = () => {
  const { getActiveBook, addChapter, updateChapter, removeChapter, updateBookTitle, activeBookId, loadBookFile } = useApp();
  const book = getActiveBook();
  const isPdfBook = book?.fileName.toLowerCase().endsWith(".pdf") ?? false;

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [chapterStart, setChapterStart] = useState<number | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [namingDialog, setNamingDialog] = useState<{ open: boolean; endPage: number; defaultName: string }>({
    open: false, endPage: 0, defaultName: "",
  });
  const [fileUrl, setFileUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [manageChaptersOpen, setManageChaptersOpen] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSavingChapter, setIsSavingChapter] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // --- Read aloud ---
  const readCurrentPage = useCallback(async () => {
    if (!fileUrl) return;
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
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
  }, [fileUrl, currentPage, isSpeaking]);

  useEffect(() => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, [currentPage, activeBookId]);

  // --- Swipe gestures ---
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

  useEffect(() => {
    setCurrentPage(1);
    setChapterStart(null);
    setSelectedChapterId(null);
    setFileUrl("");
  }, [activeBookId]);

  useEffect(() => {
    if (!activeBookId) return;
    if (!isPdfBook) { setFileUrl(""); setLoading(false); return; }
    if (book?.fileData) { setFileUrl(book.fileData); setLoading(false); return; }
    setLoading(true);
    loadBookFile(activeBookId).then((url) => { setFileUrl(url); setLoading(false); }).catch(() => { setFileUrl(""); setLoading(false); });
  }, [activeBookId, isPdfBook, book?.fileData, loadBookFile]);

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
    if (chapter) { setCurrentPage(chapter.startPage); setSelectedChapterId(chapterId); }
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

  if (!isPdfBook) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant animate-fade-in">
        <span className="material-symbols-outlined text-6xl mb-4 opacity-30">description</span>
        <p className="text-lg font-headline">Preview unavailable</p>
        <p className="text-sm mt-1">Reader preview supports PDF files only.</p>
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

  if (!fileUrl) {
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
      {/* Primary Toolbar: Pagination */}
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

        {/* Zoom */}
        <div className="flex items-center bg-surface-container-highest px-3 py-1.5 rounded-full gap-4 shrink-0">
          <button onClick={() => zoom(-0.2)} className="material-symbols-outlined text-secondary hover:text-primary transition-colors">remove</button>
          <span className="font-label text-sm font-bold text-foreground w-10 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(0.2)} className="material-symbols-outlined text-secondary hover:text-primary transition-colors">add</button>
        </div>

        {/* Chapter Isolation */}
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

        {/* Chapter select */}
        {book.chapters.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant text-sm">bookmark</span>
            <select
              value={selectedChapterId || ""}
              onChange={(e) => handleChapterSelect(e.target.value)}
              className="text-xs font-body bg-surface-container-highest border-none rounded-lg px-3 py-2 text-foreground focus:ring-1 focus:ring-primary/40"
            >
              <option value="">Jump to chapter…</option>
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

      {/* PDF content */}
      <div ref={containerRef} className="flex-1 overflow-auto bg-background flex justify-center py-6 scrollbar-thin" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        <Document
          file={fileUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={<div className="flex items-center justify-center py-20"><div className="animate-pulse text-on-surface-variant text-sm">Loading document…</div></div>}
          error={<div className="text-destructive text-sm text-center py-20">Failed to load the document.</div>}
        >
          <Page pageNumber={currentPage} scale={scale} renderTextLayer={true} renderAnnotationLayer={true} />
        </Document>
      </div>

      {/* Floating chapter info */}
      {book.chapters.length > 0 && selectedChapterId && (() => {
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
    </div>
  );
};

export default PdfViewer;
