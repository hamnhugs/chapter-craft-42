/**
 * Reader highlights: passages the user marks while reading, saved with a
 * robust anchor and surfaced to chat as a signal of what they found
 * important.
 *
 * Why not memory cards: a highlight is automatic and cheap — no title, no
 * embedding, no Sleep Cycle. Minting a knowledge_entry per marked sentence
 * would crowd curated cards out of neuron retrieval and spend embedding
 * budget on every drag. "Save as card" promotes one explicitly.
 *
 * Anchoring (W3C Web Annotation, as Hypothesis does it): the quote plus a
 * little prefix/suffix context (TextQuoteSelector) and its offsets in the
 * rendered page text (TextPositionSelector). Re-anchoring tries the offsets
 * first, verified against the quote; then every exact occurrence, scored by
 * how much surrounding context agrees; then a whitespace-flexible match —
 * so a re-rendered text layer with different spacing still finds the passage.
 */
import { supabase } from "@/integrations/supabase/client";
import { foldGlyphs } from "@/lib/bookSearch";
import type { BookDocument } from "@/types/library";

export const QUOTE_CONTEXT = 32;
export const QUOTE_MAX_CHARS = 4000;
export const NOTE_MAX_CHARS = 2000;

export interface BookHighlight {
  id: string;
  book_id: string;
  /** 1-based PDF page; null for HTML books. */
  page: number | null;
  quote: string;
  prefix: string;
  suffix: string;
  pos_start: number;
  pos_end: number;
  chapter_id: string | null;
  char_start: number | null;
  char_end: number | null;
  note: string | null;
  created_at: string;
}

export type NewHighlight = Omit<BookHighlight, "id" | "created_at" | "chapter_id" | "char_start" | "char_end" | "note"> &
  Partial<Pick<BookHighlight, "chapter_id" | "char_start" | "char_end" | "note">>;

// ── Anchoring (pure) ──────────────────────────────────────────────────────

export interface TextQuote {
  quote: string;
  prefix: string;
  suffix: string;
  pos_start: number;
  pos_end: number;
}

/** Selector for text[start, end), with edge whitespace trimmed off. */
export function quoteSelector(text: string, start: number, end: number): TextQuote | null {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e - s > QUOTE_MAX_CHARS) e = s + QUOTE_MAX_CHARS;
  if (e <= s) return null;
  return {
    quote: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - QUOTE_CONTEXT), s),
    suffix: text.slice(e, e + QUOTE_CONTEXT),
    pos_start: s,
    pos_end: e,
  };
}

/** Worth saving: at least two words and 8 characters. A double-tap on a phone
 *  selects one word, and that should not leave a mark behind. */
export function isHighlightWorthy(quote: string): boolean {
  const q = quote.trim();
  return q.length >= 8 && /\S\s+\S/.test(q);
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

const MAX_CANDIDATES = 200;

/** Where `sel` sits in `text` now, or null when the passage is gone. */
export function anchorInText(text: string, sel: TextQuote): { start: number; end: number } | null {
  const { quote } = sel;
  if (!quote || !text) return null;
  if (text.slice(sel.pos_start, sel.pos_end) === quote) return { start: sel.pos_start, end: sel.pos_end };

  const score = (start: number, end: number) =>
    commonSuffixLen(text.slice(Math.max(0, start - sel.prefix.length), start), sel.prefix) +
    commonPrefixLen(text.slice(end, end + sel.suffix.length), sel.suffix) +
    // Ties go to the occurrence nearest the saved position.
    (1 - Math.min(1, Math.abs(start - sel.pos_start) / Math.max(1, text.length)));

  let best: { start: number; end: number; score: number } | null = null;
  for (let i = text.indexOf(quote), n = 0; i >= 0 && n < MAX_CANDIDATES; i = text.indexOf(quote, i + 1), n++) {
    const sc = score(i, i + quote.length);
    if (!best || sc > best.score) best = { start: i, end: i + quote.length, score: sc };
  }
  if (best) return { start: best.start, end: best.end };

  // Whitespace-flexible, glyph-folded (curly quotes, dashes): offsets carry
  // over because foldGlyphs replaces one char with one char.
  const tokens = foldGlyphs(quote).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "g");
  const folded = foldGlyphs(text);
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = pattern.exec(folded)) && n++ < MAX_CANDIDATES) {
    const sc = score(m.index, m.index + m[0].length);
    if (!best || sc > best.score) best = { start: m.index, end: m.index + m[0].length, score: sc };
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return best ? { start: best.start, end: best.end } : null;
}

/** Merge a new range with the existing ranges it overlaps or touches, the way
 *  Kindle does: extending a highlight replaces it rather than stacking. */
export function mergeRange(
  existing: ReadonlyArray<{ id: string; start: number; end: number }>,
  start: number,
  end: number,
): { start: number; end: number; absorbed: string[] } {
  let s = start;
  let e = end;
  const absorbed: string[] = [];
  let changed = true;
  const pending = [...existing];
  while (changed) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = pending[i];
      if (r.start <= e + 1 && r.end >= s - 1) {
        s = Math.min(s, r.start);
        e = Math.max(e, r.end);
        absorbed.push(r.id);
        pending.splice(i, 1);
        changed = true;
      }
    }
  }
  return { start: s, end: e, absorbed };
}

/** A highlight colour that never collides with the theme's read-along colour:
 *  warm gold, unless the theme's primary is itself near gold — then teal. */
export function highlightHue(primaryHsl: string | null | undefined): number {
  const GOLD = 45;
  const TEAL = 178;
  const hue = Number.parseFloat(String(primaryHsl ?? "").trim().split(/[\s,]+/)[0]);
  if (!Number.isFinite(hue)) return GOLD;
  const d = Math.abs(((hue % 360) + 360) % 360 - GOLD);
  return Math.min(d, 360 - d) < 40 ? TEAL : GOLD;
}

// ── Chat relevance (pure) ─────────────────────────────────────────────────

const STOPWORDS = new Set(
  ("the and for are but not you all any can had her was one our out has his how its may new now old see two who did get let say she too use " +
    "that this with from they will would there their what when where which while about into than then them these those have been were your " +
    "just like also more most some such only other over very much many each should could does doing done make made because between after " +
    "before being both same under again further once here why whom yours ours myself itself please tell explain thing things something " +
    "book books chapter page pages text passage passages highlight highlights highlighted marked mark")
    .split(" "),
);

function stem(w: string): string {
  if (w.length > 5) {
    for (const suf of ["ing", "ed", "es", "ly", "s"]) {
      if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
    }
  }
  return w;
}

export function contentTokens(s: string): string[] {
  const out = new Set<string>();
  for (const raw of String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return [...out];
}

const ASKS_ABOUT_HIGHLIGHTS =
  /\b(highlight(s|ed|ing)?|underlin(e|ed|es|ing)|(i|i've|i have|we)\s+(marked|flagged|saved)|my\s+(marks|notes\s+in|quotes))\b/i;

/** The user is asking about their highlights themselves. */
export function asksAboutHighlights(query: string | null | undefined): boolean {
  return ASKS_ABOUT_HIGHLIGHTS.test(String(query || ""));
}

/**
 * Highlights on topic for `query`, best first. A highlight needs two distinct
 * query words; a query with only one content word counts only when that word
 * is distinctive (5+ letters) — one short shared word is how "ok so what about
 * the war" would drag in every war passage.
 */
export function rankHighlightsForQuery<T extends Pick<BookHighlight, "quote" | "note" | "created_at">>(
  highlights: readonly T[],
  query: string,
  limit: number,
): T[] {
  const q = contentTokens(query);
  if (q.length === 0) return [];
  if (q.length === 1 && q[0].length < 5) return [];
  const need = Math.min(2, q.length);
  const scored: Array<{ h: T; score: number }> = [];
  for (const h of highlights) {
    const tokens = new Set(contentTokens(`${h.quote} ${h.note ?? ""}`));
    let hits = 0;
    let weight = 0;
    for (const t of q) {
      if (tokens.has(t)) {
        hits++;
        weight += Math.min(t.length, 10);
      }
    }
    if (hits >= need) scored.push({ h, score: weight + hits * 5 });
  }
  scored.sort((a, b) => b.score - a.score || b.h.created_at.localeCompare(a.h.created_at));
  return scored.slice(0, limit).map((x) => x.h);
}

// ── Store ─────────────────────────────────────────────────────────────────

const COLUMNS = "id, book_id, page, quote, prefix, suffix, pos_start, pos_end, chapter_id, char_start, char_end, note, created_at";
const EMPTY: readonly BookHighlight[] = Object.freeze([]);
const RECENT_TTL_MS = 60_000;

export type HighlightStorage = "unknown" | "saved" | "session";

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /book_highlights/.test(error.message || "") && /does not exist|schema cache/i.test(error.message || "");
}

class HighlightStore {
  private byBook = new Map<string, readonly BookHighlight[]>();
  private loads = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private recentCache: { at: number; rows: BookHighlight[] } | null = null;
  /** "session": the table isn't there yet — highlights live until reload. */
  storage: HighlightStorage = "unknown";

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private emit() {
    this.recentCache = null;
    for (const fn of this.listeners) fn();
  }

  get(bookId: string | null | undefined): readonly BookHighlight[] {
    return (bookId && this.byBook.get(bookId)) || EMPTY;
  }

  private set(bookId: string, rows: readonly BookHighlight[]) {
    this.byBook.set(bookId, rows);
    this.emit();
  }

  ensure(bookId: string): Promise<void> {
    if (this.byBook.has(bookId)) return Promise.resolve();
    const pending = this.loads.get(bookId);
    if (pending) return pending;
    const load = (async () => {
      const { data, error } = await (supabase.from("book_highlights" as any) as any)
        .select(COLUMNS)
        .eq("book_id", bookId)
        .order("created_at", { ascending: true })
        .limit(5000);
      if (error) {
        if (isMissingTable(error)) this.storage = "session";
        else {
          this.loads.delete(bookId); // transient — retry on the next ensure
          return;
        }
      } else if (this.storage === "unknown") {
        this.storage = "saved";
      }
      // Keep anything added while the fetch was in flight.
      const local = this.byBook.get(bookId) ?? [];
      const fetched = (data as BookHighlight[] | null) ?? [];
      const ids = new Set(fetched.map((h) => h.id));
      this.set(bookId, [...fetched, ...local.filter((h) => !ids.has(h.id))]);
    })();
    this.loads.set(bookId, load);
    return load;
  }

  /** Optimistic: the mark appears at once and is rolled back if the save fails. */
  async add(row: NewHighlight): Promise<BookHighlight> {
    const full: BookHighlight = {
      chapter_id: null, char_start: null, char_end: null, note: null,
      ...row,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.set(row.book_id, [...this.get(row.book_id), full]);
    if (this.storage === "session") return full;
    const { error } = await (supabase.from("book_highlights" as any) as any).insert({
      id: full.id, book_id: full.book_id, page: full.page, quote: full.quote, prefix: full.prefix,
      suffix: full.suffix, pos_start: full.pos_start, pos_end: full.pos_end, chapter_id: full.chapter_id,
      char_start: full.char_start, char_end: full.char_end, note: full.note,
    });
    if (error) {
      if (isMissingTable(error)) {
        this.storage = "session";
        return full;
      }
      this.set(row.book_id, this.get(row.book_id).filter((h) => h.id !== full.id));
      throw new Error(error.message || "Couldn't save the highlight.");
    }
    this.storage = "saved";
    return full;
  }

  async remove(bookId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const before = this.get(bookId);
    const drop = new Set(ids);
    this.set(bookId, before.filter((h) => !drop.has(h.id)));
    if (this.storage === "session") return;
    const { error } = await (supabase.from("book_highlights" as any) as any).delete().in("id", [...ids]);
    if (error && !isMissingTable(error)) {
      this.set(bookId, before);
      throw new Error(error.message || "Couldn't remove the highlight.");
    }
  }

  /** Best-effort patch (chapter anchoring, notes); local state updates first. */
  async update(bookId: string, id: string, patch: Partial<Pick<BookHighlight, "chapter_id" | "char_start" | "char_end" | "note">>): Promise<void> {
    const before = this.get(bookId);
    if (!before.some((h) => h.id === id)) return;
    this.set(bookId, before.map((h) => (h.id === id ? { ...h, ...patch } : h)));
    if (this.storage === "session") return;
    const { error } = await (supabase.from("book_highlights" as any) as any).update(patch).eq("id", id);
    if (error && !isMissingTable(error)) throw new Error(error.message || "Couldn't update the highlight.");
  }

  /** The user's most recent highlights across the library (for chat). */
  async recent(limit = 200): Promise<BookHighlight[]> {
    if (this.recentCache && Date.now() - this.recentCache.at < RECENT_TTL_MS) return this.recentCache.rows;
    let rows: BookHighlight[] = [];
    if (this.storage !== "session") {
      const { data, error } = await (supabase.from("book_highlights" as any) as any)
        .select(COLUMNS)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error && isMissingTable(error)) this.storage = "session";
      else if (!error) rows = (data as BookHighlight[] | null) ?? [];
    }
    // Local rows (unsaved session highlights, or ones newer than the fetch).
    const seen = new Set(rows.map((h) => h.id));
    for (const list of this.byBook.values()) for (const h of list) if (!seen.has(h.id)) rows.push(h);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    this.recentCache = { at: Date.now(), rows };
    return rows;
  }
}

export const highlightStore = new HighlightStore();

// ── Chat turn context ─────────────────────────────────────────────────────

export interface PromptHighlight {
  bookTitle: string;
  chapterName?: string;
  chapterId?: string;
  charStart?: number;
  page?: number | null;
  quote: string;
  note?: string | null;
}

export interface TurnHighlights {
  /** "asked": the user asked about their highlights; "matched": on topic. */
  mode: "asked" | "matched";
  items: PromptHighlight[];
}

export const ASKED_HIGHLIGHT_LIMIT = 12;
export const MATCHED_HIGHLIGHT_LIMIT = 5;

export function toPromptHighlight(h: BookHighlight, books: readonly BookDocument[]): PromptHighlight | null {
  const book = books.find((b) => b.id === h.book_id);
  if (!book) return null; // deleted or trashed book: not part of the library the model sees
  const chapter = h.chapter_id ? book.chapters.find((c) => c.id === h.chapter_id) : undefined;
  return {
    bookTitle: book.title || "Untitled",
    chapterName: chapter?.name,
    chapterId: chapter?.id,
    charStart: chapter && h.char_start != null ? h.char_start : undefined,
    page: h.page,
    quote: h.quote,
    note: h.note,
  };
}

/**
 * Pick the highlights worth adding to this message's context — nothing on most
 * turns. Asking about highlights lists them (topic-ranked when the question
 * has a topic, most recent otherwise, books in play first); any other message
 * only gets highlights from the books in play that clearly match its words.
 */
export function selectTurnHighlights(args: {
  query: string | null | undefined;
  books: readonly BookDocument[];
  inPlayBookIds: readonly string[];
  inPlay: readonly BookHighlight[];
  recent: readonly BookHighlight[];
}): TurnHighlights | null {
  const query = String(args.query || "").trim();
  if (!query) return null;
  const toPrompt = (list: readonly BookHighlight[]) =>
    list.map((h) => toPromptHighlight(h, args.books)).filter((x): x is PromptHighlight => !!x);

  if (asksAboutHighlights(query)) {
    const pool = new Map<string, BookHighlight>();
    for (const h of [...args.inPlay, ...args.recent]) pool.set(h.id, h);
    const all = [...pool.values()];
    const ranked = rankHighlightsForQuery(all, query, ASKED_HIGHLIGHT_LIMIT);
    const inPlay = new Set(args.inPlayBookIds);
    const byRecency = all
      .slice()
      .sort((a, b) => Number(inPlay.has(b.book_id)) - Number(inPlay.has(a.book_id)) || b.created_at.localeCompare(a.created_at));
    const items = toPrompt(ranked.length > 0 ? ranked : byRecency).slice(0, ASKED_HIGHLIGHT_LIMIT);
    return { mode: "asked", items };
  }
  const items = toPrompt(rankHighlightsForQuery(args.inPlay, query, MATCHED_HIGHLIGHT_LIMIT));
  return items.length > 0 ? { mode: "matched", items } : null;
}

/** Loads what selectTurnHighlights needs. Never throws — highlights are optional context. */
export async function highlightsForTurn(args: {
  query: string | null | undefined;
  books: readonly BookDocument[];
  inPlayBookIds: readonly string[];
}): Promise<TurnHighlights | null> {
  try {
    if (!String(args.query || "").trim()) return null;
    const asked = asksAboutHighlights(args.query);
    await Promise.all(args.inPlayBookIds.map((id) => highlightStore.ensure(id)));
    const inPlay = args.inPlayBookIds.flatMap((id) => highlightStore.get(id));
    const recent = asked ? await highlightStore.recent() : [];
    return selectTurnHighlights({ ...args, inPlay, recent });
  } catch {
    return null;
  }
}
