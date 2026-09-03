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
  /** Model-authored book-level summary — the catalog layer ABOVE chapter
   *  gists. Untrusted text, same contract as Chapter.gist: stored raw, every
   *  prompt/tool door sanitizes it on read. Absent until generated, and
   *  absent for the whole session if the books.summary migration
   *  (20260902120000) has not been applied — every reader feature-detects. */
  summary?: string | null;
  /** Model id that authored `summary`. Surfaced in the UI so a summary is
   *  never shown as unattributed book metadata. */
  summaryModel?: string | null;
  /** When `summary` was written (epoch ms), for staleness against chapters. */
  summarizedAt?: number | null;
  /** Who wrote the book: "user" (uploaded — the primary tier) or
   *  "assistant" (written in-app at the user's request — a derived tier that
   *  every read door labels). Set by the APP at insert, never by the model.
   *  Absent until the provenance migration (20260903120000) is applied, in
   *  which case the reserved tag carries it — read through bookProvenance's
   *  `bookSource`, never by inspecting either field directly. */
  source?: "user" | "assistant";
  /** Model id that authored an assistant-written book. */
  sourceModel?: string | null;
  /** For assistant-written books: what was LOADED in the conversation when
   *  it was written ({book_ids, shelf_id}) — computed by the app. */
  sourceContext?: { book_ids?: string[]; shelf_id?: string | null } | null;
  /** User-managed shelf ids (book_folders.id), non-exclusive; empty when
   *  unshelved. Junction mode loads them in deterministic (book, shelf)
   *  order; books.folder_id survives only as a BEST-EFFORT single-shelf
   *  mirror for stale bundles (it may drift — e.g. a shelf delete SET NULLs
   *  it while other memberships remain). In fallback mode (migration not
   *  applied yet) this holds at most one id, derived from books.folder_id. */
  folderIds: string[];
}

