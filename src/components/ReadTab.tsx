import React, { useEffect, useSyncExternalStore } from "react";
import { useApp } from "@/context/AppContext";
import PdfViewer from "@/components/PdfViewer";
import PaperDesk from "@/components/PaperDesk";
import { isPaperBook, isUnfinishedPaper } from "@/lib/paperBook";
import { paperSession } from "@/lib/paperSession";

/**
 * The Read tab: the reader, or — for a paper book that is still being
 * scanned — the scanning desk.
 *
 * The desk shows in three cases: the open book is an unfinished paper book;
 * the reader asked to start a new one; or they asked to add pages to a
 * finished one. Everything else is the reader, unchanged.
 */
const ReadTab: React.FC = () => {
  const { getActiveBook } = useApp();
  const book = getActiveBook();
  const starting = useSyncExternalStore(paperSession.subscribe, paperSession.isStarting);
  const resumeId = useSyncExternalStore(paperSession.subscribe, paperSession.resumeId);

  const adopted = useSyncExternalStore(paperSession.subscribe, paperSession.adoptedId);

  // Opening any other book puts a pending "add pages" request to rest.
  useEffect(() => {
    if (resumeId && book && book.id !== resumeId) paperSession.clearResume();
  }, [resumeId, book]);

  // One desk instance across "new book" → "the book it just made", so the
  // pages and the voice survive the moment the book gets its id.
  if (starting) return <PaperDesk bookId={null} />;
  if (adopted && (!book || book.id === adopted)) return <PaperDesk bookId={adopted} />;
  if (book && isPaperBook(book) && (isUnfinishedPaper(book) || resumeId === book.id)) return <PaperDesk bookId={book.id} />;
  return <PdfViewer />;
};

export default ReadTab;
