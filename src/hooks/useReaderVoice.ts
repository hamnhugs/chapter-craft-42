import { useEffect, useRef, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { BookDocument, Chapter } from "@/types/library";
import { registerVoiceReader, labelScore, type ReaderCommand } from "@/lib/voiceControl";
import { collectPageText, resolvePassage, selectRange } from "@/lib/voicePageText";
import { screenshotHtmlImages, screenshotPdf } from "@/lib/pageCapture";
import { QUOTE_MAX_CHARS } from "@/lib/highlights";

// The Read tab's half of hands-free voice control (see lib/voiceControl.ts):
// pages, chapters, zoom, focus mode, highlights / cards, and screenshots.
// Everything goes through the same functions the reader's buttons call.

export interface ReaderVoiceState {
  book: BookDocument | null;
  mode: "pdf" | "html";
  numPages: number;
  currentPage: number;
  selectedChapterId: string | null;
  focused: boolean;
  pdfRef: RefObject<PDFDocumentProxy | null>;
  pageHostRef: RefObject<HTMLElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  goToPage: (n: number) => void;
  selectChapter: (id: string) => void;
  zoomBy: (delta: number) => void;
  zoomFit: () => void;
  enterFocus: () => void;
  exitFocus: () => void;
  commitSelection: () => Promise<boolean>;
  /** Open the "Save quote to neuron" card dialog for this quote. */
  openCard: (quote: string) => void;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function sortedChapters(book: BookDocument): Chapter[] {
  return [...book.chapters].sort((a, b) => a.startPage - b.startPage);
}

function preview(s: string): string {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length > 8 ? `${w.slice(0, 8).join(" ")}…` : w.join(" ");
}

export function useReaderVoice(state: ReaderVoiceState) {
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    /** Wait for the PDF to load / the page's text layer to render. */
    const ready = async (needText: boolean): Promise<boolean> => {
      const end = Date.now() + 6000;
      for (;;) {
        const s = ref.current;
        const loaded = s.mode === "html" ? !!s.iframeRef.current?.contentDocument?.body : s.numPages > 0;
        const hasText = s.mode === "html"
          ? !!s.iframeRef.current?.contentDocument?.body?.innerText.trim()
          : !!s.pageHostRef.current?.querySelector(".textLayer span");
        if (loaded && (!needText || hasText)) return true;
        if (Date.now() > end) return false;
        await sleep(120);
      }
    };

    const currentChapterIndex = (chs: Chapter[]): number => {
      const s = ref.current;
      if (s.selectedChapterId) {
        const i = chs.findIndex((c) => c.id === s.selectedChapterId);
        if (i >= 0 && (s.mode === "html" || (s.currentPage >= chs[i].startPage && s.currentPage <= chs[i].endPage))) return i;
      }
      if (s.mode === "html") return -1;
      let idx = -1;
      chs.forEach((c, i) => { if (c.startPage <= s.currentPage) idx = i; });
      return idx;
    };

    const pageReply = (n: number) => `Page ${n} of ${ref.current.numPages}.`;

    const run = async (cmd: ReaderCommand): Promise<string> => {
      const s0 = ref.current;
      if (!s0.book) return "No book is open.";
      const title = s0.book.title || "this book";

      switch (cmd.kind) {
        case "where": {
          const s = ref.current;
          const chs = sortedChapters(s.book!);
          const ci = currentChapterIndex(chs);
          const ch = ci >= 0 ? `, ${chs[ci].name}` : "";
          return s.mode === "pdf" ? `${title}, page ${s.currentPage} of ${s.numPages}${ch}.` : `${title}${ch}.`;
        }
        case "page":
        case "pageBy": {
          if (ref.current.mode === "html") return "This book scrolls instead of having pages — say scroll down, or next chapter.";
          if (!(await ready(false))) return "The book is still loading.";
          const s = ref.current;
          let target = s.currentPage;
          if (cmd.kind === "pageBy") target = s.currentPage + cmd.delta;
          else if (cmd.to === "next") target = s.currentPage + 1;
          else if (cmd.to === "prev") target = s.currentPage - 1;
          else if (cmd.to === "first") target = 1;
          else if (cmd.to === "last") target = s.numPages;
          else if (cmd.to === "number") target = cmd.n;
          if (target > s.numPages) {
            if (s.currentPage === s.numPages) return "That's the last page.";
            if (cmd.kind === "page" && cmd.to === "number") return `This book only has ${s.numPages} pages.`;
            target = s.numPages;
          }
          if (target < 1) {
            if (s.currentPage === 1) return "That's the first page.";
            target = 1;
          }
          s.goToPage(target);
          return pageReply(target);
        }
        case "chapter": {
          const s = ref.current;
          const chs = sortedChapters(s.book!);
          if (chs.length === 0) return "This book has no chapters marked yet. You can go by page, or say click detect in the Vault.";
          const ci = currentChapterIndex(chs);
          let target: number;
          if (cmd.to === "next") target = ci + 1;
          else if (cmd.to === "prev") target = ci - 1;
          else if (cmd.to === "first") target = 0;
          else if (cmd.to === "last") target = chs.length - 1;
          else if (cmd.to === "current") target = Math.max(0, ci);
          else if (cmd.to === "number") {
            // "chapter 3": a chapter NAMED with 3 beats the third in the list.
            const named = chs.findIndex((c) => new RegExp(`\\b(?:chapter|ch\\.?|part|section)\\s*${cmd.n}\\b|^${cmd.n}\\b`, "i").test(c.name));
            target = named >= 0 ? named : cmd.n - 1;
          } else if (cmd.to === "name") {
            let best = -1, bestScore = 0;
            chs.forEach((c, i) => { const sc = labelScore(cmd.name, c.name); if (sc > bestScore) { best = i; bestScore = sc; } });
            if (best < 0 || bestScore < 30) return `I couldn't find a chapter called ${cmd.name}.`;
            target = best;
          } else return "Which chapter?";
          if (target >= chs.length) return "That's the last chapter.";
          if (target < 0) return ci < 0 ? "You're before the first chapter." : "That's the first chapter.";
          s.selectChapter(chs[target].id);
          return s.mode === "pdf" ? `${chs[target].name}, page ${chs[target].startPage}.` : `${chs[target].name}.`;
        }
        case "zoom": {
          const s = ref.current;
          if (s.mode === "html") return "Zoom works on PDF books.";
          if (cmd.to === "fit") { s.zoomFit(); return "Fit to width."; }
          s.zoomBy(cmd.to === "in" ? 0.2 : -0.2);
          return cmd.to === "in" ? "Zoomed in." : "Zoomed out.";
        }
        case "focus": {
          const s = ref.current;
          if (cmd.on) { if (!s.focused) s.enterFocus(); return "Focus mode."; }
          if (s.focused) s.exitFocus();
          return "Focus mode off.";
        }
        case "screenshot": {
          if (!(await ready(false))) return "The book is still loading.";
          const s = ref.current;
          if (s.mode === "html") {
            if (cmd.target === "page") return "This book has no pages to screenshot. Say screenshot the picture for its images.";
            const doc = s.iframeRef.current?.contentDocument;
            if (!doc) return "The book isn't ready yet.";
            return screenshotHtmlImages({ doc, bookTitle: title, which: cmd.which });
          }
          if (!s.pdfRef.current) return "The book is still loading.";
          return screenshotPdf({
            pdf: s.pdfRef.current, page: s.currentPage, bookTitle: title, target: cmd.target,
            which: cmd.target === "image" ? cmd.which : null,
          });
        }
        case "save": {
          if (!(await ready(true))) return "I can't read the text on this page — it may be a scanned image.";
          const s = ref.current;
          const root = s.mode === "pdf"
            ? (s.pageHostRef.current?.querySelector(".textLayer") as Element | null) ?? s.pageHostRef.current
            : s.iframeRef.current?.contentDocument?.body ?? null;
          if (!root) return "The page isn't ready yet.";
          const page = collectPageText(root, s.mode);
          const found = resolvePassage(page, cmd);
          if ("error" in found) return found.error;
          let [start, end] = found.range;
          let clipped = false;
          if (end - start > QUOTE_MAX_CHARS) { end = start + QUOTE_MAX_CHARS; clipped = true; }
          const quote = selectRange(page, start, end);
          if (!quote.trim()) return "I couldn't select that part.";
          if (cmd.asCard) {
            s.openCard(quote);
            return `Card ready: ${preview(quote)} Say click save to keep it, or close this.`;
          }
          const ok = await s.commitSelection();
          // Clear the selection so the floating "Save quote" buttons go away.
          window.setTimeout(() => { try { page.doc.getSelection()?.removeAllRanges(); } catch { /* no-op */ } }, 1500);
          if (!ok) return "I couldn't save that — it may be too short to highlight.";
          return `Highlighted${clipped ? " the first part of the page" : ""}: ${preview(quote)}`;
        }
      }
    };

    return registerVoiceReader({ run });
  }, []);
}
