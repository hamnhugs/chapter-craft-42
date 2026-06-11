import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { supabase } from "@/integrations/supabase/client";
import { Chapter } from "@/types/library";

// Automated book/paper structure detection. Tiered for token efficiency:
//   Tier 0 (free): embedded PDF outline — deterministic, no AI call.
//   Tier 1 (free): heuristic scan of every page for candidate heading lines
//                  (chapter/part patterns, IMRaD section names, numbered
//                  sections) + printed table-of-contents pages for cross-check.
//   Tier 2 (one cheap call): the `auto-structure` edge function sends ONLY the
//                  numbered candidate lines to a long-context model, which
//                  answers with indices into that list — so page numbers come
//                  from us, never from the model, and cannot be hallucinated.
// Everything the model returns is re-validated here (index anchoring,
// monotonic pages, dedupe) before chapters are saved.

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export interface DetectedSection {
  title: string;
  startPage: number;
  endPage: number;
  level: number;
  kind: "part" | "chapter" | "section" | "front_matter" | "back_matter";
  source: "outline" | "ai" | "ai-pages";
}

export interface DetectResult {
  sections: DetectedSection[];
  method: "outline" | "ai" | "ai-pages";
  docType: string;
}

type CandidateCategory = "chapter" | "named" | "numeric" | "caps" | "pageline";

interface ScanCandidate {
  i: number;
  page: number;
  level: number;
  text: string;
  cat: CandidateCategory;
}

const MAX_CANDIDATES = 500;
const MAX_SECTIONS = 300;
const MAX_SCAN_PAGES = 2000;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
// Letters/digits only — robust to the model fixing OCR spacing/casing.
const stripped = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const CHAPTER_RE =
  /^(?:chapter|part|book)\s+(?:\d{1,3}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|thirty|forty|fifty)\b.{0,80}$/i;
const NAMED_RE =
  /^\s*(abstract|introduction|background|related work|motivation|methods?|materials and methods|methodology|experiments?|experimental setup|results?|evaluation|analysis|discussion|conclusion|conclusions|future work|limitations|references|bibliography|appendix(?:\s+[a-z])?|acknowledgments?|acknowledgements?|prologue|epilogue|preface|foreword|afterword|glossary|index|about the author)\b[^a-z0-9]*$/i;
const NUMERIC_RE = /^\s*(\d+(?:\.\d+){0,3})[.)]?\s+([A-Z][\w\-:,'’ ]{2,80})\s*$/;
const ALL_CAPS_RE = /^[A-Z][A-Z0-9 ,.:;'"&\-–—]{3,70}$/;
const TOC_DOTS_RE = /\.{3,}\s*\d{1,4}\s*$/;
const SKIP_TITLE_RE = /^(cover|title page|copyright|contents|table of contents|toc)$/i;

/** Reconstruct a page's lines by grouping text items on shared y positions. */
async function getPageLines(pdf: PDFDocumentProxy, pageNum: number): Promise<string[]> {
  try {
    const page = await pdf.getPage(pageNum);
    const tc = await page.getTextContent();
    const items = (tc.items as any[])
      .filter((it) => typeof it.str === "string" && it.str.trim().length > 0)
      .map((it) => ({ str: it.str, y: it.transform?.[5] ?? 0 }));
    items.sort((a, b) => b.y - a.y);
    const lines: string[] = [];
    let currentY: number | null = null;
    let current: string[] = [];
    for (const it of items) {
      if (currentY === null || Math.abs(it.y - currentY) < 3) {
        current.push(it.str);
        currentY = currentY ?? it.y;
      } else {
        if (current.length) lines.push(collapse(current.join(" ")));
        current = [it.str];
        currentY = it.y;
      }
    }
    if (current.length) lines.push(collapse(current.join(" ")));
    return lines.filter(Boolean);
  } catch {
    return [];
  }
}

/** Tier 0: embedded PDF outline → sections (free, deterministic). */
async function tryOutline(pdf: PDFDocumentProxy, pageCount: number): Promise<DetectedSection[] | null> {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline || outline.length === 0) return null;

  const flat: { title: string; ref: any; level: number }[] = [];
  const walk = (items: any[], lvl: number) => {
    for (const it of items) {
      flat.push({ title: it.title, ref: it.dest, level: lvl });
      if (it.items?.length) walk(it.items, lvl + 1);
    }
  };
  walk(outline, 1);

  const resolved: { title: string; page: number; level: number }[] = [];
  for (const item of flat) {
    try {
      let dest = item.ref;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!dest) continue;
      const pageIndex = await pdf.getPageIndex(dest[0]);
      const title = collapse(item.title || "");
      if (!title || SKIP_TITLE_RE.test(title)) continue;
      resolved.push({ title, page: pageIndex + 1, level: item.level });
    } catch {
      // ignore individual outline failures
    }
  }

  let picked = resolved.filter((r) => r.level === 1);
  if (picked.length < 3) picked = resolved.filter((r) => r.level <= 2);
  if (picked.length < 3) return null;

  picked.sort((a, b) => a.page - b.page);
  const deduped: DetectedSection[] = [];
  for (const r of picked) {
    if (deduped.length && deduped[deduped.length - 1].startPage === r.page) continue;
    deduped.push({
      title: r.title,
      startPage: r.page,
      endPage: 0,
      level: r.level,
      kind: r.level === 1 ? "chapter" : "section",
      source: "outline",
    });
    if (deduped.length >= MAX_SECTIONS) break;
  }
  for (let i = 0; i < deduped.length; i++) {
    deduped[i].endPage = i === deduped.length - 1 ? pageCount : Math.max(deduped[i].startPage, deduped[i + 1].startPage - 1);
  }
  return deduped;
}

/** Tier 1: scan every page for candidate heading lines + printed TOC pages. */
async function scanCandidates(
  pdf: PDFDocumentProxy,
  pageCount: number,
  onProgress?: (msg: string) => void,
): Promise<{ candidates: ScanCandidate[]; tocText: string; docType: string }> {
  const lastPage = Math.min(pageCount, MAX_SCAN_PAGES);
  const pool: Omit<ScanCandidate, "i">[] = [];
  const tocChunks: string[] = [];
  const tocScanLimit = Math.max(5, Math.ceil(pageCount * 0.15));

  for (let p = 1; p <= lastPage; p++) {
    if (p % 25 === 0) onProgress?.(`Scanning pages… ${p}/${lastPage}`);
    const lines = await getPageLines(pdf, p);

    // Printed TOC page? (dot leaders / "Contents" heading near the front).
    // TOC pages are sent separately for cross-checking and must NOT contribute
    // heading candidates — a "Chapter 1 …" line on a TOC page would otherwise
    // anchor the chapter to the TOC page instead of where it really starts.
    if (p <= tocScanLimit) {
      const dotLines = lines.filter((l) => TOC_DOTS_RE.test(l)).length;
      const hasContentsHeading = lines.slice(0, 4).some((l) => /^(table of )?contents$/i.test(collapse(l)));
      if (dotLines >= 3 || hasContentsHeading) {
        if (tocChunks.length < 3) tocChunks.push(`--- p.${p} ---\n${lines.join("\n")}`);
        continue;
      }
    }

    let pageHits = 0;
    for (const raw of lines) {
      // A real page has at most a couple of headings; many matches on one page
      // means a TOC/index-like listing — stop collecting from it.
      if (pageHits >= 6) break;
      const line = collapse(raw);
      if (line.length < 2 || line.length > 120) continue;
      // TOC entry lines are not headings — the model gets the TOC separately.
      if (TOC_DOTS_RE.test(line)) continue;

      if (CHAPTER_RE.test(line)) {
        pool.push({ page: p, level: 1, text: line, cat: "chapter" });
        pageHits++;
        continue;
      }
      const numMatch = line.match(NUMERIC_RE);
      if (numMatch) {
        const level = (numMatch[1].match(/\./g)?.length ?? 0) + 1;
        if (level <= 3) {
          pool.push({ page: p, level, text: line, cat: "numeric" });
          pageHits++;
        }
        continue;
      }
      if (NAMED_RE.test(line)) {
        pool.push({ page: p, level: 1, text: line, cat: "named" });
        pageHits++;
        continue;
      }
      if (ALL_CAPS_RE.test(line) && /[A-Z]{3,}/.test(line) && line.split(" ").length <= 8) {
        pool.push({ page: p, level: 1, text: line, cat: "caps" });
        pageHits++;
      }
    }
  }

  // Doc-type heuristic (a hint for the model, not a hard decision).
  const chapterHits = pool.filter((c) => c.cat === "chapter").length;
  const hasAbstract = pool.some((c) => /^abstract\b/i.test(c.text));
  const hasRefs = pool.some((c) => /^(references|bibliography)\b/i.test(c.text));
  const docType =
    chapterHits >= 3 ? "book" : (hasAbstract || hasRefs) && pageCount <= 100 ? "paper" : "unknown";

  // Keep the pool within budget. Steps, applied only while oversized:
  // 1) collapse exact repeats (running headers) to their first occurrence,
  // 2) drop the weakest signals (ALL-CAPS lines, then deep numeric levels),
  // 3) hard cap.
  let kept = pool;
  if (kept.length > MAX_CANDIDATES) {
    const seen = new Set<string>();
    kept = kept.filter((c) => {
      const key = `${c.cat}|${stripped(c.text)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (kept.length > MAX_CANDIDATES) kept = kept.filter((c) => c.cat !== "caps");
  if (kept.length > MAX_CANDIDATES) kept = kept.filter((c) => c.cat !== "numeric" || c.level <= 2);
  if (kept.length > MAX_CANDIDATES) kept = kept.filter((c) => c.cat !== "numeric" || c.level === 1);
  if (kept.length > MAX_CANDIDATES) kept = kept.slice(0, MAX_CANDIDATES);

  return {
    candidates: kept.map((c, i) => ({ ...c, i })),
    tocText: tocChunks.join("\n").slice(0, 6000),
    docType,
  };
}

/** Fallback candidates when no headings were found: first meaningful line of each page. */
async function pageLineCandidates(
  pdf: PDFDocumentProxy,
  pageCount: number,
  onProgress?: (msg: string) => void,
): Promise<ScanCandidate[]> {
  // One candidate per sampled page, kept within the candidate budget.
  const step = Math.max(1, Math.ceil(pageCount / (MAX_CANDIDATES - 10)));
  const out: ScanCandidate[] = [];
  for (let p = 1; p <= Math.min(pageCount, MAX_SCAN_PAGES); p += step) {
    if (p % 25 === 0) onProgress?.(`Sampling pages… ${p}/${pageCount}`);
    const lines = await getPageLines(pdf, p);
    const first = lines.find(
      (l) => l.length >= 4 && !/^\d+$/.test(l) && !/^page\s+\d+/i.test(l),
    );
    if (first) out.push({ i: out.length, page: p, level: 1, text: first.slice(0, 120), cat: "pageline" });
  }
  return out;
}

/** Tier 2: one structured call to the auto-structure edge function. */
async function callAutoStructure(body: {
  candidates: { i: number; page: number; level?: number; text: string }[];
  pageCount: number;
  docType: string;
  tocText?: string;
  model?: string;
  openrouterApiKey?: string;
}): Promise<{ entries: { i: number; title: string; level: number; kind: string; page: number }[]; doc_type: string }> {
  const { data, error } = await supabase.functions.invoke("auto-structure", { body });
  if (error) throw new Error(error.message || "AI request failed");
  if ((data as any)?.error) throw new Error((data as any).error);
  const entries = (data as any)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("AI did not find any sections.");
  }
  return { entries, doc_type: (data as any)?.doc_type || "other" };
}

/** Validate model output against the candidate list and build final sections. */
function entriesToSections(
  entries: { i: number; title: string; level: number; kind: string }[],
  candidates: ScanCandidate[],
  pageCount: number,
  docType: string,
  source: DetectedSection["source"],
): DetectedSection[] {
  const byIndex = new Map(candidates.map((c) => [c.i, c]));
  const KINDS = new Set(["part", "chapter", "section", "front_matter", "back_matter"]);

  let mapped = entries
    .filter((e) => byIndex.has(e.i))
    .map((e) => {
      const cand = byIndex.get(e.i)!;
      let title = collapse(e.title || "");
      // Anchor check: the cleaned title must come from the candidate's text;
      // otherwise fall back to the raw candidate line. Pages always come from
      // the candidate, so a bad title can never misplace a chapter.
      if (!title || !(stripped(cand.text).includes(stripped(title)) || stripped(title).includes(stripped(cand.text)))) {
        title = cand.text;
      }
      return {
        title: title.slice(0, 200),
        startPage: cand.page,
        endPage: 0,
        level: Math.min(3, Math.max(1, e.level || cand.level || 1)),
        kind: (KINDS.has(e.kind) ? e.kind : "section") as DetectedSection["kind"],
        source,
      };
    })
    .filter((s) => !(s.kind === "front_matter" && SKIP_TITLE_RE.test(s.title)));

  // Granularity: books read by chapter; papers benefit from subsections.
  if (docType === "book") {
    const top = mapped.filter((s) => s.level === 1 || s.kind === "part");
    if (top.length >= 3) mapped = top;
  } else {
    mapped = mapped.filter((s) => s.level <= 2);
  }

  mapped.sort((a, b) => a.startPage - b.startPage);
  const deduped: DetectedSection[] = [];
  for (const s of mapped) {
    if (deduped.length && deduped[deduped.length - 1].startPage === s.startPage) continue;
    deduped.push(s);
    if (deduped.length >= MAX_SECTIONS) break;
  }
  for (let i = 0; i < deduped.length; i++) {
    deduped[i].endPage = i === deduped.length - 1 ? pageCount : Math.max(deduped[i].startPage, deduped[i + 1].startPage - 1);
  }
  return deduped;
}

/** Detect the structure of a loaded PDF (does not save anything). */
export async function detectStructure(
  pdf: PDFDocumentProxy,
  opts: { apiKey?: string; model?: string; onProgress?: (msg: string) => void } = {},
): Promise<DetectResult> {
  const pageCount = pdf.numPages;
  const { onProgress } = opts;

  onProgress?.("Reading PDF outline…");
  const outlined = await tryOutline(pdf, pageCount);
  if (outlined) return { sections: outlined, method: "outline", docType: "unknown" };

  onProgress?.("Scanning pages for headings…");
  const { candidates, tocText, docType } = await scanCandidates(pdf, pageCount, onProgress);

  if (candidates.length > 0) {
    onProgress?.("Asking AI to isolate the table of contents…");
    try {
      const { entries, doc_type } = await callAutoStructure({
        candidates: candidates.map(({ i, page, level, text }) => ({ i, page, level, text })),
        pageCount,
        docType,
        tocText: tocText || undefined,
        model: opts.model,
        openrouterApiKey: opts.apiKey,
      });
      const finalType = docType !== "unknown" ? docType : doc_type;
      const sections = entriesToSections(entries, candidates, pageCount, finalType, "ai");
      if (sections.length > 0) return { sections, method: "ai", docType: finalType };
    } catch (e: any) {
      // "No sections found" → the candidates were noise; try the page-sampling
      // fallback below. Real API errors (auth, rate limit) would just fail
      // again, so surface them now.
      if (!/did not find/i.test(e?.message || "")) throw e;
    }
  }

  // No heading-shaped lines anywhere (e.g. novels whose chapters are bare
  // numbers): fall back to one line per page and let the model spot starts.
  onProgress?.("No headings found — sampling page tops…");
  const pageCands = await pageLineCandidates(pdf, pageCount, onProgress);
  if (pageCands.length === 0) throw new Error("Could not extract any text from this document.");

  onProgress?.("Asking AI to segment the document…");
  const { entries, doc_type } = await callAutoStructure({
    candidates: pageCands.map(({ i, page, text }) => ({ i, page, text })),
    pageCount,
    docType: "unknown",
    model: opts.model,
    openrouterApiKey: opts.apiKey,
  });
  const sections = entriesToSections(entries, pageCands, pageCount, doc_type, "ai-pages");
  if (sections.length === 0) throw new Error("AI could not segment this document.");
  return { sections, method: "ai-pages", docType: doc_type };
}

export interface SaveDeps {
  addChapter: (bookId: string, chapter: Chapter) => Promise<void>;
  removeChapter: (bookId: string, chapterId: string) => Promise<void> | void;
}

/** Extract each section's text and save it as a chapter row. */
export async function saveSections(opts: {
  bookId: string;
  pdf: PDFDocumentProxy;
  sections: DetectedSection[];
  deps: SaveDeps;
  replaceChapters?: Chapter[];
  onProgress?: (msg: string) => void;
}): Promise<number> {
  const { bookId, pdf, sections, deps, replaceChapters, onProgress } = opts;

  if (replaceChapters?.length) {
    onProgress?.("Removing old chapters…");
    for (const c of replaceChapters) {
      await deps.removeChapter(bookId, c.id);
    }
  }

  let saved = 0;
  for (const row of sections) {
    onProgress?.(`Saving ${saved + 1}/${sections.length}: ${row.title.slice(0, 40)}…`);
    let text = "";
    for (let p = row.startPage; p <= row.endPage; p++) {
      try {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        text += tc.items.map((it: any) => it.str).join(" ") + "\n\n";
      } catch {
        // skip page on extract failure
      }
    }
    const chapter: Chapter = {
      id: crypto.randomUUID(),
      name: row.title,
      startPage: row.startPage,
      endPage: row.endPage,
      textContent: text.trim(),
    };
    await deps.addChapter(bookId, chapter);
    saved += 1;
  }
  return saved;
}

/** End-to-end: load → detect → save. Used by the upload auto-trigger and the manual button. */
export async function detectAndSaveStructure(opts: {
  bookId: string;
  file?: File | Blob;
  fileUrl?: string;
  apiKey?: string;
  model?: string;
  replaceChapters?: Chapter[];
  deps: SaveDeps;
  onProgress?: (msg: string) => void;
}): Promise<{ saved: number; method: DetectResult["method"]; docType: string }> {
  const { onProgress } = opts;
  onProgress?.("Loading book…");

  let loadingTask;
  if (opts.file) {
    loadingTask = pdfjsLib.getDocument({ data: await opts.file.arrayBuffer() });
  } else if (opts.fileUrl) {
    loadingTask = pdfjsLib.getDocument({ url: opts.fileUrl });
  } else {
    throw new Error("No file provided for structure detection.");
  }
  const pdf = await loadingTask.promise;

  try {
    const result = await detectStructure(pdf, {
      apiKey: opts.apiKey,
      model: opts.model,
      onProgress,
    });
    const saved = await saveSections({
      bookId: opts.bookId,
      pdf,
      sections: result.sections,
      deps: opts.deps,
      replaceChapters: opts.replaceChapters,
      onProgress,
    });
    return { saved, method: result.method, docType: result.docType };
  } finally {
    try { pdf.destroy(); } catch { /* ignore */ }
  }
}
