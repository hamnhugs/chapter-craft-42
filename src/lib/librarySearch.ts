import type { BookDocument } from "@/types/library";

/**
 * Vault search: what the library's own search box matches on.
 *
 * It used to see title, category and tags only — so chapter names and the
 * summaries the app spends the user's key generating were invisible to it,
 * and the Vault offered exactly two ways to find anything: recall the title,
 * or ask the assistant. Teevan et al. (CHI 2004) measured 61% of real
 * re-finding as ORIENTEERING — small contextual steps toward a remembered
 * place — which is the middle this had none of.
 *
 * Case- and diacritic-insensitive; every typed token must appear somewhere in
 * the book's searchable text (AND semantics), which is what makes typing more
 * words narrow rather than widen.
 *
 * NOT the same machinery as bookSearch.ts. That is an exact-text seek over
 * chapter bodies with offsets, used for locators and quotes. This is a
 * fuzzy-ish metadata filter over what is already in memory. Keeping them
 * separate is deliberate: this one must never mint an anchor.
 */

export const normalizeText = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export const tokenize = (query: string): string[] =>
  normalizeText(query).split(/\s+/).filter(Boolean);

/** Everything about a book the search box can see, normalized once. */
export function bookHaystack(book: BookDocument): string {
  return normalizeText([
    book.title,
    book.category || "",
    ...(book.tags || []),
    book.summary || "",
    ...book.chapters.map((c) => c.name),
    ...book.chapters.map((c) => c.gist || ""),
  ].join(" "));
}

/** Just the spine: what a book card already says without opening anything. */
export function spineHaystack(book: BookDocument): string {
  return normalizeText([book.title, book.category || "", ...(book.tags || [])].join(" "));
}

export const matchesAll = (haystack: string, tokens: string[]): boolean =>
  tokens.every((t) => haystack.includes(t));

export interface ChapterMatch {
  name: string;
  gist?: string | null;
}

/**
 * Which chapter answered the query, when the book's spine did not.
 *
 * The orienteering step: "Solaris matched" is a teleport that leaves the user
 * to open the book and hunt, while "matched chapter 4, The Ocean" is a step
 * they can act on. Returns null when the spine already explains the match —
 * repeating the title back as a reason is noise.
 */
export function chapterMatch(book: BookDocument, tokens: string[]): ChapterMatch | null {
  if (tokens.length === 0) return null;
  if (matchesAll(spineHaystack(book), tokens)) return null;
  for (const c of book.chapters) {
    if (matchesAll(normalizeText(`${c.name} ${c.gist || ""}`), tokens)) {
      return { name: c.name, gist: c.gist };
    }
  }
  return null;
}
