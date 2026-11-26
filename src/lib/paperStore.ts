/**
 * Saving a paper book.
 *
 * Three things are written for every page that arrives, in this order, and
 * the order is the crash-safety argument:
 *
 *   1. the book FILE (the whole book as HTML — the one copy of the pages),
 *   2. the CHAPTERS Chat reads (one row per page; only new pages are
 *      written, and no row's text is ever rewritten),
 *   3. the book ROW (page count + the "unfinished" state the Library shows).
 *
 * If the tab dies between steps the file is ahead of the rest; the next save
 * rewrites all three from the pages, so nothing needs repairing. The page
 * photo is not in this file at all: it never leaves the scanning desk.
 *
 * `PaperIO` is the seam the desk talks to. The real one is `supabasePaperIO`;
 * the dev lab swaps in a memory one through `PaperIOContext`.
 */

import { createContext } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { BookDocument, Chapter } from "@/types/library";
import {
  buildPaperHtml, chaptersForPages, parsePaperHtml, planChapterSync,
  type PaperMeta, type PaperPage,
} from "@/lib/paperBook";
import type { Transcriber } from "@/lib/pageTranscribe";

export interface PaperSave {
  title: string;
  pages: PaperPage[];
  meta: PaperMeta;
}

export interface PaperIO {
  /** Make the (empty) book. Resolves to its id. */
  create: (title: string, meta: PaperMeta) => Promise<string>;
  load: (bookId: string) => Promise<PaperPage[]>;
  save: (bookId: string, next: PaperSave) => Promise<void>;
  /** Keep a small cover thumbnail (only ever from a photo OF the cover). */
  setCover: (bookId: string, image: Blob) => Promise<void>;
}

/** Lab/test override for the save layer and the page reader. */
export const PaperIOContext = createContext<{ io?: PaperIO; transcribe?: Transcriber } | null>(null);

/** Position updates sent together when pages shift. */
const MOVES_AT_ONCE = 8;

export const paperFileName = (bookId: string) => `paper-${bookId}.html`;

export function metaFor(pages: readonly PaperPage[], prev: PaperMeta | null, patch: Partial<PaperMeta> = {}): PaperMeta {
  const lastPrinted = [...pages].reverse().find((p) => p.printed)?.printed ?? null;
  return {
    kind: "paper",
    status: prev?.status ?? "open",
    author: prev?.author ?? null,
    total_pages: prev?.total_pages ?? null,
    ...patch,
    pages: pages.length,
    last_printed: lastPrinted,
    updated_at: Date.now(),
  };
}

export interface SupabasePaperDeps {
  userId: string;
  addBook: (book: BookDocument, sourceFile?: File, opts?: { createOnly?: boolean }) => Promise<string>;
  loadBookFile: (bookId: string) => Promise<string>;
  patchBookLocal: (bookId: string, patch: (book: BookDocument) => BookDocument) => void;
  setBookCover: (bookId: string, image: Blob) => Promise<boolean>;
  getBook: (bookId: string) => BookDocument | undefined;
}

export function supabasePaperIO(deps: SupabasePaperDeps): PaperIO {
  const filePath = (bookId: string) => `${deps.userId}/${bookId}.html`;

  return {
    async create(title, meta) {
      const id = crypto.randomUUID();
      const html = buildPaperHtml(title, []);
      const file = new File([html], paperFileName(id), { type: "text/html" });
      const book: BookDocument = {
        id, title, fileName: file.name, fileData: "", pageCount: 0, chapters: [],
        addedAt: Date.now(), folderIds: [], sourceContext: meta,
      };
      const bookId = await deps.addBook(book, file, { createOnly: true });
      const { error } = await supabase.from("books")
        .update({ source_context: meta } as never).eq("id", bookId).eq("user_id", deps.userId);
      if (error) {
        // Without the marker this would sit in the library as a blank HTML
        // book nobody can resume — take it back out rather than leave it.
        await supabase.from("books").delete().eq("id", bookId).eq("user_id", deps.userId);
        await supabase.storage.from("book-pdfs").remove([filePath(bookId)]);
        deps.patchBookLocal(bookId, (b) => ({ ...b, sourceContext: null }));
        throw new Error("Could not start the book. Check your connection and try again.");
      }
      return bookId;
    },

    async load(bookId) {
      // Always the stored copy: a cached blob URL can predate pages scanned
      // on another device.
      const { data, error } = await supabase.storage.from("book-pdfs").download(filePath(bookId));
      if (!error && data) return parsePaperHtml(await data.text());
      const url = await deps.loadBookFile(bookId);
      if (!url) throw new Error("This book's pages could not be loaded. Check your connection.");
      return parsePaperHtml(await (await fetch(url)).text());
    },

    async save(bookId, next) {
      const html = buildPaperHtml(next.title, next.pages);
      const blob = new Blob([html], { type: "text/html" });
      const up = await supabase.storage.from("book-pdfs")
        .upload(filePath(bookId), blob, { contentType: "text/html", upsert: true });
      if (up.error) throw up.error;

      // One row per page, id = page id. Text is INSERTED and never updated
      // (chapter text is immutable per id — see chaptersForPages).
      const wanted = chaptersForPages(next.pages);
      const existing = deps.getBook(bookId)?.chapters ?? [];
      const plan = planChapterSync(existing, wanted);
      if (plan.remove.length > 0) {
        const gone = await supabase.from("chapters").delete().in("id", plan.remove).eq("user_id", deps.userId);
        if (gone.error) throw gone.error;
      }
      for (let i = 0; i < plan.insert.length; i += 100) {
        const rows = plan.insert.slice(i, i + 100).map((c) => ({
          id: c.id, book_id: bookId, name: c.name, start_page: c.startPage, end_page: c.endPage,
          text_content: c.textContent, user_id: deps.userId,
        }));
        // upsert + ignoreDuplicates: a save that died after this step is
        // retried whole, and the rows it already wrote must not fail it.
        const put = await supabase.from("chapters").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
        if (put.error) throw put.error;
      }
      // A page deleted or filed near the front shifts every row after it, and
      // each row moves to its own position, so it is one request a row. Eight
      // at a time: one at a time made a delete in a long book take half a minute.
      for (let i = 0; i < plan.move.length; i += MOVES_AT_ONCE) {
        const results = await Promise.all(plan.move.slice(i, i + MOVES_AT_ONCE).map((m) =>
          supabase.from("chapters")
            .update({ name: m.name, start_page: m.startPage, end_page: m.endPage })
            .eq("id", m.id).eq("user_id", deps.userId)));
        const failed = results.find((r) => r.error);
        if (failed?.error) throw failed.error;
      }

      const { error } = await supabase.from("books")
        .update({ title: next.title, page_count: next.pages.length, source_context: next.meta } as never)
        .eq("id", bookId).eq("user_id", deps.userId);
      if (error) throw error;

      const chapters: Chapter[] = wanted.map((c) => ({
        id: c.id, name: c.name, startPage: c.startPage, endPage: c.endPage, textContent: c.textContent,
      }));
      const url = URL.createObjectURL(blob);
      deps.patchBookLocal(bookId, (b) => {
        if (b.fileData?.startsWith("blob:")) URL.revokeObjectURL(b.fileData);
        return { ...b, title: next.title, pageCount: next.pages.length, sourceContext: next.meta, chapters, fileData: url };
      });
    },

    async setCover(bookId, image) {
      await deps.setBookCover(bookId, image);
    },
  };
}
