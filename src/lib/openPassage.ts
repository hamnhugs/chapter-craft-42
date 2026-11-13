import { saveLastPage } from "@/hooks/useReaderPrefs";

/**
 * Open the reader at a note's page — the "jump to the source" half of every
 * note. The reader reopens a book at its saved last page, so setting that
 * first covers a book that isn't open yet; the event covers the book that
 * already is (PdfViewer listens for it).
 */
export const READER_GO_TO_PAGE = "reader-go-to-page";

export function openPassage(
  app: { setActiveBook: (id: string) => void; setActiveTab: (tab: any) => void },
  bookId: string,
  page: number,
): void {
  const p = Number.isInteger(page) && page > 0 ? page : 1;
  try { saveLastPage(bookId, p); } catch { /* storage unavailable: the event still works */ }
  app.setActiveBook(bookId);
  app.setActiveTab("viewer");
  // After the tab switch, so a freshly mounted reader hears it too.
  setTimeout(() => {
    try { window.dispatchEvent(new CustomEvent(READER_GO_TO_PAGE, { detail: { bookId, page: p } })); } catch { /* non-browser */ }
  }, 0);
}

/**
 * Open one note in the notebook view (from a reply's "Used N notes" list).
 * The notebook view may not be mounted yet, so the request also waits in
 * sessionStorage for it to pick up on mount.
 */
export const OPEN_NOTE_EVENT = "open-note";
export const OPEN_NOTE_PENDING_KEY = "open-note-pending";

export function openNote(app: { setActiveTab: (tab: any) => void }, entryId: string): void {
  try { sessionStorage.setItem(OPEN_NOTE_PENDING_KEY, entryId); } catch { /* the event still works */ }
  app.setActiveTab("wiki");
  setTimeout(() => {
    try { window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, { detail: { entryId } })); } catch { /* non-browser */ }
  }, 0);
}
