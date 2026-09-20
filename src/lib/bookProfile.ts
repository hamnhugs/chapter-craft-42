/**
 * A book's profile: everything the app knows about one book, gathered in one
 * place and in one shape.
 *
 * The library never had this. The data existed — summary and its model
 * attribution, chapter gists, category, topic tags, provenance, shelf
 * membership, page count, the locally-remembered reading position — but each
 * view reached for a different subset and assembled it inline, so no two
 * agreed on what a book "is". The showcase needs all of it at once, and a pure
 * assembler is also the only way any of this gets unit-tested.
 *
 * Pure and DOM-free. The one piece of ambient state it needs — the last page
 * read, which lives in localStorage per device — is passed in.
 */

import type { BookDocument } from "@/types/library";
import { bookSource, provenanceLabel, topicTags, youtubeSource } from "@/lib/bookProvenance";

export interface BookProfileStat {
  label: string;
  value: string;
  /** Material Symbols glyph name. */
  icon: string;
}

export interface BookProfile {
  id: string;
  title: string;
  source: ReturnType<typeof bookSource>;
  provenance: string | null;
  category: string | null;
  tags: string[];
  summary: string | null;
  summaryModel: string | null;
  coverImageUrl: string | null;
  /** Stable per-book colour seed. */
  seed: number;
  /** Reading position, when this device remembers one. */
  progress: { page: number; pages: number; pct: number } | null;
  /** Chapter gists worth showing — the closest thing to a table of contents. */
  highlights: { name: string; gist: string | null }[];
  shelves: string[];
  stats: BookProfileStat[];
  addedAt: number;
}

/**
 * Stable 32-bit hash of the book id (FNV-1a).
 *
 * The grid's placeholder covers seed their gradient from the book's *index*,
 * so a book is olive in one sort order and amber in another. A profile is
 * supposed to be the book's face; it should not depend on who it is standing
 * next to. Hashing the id instead makes a cover-less book look like itself
 * every time, for as long as it exists.
 */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function relativeDay(ts: number, now: number = Date.now()): string {
  const day = 86_400_000;
  const diff = now - ts;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 30 * day) return `${Math.floor(diff / day)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const MAX_HIGHLIGHTS = 4;

export interface ProfileInputs {
  book: BookDocument;
  /** Shelf id → name, for turning folderIds into something readable. */
  shelfNames?: Map<string, string>;
  /** Last page read on this device, 0 or absent when never opened. */
  lastPage?: number;
  now?: number;
}

export function bookProfile({ book, shelfNames, lastPage = 0, now = Date.now() }: ProfileInputs): BookProfile {
  const source = bookSource(book);
  const yt = youtubeSource(book);
  const tags = topicTags(book.tags);

  const pages = book.pageCount > 0 ? book.pageCount : 0;
  // A reader on page 1 has not read 1/300th of a book, they have opened it.
  // Only a position past the first page is worth reporting as progress.
  const progress =
    pages > 0 && lastPage > 1
      ? { page: Math.min(lastPage, pages), pages, pct: Math.min(100, Math.round((Math.min(lastPage, pages) / pages) * 100)) }
      : null;

  const highlights = book.chapters
    .filter((c) => (c.gist || "").trim().length > 0)
    .slice(0, MAX_HIGHLIGHTS)
    .map((c) => ({ name: c.name, gist: c.gist ?? null }));
  // Fall back to bare chapter names when the catalog has not been generated —
  // a list of chapters is still the shape of the book.
  const fallback = book.chapters.slice(0, MAX_HIGHLIGHTS).map((c) => ({ name: c.name, gist: null }));

  const shelves = (book.folderIds || [])
    .map((id) => shelfNames?.get(id))
    .filter((n): n is string => !!n);

  const stats: BookProfileStat[] = [];
  if (pages > 0) stats.push({ label: "pages", value: String(pages), icon: "description" });
  if (book.chapters.length > 0) {
    stats.push({ label: book.chapters.length === 1 ? "chapter" : "chapters", value: String(book.chapters.length), icon: "list" });
  }
  if (yt?.durationSeconds) {
    stats.push({ label: "runtime", value: formatMinutes(yt.durationSeconds), icon: "schedule" });
  }
  if (progress) stats.push({ label: "read", value: `${progress.pct}%`, icon: "auto_stories" });
  stats.push({ label: "added", value: relativeDay(book.addedAt, now), icon: "event" });

  return {
    id: book.id,
    title: book.title,
    source,
    provenance: provenanceLabel(book),
    category: book.category || null,
    tags,
    summary: (book.summary || "").trim() || null,
    summaryModel: book.summaryModel || null,
    coverImageUrl: book.coverImageUrl || null,
    seed: seedOf(book.id),
    progress,
    highlights: highlights.length > 0 ? highlights : fallback,
    shelves,
    stats,
    addedAt: book.addedAt,
  };
}

function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
