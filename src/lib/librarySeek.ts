import { supabase } from "@/integrations/supabase/client";
import {
  approxPage, buildSearchPattern, escapeIlike, excerptAround,
  normalizeSearchQuery, prefilterToken, searchChaptersInMemory,
} from "@/lib/bookSearch";
import type { BookDocument } from "@/types/library";

/**
 * "Where did I read that?" — an exact-text seek across the WHOLE library.
 *
 * The machinery for this was already built, reviewed and property-tested in
 * bookSearch.ts, and reachable only as a chat tool. So the Vault could filter
 * on titles or hand you to the assistant, with nothing in between — and the
 * one thing a reader most often wants from a personal library, finding the
 * passage they half-remember, needed a conversation.
 *
 * This is the same predicate, not a second one. bookSearch's regex remains
 * the sole semantic authority: case-insensitive, whitespace-run flexible,
 * 1:1 glyph-folded, deliberately not typo-tolerant. The server-side ilike is
 * a PROVABLE SUPERSET used only to narrow which chapters get fetched, exactly
 * as search_book_text uses it.
 *
 * It deliberately does NOT mint locators. Anchoring is anchorQuote's job and
 * carries different guarantees; this only shows the reader where to look.
 */

/** Chapters fetched per seek. Bounds a search over a large library to a
 *  handful of round trips; the outcome reports what it did not read. */
export const SEEK_FETCH_CAP = 8;
/** Chapters the server prefilter may return before we stop asking. */
const PREFILTER_CAP = 300;
/** Matches surfaced in the Vault (chat's tool budget is separate). */
export const SEEK_MATCH_CAP = 20;

export interface SeekHit {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterName: string;
  /** Approximate page, interpolated across the chapter's page range. */
  page: number;
  /** Verbatim slice around the match — a plain substring of the chapter. */
  excerpt: string;
  charStart: number;
  charEnd: number;
}

export interface SeekOutcome {
  hits: SeekHit[];
  /** Chapters that passed the prefilter but were not read (fetch cap). */
  notSearched: number;
  /** True when server-side narrowing did not run, so coverage is partial and
   *  a zero result must NOT be reported as "nothing in your library". */
  degraded: boolean;
  /** Human-readable reason, when there is one worth showing. */
  note?: string;
  /** Null when the query was too short or otherwise unusable. */
  normalizedQuery: string | null;
}

export interface SeekDeps {
  /** Fetch one chapter's text. Returns null/empty when unreadable. */
  loadChapterText: (chapterId: string) => Promise<string>;
}

const EMPTY: SeekOutcome = { hits: [], notSearched: 0, degraded: false, normalizedQuery: null };

/**
 * Seek `query` across every chapter of `books`.
 *
 * Chapters already hydrated client-side are searched without a round trip;
 * the rest go through one ilike prefilter and a capped fetch.
 */
export async function seekLibrary(
  books: BookDocument[],
  userId: string,
  query: string,
  deps: SeekDeps,
): Promise<SeekOutcome> {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return EMPTY;

  // Chapter → its book, in reading order, so results come back in an order a
  // reader recognizes rather than the server's.
  const spine: { book: BookDocument; chapterIndex: number }[] = [];
  for (const b of books) {
    b.chapters.forEach((_, i) => spine.push({ book: b, chapterIndex: i }));
  }
  if (spine.length === 0) return { ...EMPTY, normalizedQuery: normalized };

  const chapterOf = (e: { book: BookDocument; chapterIndex: number }) => e.book.chapters[e.chapterIndex];
  const textless = spine.filter((e) => !(chapterOf(e).textContent || ""));

  let candidateIds: string[] = [];
  let degraded = false;
  let note: string | undefined;

  if (textless.length > 0) {
    const token = prefilterToken(normalized);
    if (!token) {
      // No plain word to narrow on (punctuation, non-ASCII). Read in spine
      // order under the cap rather than claiming a filtered search.
      candidateIds = textless.map((e) => chapterOf(e).id);
      degraded = true;
      note = "This query has no plain word the server can narrow on, so only the first chapters were read.";
    } else {
      const { data, error } = await supabase
        .from("chapters")
        .select("id")
        .eq("user_id", userId)
        .ilike("text_content", `%${escapeIlike(token)}%`)
        .limit(PREFILTER_CAP);
      if (error) {
        // The prefilter is an optimization; its failure must never become a
        // false "no matches".
        candidateIds = textless.map((e) => chapterOf(e).id);
        degraded = true;
        note = "Search narrowing was unavailable, so only the first chapters were read.";
      } else {
        const hit = new Set(((data as { id: string }[]) || []).map((r) => r.id));
        candidateIds = textless.filter((e) => hit.has(chapterOf(e).id)).map((e) => chapterOf(e).id);
      }
    }
  }

  const toFetch = candidateIds.slice(0, SEEK_FETCH_CAP);
  const notSearched = candidateIds.length - toFetch.length;
  const fetched = new Map<string, string>();
  await Promise.all(toFetch.map(async (id) => {
    try {
      const t = await deps.loadChapterText(id);
      if (t) fetched.set(id, t);
    } catch {
      // An unreadable chapter is not a zero result; it simply isn't searched.
    }
  }));

  const js = buildSearchPattern(normalized);
  const searchable = spine.map((e) => {
    const c = chapterOf(e);
    return { id: c.id, textContent: c.textContent || fetched.get(c.id) || "" };
  });
  const { results } = searchChaptersInMemory(searchable, js, SEEK_MATCH_CAP);

  const byChapterId = new Map(spine.map((e) => [chapterOf(e).id, e]));
  const hits: SeekHit[] = [];
  for (const r of results) {
    const entry = byChapterId.get(r.chapterId);
    if (!entry) continue;
    const c = chapterOf(entry);
    const raw = c.textContent || fetched.get(c.id) || "";
    for (const m of r.matches) {
      if (hits.length >= SEEK_MATCH_CAP) break;
      const { excerpt } = excerptAround(raw, m.charStart, m.charEnd);
      hits.push({
        bookId: entry.book.id,
        bookTitle: entry.book.title,
        chapterId: c.id,
        chapterName: c.name,
        page: approxPage(c, m.charStart, raw.length),
        excerpt,
        charStart: m.charStart,
        charEnd: m.charEnd,
      });
    }
  }

  return { hits, notSearched, degraded, note, normalizedQuery: normalized };
}
