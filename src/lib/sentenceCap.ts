// Sentence counting + hard truncation for the "Max sentences per reply" cap.
//
// Counting rules (shared by the streaming abort in ChatContext and the final
// truncation invariant, so they can never disagree):
//   • Prose is segmented with Intl.Segmenter (granularity "sentence") — it
//     handles "Dr.", "e.g.", decimals via ICU's suppression lists. A regex
//     fallback covers engines without it.
//   • Fenced code blocks (``` / ~~~) count ZERO sentences and are atomic —
//     the cap can cut before a fence, never inside one.
//   • A markdown list item counts as exactly ONE sentence, however it's
//     punctuated. Headings count zero.
//   • In streaming mode the trailing fragment is only counted once it ends
//     with terminal punctuation — it may still be growing. The final
//     (non-streaming) pass counts a trailing fragment as a sentence, so the
//     post-stream truncation is always at least as strict as the abort check.

export interface SentenceCapOptions {
  /** True while the text is still streaming in (don't count the live tail). */
  streaming?: boolean;
}

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const LIST_ITEM_RE = /^\s{0,5}([-*+]|\d{1,3}[.)])\s+/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const HAS_WORD_RE = /[\p{L}\p{N}]/u;
// Terminal punctuation (incl. CJK 。！？), allowing trailing quotes/brackets/
// markdown marks. Deliberately NO colon: a mid-sentence colon landing at the
// end of a network delta would make the unfinished sentence count as complete
// and the streaming cap would cut mid-sentence ("My verdict:" ✂). A colon
// lead-in is still counted one step later, when its newline flushes the run.
const TERMINATED_RE = /[.!?…。！？]["'’”)\]*_~`]*\s*$/;

// Structural types for Intl.Segmenter — the project's TS lib target predates
// its declarations; the runtime API is Baseline in all engines since 2024.
interface SentenceSegment { segment: string; index: number; }
interface SentenceSegmenter { segment(input: string): Iterable<SentenceSegment>; }

let segmenter: SentenceSegmenter | null | undefined;
function getSegmenter(): SentenceSegmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    const Seg = typeof Intl !== "undefined" ? (Intl as any).Segmenter : undefined;
    segmenter = typeof Seg === "function"
      ? (new Seg("en", { granularity: "sentence" }) as SentenceSegmenter)
      : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/** End offsets (exclusive, in the original string) of each sentence in a
 *  prose slice that starts at `base` in the original string. */
function proseSentenceEnds(slice: string, base: number): number[] {
  const ends: number[] = [];
  const seg = getSegmenter();
  if (seg) {
    for (const s of seg.segment(slice)) {
      if (!HAS_WORD_RE.test(s.segment)) continue; // whitespace/punctuation-only
      ends.push(base + s.index + s.segment.length);
    }
    return ends;
  }
  // Fallback: terminal-punctuation split. Coarser than ICU but errs toward
  // over-merging (abbreviations may glue sentences), never mid-sentence cuts.
  const re = /[^.!?…。！？]*[.!?…。！？]+["'’”)\]]*\s*/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(slice)) !== null) {
    if (HAS_WORD_RE.test(m[0])) ends.push(base + m.index + m[0].length);
    last = m.index + m[0].length;
  }
  const rest = slice.slice(last);
  if (HAS_WORD_RE.test(rest)) ends.push(base + slice.length);
  return ends;
}

interface Analysis {
  count: number;
  /** Exclusive end offset of the cap-th sentence, or null while under cap. */
  capIndex: number | null;
}

function analyze(text: string, cap: number, opts?: SentenceCapOptions): Analysis {
  const streaming = !!opts?.streaming;
  // Sentence end offsets in document order, built line-block by line-block.
  const ends: number[] = [];

  let pos = 0;
  let inFence = false;
  let proseStart = -1; // start offset of the current contiguous prose run

  const flushProse = (endPos: number) => {
    if (proseStart < 0) return;
    ends.push(...proseSentenceEnds(text.slice(proseStart, endPos), proseStart));
    proseStart = -1;
  };

  const len = text.length;
  while (pos <= len) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? len : nl;
    const line = text.slice(pos, lineEnd);
    const atEof = nl === -1;

    if (inFence) {
      if (FENCE_RE.test(line)) inFence = false; // closing fence — still 0 sentences
    } else if (FENCE_RE.test(line)) {
      flushProse(pos);
      inFence = true;
    } else if (LIST_ITEM_RE.test(line) && HAS_WORD_RE.test(line)) {
      flushProse(pos);
      // One sentence per list item; while streaming, the last line may still
      // be growing — hold off counting it until its newline arrives.
      if (!(streaming && atEof)) ends.push(lineEnd);
    } else if (HEADING_RE.test(line)) {
      flushProse(pos);
    } else if (!line.trim()) {
      flushProse(pos);
    } else if (proseStart < 0) {
      proseStart = pos;
    }

    if (atEof) break;
    pos = lineEnd + 1;
  }
  if (!inFence) flushProse(len);

  // Streaming: drop the final sentence if it runs to EOF unterminated.
  if (streaming && ends.length > 0 && ends[ends.length - 1] >= len && !TERMINATED_RE.test(text)) {
    ends.pop();
  }

  return {
    count: ends.length,
    capIndex: cap > 0 && ends.length >= cap ? ends[cap - 1] : null,
  };
}

/** Number of countable sentences in the text. */
export function countSentences(text: string, opts?: SentenceCapOptions): number {
  return analyze(text, 0, opts).count;
}

/** Exclusive cut offset once the text holds `cap` sentences, else null. */
export function findSentenceCapIndex(text: string, cap: number, opts?: SentenceCapOptions): number | null {
  if (!text || cap <= 0) return null;
  return analyze(text, cap, opts).capIndex;
}

/** The text hard-truncated at the end of its `cap`-th sentence. */
export function truncateAtSentenceCap(text: string, cap: number, opts?: SentenceCapOptions): string {
  const idx = findSentenceCapIndex(text, cap, opts);
  return idx === null ? text : text.slice(0, idx).trimEnd();
}
