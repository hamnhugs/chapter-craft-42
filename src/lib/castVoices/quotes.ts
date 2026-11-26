/**
 * Cast voices, step 1: where the quoted speech is.
 *
 * Pure and deterministic. The model that decides WHO is speaking never
 * re-emits the book's words — it is handed numbered quotes and answers with
 * numbers — so the spans have to come from here, as character offsets into
 * the exact text the reader speaks. Anything this cannot pair confidently is
 * simply left out: an unmarked quote is read by the narrator, which is the
 * safe failure. A wrong voice is worse than no voice.
 *
 * Handled: curly double quotes, straight double quotes, guillemets, German
 * low-high quotes, and curly single quotes when the text uses them as its
 * main quotation mark (British typesetting). A quotation that runs over
 * several paragraphs (each paragraph re-opens, only the last closes) becomes
 * one span per paragraph. Nested quotes stay inside their outer span.
 *
 * Not handled: dialogue dashes (— Spanish, French, Joyce) and books with no
 * quotation marks at all; those read in the narrator's voice.
 */

export interface QuoteSpan {
  /** Offset of the opening mark. */
  start: number;
  /** Offset one past the closing mark (or past the last char spoken). */
  end: number;
  /** The words between the marks. */
  text: string;
}

/** A quote longer than this is almost certainly a mis-paired mark. */
const MAX_QUOTE_CHARS = 2400;

const LETTER = /[\p{L}\p{N}]/u;
const isLetter = (c: string | undefined) => !!c && LETTER.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

type Pair = { open: string; close: string };
const PAIRS: Pair[] = [
  { open: "“", close: "”" },
  { open: "«", close: "»" },
  { open: "„", close: "“" },
];

function count(text: string, ch: string): number {
  let n = 0;
  for (let i = text.indexOf(ch); i >= 0; i = text.indexOf(ch, i + 1)) n++;
  return n;
}

/** Is this straight `"` an opening mark? Decided by what surrounds it. */
function straightOpens(text: string, i: number): boolean {
  const prev = text[i - 1];
  const next = text[i + 1];
  if (isSpace(next)) return false;
  return isSpace(prev) || /[([{—–-]/.test(prev!);
}

/** A curly `‘` that starts speech: at a word boundary, before a letter. */
function singleOpens(text: string, i: number): boolean {
  const prev = text[i - 1];
  return (isSpace(prev) || /[([{—–“]/.test(prev!)) && !isSpace(text[i + 1]);
}

/**
 * A curly `’` that ends speech rather than marking an apostrophe: it follows
 * closing punctuation and is not glued to a following letter. ("the boys’
 * room" and "don’t" both fail the first test.)
 */
function singleCloses(text: string, i: number): boolean {
  return /[.,!?…—–-]/.test(text[i - 1] || "") && !isLetter(text[i + 1]);
}

function push(out: QuoteSpan[], text: string, start: number, end: number, inner: [number, number]) {
  const body = text.slice(inner[0], inner[1]).trim();
  if (!body || !LETTER.test(body)) return;
  if (end - start > MAX_QUOTE_CHARS) return;
  out.push({ start, end, text: body });
}

/**
 * Every quoted span in `text`, in order, never overlapping.
 */
export function findQuotes(text: string): QuoteSpan[] {
  const out: QuoteSpan[] = [];
  const n = text.length;
  // Single quotes are the book's quotation mark only when doubles are scarce:
  // otherwise ‘…’ is a quote inside a quote, or an apostrophe.
  const doubles = count(text, "“") + count(text, '"') / 2 + count(text, "«") + count(text, "„");
  let singleOpeners = 0;
  for (let i = text.indexOf("‘"); i >= 0; i = text.indexOf("‘", i + 1)) if (singleOpens(text, i)) singleOpeners++;
  const singlesAreSpeech = singleOpeners >= 2 && singleOpeners > doubles * 2;

  let i = 0;
  while (i < n) {
    const c = text[i];

    // Paired marks with distinct open and close.
    const pair = PAIRS.find((p) => p.open === c);
    if (pair) {
      let j = i + 1;
      let closed = -1;
      let reopened = -1;
      for (; j < n && j - i <= MAX_QUOTE_CHARS; j++) {
        const d = text[j];
        if (d === pair.close) { closed = j; break; }
        // German „…“ closes with “; for “…”, a second “ before any ” means
        // the quotation continued into a new paragraph.
        if (d === pair.open && pair.open !== pair.close && /\n\s*$/.test(text.slice(Math.max(i, j - 6), j))) { reopened = j; break; }
        if (d === "\n" && text[j + 1] === "\n") {
          // Paragraph break inside an open quote: continuation only if the
          // next paragraph re-opens.
          let k = j;
          while (k < n && /\s/.test(text[k])) k++;
          if (text[k] === pair.open) { reopened = k; break; }
        }
      }
      if (closed >= 0) {
        push(out, text, i, closed + 1, [i + 1, closed]);
        i = closed + 1;
        continue;
      }
      if (reopened >= 0) {
        let end = reopened;
        while (end > i && /\s/.test(text[end - 1])) end--;
        push(out, text, i, end, [i + 1, end]);
        i = reopened;
        continue;
      }
      i++;
      continue;
    }

    if (c === '"' && straightOpens(text, i)) {
      let closed = -1;
      let paraEnd = -1;
      for (let j = i + 1; j < n && j - i <= MAX_QUOTE_CHARS; j++) {
        const d = text[j];
        if (d === '"' && !straightOpens(text, j)) { closed = j; break; }
        if (d === '"') { closed = -2; break; } // another opener first: mis-pair
        if (d === "\n" && text[j + 1] === "\n") { paraEnd = j; break; }
      }
      if (closed >= 0) {
        push(out, text, i, closed + 1, [i + 1, closed]);
        i = closed + 1;
        continue;
      }
      if (paraEnd >= 0) {
        // Open at the paragraph's end: a continued quotation if the next
        // paragraph opens with a quote mark; otherwise a stray mark.
        let k = paraEnd;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === '"') {
          push(out, text, i, paraEnd, [i + 1, paraEnd]);
          i = k;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === "‘" && singlesAreSpeech && singleOpens(text, i)) {
      let closed = -1;
      for (let j = i + 1; j < n && j - i <= MAX_QUOTE_CHARS; j++) {
        const d = text[j];
        if (d === "’" && singleCloses(text, j)) { closed = j; break; }
        if (d === "‘" && singleOpens(text, j)) break;
        if (d === "\n" && text[j + 1] === "\n") break;
      }
      if (closed >= 0) {
        push(out, text, i, closed + 1, [i + 1, closed]);
        i = closed + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * The page with each quote numbered for the model: `⟦3⟧“…”`. The numbers are
 * 1-based positions in `quotes`. The marker characters are stripped from the
 * source first so nothing on the page can forge one.
 */
export function numberQuotes(text: string, quotes: QuoteSpan[], opts: { from?: number; to?: number } = {}): string {
  const from = opts.from ?? 0;
  const to = opts.to ?? text.length;
  const clean = (s: string) => s.replace(/[⟦⟧]/g, "");
  let out = "";
  let at = from;
  quotes.forEach((q, k) => {
    if (q.start < from || q.start >= to) return;
    out += clean(text.slice(at, q.start)) + `⟦${k + 1}⟧`;
    at = q.start;
  });
  return out + clean(text.slice(at, to));
}
