import React, { useState, useCallback, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  BookOpen,
  Flag,
  FlagOff,
  Bookmark,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { Chapter } from "@/types/library";
import ChapterNameDialog from "@/components/ChapterNameDialog";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const PdfViewer: React.FC = () => {
  const { getActiveBook, addChapter, activeBookId } = useApp();
  const book = getActiveBook();

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [chapterStart, setChapterStart] = useState<number | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [namingDialog, setNamingDialog] = useState<{ open: boolean; endPage: number; defaultName: string }>({
    open: false, endPage: 0, defaultName: "",
  });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentPage(1);
    setChapterStart(null);
    setSelectedChapterId(null);
  }, [activeBookId]);

  const onDocumentLoadSuccess = useCallback(({ numPages }: any) => {
    setNumPages(numPages);
  }, []);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= numPages) setCurrentPage(page);
  };

  const zoom = (delta: number) => {
    setScale((s) => Math.max(0.5, Math.min(3, s + delta)));
  };

  const markChapterStart = () => {
    setChapterStart(currentPage);
  };

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

    setNamingDialog({ open: false, endPage: 0, defaultName: "" });

    // Extract text
    let textContent = "";
    try {
      const loadingTask = pdfjs.getDocument(book.fileData);
      const pdf = await loadingTask.promise;
      for (let i = chapterStart; i <= endPage; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item: any) => item.str).join(" ");
        textContent += pageText + "\n\n";
      }
    } catch (err) {
      console.error("Failed to extract text:", err);
    }

    const chapter: Chapter = {
      id: crypto.randomUUID(),
      name,
      startPage: chapterStart,
      endPage,
      textContent,
    };

    addChapter(book.id, chapter);
    setChapterStart(null);
  };

  const handleChapterSelect = (chapterId: string) => {
    if (!book) return;
    const chapter = book.chapters.find((c) => c.id === chapterId);
    if (chapter) {
      setCurrentPage(chapter.startPage);
      setSelectedChapterId(chapterId);
    }
  };

  if (!book) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground animate-fade-in">
        <BookOpen className="w-16 h-16 mb-4 opacity-30" />
        <p className="text-lg font-display">No document selected</p>
        <p className="text-sm mt-1">Choose a book from your library to start reading</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-viewer-toolbar border-b border-border flex-wrap">
        {/* Navigation */}
        <div className="flex items-center gap-1">
          <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="p-1.5 rounded-md hover:bg-secondary disabled:opacity-30 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-body min-w-[80px] text-center tabular-nums">{currentPage} / {numPages}</span>
          <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} className="p-1.5 rounded-md hover:bg-secondary disabled:opacity-30 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="w-px h-6 bg-border" />

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <button onClick={() => zoom(-0.2)} className="p-1.5 rounded-md hover:bg-secondary transition-colors">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs font-body min-w-[40px] text-center tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(0.2)} className="p-1.5 rounded-md hover:bg-secondary transition-colors">
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>

        <div className="w-px h-6 bg-border" />

        {/* Chapter isolation */}
        <div className="flex items-center gap-1">
          {chapterStart === null ? (
            <button onClick={markChapterStart} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-body hover:bg-secondary transition-colors" title="Mark chapter start">
              <Flag className="w-3.5 h-3.5 text-accent" />
              <span>Start</span>
            </button>
          ) : (
            <>
              <span className="text-xs text-accent font-medium px-2">Started p.{chapterStart}</span>
              <button onClick={markChapterEnd} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-body bg-accent text-accent-foreground hover:opacity-90 transition-colors" title="Mark chapter end">
                <FlagOff className="w-3.5 h-3.5" />
                <span>End</span>
              </button>
              <button onClick={() => setChapterStart(null)} className="text-xs text-muted-foreground hover:text-foreground px-1">Cancel</button>
            </>
          )}
        </div>

        <div className="w-px h-6 bg-border" />

        {/* Chapter dropdown */}
        <div className="flex items-center gap-1.5">
          <Bookmark className="w-3.5 h-3.5 text-muted-foreground" />
          <select value={selectedChapterId || ""} onChange={(e) => handleChapterSelect(e.target.value)} className="text-xs font-body bg-transparent border border-border rounded-md px-2 py-1.5 min-w-[160px] focus:outline-none focus:ring-1 focus:ring-ring">
            <option value="">{book.chapters.length === 0 ? "No chapters yet" : "Jump to chapter…"}</option>
            {book.chapters.map((ch) => (
              <option key={ch.id} value={ch.id}>{ch.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* PDF content */}
      <div ref={containerRef} className="flex-1 overflow-auto bg-viewer-bg flex justify-center py-6 scrollbar-thin">
        <Document
          file={book.fileData}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={<div className="flex items-center justify-center py-20"><div className="animate-pulse text-muted-foreground text-sm">Loading document…</div></div>}
          error={<div className="text-destructive text-sm text-center py-20">Failed to load the document.</div>}
        >
          <Page pageNumber={currentPage} scale={scale} renderTextLayer={true} renderAnnotationLayer={true} />
        </Document>
      </div>

      {/* Chapter naming dialog */}
      <ChapterNameDialog
        open={namingDialog.open}
        defaultName={namingDialog.defaultName}
        onConfirm={handleChapterConfirm}
        onCancel={() => {
          setNamingDialog({ open: false, endPage: 0, defaultName: "" });
        }}
      />
    </div>
  );
};

export default PdfViewer;
