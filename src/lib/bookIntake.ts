/**
 * Book intake: what the app works out for itself the moment a file lands, so
 * the reader never has to.
 *
 * Two things were manual and are not any more:
 *
 *  - the TITLE. A book used to be named after its file, extension stripped —
 *    "atomic_habits-james.clear(z-lib.org)" sat on the shelf until somebody
 *    renamed it by hand. `resolveTitle` picks the best of three sources (the
 *    PDF's own metadata, the largest text on page one, the cleaned file name).
 *  - the COVER. Nothing ever wrote one, so every book wore a generated
 *    placeholder. `probePdf` renders page one to a small JPEG in the same pass
 *    that counts the pages; lib/bookCovers.ts stores it.
 *
 * The title logic is pure and DOM-free (unit-tested). Only `probePdf` touches
 * pdf.js and a canvas.
 */

/** Junk that file-sharing sites, scanners and exporters leave in a name. */
const BRACKETED_JUNK =
  /[([{][^)\]}]*(z-?lib|libgen|lib\.?gen|b-?ok\.|1lib|annas?[-\s]?archive|pdfdrive|epub|pdf|mobi|azw3?|retail|scan|ocr|ebook|www\.|\.com|\.org|\.net)[^)\]}]*[)\]}]/gi;
const TRAILING_JUNK = /[\s._-]*(z-?lib(\.org)?|libgen(\.\w+)?|pdfdrive(\.com)?|annas?[-\s]?archive)\s*$/i;
/** "(1)", " copy", " - Copy", "_final", "_v2" — duplicate/export suffixes. */
const COPY_SUFFIX = /[\s._-]*(\(\d{1,2}\)|copy(\s*\d+)?|final|v\d{1,2})\s*$/i;

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "en", "for", "from", "in", "nor", "of", "on", "or", "per", "the", "to", "vs", "via", "with",
]);

function titleCase(s: string): string {
  const words = s.toLowerCase().split(" ");
  return words
    .map((w, i) => {
      if (!w) return w;
      if (i > 0 && i < words.length - 1 && SMALL_WORDS.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

const letters = (s: string) => (s.match(/\p{L}/gu) || []).length;

/**
 * A file name, made presentable. Never returns an empty string for a
 * non-empty input: whatever cleaning strips, the raw stem is the floor.
 */
export function cleanFileTitle(fileName: string): string {
  const stem = fileName.replace(/\.[^/.\s]{1,5}$/i, "");
  // Site names go first, while "libgen.li" is still one token.
  let t = stem.replace(BRACKETED_JUNK, " ").replace(TRAILING_JUNK, "");
  // Separators people type instead of spaces. A dot survives only when it is
  // already followed by a space ("Vol. 2") — "a.b.c" is a separator pattern.
  t = t.replace(/_+/g, " ").replace(/\.(?=\S)/g, " ");
  // Hyphens: keep " - " as a real dash, turn word-joining runs into spaces
  // only when the name has no spaces of its own (a slug).
  if (!/\s/.test(t.trim())) t = t.replace(/-+/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(TRAILING_JUNK, "").replace(COPY_SUFFIX, "").trim();
    if (next === t || !next) break;
    t = next;
  }
  t = t.replace(/^[\s\-–—.,;:]+|[\s\-–—.,;:]+$/g, "").replace(/\s{2,}/g, " ");
  if (!t) return stem.trim() || fileName;
  // Only re-case names that carry no casing information of their own.
  const hasLower = /\p{Ll}/u.test(t);
  const hasUpper = /\p{Lu}/u.test(t);
  if (letters(t) >= 3 && (!hasLower || !hasUpper)) t = titleCase(t);
  return t;
}

/**
 * Is this file name telling us nothing? "1707.03762v5", "scan0001",
 * "document (3)", a hash. For these, text found INSIDE the file is a better
 * title than anything derived from the name.
 */
export function isOpaqueFileName(fileName: string): boolean {
  const stem = fileName.replace(/\.[^/.\s]{1,5}$/i, "").trim();
  const l = letters(stem);
  if (l < 3) return true;
  if (/^(scan|img|image|doc|document|untitled|file|download|output|export|print|new\s*document)[\s._-]*[\d()]*$/i.test(stem)) return true;
  if (/^[0-9a-f]{12,}$/i.test(stem.replace(/[\s._-]/g, ""))) return true;
  // Mostly digits: arXiv ids, ISBNs, timestamps.
  const digits = (stem.match(/\d/g) || []).length;
  return digits > l;
}

/**
 * Is this string plausibly a title a person would recognise? Rejects what PDF
 * producers write into the Title field by default: the source file name
 * ("Microsoft Word - draft3.docx"), a path, a placeholder.
 */
export function isPlausibleTitle(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > 160) return false;
  if (letters(t) < 3) return false;
  if (/^(untitled|unknown|no title|title|document\d*|slide \d+|presentation\d*|null|undefined)$/i.test(t)) return false;
  if (/^(microsoft (word|powerpoint|excel)|adobe|pdf|scanned|scan)\b/i.test(t)) return false;
  if (/\.(docx?|pdf|pptx?|indd|tex|dvi|qxd|rtf|pages|xlsx?|epub|html?)$/i.test(t)) return false;
  if (/[\\/]/.test(t) && !/\s/.test(t)) return false; // a path
  if (isOpaqueFileName(t)) return false;
  return true;
}

export interface TitleSources {
  fileName: string;
  /** The PDF Info dictionary's Title, if any. */
  metadataTitle?: string | null;
  /** The largest text on page one, if any. */
  headingTitle?: string | null;
}

/**
 * The title a freshly-uploaded book gets.
 *
 * Order of trust: the document's own metadata when it reads like a title;
 * otherwise the file name — unless the name is opaque, in which case the
 * heading printed on the first page wins. The heading is deliberately the
 * last resort for a readable file name: page-one layouts vary too much
 * (running heads, journal banners) to outrank a name a person chose.
 */
export function resolveTitle({ fileName, metadataTitle, headingTitle }: TitleSources): string {
  const tidy = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    const hasLower = /\p{Ll}/u.test(t);
    return hasLower ? t : titleCase(t);
  };
  if (isPlausibleTitle(metadataTitle)) return tidy(metadataTitle);
  if (isOpaqueFileName(fileName) && isPlausibleTitle(headingTitle)) return tidy(headingTitle);
  return cleanFileTitle(fileName);
}

export interface TextRun {
  str: string;
  /** Rendered glyph height in page units. */
  size: number;
  /** Baseline y in page units (PDF space: larger = higher on the page). */
  y: number;
}

/**
 * The heading on a page: the lines set in its largest type, top to bottom.
 *
 * Runs within 8% of the largest size count as the same size (a title that
 * wraps is rarely set in exactly equal sizes across pdf producers). Capped at
 * three lines — beyond that the "largest text" is body copy, not a heading.
 */
export function headingFromRuns(runs: TextRun[]): string | null {
  const usable = runs.filter((r) => r.str.trim().length > 0 && r.size > 0);
  if (usable.length === 0) return null;
  const max = Math.max(...usable.map((r) => r.size));
  const big = usable.filter((r) => r.size >= max * 0.92);
  // The largest type is the body text itself on a plain page.
  if (big.length > usable.length * 0.6 && usable.length > 12) return null;
  const lines: { y: number; text: string }[] = [];
  for (const r of big) {
    const line = lines.find((l) => Math.abs(l.y - r.y) < max * 0.5);
    if (line) line.text += (line.text.endsWith(" ") || r.str.startsWith(" ") ? "" : " ") + r.str;
    else lines.push({ y: r.y, text: r.str });
  }
  lines.sort((a, b) => b.y - a.y);
  if (lines.length > 3) return null;
  const text = lines.map((l) => l.text.trim()).join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

export interface PdfProbe {
  pageCount: number;
  metadataTitle: string | null;
  headingTitle: string | null;
  /** Page one as a small JPEG, or null if it could not be drawn. */
  cover: Blob | null;
}

/** Longest edge of a stored cover. Cards show it at ~120–260px wide; 2x that
 *  keeps it sharp on a retina screen at roughly 20–40 KB a book. */
export const COVER_WIDTH = 420;

type PdfDoc = {
  numPages: number;
  getMetadata: () => Promise<{ info?: Record<string, unknown> }>;
  getPage: (n: number) => Promise<any>;
  destroy?: () => Promise<void> | void;
};

/** Draw page one of an open document to a JPEG. Null on any failure — a
 *  missing cover is a cosmetic loss and must never fail an upload. */
export async function renderCover(pdf: PdfDoc, width = COVER_WIDTH): Promise<Blob | null> {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    // A cover taller than 1.7:1 is a scroll, not a page; clip rather than
    // store a strip no card can show.
    canvas.height = Math.round(Math.min(viewport.height, viewport.width * 1.7));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Open a PDF once and take everything intake needs from it: page count,
 * title candidates and the cover. Never throws; a file pdf.js cannot open
 * comes back as an empty probe (page count 0), exactly what the old
 * count-only probe returned.
 */
export async function probePdf(source: File | Blob | string): Promise<PdfProbe> {
  const empty: PdfProbe = { pageCount: 0, metadataTitle: null, headingTitle: null, cover: null };
  let pdf: PdfDoc | null = null;
  try {
    // Loaded on demand (the title logic above stays importable without
    // pdf.js). The worker is configured here only if no other module —
    // bookStructure, the reader — has already done it.
    const pdfjsLib = await import("pdfjs-dist");
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    }
    const task = typeof source === "string"
      ? pdfjsLib.getDocument(source)
      : pdfjsLib.getDocument({ data: await source.arrayBuffer() });
    pdf = (await task.promise) as unknown as PdfDoc;
    const probe: PdfProbe = { ...empty, pageCount: pdf.numPages };
    try {
      const meta = await pdf.getMetadata();
      const t = meta?.info?.Title;
      if (typeof t === "string" && t.trim()) probe.metadataTitle = t.trim();
    } catch { /* no Info dictionary */ }
    try {
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const runs: TextRun[] = (content.items as any[])
        .filter((it) => typeof it?.str === "string" && Array.isArray(it.transform))
        .map((it) => ({
          str: it.str as string,
          size: Math.abs(Number(it.height) || Math.hypot(it.transform[2], it.transform[3])),
          y: Number(it.transform[5]) || 0,
        }));
      probe.headingTitle = headingFromRuns(runs);
    } catch { /* image-only first page */ }
    probe.cover = await renderCover(pdf);
    return probe;
  } catch {
    return empty;
  } finally {
    try { await pdf?.destroy?.(); } catch { /* already gone */ }
  }
}
