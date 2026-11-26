/**
 * Cast voices, the part that runs while you listen.
 *
 * Every tool and paper that gives characters their own voices does it as an
 * offline batch: analyse the whole book, render the audio, then listen. This
 * works just ahead of the reader instead. The page is cut into windows; the
 * window being read (and the one after it) is attributed by one model call
 * each, while narration — which needs no analysis — is already playing. The
 * player asks "who says quote 7?" only when it is about to fetch that line's
 * audio, a few seconds before it is heard, so the answer is usually waiting.
 * If it is not there in time, the narrator reads the line: late is never
 * worse than what the reader did before this existed.
 *
 * What is kept, per book, on this device:
 *  - the cast (names, aliases, gender, age, voice, the listener's overrides);
 *  - each analysed window's verdicts, keyed by a hash of its text, so a page
 *    heard once is never paid for twice and always sounds the same.
 */
import { findQuotes, numberQuotes, type QuoteSpan } from "@/lib/castVoices/quotes";
import {
  buildAttributionMessages, mergeCast, parseAttribution, type CastMember,
} from "@/lib/castVoices/attribute";
import { castVoices, hash01 } from "@/lib/castVoices/casting";
import type { InworldVoice } from "@/lib/inworldTts";
import type { VoiceSpan } from "@/lib/readAlong";

/** A window is roughly a printed page: enough context for a conversation,
 *  short enough that its answer is back before the voice reaches it. */
const WINDOW_CHARS = 4500;
/** How long a line will wait for its verdict before the narrator takes it. */
const RESOLVE_TIMEOUT_MS = 7000;
const MAX_WINDOWS_STORED = 400;
const RECENT_KEPT = 6;

export interface StoredVerdict { m: string | null; how?: string }
export interface CastBook {
  v: 1;
  cast: CastMember[];
  /** window hash → one verdict per quote in that window. */
  windows: Record<string, StoredVerdict[]>;
  /** Window hashes, oldest first, for trimming. */
  order: string[];
}

export const emptyCastBook = (): CastBook => ({ v: 1, cast: [], windows: {}, order: [] });

const bookKey = (uid: string | null, bookId: string) => `bw_cast_${uid || "anon"}_${bookId}`;

export const castBookStore = {
  load(uid: string | null, bookId: string): CastBook {
    try {
      const o = JSON.parse(localStorage.getItem(bookKey(uid, bookId)) || "null");
      if (o && o.v === 1 && Array.isArray(o.cast) && o.windows && typeof o.windows === "object") {
        return { v: 1, cast: o.cast, windows: o.windows, order: Array.isArray(o.order) ? o.order : Object.keys(o.windows) };
      }
    } catch { /* corrupt or unavailable: start fresh */ }
    return emptyCastBook();
  },
  save(uid: string | null, bookId: string, book: CastBook): void {
    try {
      localStorage.setItem(bookKey(uid, bookId), JSON.stringify(book));
    } catch {
      // Storage full: drop the oldest half of the window cache and try once
      // more. The cast itself is small and is what must survive.
      try {
        const keep = book.order.slice(Math.floor(book.order.length / 2));
        const windows: CastBook["windows"] = {};
        for (const h of keep) if (book.windows[h]) windows[h] = book.windows[h];
        localStorage.setItem(bookKey(uid, bookId), JSON.stringify({ ...book, windows, order: keep }));
      } catch { /* the cast lives for this session only */ }
    }
  },
  clear(uid: string | null, bookId: string): void {
    try { localStorage.removeItem(bookKey(uid, bookId)); } catch { /* nothing to clear */ }
  },
};

/** Stable key for a stretch of text (two FNV passes; collisions would need
 *  the same length too). */
export function textHash(s: string): string {
  return `${s.length.toString(36)}.${Math.floor(hash01(s) * 1e5).toString(36)}.${Math.floor(hash01(`~${s}`) * 1e5).toString(36)}`;
}

/**
 * Worth a voice of its own? A quoted word or title in the middle of a
 * sentence (the so-called “expert”) is not speech; giving it its own audio
 * request would only chop the narrator's sentence in three. Speech carries
 * its own punctuation or runs to a few words.
 */
export function speechLike(q: QuoteSpan): boolean {
  return /[.,!?…—–-]$/.test(q.text) || q.text.split(/\s+/).length >= 4;
}

interface Window {
  /** Indices into the page's quotes: [first, last). */
  first: number;
  last: number;
  /** Source range the model is shown. */
  from: number;
  to: number;
  hash: string;
}

/** Cut the page into windows that each end between quotes, never inside one. */
export function planWindows(text: string, quotes: QuoteSpan[]): Window[] {
  const out: Window[] = [];
  let first = 0;
  let from = 0;
  while (first < quotes.length) {
    let last = first + 1;
    while (last < quotes.length && quotes[last].end - from <= WINDOW_CHARS) last++;
    const to = last < quotes.length ? quotes[last].start : text.length;
    out.push({ first, last, from, to, hash: textHash(text.slice(from, to)) });
    first = last;
    from = to;
  }
  return out;
}

export interface DirectorDeps {
  /** One model call: messages in, the reply's text out. */
  complete: (messages: Array<{ role: "system" | "user"; content: string }>, signal?: AbortSignal) => Promise<string>;
  /** The listener's voice catalog (fetched once, may still be loading). */
  voices: () => Promise<InworldVoice[]>;
  narratorVoiceId: string;
  bookTitle: string;
  /** The book's cast and cache; mutated in place and saved through `save`. */
  book: CastBook;
  save: (book: CastBook) => void;
  /** The cast changed (someone new spoke, a voice was assigned). */
  onCast?: (cast: CastMember[]) => void;
  /** Text and speakers from the page before this one, when read in order. */
  carry?: { before: string; recent: Array<{ speaker: string; text: string }> };
}

export interface ResolvedVoice { voiceId: string; direction?: string; name: string }

/**
 * One page's (or one HTML book's) casting. Created when reading starts,
 * thrown away when the text changes.
 */
export class CastDirector {
  readonly quotes: QuoteSpan[];
  /** One span per quote; `voice` is the quote's index, resolved at fetch time. */
  readonly spans: VoiceSpan[];
  private windows: Window[];
  private running = new Map<number, Promise<void>>();
  /** Analyses run one at a time: each needs the cast the last one left. */
  private chain: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private failed = 0;

  constructor(private text: string, private deps: DirectorDeps) {
    this.quotes = findQuotes(text).filter(speechLike);
    this.spans = this.quotes.map((q, i) => ({ start: q.start, end: q.end, voice: String(i) }));
    this.windows = planWindows(text, this.quotes);
  }

  dispose() { this.abort.abort(); }

  private windowOf(quote: number): number {
    return this.windows.findIndex((w) => quote >= w.first && quote < w.last);
  }

  /** Start work on the window holding source offset `at`, and the next. */
  warm(at: number) {
    let wi = this.windows.findIndex((w) => at < w.to);
    if (wi < 0) wi = this.windows.length - 1;
    if (wi < 0) return;
    void this.ensure(wi);
    if (wi + 1 < this.windows.length) void this.ensure(wi + 1);
  }

  private ensure(wi: number): Promise<void> {
    const w = this.windows[wi];
    if (!w || this.deps.book.windows[w.hash]) return Promise.resolve();
    let p = this.running.get(wi);
    if (!p) {
      p = this.chain = this.chain.then(() => this.analyse(wi)).catch(() => { /* narrator reads it */ });
      this.running.set(wi, p);
    }
    return p;
  }

  private async analyse(wi: number): Promise<void> {
    const w = this.windows[wi];
    const { book } = this.deps;
    if (book.windows[w.hash] || this.abort.signal.aborted) return;
    // After repeated failures (no key, model down) stop asking for this page.
    if (this.failed >= 2) return;
    const count = w.last - w.first;
    const local = this.quotes.slice(w.first, w.last);
    const numbered = numberQuotes(this.text, local, { from: w.from, to: w.to });
    const prevW = wi > 0 ? this.windows[wi - 1] : null;
    const before = prevW ? this.text.slice(Math.max(0, w.from - 3000), w.from) : (this.deps.carry?.before || "");
    const recent = prevW ? this.recentFrom(prevW) : (this.deps.carry?.recent || []);
    let raw: string;
    try {
      raw = await this.deps.complete(
        buildAttributionMessages({ bookTitle: this.deps.bookTitle, cast: book.cast, numbered, quoteCount: count, before, recent }),
        this.abort.signal,
      );
    } catch (e) {
      if (!this.abort.signal.aborted) this.failed++;
      throw e;
    }
    const parsed = parseAttribution(raw, count);
    if (!parsed) { this.failed++; return; }
    const merged = mergeCast(book.cast, parsed);
    const voices = await this.deps.voices().catch(() => [] as InworldVoice[]);
    book.cast = castVoices(merged.cast, voices, { narratorVoiceId: this.deps.narratorVoiceId });
    book.windows[w.hash] = merged.speakers.map((m, i) => ({ m, ...(parsed.verdicts[i].how ? { how: parsed.verdicts[i].how } : {}) }));
    book.order.push(w.hash);
    while (book.order.length > MAX_WINDOWS_STORED) delete book.windows[book.order.shift()!];
    this.deps.save(book);
    this.deps.onCast?.(book.cast);
  }

  private recentFrom(w: Window): Array<{ speaker: string; text: string }> {
    const verdicts = this.deps.book.windows[w.hash];
    if (!verdicts) return [];
    const out: Array<{ speaker: string; text: string }> = [];
    verdicts.forEach((v, i) => {
      const m = v.m ? this.deps.book.cast.find((c) => c.id === v.m) : null;
      if (m) out.push({ speaker: m.name, text: this.quotes[w.first + i].text });
    });
    return out.slice(-RECENT_KEPT);
  }

  /** What the next page should be told about this one. */
  carryOut(): { before: string; recent: Array<{ speaker: string; text: string }> } {
    const last = this.windows[this.windows.length - 1];
    return { before: this.text.slice(-3000), recent: last ? this.recentFrom(last) : (this.deps.carry?.recent || []) };
  }

  private lookup(quote: number): ResolvedVoice | null {
    const w = this.windows[this.windowOf(quote)];
    const v = w && this.deps.book.windows[w.hash]?.[quote - w.first];
    if (!v?.m) return null;
    const m = this.deps.book.cast.find((c) => c.id === v.m);
    if (!m?.voiceId) return null;
    return { voiceId: m.voiceId, name: m.name, ...(v.how ? { direction: v.how } : {}) };
  }

  /**
   * The voice for a quote, by its key (`spans[i].voice`). Null = the
   * narrator reads it: not speech, nobody could be named, the analysis
   * failed, or it did not arrive in time.
   */
  async resolve(key: string): Promise<ResolvedVoice | null> {
    const quote = Number(key);
    const wi = this.windowOf(quote);
    if (wi < 0) return null;
    const w = this.windows[wi];
    if (!this.deps.book.windows[w.hash]) {
      let timer = 0;
      const timeout = new Promise<void>((r) => { timer = window.setTimeout(r, RESOLVE_TIMEOUT_MS); });
      await Promise.race([this.ensure(wi), timeout]);
      window.clearTimeout(timer);
    }
    // Reading has reached this window: get the next one going.
    if (wi + 1 < this.windows.length) void this.ensure(wi + 1);
    // Someone known but voiceless (the catalog was not loaded when they
    // first spoke, or their voice has since left it): cast them now.
    if (this.deps.book.cast.some((m) => !m.voiceId)) {
      const voices = await this.deps.voices().catch(() => [] as InworldVoice[]);
      const recast = castVoices(this.deps.book.cast, voices, { narratorVoiceId: this.deps.narratorVoiceId });
      if (recast !== this.deps.book.cast && recast.some((m, i) => m.voiceId !== this.deps.book.cast[i]?.voiceId)) {
        this.deps.book.cast = recast;
        this.deps.save(this.deps.book);
        this.deps.onCast?.(recast);
      }
    }
    return this.lookup(quote);
  }
}
