import type { Chapter } from "@/types/library";

/**
 * Exact-text seek over chapter text — the machinery behind the
 * `search_book_text` chat tool, locator anchoring (cardLocators), and the
 * capture flow (Card Catalog Stage 2, docs/stage2-card-pointers.md §4).
 *
 * THE ONE SHARED PREDICATE (design §2): case-insensitive, whitespace-run
 * flexible, 1:1 glyph-folded. Finding, write-time locator resolution, and
 * read-time verification all use it, so "find" and "verify" can never
 * disagree about the same document.
 *
 *  - WHITESPACE-FLEXIBLE: PDF-extracted text hard-wraps mid-sentence
 *    ("the law of\nsines"), so every whitespace run in the query matches any
 *    whitespace run in the text.
 *  - GLYPH-FOLDED: pdf.js routinely emits curly quotes, en/em-dashes and
 *    NBSP; the E3 verifier already forgives those, and a finder stricter
 *    than the verifier spirals retries (review finding). Folding is
 *    STRICTLY 1:1 (char for char), so offsets into the folded text ARE
 *    offsets into the raw text — no offset map, no drift.
 *  - Deliberately NOT typo-tolerant: "modern" never matches the OCR's
 *    "modem" — a search that silently corrects the text is how fake anchors
 *    get minted. Hyphenated line-breaks ("diffi- culties") are also not
 *    crossed in v1 (that needs an offset map); the 0-match hint teaches the
 *    recourse.
 *
 * The JS regex built here is the ONLY semantic authority for what matches.
 * The server-side prefilter (`prefilterToken`) is a PROVABLE SUPERSET, not a
 * translation: one `ilike %token%` on the query's longest ASCII-alphanumeric
 * token. Any text the JS predicate matches must contain every query token,
 * ASCII case-folds identically under ilike and the JS `i` flag, and glyph
 * folding never touches [a-zA-Z0-9] — so token containment strictly
 * over-approximates the predicate (pinned by a differential property test).
 * JS \s vs Postgres [[:space:]] never meet: the token contains no whitespace.
 */

export const SEARCH_QUERY_MIN = 3;
export const SEARCH_QUERY_MAX = 200;

/** One match inside one chapter. Offsets are UTF-16 code-unit indices into
 *  chapters.text_content — the app-wide unit (get_chapter_text slices with
 *  the same). */
export interface BookTextMatch {
  chapterId: string;
  charStart: number;
  charEnd: number;
  /** Verbatim RAW slice around the match (window ~160 before / ~240 after).
   *  Purity law: always a plain substring of the chapter — no decorations
   *  (a decorated excerpt copied faithfully would fail quote verification
   *  by construction). The caller decides fencing per surface. */
  excerpt: string;
  /** Offset of `excerpt`'s first char in the chapter. */
  excerptStart: number;
}

export interface ChapterSearchResult {
  chapterId: string;
  matches: BookTextMatch[];
  /** Matches found beyond the caps (honest-truncation law). */
  moreMatches: number;
}

const EXCERPT_BEFORE = 160;
const EXCERPT_AFTER = 240;
/** Pass-1 per-chapter keep, so a common term in early chapters cannot starve
 *  a deep target (review finding); pass 2 fills to the total in reading
 *  order. */
export const MATCHES_PER_CHAPTER_FIRST_PASS = 2;
export const MATCHES_PER_CHAPTER_SCAN = 8;
export const MATCHES_TOTAL = 12;

// ── The shared fold (1:1 — offsets are preserved by construction) ───────────

/** Curly/typographic single quotes → '  */
const SINGLE_QUOTES = /[‘’‚‛′ʼ]/g;
/** Curly/typographic double quotes → "  */
const DOUBLE_QUOTES = /[“”„‟″]/g;
/** Hyphen/dash variants → -  (U+2010..2015, minus U+2212) */
const DASHES = /[‐‑‒–—―−]/g;
/** Unicode spaces JS \s already matches but Postgres would not; folded to a
 *  plain space so the QUERY side never carries them into token extraction.
 *  (Folding the text side too keeps the fold involutive/idempotent.) */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;

/** 1:1 glyph fold — every replacement is exactly one char for one char. */
export function foldGlyphs(s: string): string {
  return s
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(ODD_SPACES, " ");
}

/** Strip control chars and collapse the query to something searchable.
 *  Returns null when nothing usable remains. */
export function normalizeSearchQuery(raw: unknown): string | null {
  const q = foldGlyphs(String(raw ?? ""))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_QUERY_MAX);
  return q.length >= SEARCH_QUERY_MIN ? q : null;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Build the authoritative JS pattern from one normalized query. Run it
 *  against FOLDED text (foldGlyphs) — offsets transfer to the raw text 1:1. */
export function buildSearchPattern(normalizedQuery: string): RegExp {
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const body = tokens.map((t) => t.replace(REGEX_META, "\\$&")).join("\\s+");
  // "g" so lastIndex walks all occurrences; "i" for case-insensitivity. No
  // "u": the pattern is all escaped literals; unicode mode buys nothing and
  // can only throw.
  return new RegExp(body, "gi");
}

/** The server-prefilter token: the longest ASCII-alphanumeric run (>=3) in
 *  the normalized query, lowercased. null = no usable token — the caller
 *  must degrade to fetching ALL in-scope text-less chapters (honestly). */
export function prefilterToken(normalizedQuery: string): string | null {
  const runs = normalizedQuery.match(/[a-zA-Z0-9]{3,}/g);
  if (!runs || runs.length === 0) return null;
  let best = runs[0];
  for (const r of runs) if (r.length > best.length) best = r;
  return best.toLowerCase();
}

/** Escape a token for a PostgREST/SQL `ilike %…%` pattern. The token is
 *  [a-z0-9]+ by construction, so this is belt-and-braces. */
export function escapeIlike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** All matches of the pattern in one chapter's RAW text (folded internally),
 *  capped. Non-overlapping; linear-time. */
export function searchChapterText(
  rawText: string,
  js: RegExp,
  scanCap: number = MATCHES_PER_CHAPTER_SCAN,
): { matches: Array<{ start: number; end: number }>; more: number } {
  const text = foldGlyphs(rawText);
  const matches: Array<{ start: number; end: number }> = [];
  let more = 0;
  js.lastIndex = 0;
  for (let m = js.exec(text); m; m = js.exec(text)) {
    if (matches.length < scanCap) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    } else {
      more++;
    }
    // Resume past the whole hit; the floor of 1 removes the zero-length
    // infinite-loop class outright.
    js.lastIndex = m.index + Math.max(1, m[0].length);
    // Past ~200 occurrences the count is "lots" — a pathological one-word
    // query over 384k chars must not spin.
    if (more > 200) { more = 201; break; }
  }
  return { matches, more };
}

/** Excerpt window around one match — a verbatim RAW substring, clamped. */
export function excerptAround(rawText: string, start: number, end: number): { excerpt: string; excerptStart: number } {
  const from = Math.max(0, start - EXCERPT_BEFORE);
  const to = Math.min(rawText.length, end + EXCERPT_AFTER);
  return { excerpt: rawText.slice(from, to), excerptStart: from };
}

/** Estimate the page a char offset falls on, from the chapter's page range.
 *  Display-only (extraction concatenates pages) — always label approximate. */
export function approxPage(ch: Pick<Chapter, "startPage" | "endPage">, offset: number, textLength: number): number {
  if (textLength <= 0) return ch.startPage;
  const span = Math.max(0, ch.endPage - ch.startPage);
  return ch.startPage + Math.min(span, Math.floor((offset / textLength) * (span + 1)));
}

/**
 * Search chapters that have text in hand, in the order given (reading order
 * is the caller's job). TWO PASSES over the per-chapter scans: pass 1 keeps
 * at most MATCHES_PER_CHAPTER_FIRST_PASS per chapter so early chapters
 * cannot starve a deep target; pass 2 fills remaining slots up to the total
 * cap in reading order. Every cut is counted.
 */
export function searchChaptersInMemory(
  chapters: ReadonlyArray<Pick<Chapter, "id" | "textContent">>,
  js: RegExp,
  totalCap: number = MATCHES_TOTAL,
): { results: ChapterSearchResult[]; total: number; moreTotal: number } {
  interface Scan {
    chapterId: string;
    text: string;
    hits: Array<{ start: number; end: number }>;
    more: number;
  }
  const scans: Scan[] = [];
  for (const ch of chapters) {
    const text = ch.textContent || "";
    if (!text) continue;
    const { matches, more } = searchChapterText(text, js);
    if (matches.length === 0 && more === 0) continue;
    scans.push({ chapterId: ch.id, text, hits: matches, more });
  }

  const takenPerScan = scans.map(() => 0);
  let total = 0;
  const take = (cap: (scanIdx: number) => number) => {
    for (let i = 0; i < scans.length && total < totalCap; i++) {
      while (takenPerScan[i] < Math.min(cap(i), scans[i].hits.length) && total < totalCap) {
        takenPerScan[i]++;
        total++;
      }
    }
  };
  take(() => MATCHES_PER_CHAPTER_FIRST_PASS);
  take((i) => scans[i].hits.length);

  const results: ChapterSearchResult[] = [];
  let moreTotal = 0;
  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const kept = s.hits.slice(0, takenPerScan[i]).map((m) => {
      const { excerpt, excerptStart } = excerptAround(s.text, m.start, m.end);
      return { chapterId: s.chapterId, charStart: m.start, charEnd: m.end, excerpt, excerptStart };
    });
    const dropped = (s.hits.length - takenPerScan[i]) + s.more;
    moreTotal += dropped;
    if (kept.length > 0 || dropped > 0) {
      results.push({ chapterId: s.chapterId, matches: kept, moreMatches: dropped });
    }
  }
  return { results, total, moreTotal };
}

/**
 * Find ONE anchoring span for a quote inside a chapter — the write-side
 * companion (locator resolution: models and the capture flow supply the
 * QUOTE; the app anchors it). Same predicate as search — find and verify
 * cannot disagree. Returns the FIRST occurrence plus the occurrence count so
 * callers can note ambiguity honestly.
 */
export function anchorQuote(
  rawText: string,
  quote: string,
): { start: number; end: number; occurrences: number } | null {
  const normalized = normalizeSearchQuery(quote);
  if (!normalized || !rawText) return null;
  const js = buildSearchPattern(normalized);
  const { matches, more } = searchChapterText(rawText, js);
  if (matches.length === 0) return null;
  return { start: matches[0].start, end: matches[0].end, occurrences: matches.length + more };
}
