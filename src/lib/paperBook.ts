/**
 * Paper books: a book the reader holds in their hands, brought into the
 * library one photographed page at a time.
 *
 * This file is the model — pure and DOM-light (only `parsePaperHtml` touches
 * DOMParser), so every rule here is unit-tested:
 *
 *   - what a scanned page IS (`PaperPage`),
 *   - where a new page goes among the ones already there (`placePages`),
 *   - how the pages become the book file the reader opens (`buildPaperHtml` /
 *     `parsePaperHtml` — the HTML is the one stored copy of the pages, so
 *     there is no second manifest to drift from it),
 *   - how they become chapters Counsel reads (`chaptersForPages` — one per
 *     page, written once and never rewritten),
 *   - what is spoken for a page, including the sentence that runs over the
 *     page turn (`speechFor`).
 *
 * PHOTOS ARE NOT PART OF THE MODEL. A page photo exists only in memory, from
 * the shutter until its words have been read off it; nothing here can hold a
 * reference to one, and nothing is uploaded. What is kept is the text.
 *
 * A paper book is an ordinary `.html` book with `sourceContext.kind ===
 * "paper"`. While `status` is "open" it is UNFINISHED: the Read tab shows the
 * scanning desk instead of the reader and the Library files it under
 * Unfinished. "Finish" only flips the status — nothing is converted, so
 * finishing and reopening are both instant and lossless.
 *
 * docs/paper-books.md has the reasoning and the research behind the choices.
 */

import type { BookDocument, Chapter } from "@/types/library";

export interface PaperPage {
  /** Stable short id. */
  id: string;
  /** The number printed on the page ("47", "xii"), when one was visible. */
  printed: string | null;
  /** A chapter or section title that STARTS on this page. */
  heading: string | null;
  /** Body text: paragraphs separated by a blank line. Verbatim. */
  text: string;
  footnotes: string[];
  /** One line per picture, chart or table on the page. */
  figures: string[];
  /** The body opens in the middle of a sentence carried from the page before. */
  startsMid: boolean;
  /** The body stops in the middle of a sentence that the next page finishes. */
  endsMid: boolean;
  /** How many spots the transcriber could not read (marked "[unclear]"). */
  unclear: number;
  /** The transcriber's own doubt about this page ("poor" = most of it could
   *  not be read or did not form sentences), or null. */
  flag: "partial" | "poor" | null;
  /** The reader looked at a doubted page and said it is fine. */
  checked: boolean;
  /** When it was scanned (epoch ms). */
  at: number;
}

export interface PaperMeta {
  kind: "paper";
  status: "open" | "done";
  /** Scanned pages so far. */
  pages: number;
  /** Printed number of the furthest page, for "last p. 57". */
  last_printed?: string | null;
  author?: string | null;
  /** Whole-book page count, if the reader told us. Enables a real percentage. */
  total_pages?: number | null;
  updated_at?: number;
}

type MetaCarrier = Pick<BookDocument, "sourceContext">;

export function paperMeta(book: MetaCarrier | null | undefined): PaperMeta | null {
  const ctx = book?.sourceContext as unknown as Partial<PaperMeta> | null | undefined;
  if (!ctx || ctx.kind !== "paper") return null;
  return {
    kind: "paper",
    status: ctx.status === "done" ? "done" : "open",
    pages: Number.isFinite(ctx.pages) ? Number(ctx.pages) : 0,
    last_printed: typeof ctx.last_printed === "string" ? ctx.last_printed : null,
    author: typeof ctx.author === "string" ? ctx.author : null,
    total_pages: typeof ctx.total_pages === "number" && ctx.total_pages > 0 ? ctx.total_pages : null,
    updated_at: typeof ctx.updated_at === "number" ? ctx.updated_at : undefined,
  };
}

export const isPaperBook = (book: MetaCarrier | null | undefined): boolean => paperMeta(book) !== null;
/** Still being scanned — the Library's "Unfinished". */
export const isUnfinishedPaper = (book: MetaCarrier | null | undefined): boolean => paperMeta(book)?.status === "open";

/** "12 pages · last p. 57" — the line an unfinished card and the desk share.
 *  Never a percentage unless the whole-book count is known: a bar that
 *  cannot say how far is left should not pretend to. */
export function paperProgressLabel(meta: PaperMeta): string {
  const n = meta.pages;
  const count = n === 0 ? "No pages yet" : `${n} page${n === 1 ? "" : "s"}`;
  return meta.last_printed ? `${count} · last p. ${meta.last_printed}` : count;
}

/** 0–1 through the book, or null when its length is unknown. */
export function paperFraction(meta: PaperMeta): number | null {
  if (!meta.total_pages) return null;
  const at = arabic(meta.last_printed ?? null) ?? meta.pages;
  return Math.max(0, Math.min(1, at / meta.total_pages));
}

/** A page's id is a UUID because it is ALSO the id of its chapter row. */
export function newPageId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

/** A printed page number as an integer, when it is a plain arabic one. */
export function arabic(printed: string | null): number | null {
  if (!printed) return null;
  const m = printed.trim().match(/^\d{1,5}$/);
  return m ? Number(m[0]) : null;
}

export interface Placement {
  pages: PaperPage[];
  /** Ids of pages that took the place of an earlier scan of the same page. */
  replaced: string[];
  /** Index of the first page added by this call. */
  firstIndex: number;
}

/**
 * Put freshly scanned pages among the existing ones.
 *
 * Capture order is the default — it is what the reader did. The printed
 * number overrides it in two cases only, both of which a person would call
 * obvious: the same number again is a RETAKE (it replaces the old scan in
 * place), and a number lower than one already in the book is a page scanned
 * out of order (it goes before the first page with a higher number).
 * Pages without a readable arabic number never move anything.
 */
export function placePages(existing: readonly PaperPage[], incoming: readonly PaperPage[]): Placement {
  const pages = existing.slice();
  const replaced: string[] = [];
  let firstIndex = -1;
  for (const page of incoming) {
    const n = arabic(page.printed);
    let at = pages.length;
    if (n !== null) {
      const same = pages.findIndex((p) => arabic(p.printed) === n);
      if (same !== -1) {
        replaced.push(pages[same].id);
        pages[same] = page;
        if (firstIndex === -1) firstIndex = same;
        continue;
      }
      const later = pages.findIndex((p) => { const m = arabic(p.printed); return m !== null && m > n; });
      if (later !== -1) at = later;
    }
    pages.splice(at, 0, page);
    if (firstIndex === -1 || at < firstIndex) firstIndex = at;
  }
  return { pages, replaced, firstIndex: Math.max(0, firstIndex) };
}

/** Runs of printed numbers that were skipped: [[43, 44]] = "p. 43–44 missing".
 *  Only between neighbours that both carry a number, and only small holes — a
 *  jump of fifty pages is someone skipping ahead, not a missed page. */
export function missingRuns(pages: readonly PaperPage[], maxHole = 6): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i < pages.length; i++) {
    const a = arabic(pages[i - 1].printed);
    const b = arabic(pages[i].printed);
    if (a === null || b === null) continue;
    const hole = b - a - 1;
    if (hole >= 1 && hole <= maxHole) out.push([a + 1, b - 1]);
  }
  return out;
}

export const pageLabel = (page: PaperPage, index: number): string =>
  page.printed ? `p. ${page.printed}` : `Scan ${index + 1}`;

// ── Pages that make no sense ────────────────────────────────────────────────

const wordsOf = (text: string): string[] =>
  text.replace(/\[unclear\]/gi, " ").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);

/** Letters and digits only, lower-cased: two readings of the same page come
 *  out equal however their spacing and punctuation differ. */
const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Why a page probably did not come in well — in the reader's words, most
 * serious first; empty when nothing looks wrong.
 *
 * Deliberately cheap and local: no second model call (a model asked to judge
 * a transcription is the same kind of model that made it, and over-correction
 * of clean text is a measured failure). These are the things a person
 * flipping through would spot at a glance:
 *
 *   - the transcriber itself said it could not read most of the page;
 *   - several "[unclear]" gaps;
 *   - almost no text at all;
 *   - text that is not words (a photo of a table top, a cover, a hand);
 *   - the same words over and over (a model stuck in a loop);
 *   - the very same page twice.
 *
 * Every threshold errs towards silence. A false alarm on a good page teaches
 * the reader to ignore the mark; a missed bad page is still one tap to delete.
 */
export function pageDoubts(page: PaperPage, all: readonly PaperPage[] = []): string[] {
  const out: string[] = [];
  const words = wordsOf(page.text);
  const picturesOnly = words.length === 0 && page.figures.length > 0;
  if (page.flag === "poor") out.push("Most of this page could not be read from the photo.");
  if (page.unclear >= 3) out.push(`${page.unclear} spots could not be read.`);
  else if (page.flag === "partial" && page.unclear === 0) out.push("Part of this page could not be read from the photo.");
  // Counted in letters as well as words: a page of Chinese is one "word" to a
  // whitespace split and is not short.
  const letters = (page.text.match(/\p{L}/gu) || []).length;
  if (!picturesOnly && words.length < 12 && letters < 60 && !page.heading) out.push("Very little text was found on it.");
  if (words.length >= 12) {
    // "Wordlike": letters only, a sane length, and (for Latin script) a vowel.
    const latin = words.filter((w) => /^[\p{Script=Latin}'’-]+$/u.test(w));
    const mostlyLatin = latin.length >= words.length * 0.6;
    const wordlike = words.filter((w) =>
      /^[\p{L}'’-]+$/u.test(w) && w.length <= 24 && (!mostlyLatin || w.length === 1 || /[aeiouyáéíóúàèìòùâêîôûäëïöüæœ]/i.test(w)),
    ).length;
    const numeric = words.filter((w) => /^[\p{N}.,:/%-]+$/u.test(w)).length;
    if ((wordlike + numeric * 0.5) / words.length < 0.6) out.push("The text does not read like sentences.");
    const single = words.filter((w) => w.length === 1 && !/^[aAiIoO\d]$/.test(w)).length;
    if (mostlyLatin && single / words.length > 0.3) out.push("The words came out broken into single letters.");
  }
  if (words.length >= 60) {
    const distinct = new Set(words.map((w) => w.toLowerCase())).size;
    if (distinct / words.length < 0.2) out.push("The same words repeat over and over.");
  }
  const mine = squash(page.text);
  if (mine.length >= 80) {
    const twin = all.findIndex((p) => p.id !== page.id && squash(p.text) === mine);
    if (twin !== -1) out.push(`It is the same as ${pageLabel(all[twin], twin)}.`);
  }
  return out;
}

/** Does this page want a look? Not once the reader has said it is fine. */
export const needsLook = (page: PaperPage, all: readonly PaperPage[] = []): boolean =>
  !page.checked && pageDoubts(page, all).length > 0;

// ── The book file ───────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const paragraphsOf = (text: string): string[] =>
  text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);

const PAPER_CSS = `
:root{color-scheme:light dark}
body{margin:0 auto;max-width:38rem;padding:1.5rem 1.25rem 6rem;font:1.08rem/1.7 Georgia,"Iowan Old Style","Times New Roman",serif;background:Canvas;color:CanvasText}
section{padding:0 0 1.25rem;margin:0 0 1.25rem;border-bottom:1px dashed color-mix(in srgb,CanvasText 22%,transparent)}
h2{font-size:1.3rem;line-height:1.3;margin:1.5rem 0 1rem}
p{margin:0 0 1rem}
aside{font:0.88rem/1.5 system-ui,sans-serif;opacity:.8;margin:0 0 .75rem;padding-left:.75rem;border-left:3px solid color-mix(in srgb,CanvasText 25%,transparent)}
footer{font:0.75rem/1 system-ui,sans-serif;opacity:.55;text-align:center;letter-spacing:.04em}
`.trim();

/**
 * The whole book as one HTML document: a `<section id="section-N">` per page
 * (the id the reader's Contents already scrolls to), carrying everything
 * `parsePaperHtml` needs to get the pages back out.
 */
export function buildPaperHtml(title: string, pages: readonly PaperPage[]): string {
  const sections = pages.map((p, i) => {
    const attrs = [
      `id="section-${i + 1}"`,
      `data-page-id="${esc(p.id)}"`,
      p.printed ? `data-printed="${esc(p.printed)}"` : "",
      `data-at="${p.at}"`,
      p.startsMid ? "data-starts-mid" : "",
      p.endsMid ? "data-ends-mid" : "",
      p.unclear ? `data-unclear="${p.unclear}"` : "",
      p.flag ? `data-flag="${p.flag}"` : "",
      p.checked ? "data-checked" : "",
    ].filter(Boolean).join(" ");
    const parts = [
      p.heading ? `<h2>${esc(p.heading)}</h2>` : "",
      ...paragraphsOf(p.text).map((t) => `<p>${esc(t)}</p>`),
      ...p.figures.map((f) => `<aside data-role="figure">${esc(f)}</aside>`),
      ...p.footnotes.map((f) => `<aside data-role="footnote">${esc(f)}</aside>`),
      `<footer>${esc(pageLabel(p, i))}</footer>`,
    ].filter(Boolean).join("\n");
    return `<section ${attrs}>\n${parts}\n</section>`;
  }).join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="cc-paper" content="1"><title>${esc(title)}</title><style>${PAPER_CSS}</style></head><body>\n${sections}\n</body></html>\n`;
}

/** The pages back out of a stored book file. Tolerant: a file that is not a
 *  paper book, or is damaged, yields whatever sections it can and never throws. */
export function parsePaperHtml(html: string): PaperPage[] {
  if (!html || typeof DOMParser === "undefined") return [];
  let doc: Document;
  try { doc = new DOMParser().parseFromString(html, "text/html"); } catch { return []; }
  const out: PaperPage[] = [];
  doc.querySelectorAll("section[data-page-id]").forEach((el) => {
    const texts = (sel: string) => Array.from(el.querySelectorAll(sel), (n) => (n.textContent || "").trim()).filter(Boolean);
    out.push({
      id: el.getAttribute("data-page-id") || newPageId(),
      printed: el.getAttribute("data-printed") || null,
      heading: (el.querySelector("h2")?.textContent || "").trim() || null,
      text: texts("p").join("\n\n"),
      footnotes: texts('aside[data-role="footnote"]'),
      figures: texts('aside[data-role="figure"]'),
      startsMid: el.hasAttribute("data-starts-mid"),
      endsMid: el.hasAttribute("data-ends-mid"),
      unclear: Number(el.getAttribute("data-unclear")) || 0,
      flag: el.getAttribute("data-flag") === "poor" ? "poor" : el.getAttribute("data-flag") === "partial" ? "partial" : null,
      checked: el.hasAttribute("data-checked"),
      at: Number(el.getAttribute("data-at")) || 0,
    });
  });
  return out;
}

// ── Chapters (what Counsel reads) ───────────────────────────────────────────

/**
 * ONE CHAPTER ROW PER SCANNED PAGE, and its id is the page's id.
 *
 * The app's law is that a chapter's text never changes under its id — saved
 * cards and quotes point into it by character offset
 * (docs/stage2-card-pointers.md §1, pinned by chapterImmutability.test). A
 * growing book cannot keep that law with chapters that span pages: every new
 * page would rewrite the last chapter. So a page is the unit. Adding a page
 * is one INSERT; a retake is a new page (new id) replacing the old row;
 * nothing already written is ever touched again, and a card made from page 47
 * still points at page 47 after page 300 arrives.
 */
export interface PaperChapter {
  /** The page's id. */
  id: string;
  name: string;
  /** 1-based position in the page list (the reader's section number). */
  startPage: number;
  endPage: number;
  textContent: string;
}

/** One page as Counsel sees it: a page marker it can cite, then everything on
 *  the page — body, pictures, footnotes. (Speech takes the body only.) */
export function pageTextForChat(page: PaperPage, index: number): string {
  const parts = [`[${pageLabel(page, index)}]`];
  if (page.heading) parts.push(page.heading);
  if (page.text.trim()) parts.push(page.text.trim());
  for (const f of page.figures) parts.push(`[Figure: ${f}]`);
  for (const f of page.footnotes) parts.push(`[Footnote: ${f}]`);
  return parts.join("\n\n");
}

/** What Counsel is told about a page that did not come in well. In the NAME,
 *  because a name may change (a chapter's text may not) and the name is what
 *  heads the page in everything Counsel is sent. */
export const POOR_SCAN_MARK = "(poor scan, may be wrong)";

/** "p. 41 · Chapter Four" where a title starts, else "p. 42" / "Scan 3". */
export function chapterName(page: PaperPage, index: number, poor = false): string {
  const label = pageLabel(page, index);
  const name = (page.heading ? `${label} · ${page.heading.trim()}` : label).slice(0, 110);
  return poor ? `${name} ${POOR_SCAN_MARK}` : name;
}

export function chaptersForPages(pages: readonly PaperPage[]): PaperChapter[] {
  return pages.map((p, i) => ({
    id: p.id, name: chapterName(p, i, needsLook(p, pages)), startPage: i + 1, endPage: i + 1, textContent: pageTextForChat(p, i),
  }));
}

export interface ChapterPlan {
  /** Pages with no row yet. */
  insert: PaperChapter[];
  /** Rows whose POSITION or NAME moved (a page filed earlier shifts the rest). Never text. */
  move: Array<Pick<PaperChapter, "id" | "name" | "startPage" | "endPage">>;
  /** Rows whose page is gone (removed, or replaced by a retake). */
  remove: string[];
}

/** The writes that bring the stored rows in line with the pages. Text is only
 *  ever inserted — there is no update of it to plan. */
export function planChapterSync(
  existing: ReadonlyArray<Pick<Chapter, "id" | "name" | "startPage" | "endPage">>,
  wanted: readonly PaperChapter[],
): ChapterPlan {
  const have = new Map(existing.map((c) => [c.id, c]));
  const keep = new Set(wanted.map((w) => w.id));
  const plan: ChapterPlan = { insert: [], move: [], remove: existing.filter((c) => !keep.has(c.id)).map((c) => c.id) };
  for (const w of wanted) {
    const h = have.get(w.id);
    if (!h) plan.insert.push(w);
    else if (h.name !== w.name || h.startPage !== w.startPage || h.endPage !== w.endPage) {
      plan.move.push({ id: w.id, name: w.name, startPage: w.startPage, endPage: w.endPage });
    }
  }
  return plan;
}

// ── Speech ──────────────────────────────────────────────────────────────────

const SENTENCE_END = /[.!?…]["'”’)\]]*\s*$/;

/** Split a body into what can be spoken now and the unfinished sentence at
 *  its end (empty when the page ends on a full stop). */
export function splitTrailingFragment(text: string): { spoken: string; fragment: string } {
  const t = text.trimEnd();
  if (!t || SENTENCE_END.test(t)) return { spoken: t, fragment: "" };
  // The last sentence boundary: terminator, optional closers, then whitespace.
  const re = /[.!?…]["'”’)\]]*\s+/g;
  let cut = -1;
  for (let m = re.exec(t); m; m = re.exec(t)) cut = m.index + m[0].length;
  if (cut === -1) return { spoken: "", fragment: t };
  return { spoken: t.slice(0, cut).trimEnd(), fragment: t.slice(cut) };
}

/** Join a carried fragment to the text that finishes it. A word broken by a
 *  line-end hyphen ("under-" + "standing") closes up; anything else gets a space. */
export function joinAcrossPages(fragment: string, next: string): string {
  const f = fragment.trimEnd();
  const n = next.trimStart();
  if (!f) return n;
  if (!n) return f;
  if (/\p{L}-$/u.test(f) && /^\p{Ll}/u.test(n)) return f.slice(0, -1) + n;
  return `${f} ${n}`;
}

/** The body as it is both SHOWN and SPOKEN on the desk: the title (if one
 *  starts here) and the paragraphs, a blank line between. One string for
 *  both, so a spoken word's offset is its place on screen. */
export function deskText(page: PaperPage): string {
  return [page.heading?.trim() || "", ...paragraphsOf(page.text)].filter(Boolean).join("\n\n");
}

export interface PageSpeech {
  /** What to say for this page now. */
  text: string;
  /** Characters at the front of `text` that belong to the page BEFORE (the
   *  carried sentence start). `text.slice(lead)` is a prefix of `deskText`. */
  lead: number;
  /** Sentence start held back until the next page arrives. */
  held: string;
}

/**
 * What is spoken for a page. Body only — never the running head, the page
 * number, footnotes or picture notes.
 *
 * A sentence that runs over the page turn is spoken WHOLE, once: its start
 * is held back from this page (when the next one is not scanned yet) and
 * carried into the next page's speech as `carry`.
 */
export function speechFor(page: PaperPage, opts: { carry?: string; nextReady: boolean }): PageSpeech {
  // "[unclear]" stays on screen but is not read out; blanked with spaces so
  // every offset still lines up with deskText.
  const body = deskText(page).replace(/\[unclear\]/gi, (m) => " ".repeat(m.length));
  let spoken = body;
  let held = "";
  if (page.endsMid && !opts.nextReady) ({ spoken, fragment: held } = splitTrailingFragment(body));
  const carry = (opts.carry || "").trim();
  if (!carry || !spoken) return { text: spoken || carry, lead: spoken ? 0 : carry.length, held };
  // A hyphen-broken word closes up, so the join is not always one space.
  const hyphenJoin = /\p{L}-$/u.test(carry) && /^\p{Ll}/u.test(spoken);
  const text = hyphenJoin ? carry.slice(0, -1) + spoken : `${carry} ${spoken}`;
  return { text, lead: text.length - spoken.length, held };
}

/** A new, empty paper book's title until the cover or a running head names it. */
export function untitledPaperTitle(now = new Date()): string {
  return `Paper book · ${now.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export const isPlaceholderPaperTitle = (title: string): boolean => /^Paper book · /.test(title);
