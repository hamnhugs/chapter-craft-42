import { supabase } from "@/integrations/supabase/client";
import type { BookDocument, Chapter } from "@/types/library";

// Book figures, as the READ side sees them.
//
// figureJobs writes one image_attachments row per extracted figure
// (kind='figure', book_id, page). Nothing on a row names a chapter, on
// purpose: chapter ids are replaced wholesale by a re-detect, while a page
// number is a fact about the file. So a figure's chapter is DERIVED here, at
// read time, from the page and the book's current chapter ranges — it can
// never go stale and it needs no migration.
//
// Everything a figure says about itself (label, caption) is VISION-MODEL text
// written from book content: untrusted, stored raw, sanitized at each door
// that hands it to a model — the same contract as chapter gists.

export interface BookFigure {
  /** image_attachments.id — the image_id every image tool accepts. */
  id: string;
  bookId: string;
  page: number;
  /** Short label (the vision model's alt), provenance prefix stripped. */
  label: string;
  /** 2–4 sentence description, including any text readable in the figure. */
  caption: string;
  storagePath: string;
}

/** The stored one-liner is `Fig. p. 12 (Chapter) of "Title" — <alt>`. The alt
 *  is everything after the FIRST em-dash separator; older or hand-made rows
 *  without one are used whole. */
export function labelFromPrompt(prompt: string | null | undefined): string {
  const p = (prompt || "").replace(/\s+/g, " ").trim();
  const cut = p.indexOf(" — ");
  const label = cut >= 0 && /^Fig\. p\. \d+/.test(p) ? p.slice(cut + 3).trim() : p;
  return label || "Figure";
}

interface FigureRow {
  id: string;
  book_id: string;
  page: number | null;
  prompt: string | null;
  caption: string | null;
  storage_path: string;
}

const toFigure = (r: FigureRow): BookFigure => ({
  id: r.id,
  bookId: r.book_id,
  page: Math.max(1, Number(r.page) || 1),
  label: labelFromPrompt(r.prompt),
  caption: (r.caption || "").replace(/\s+/g, " ").trim(),
  storagePath: r.storage_path,
});

// ── Cache ───────────────────────────────────────────────────────────────────
// Figures change only when an extraction runs or an image is deleted, and
// both announce themselves on the window ("image-attachments-changed"). A
// short TTL covers writes made from another tab or device.
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; figures: BookFigure[] }>();
const listeners = new Set<() => void>();

export function invalidateBookFigures(bookId?: string): void {
  if (bookId) cache.delete(bookId);
  else cache.clear();
  listeners.forEach((l) => l());
}

/** Subscribe to "figures may have changed" (for views that show them). */
export function onBookFiguresChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  window.addEventListener("image-attachments-changed", () => invalidateBookFigures());
}

/**
 * Every extracted figure for the given books, in reading order per book.
 * One query for all uncached books. A failure (offline, or the figures
 * migration missing) resolves to "no figures" rather than throwing: figures
 * are an enrichment, and a book read must never fail because of them.
 */
export async function loadFiguresForBooks(bookIds: string[]): Promise<Map<string, BookFigure[]>> {
  const out = new Map<string, BookFigure[]>();
  const now = Date.now();
  const need: string[] = [];
  for (const id of new Set(bookIds)) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.figures);
    else need.push(id);
  }
  if (need.length === 0) return out;
  try {
    const { data, error } = await (supabase.from("image_attachments" as never) as any)
      .select("id, book_id, page, prompt, caption, storage_path")
      .eq("kind", "figure")
      .in("book_id", need)
      .order("page", { ascending: true })
      .limit(2000);
    if (error) throw error;
    const grouped = new Map<string, BookFigure[]>();
    for (const row of (data as FigureRow[]) || []) {
      if (!row?.book_id || !row.storage_path) continue;
      const list = grouped.get(row.book_id) || [];
      list.push(toFigure(row));
      grouped.set(row.book_id, list);
    }
    for (const id of need) {
      const figures = grouped.get(id) || [];
      cache.set(id, { at: now, figures });
      out.set(id, figures);
    }
  } catch {
    for (const id of need) out.set(id, []);
  }
  return out;
}

export async function loadBookFigures(bookId: string): Promise<BookFigure[]> {
  return (await loadFiguresForBooks([bookId])).get(bookId) || [];
}

// ── Chapter placement ───────────────────────────────────────────────────────

type ChapterRange = Pick<Chapter, "id" | "name" | "startPage" | "endPage">;

/** Index of the chapter a page falls in (first match in reading order — the
 *  same rule figureJobs.chapterForPage applies at write time), or -1. */
export function chapterIndexForPage(chapters: ChapterRange[], page: number): number {
  return chapters.findIndex((c) => page >= c.startPage && page <= c.endPage);
}

export function figuresInChapter(figures: BookFigure[], chapters: ChapterRange[], chapterId: string): BookFigure[] {
  const idx = chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) return [];
  return figures.filter((f) => chapterIndexForPage(chapters, f.page) === idx);
}

/** chapter id → how many figures sit in it. Chapters with none are absent. */
export function figureCountsByChapter(figures: BookFigure[], chapters: ChapterRange[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of figures) {
    const idx = chapterIndexForPage(chapters, f.page);
    if (idx < 0) continue;
    const id = chapters[idx].id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// ── Search ──────────────────────────────────────────────────────────────────
// Captions are a vision model's paraphrase, so the exact-phrase predicate that
// search_book_text uses on book text would almost never hit. This is a plain
// keyword overlap instead: every content word of the query that appears in
// the label or caption scores, label hits count double, and a figure must
// match at least half the query's words to be returned at all. No embeddings
// — the corpus is at most a few hundred short captions, all already in memory.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "which", "show", "shows", "showing",
  "picture", "pictures", "image", "images", "figure", "figures", "fig", "diagram", "diagrams",
  "illustration", "photo", "chart", "about", "into", "have", "does", "how", "are", "was", "its",
  "book", "chapter", "page", "please", "can", "you", "see", "look", "like", "any", "all", "one",
]);

/** Lowercased content words; a trailing plural "s" is folded so "valves"
 *  finds "valve". */
export function figureQueryTokens(query: string): string[] {
  const words = (query || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
  const out: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const stem = w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    if (!out.includes(stem)) out.push(stem);
  }
  return out.slice(0, 12);
}

export interface FigureHit { figure: BookFigure; score: number }

export function searchFigures(figures: BookFigure[], query: string, limit = 8): FigureHit[] {
  const tokens = figureQueryTokens(query);
  if (tokens.length === 0) return [];
  const needed = Math.max(1, Math.ceil(tokens.length / 2));
  const hits: FigureHit[] = [];
  for (const figure of figures) {
    const label = figure.label.toLowerCase();
    const caption = figure.caption.toLowerCase();
    let matched = 0;
    let score = 0;
    for (const t of tokens) {
      const inLabel = label.includes(t);
      const inCaption = caption.includes(t);
      if (!inLabel && !inCaption) continue;
      matched += 1;
      score += inLabel ? 2 : 1;
    }
    if (matched >= needed) hits.push({ figure, score: score + matched / tokens.length });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.figure.page - b.figure.page)
    .slice(0, Math.max(1, limit));
}

/** Figures on or next to a page — what a text-search hit should offer. */
export function figuresNearPage(figures: BookFigure[], page: number, spread = 1): BookFigure[] {
  return figures.filter((f) => Math.abs(f.page - page) <= spread);
}

/** Convenience for surfaces that hold a BookDocument. */
export function chapterRanges(book: Pick<BookDocument, "chapters">): ChapterRange[] {
  return book.chapters.map((c) => ({ id: c.id, name: c.name, startPage: c.startPage, endPage: c.endPage }));
}

// ── Handles ─────────────────────────────────────────────────────────────────
// What a model writes to point at a figure: the first 8 hex characters of the
// row id. A full UUID is 36 characters a small model has to copy perfectly
// into running prose; eight survive far better and cost a fifth of the tokens.
// Collisions inside one user's figures are a 1-in-4-billion-per-pair event,
// and a collision resolves to "ambiguous → show nothing", never a wrong image.

const HANDLE_RE = /^[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function figureHandle(id: string): string {
  return (id || "").slice(0, 8).toLowerCase();
}

export interface ResolvedFigure extends BookFigure { prompt: string; entryId: string | null }

const resolved = new Map<string, Promise<ResolvedFigure | null>>();
onBookFiguresChanged(() => resolved.clear());

/**
 * A figure by handle or full id — null when it does not exist, is not a book
 * figure, or the handle is ambiguous. Row-level security scopes the lookup to
 * the signed-in user, so an id a model invented (or lifted from hostile book
 * text) can only ever resolve to one of the user's own figures.
 */
export function resolveFigure(ref: string): Promise<ResolvedFigure | null> {
  const key = (ref || "").trim().toLowerCase();
  if (!HANDLE_RE.test(key) && !UUID_RE.test(key)) return Promise.resolve(null);
  const hit = resolved.get(key);
  if (hit) return hit;
  const run = (async (): Promise<ResolvedFigure | null> => {
    try {
      let q = (supabase.from("image_attachments" as never) as any)
        .select("id, book_id, page, prompt, caption, storage_path, entry_id")
        .eq("kind", "figure");
      q = UUID_RE.test(key)
        ? q.eq("id", key)
        // uuid columns have no LIKE; a prefix is a range.
        : q.gte("id", `${key}-0000-0000-0000-000000000000`).lte("id", `${key}-ffff-ffff-ffff-ffffffffffff`);
      const { data, error } = await q.limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return null;
      const row = data[0];
      if (!row?.storage_path) return null;
      return { ...toFigure(row), prompt: row.prompt || "", entryId: row.entry_id ?? null };
    } catch {
      return null;
    }
  })();
  resolved.set(key, run);
  // A miss is not cached: the figure may simply not have landed yet.
  void run.then((r) => { if (!r) resolved.delete(key); });
  return run;
}

// ── Markers ─────────────────────────────────────────────────────────────────
// A reply places a figure by writing [[fig:<handle>]] where it belongs. The
// app swaps the marker for the picture; everywhere text is read aloud, copied
// or summarized, the marker is removed.

/** Tolerant on purpose: models add spaces, capitals, "figure", or a full id. */
export const FIGURE_MARKER_RE = /\[\[\s*fig(?:ure)?\s*[:=]\s*([0-9a-fA-F]{8}(?:-[0-9a-fA-F-]{27,28})?)\s*\]\]/gi;
/** An unfinished marker at the very end of a streaming reply. */
const DANGLING_MARKER_RE = /\[\[?\s*(?:f(?:i(?:g(?:u(?:r(?:e)?)?)?)?)?)?\s*[:=]?\s*[0-9a-fA-F-]*\s*\]?$/;

/** How many figures one reply may show. Relevant pictures help learning and
 *  extra ones measurably hurt it (Mayer's coherence principle), so the app
 *  enforces a small ceiling whatever the model writes. */
export const MAX_FIGURES_PER_REPLY = 3;

export type ReplySegment = { kind: "text"; text: string } | { kind: "figure"; ref: string };

/**
 * Split a reply into prose and figure slots. Each figure appears once (the
 * first time it is placed), at most MAX_FIGURES_PER_REPLY in total, and never
 * one already in `alreadyShown` — markers past those limits vanish rather
 * than render as raw text.
 */
export function splitFigureMarkers(content: string, opts: { streaming?: boolean; alreadyShown?: ReadonlySet<string> } = {}): ReplySegment[] {
  let text = content || "";
  if (opts.streaming) {
    const m = text.match(DANGLING_MARKER_RE);
    if (m && m[0].startsWith("[[")) text = text.slice(0, m.index);
  }
  const out: ReplySegment[] = [];
  const seen = new Set<string>(opts.alreadyShown ? [...opts.alreadyShown].map(figureHandle) : []);
  let shown = 0;
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  for (const m of text.matchAll(FIGURE_MARKER_RE)) {
    pushText(text.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const ref = m[1].toLowerCase();
    const handle = figureHandle(ref);
    if (seen.has(handle) || shown >= MAX_FIGURES_PER_REPLY) continue;
    seen.add(handle);
    shown += 1;
    out.push({ kind: "figure", ref });
  }
  pushText(text.slice(last));
  return out.filter((s) => s.kind === "figure" || s.text.trim().length > 0);
}

/** The reply with every figure marker removed — for speech, copy, summaries. */
export function stripFigureMarkers(content: string): string {
  return (content || "").replace(FIGURE_MARKER_RE, "").replace(/\n{3,}/g, "\n\n");
}
