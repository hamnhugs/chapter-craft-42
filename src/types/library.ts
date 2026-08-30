export interface Chapter {
  id: string;
  name: string;
  startPage: number;
  endPage: number;
  textContent: string;
  /** One-line model-generated summary (catalog mode). Untrusted text —
   *  every prompt/tool door sanitizes it on read. Absent until the user
   *  generates the book's catalog (and until the gist migration is applied,
   *  which every reader feature-detects). */
  gist?: string | null;
}

export interface BookDocument {
  id: string;
  title: string;
  fileName: string;
  fileData: string; // base64 data URL
  pageCount: number;
  chapters: Chapter[];
  addedAt: number;
  coverImageUrl?: string;
  /** Fixed-taxonomy category assigned by auto-tag (mind map hub). */
  category?: string;
  /** Free-form topic tags assigned by auto-tag (mind map edges + search). */
  tags?: string[];
  /** User-managed shelf ids (book_folders.id), non-exclusive; empty when
   *  unshelved. Junction mode loads them in deterministic (book, shelf)
   *  order; books.folder_id survives only as a BEST-EFFORT single-shelf
   *  mirror for stale bundles (it may drift — e.g. a shelf delete SET NULLs
   *  it while other memberships remain). In fallback mode (migration not
   *  applied yet) this holds at most one id, derived from books.folder_id. */
  folderIds: string[];
}

