// Finds a spoken passage on the rendered page and selects it, so the reader's
// own highlight / card flow can save it (voice: "save the paragraph that
// says …", "highlight the second sentence", "save from X to Y").
//
// Speech-to-text never matches print exactly ("2" vs "two", dropped words,
// near-miss spellings), so phrases are matched token-by-token with an
// in-order alignment, not as substrings.

import { normalizeSpeech, parseNumber, type Ordinal, type TextUnit } from "@/lib/voiceCommands";

interface NodeSpan { node: Text; start: number; end: number }
interface Token { w: string; start: number; end: number }

export interface PageText {
  doc: Document;
  text: string;
  nodes: NodeSpan[];
  paragraphs: [number, number][];
  sentences: [number, number][];
}

const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dd, dt, figcaption, section, article, div";

/** Collect the page's text. PDF text layers are absolutely-positioned spans
 *  with no paragraph markup, so paragraphs come from line geometry; HTML
 *  books use their block elements. */
export function collectPageText(root: Element, mode: "pdf" | "html"): PageText {
  const doc = root.ownerDocument;
  const nodes: NodeSpan[] = [];
  let text = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  type Meta = { top: number; bottom: number; left: number; right: number; block: Element | null };
  const metas: Meta[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const s = t.data;
    if (!s || !s.trim()) continue;
    const parent = t.parentElement;
    if (!parent || parent.closest("script, style, [aria-hidden='true']")) continue;
    if (text && !/\s$/.test(text) && !/^\s/.test(s)) text += " "; // virtual gap between spans
    nodes.push({ node: t, start: text.length, end: text.length + s.length });
    text += s;
    const r = parent.getBoundingClientRect();
    metas.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, block: parent.closest(BLOCK) });
  }

  // Paragraph breaks (offsets where a new paragraph begins).
  const breaks = new Set<number>();
  if (mode === "html") {
    for (let i = 1; i < nodes.length; i++) if (metas[i].block !== metas[i - 1].block) breaks.add(nodes[i].start);
  } else if (nodes.length > 1) {
    // Group spans into lines, then break on a big vertical gap, or after a
    // short line that ends a sentence.
    const lines: { start: number; top: number; bottom: number; right: number; endText: string }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const m = metas[i];
      const h = Math.max(1, m.bottom - m.top);
      const last = lines[lines.length - 1];
      if (last && Math.abs(m.top - last.top) < h * 0.5) {
        last.right = Math.max(last.right, m.right);
        last.bottom = Math.max(last.bottom, m.bottom);
        last.endText = nodes[i].node.data;
      } else {
        lines.push({ start: nodes[i].start, top: m.top, bottom: m.bottom, right: m.right, endText: nodes[i].node.data });
      }
    }
    const gaps = lines.slice(1).map((l, i) => l.top - lines[i].top).filter((g) => g > 0).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const maxRight = Math.max(...lines.map((l) => l.right));
    const minLeft = Math.min(...metas.map((m) => m.left));
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].top - lines[i - 1].top;
      const prevShort = maxRight - lines[i - 1].right > (maxRight - minLeft) * 0.15;
      const prevEnds = /[.!?:"”)]\s*$/.test(lines[i - 1].endText);
      if ((median > 0 && gap > median * 1.45) || (prevShort && prevEnds) || gap < 0) breaks.add(lines[i].start);
    }
  }
  const paraStarts = [0, ...[...breaks].sort((a, b) => a - b)];
  const paragraphs: [number, number][] = paraStarts
    .map((s, i) => [s, i + 1 < paraStarts.length ? paraStarts[i + 1] : text.length] as [number, number])
    .map(([s, e]) => trimRange(text, s, e))
    .filter(([s, e]) => e - s > 1);

  const sentences: [number, number][] = [];
  for (const [ps, pe] of paragraphs) {
    const re = /[.!?]["”’)\]]*\s+(?=["“‘(\[]?[A-Z0-9])/g;
    const chunk = text.slice(ps, pe);
    let last = 0;
    for (let m = re.exec(chunk); m; m = re.exec(chunk)) {
      const end = m.index + m[0].length;
      sentences.push(trimRange(text, ps + last, ps + end));
      last = end;
    }
    if (last < chunk.length) sentences.push(trimRange(text, ps + last, pe));
  }
  return { doc, text, nodes, paragraphs, sentences: sentences.filter(([s, e]) => e - s > 1) };
}

function trimRange(text: string, s: number, e: number): [number, number] {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

// ── Fuzzy phrase matching ─────────────────────────────────────────────────
const SMALL_NUMBER_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]);

function canon(w: string): string {
  if (SMALL_NUMBER_WORDS.has(w)) return String(parseNumber(w));
  return w;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z0-9’']+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = canon(m[0].toLowerCase().replace(/[’']/g, ""));
    if (w) out.push({ w, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  // Levenshtein ≤ 1
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Best in-order match of `spoken` in the page; [start, end) char offsets. */
export function findPhrase(page: PageText, spoken: string, after = 0): [number, number] | null {
  const want = normalizeSpeech(spoken).split(" ").filter(Boolean).map(canon);
  if (want.length === 0) return null;
  const toks = tokenize(page.text).filter((t) => t.start >= after);
  let best: { score: number; s: number; e: number } | null = null;
  const window = Math.ceil(want.length * 1.6) + 2;
  for (let i = 0; i < toks.length; i++) {
    // Anchor on one of the first two spoken words.
    if (!near(toks[i].w, want[0]) && !(want.length > 2 && near(toks[i].w, want[1]))) continue;
    const seg = toks.slice(i, i + window);
    // LCS with backtrack to find the last matched page token.
    const n = seg.length, m = want.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let a = 1; a <= n; a++) {
      for (let b = 1; b <= m; b++) {
        dp[a][b] = near(seg[a - 1].w, want[b - 1]) ? dp[a - 1][b - 1] + 1 : Math.max(dp[a - 1][b], dp[a][b - 1]);
      }
    }
    const score = dp[n][m] / m;
    if (score <= (best?.score ?? 0)) continue;
    let a = n, b = m, lastTok = 0;
    while (a > 0 && b > 0) {
      if (near(seg[a - 1].w, want[b - 1]) && dp[a][b] === dp[a - 1][b - 1] + 1) { lastTok = Math.max(lastTok, a - 1); a--; b--; }
      else if (dp[a - 1][b] >= dp[a][b - 1]) a--;
      else b--;
    }
    best = { score, s: seg[0].start, e: seg[lastTok].end };
  }
  const need = want.length <= 2 ? 1 : want.length <= 4 ? 0.74 : 0.6;
  return best && best.score >= need ? [best.s, best.e] : null;
}

function containing(ranges: [number, number][], s: number, e: number): [number, number] {
  const first = ranges.find(([rs, re]) => s < re && s >= rs) ?? ranges.find(([, re]) => re > s);
  const last = [...ranges].reverse().find(([rs, re]) => e > rs && e <= re) ?? first;
  return first && last ? [first[0], Math.max(first[1], last[1])] : [s, e];
}

export type PassageResult = { range: [number, number]; note?: string } | { error: string };

/** Resolve a spoken passage request to a char range on the page. */
export function resolvePassage(page: PageText, req: { unit: TextUnit; which?: Ordinal; says?: string; from?: string; to?: string }): PassageResult {
  if (!page.text.trim()) return { error: "I can't read any text on this page yet." };
  if (req.unit === "page") return { range: trimRange(page.text, 0, page.text.length) };
  if (req.from && req.to) {
    const a = findPhrase(page, req.from);
    if (!a) return { error: `I couldn't find "${req.from}" on this page.` };
    const b = findPhrase(page, req.to, a[0]);
    if (!b) return { error: `I found "${req.from}" but not "${req.to}" after it.` };
    return { range: [a[0], Math.max(a[1], b[1])] };
  }
  const list = req.unit === "paragraph" ? page.paragraphs : page.sentences;
  if (req.which !== undefined) {
    const idx = req.which === "last" ? list.length - 1 : req.which - 1;
    if (idx < 0 || idx >= list.length) return { error: `This page only has ${list.length} ${req.unit}${list.length === 1 ? "" : "s"}.` };
    return { range: list[idx] };
  }
  if (req.says) {
    const hit = findPhrase(page, req.says);
    if (!hit) return { error: `I couldn't find "${req.says}" on this page.` };
    if (req.unit === "phrase") return { range: hit };
    return { range: containing(list, hit[0], hit[1]) };
  }
  return { error: "Tell me which part — like the second paragraph, or the sentence that says something." };
}

/** Put the browser selection on [start, end) of the page text. */
export function selectRange(page: PageText, start: number, end: number): string {
  const locate = (off: number, isEnd: boolean): [Text, number] | null => {
    for (const n of page.nodes) {
      if (off >= n.start && off <= n.end) return [n.node, off - n.start];
      if (!isEnd && off < n.start) return [n.node, 0];          // in a virtual gap: next node
    }
    const last = [...page.nodes].reverse().find((n) => n.end <= off);
    return last ? [last.node, last.node.data.length] : null;     // end in a gap: previous node
  };
  const a = locate(start, false);
  const b = locate(end, true);
  if (!a || !b) return "";
  const range = page.doc.createRange();
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1]);
  const sel = page.doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return page.text.slice(start, end);
}
