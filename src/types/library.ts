export interface Chapter {
  id: string;
  name: string;
  startPage: number;
  endPage: number;
  textContent: string;
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
  /** User-managed folder id (book_folders.id) — null when uncategorized. */
  folderId?: string | null;
}

