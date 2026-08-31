import type { BookDocument } from "@/types/library";
import type { ChatProviderAdapter } from "@/lib/providers/types";

/**
 * E2 harness core — the quality gate for flipping the book-context default
 * from "full" to "catalog" (Card Catalog redesign §8, experiments E2/E3).
 *
 * Everything in this file is PURE relative to the network: message-loop
 * mechanics, quote verification, checkpointing, and report math. The runner
 * files (*.e2run.ts, executed only via vitest.e2.config.ts) wire it to the
 * REAL app builders (buildChatSystemPrompt / buildBookContextBlock), the REAL
 * openrouterAdapter, and the REAL executeChatTool — the harness re-implements
 * none of the product; it only replays ChatContext's assembly and loop
 * (src/context/ChatContext.tsx) outside React.
 *
 * Fairness contract (both arms identical except the book block's mode):
 *  - same system prompt bytes, same roster, same tools on the wire;
 *  - same fixture books served to get_chapter_text/get_book;
 *  - same model, same provider defaults, questions interleaved
 *    full/catalog so provider drift lands evenly;
 *  - MAX_TOOL_ITERATIONS and the 24k tool-result slice mirror the app.
 *
 * Data files live under e2-data/ (gitignored: the user's book text and the
 * question keys derived from it must never reach the repo).
 */

// ── Question set ───────────────────────────────────────────────────────────

export type E2QuestionType = "needle" | "quote" | "synthesis" | "routing";

export interface E2Question {
  id: string;
  type: E2QuestionType;
  /** The book the answer lives in ("both" only for routing questions). */
  book_id: string;
  question: string;
  key: {
    /** Canonical short answer (needle/routing) — what a grader must see. */
    expected?: string;
    /** Mechanical acceptors: case-insensitive substrings of a normalized
     *  answer. Any hit = correct without a judge call. */
    accept?: string[];
    /** Author-verified verbatim span (quote questions): must exist in the
     *  chapter EXACTLY (validator-enforced), and a correct answer quotes a
     *  part of it. */
    quote?: { chapter_id: string; text: string };
    /** Rubric key points (synthesis): the judge scores coverage of these. */
    points?: string[];
    /** Where the fact lives — provenance for the report, not for grading. */
    chapter_id?: string;
  };
  /** Author note: why this question / where it came from. */
  notes?: string;
}

export interface QuestionValidationIssue {
  id: string;
  problem: string;
}

/** Mechanical validation of the fixed set — every quote key must verbatim-
 *  match its chapter (strict, no normalization: these keys double as the E3
 *  ground truth), every id must resolve, every type must carry its key. */
export function validateQuestions(questions: E2Question[], books: BookDocument[]): QuestionValidationIssue[] {
  const issues: QuestionValidationIssue[] = [];
  const seen = new Set<string>();
  const bookById = new Map(books.map((b) => [b.id, b]));
  for (const q of questions) {
    if (seen.has(q.id)) issues.push({ id: q.id, problem: "duplicate id" });
    seen.add(q.id);
    if (q.book_id !== "both" && !bookById.has(q.book_id)) {
      issues.push({ id: q.id, problem: `unknown book_id ${q.book_id}` });
      continue;
    }
    const inBook = (chapterId: string): { ok: boolean; text: string } => {
      for (const b of books) {
        const c = b.chapters.find((ch) => ch.id === chapterId);
        if (c) return { ok: q.book_id === "both" || b.id === q.book_id, text: c.textContent };
      }
      return { ok: false, text: "" };
    };
    if (q.type === "quote") {
      if (!q.key.quote) { issues.push({ id: q.id, problem: "quote question without key.quote" }); continue; }
      const { ok, text } = inBook(q.key.quote.chapter_id);
      if (!ok) issues.push({ id: q.id, problem: "quote chapter_id not in the claimed book" });
      else if (!text.includes(q.key.quote.text)) issues.push({ id: q.id, problem: "quote key is NOT a verbatim span of its chapter" });
      if ((q.key.quote?.text || "").length < 40) issues.push({ id: q.id, problem: "quote key too short to be discriminating (<40 chars)" });
    }
    if (q.type === "needle") {
      if (!q.key.expected || !q.key.accept?.length) issues.push({ id: q.id, problem: "needle question needs expected + accept[]" });
      if (q.key.chapter_id && !inBook(q.key.chapter_id).ok) issues.push({ id: q.id, problem: "needle chapter_id not in the claimed book" });
      // The acceptor must actually appear in the source chapter — an acceptor
      // the book never says can only be satisfied by coincidence.
      if (q.key.chapter_id && q.key.accept?.length) {
        const { text } = inBook(q.key.chapter_id);
        const norm = normalizeForMatch(text, "deep").toLowerCase();
        if (!q.key.accept.some((a) => norm.includes(normalizeForMatch(a, "deep").toLowerCase()))) {
          issues.push({ id: q.id, problem: "no acceptor appears in the source chapter (deep-normalized)" });
        }
      }
    }
    if (q.type === "synthesis" && !q.key.points?.length) issues.push({ id: q.id, problem: "synthesis question needs key.points" });
    if (q.type === "routing" && (!q.key.accept?.length || !q.key.expected)) issues.push({ id: q.id, problem: "routing question needs accept[] + expected (the judge fallback interpolates expected)" });
  }
  return issues;
}

// ── Quote verification (E3, mechanical) ────────────────────────────────────

/** Normalization ladder. "strict" is identity; "ws" collapses whitespace and
 *  unifies quote/dash glyphs; "deep" additionally joins hyphenated line
 *  breaks (PDF extraction artifact). Verification reports the WEAKEST level
 *  that matched, so the report can state strict and deep rates separately. */
export function normalizeForMatch(s: string, level: "strict" | "ws" | "deep"): string {
  if (level === "strict") return s;
  let t = s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (level === "deep") t = t.replace(/- /g, "");
  return t;
}

/** Pull the spans an answer presents AS QUOTES: double-quoted runs (straight
 *  or curly) and markdown blockquote lines. Short fragments (<20 chars) are
 *  ignored — they are phrase mentions, not quote claims. */
export function extractQuotedSpans(answer: string, minLen = 20): string[] {
  const spans: string[] = [];
  // 2000-char cap, not 600: an answer that over-quotes a whole passage inline
  // must still extract, or a verbatim correct answer scores zero (review
  // finding — the old cap silently produced zero spans past 600 chars).
  const re = /["“]([^"“”]{5,2000}?)["”]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) spans.push(m[1]);
  for (const line of answer.split("\n")) {
    const bq = /^\s*>\s?(.+)$/.exec(line);
    if (!bq) continue;
    // A blockquote line is the model's PRESENTATION of a quote, not its
    // exact bytes: strip the wrapping quote glyphs and any trailing
    // parenthetical citation ("(Book 1, ch. 4)") before treating the rest as
    // the claimed span. Measured on the first live run: every blockquote span
    // carried its own quote marks, so the same quote counted twice — once
    // clean via the regex (verified) and once wrapped (failed) — dragging
    // both arms' E3 rates toward 50% for punctuation, not content.
    const t = bq[1].trim()
      .replace(/^["“”'‘’\s]+/, "")
      .replace(/\s*[(（][^()（）]{0,80}[)）]\s*$/, "")
      .replace(/["“”'‘’\s]+$/, "");
    spans.push(t);
  }
  return [...new Set(spans.filter((s) => s.trim().length >= minLen))];
}

export interface QuoteCheck {
  span: string;
  verified: boolean;
  /** The weakest normalization that produced the match. */
  level?: "strict" | "ws" | "deep";
}

/** Every claimed quote checked against the actual chapter text of the given
 *  books (the E3 mechanical gate). A span verifies when it is a substring of
 *  any chapter at any normalization level. Quoted ATTRIBUTIONS — a chapter
 *  name or book title in quotes ('the quote is from "Ch 2: Functions &
 *  Graphs"') — are not quote claims and are excluded up front; counting them
 *  charged both arms an E3 miss for citing sources by name (measured on the
 *  first live run). */
export function verifyQuotes(answer: string, books: BookDocument[], minLen = 20): QuoteCheck[] {
  const names = new Set(
    books
      .flatMap((b) => [b.title, ...b.chapters.map((c) => c.name)])
      .map((n) => normalizeForMatch(n || "", "deep").toLowerCase()),
  );
  const spans = extractQuotedSpans(answer, minLen).filter((s) => {
    const n = normalizeForMatch(s, "deep").toLowerCase();
    return !names.has(n) && !/^ch(apter)?\s*\d+\s*[:.]/.test(n);
  });
  const haystacks = {
    strict: books.flatMap((b) => b.chapters.map((c) => c.textContent)),
    ws: [] as string[],
    deep: [] as string[],
  };
  haystacks.ws = haystacks.strict.map((t) => normalizeForMatch(t, "ws"));
  haystacks.deep = haystacks.strict.map((t) => normalizeForMatch(t, "deep"));
  return spans.map((span) => {
    for (const level of ["strict", "ws", "deep"] as const) {
      const needle = normalizeForMatch(span, level);
      if (needle.length >= minLen && haystacks[level].some((h) => h.includes(needle))) {
        return { span, verified: true, level };
      }
    }
    return { span, verified: false };
  });
}

// ── The tool loop (ChatContext's loop, outside React) ──────────────────────

export const E2_MAX_TOOL_ITERATIONS = 5; // MUST mirror ChatContext.MAX_TOOL_ITERATIONS
export const E2_TOOL_RESULT_SLICE = 24_000; // MUST mirror the app's slice

export interface ToolTraceEntry {
  name: string;
  args: string;
  ok: boolean;
  resultChars: number;
  summary: string;
}

export interface LoopResult {
  text: string;
  reasoning: string;
  toolTrace: ToolTraceEntry[];
  iterations: number;
  /** Chars of the serialized message array at each iteration's send — the
   *  cost signal (tokens ≈ chars/4, the app convention). */
  sentChars: number[];
  /** "cut_short" = the provider ended the stream on length/content_filter;
   *  accumulated tool calls were DROPPED, mirroring ChatContext's
   *  streamCutShort handling — and the truncation is visible in the row.
   *  "answered_after_cap" = the tool budget was spent and the FORCED ANSWER
   *  ROUND (tool_choice:"none" + budget note, mirroring ChatContext) produced
   *  prose; "max_iterations" = even that round produced none. */
  finish: "ok" | "max_iterations" | "cut_short" | "answered_after_cap";
}

export interface RunLoopOpts {
  adapter: ChatProviderAdapter;
  model: string;
  apiKey: string;
  messages: unknown[];
  tools: unknown[] | undefined;
  cacheStablePrefixCount: number;
  executeTool: (name: string, rawArgs: string) => Promise<{ result: unknown; event: { name: string; summary: string; ok: boolean } }>;
  signal?: AbortSignal;
}

/** Drive one conversation to completion through a provider adapter, executing
 *  tool calls exactly as ChatContext does: accumulate tool_call_deltas by
 *  index, push the assistant tool_calls message, execute, push each result
 *  JSON-sliced at 24k, iterate up to the app's cap. The salvage pass for
 *  text-written calls is deliberately absent (documented harness deviation —
 *  native-tool-calling models on OpenRouter; a run that ends with prose call
 *  syntax simply ends). */
export async function runToolLoop(opts: RunLoopOpts): Promise<LoopResult> {
  const messages = [...opts.messages];
  let text = "";
  let reasoning = "";
  const toolTrace: ToolTraceEntry[] = [];
  const sentChars: number[] = [];

  // `<=`: one round past the tool budget is the forced answer round —
  // tool_choice:"none" + a truthful budget note, mirroring ChatContext (the
  // E2 run measured 6/40 catalog answers coming back BLANK without it).
  for (let iteration = 0; iteration <= E2_MAX_TOOL_ITERATIONS; iteration++) {
    const finalRound = iteration === E2_MAX_TOOL_ITERATIONS;
    if (finalRound) {
      messages.push({
        role: "system",
        content:
          "[Tool budget for this reply is spent — no further tool calls will execute this turn. Answer the user's message now from what has already been read and returned above; say plainly if something needed could not be read in time.]",
      });
    }
    sentChars.push(JSON.stringify(messages).length);
    let iterText = "";
    let cutShort = false;
    const acc: Record<number, { id?: string; name?: string; args: string }> = {};

    const stream = opts.adapter.streamChat({
      model: opts.model,
      messages,
      tools: opts.tools,
      toolChoice: finalRound ? "none" : undefined,
      apiKey: opts.apiKey,
      signal: opts.signal,
      cacheStablePrefixCount: opts.cacheStablePrefixCount,
    });
    for await (const ev of stream) {
      if (ev.type === "text") iterText += ev.delta;
      else if (ev.type === "reasoning") reasoning += ev.delta;
      else if (ev.type === "tool_call_delta") {
        const slot = (acc[ev.index] ||= { args: "" });
        if (ev.id) slot.id = ev.id;
        if (ev.name) slot.name = ev.name;
        if (ev.argsDelta) slot.args += ev.argsDelta;
      } else if (ev.type === "finish" && (ev.reason === "length" || ev.reason === "content_filter")) {
        cutShort = true;
      }
    }

    text += (text && iterText ? "\n" : "") + iterText;
    // A length/filter-cut stream may hold half-written calls; production
    // discards them (ChatContext streamCutShort) instead of executing invalid
    // JSON into a recovery round it never grants — mirror that, and make the
    // truncation visible in the row (review finding: it used to record "ok").
    if (cutShort) return { text, reasoning, toolTrace, iterations: iteration + 1, sentChars, finish: "cut_short" };
    // Forced answer round is terminal regardless of what came back — a call
    // emitted past tool_choice:"none" never executes (ChatContext parity).
    if (finalRound) {
      return { text, reasoning, toolTrace, iterations: iteration + 1, sentChars, finish: iterText ? "answered_after_cap" : "max_iterations" };
    }
    const calls = Object.keys(acc)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => acc[i])
      .filter((c) => c.name);
    if (calls.length === 0) return { text, reasoning, toolTrace, iterations: iteration + 1, sentChars, finish: "ok" };

    messages.push({
      role: "assistant",
      content: iterText || null,
      tool_calls: calls.map((t, i) => ({
        id: t.id || `call_${iteration}_${i}`,
        type: "function",
        function: { name: t.name, arguments: t.args || "{}" },
      })),
    });
    for (let i = 0; i < calls.length; i++) {
      const t = calls[i];
      const { result, event } = await opts.executeTool(t.name!, t.args || "{}");
      // Strip the app's __-prefixed UI side channels before the model sees
      // the result — same as ChatContext.
      let modelResult: unknown = result;
      if (result && typeof result === "object" && Object.keys(result as object).some((k) => k.startsWith("__"))) {
        modelResult = Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([k]) => !k.startsWith("__")));
      }
      const content = JSON.stringify(modelResult).slice(0, E2_TOOL_RESULT_SLICE);
      toolTrace.push({ name: t.name!, args: (t.args || "").slice(0, 400), ok: event.ok, resultChars: content.length, summary: event.summary });
      messages.push({ role: "tool", tool_call_id: t.id || `call_${iteration}_${i}`, name: t.name, content });
    }
  }
  return { text, reasoning, toolTrace, iterations: E2_MAX_TOOL_ITERATIONS, sentChars, finish: "max_iterations" };
}

// ── Answer rows + checkpointing ────────────────────────────────────────────

export type E2Mode = "full" | "catalog";

export interface AnswerRow {
  qid: string;
  mode: E2Mode;
  model: string;
  answer: string;
  toolTrace: ToolTraceEntry[];
  iterations: number;
  sentChars: number[];
  finish: string;
  ms: number;
  fixtureSha: string;
  questionsSha: string;
  at: string;
  error?: string;
}

export function rowKey(r: { qid: string; mode: string }): string {
  return `${r.qid}::${r.mode}`;
}

/** The identity of a run: same model, same fixture bytes, same question
 *  bytes. Rows from any other identity are STALE — resuming across a model
 *  switch would mix arms across models within one question, and resuming
 *  across a fixture/question edit would grade old answers against new keys
 *  (review finding: nothing checked the recorded shas). */
export interface RunIdentity {
  model: string;
  fixtureSha: string;
  questionsSha: string;
}

export function matchesRun(r: { model?: string; fixtureSha?: string; questionsSha?: string }, id: RunIdentity): boolean {
  return r.model === id.model && r.fixtureSha === id.fixtureSha && r.questionsSha === id.questionsSha;
}

/** Successful rows OF THIS RUN IDENTITY win; error rows and rows from any
 *  other model/fixture/question state are retried or ignored. */
export function completedKeys(rows: AnswerRow[], id?: RunIdentity): Set<string> {
  return new Set(rows.filter((r) => !r.error && (!id || matchesRun(r, id))).map(rowKey));
}

/** Parse JSONL tolerantly: a torn final line (crash mid-append) is skipped —
 *  the checkpoint design already tolerates a missing row by re-running it —
 *  instead of bricking every later phase at collection time. */
export function parseJsonlSafe<T>(content: string): T[] {
  const out: T[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // torn/corrupt line — skip; its (qid, mode) simply reruns
    }
  }
  return out;
}

/** Does an answer's prose LOOK like an unexecuted tool call against the
 *  roster? The harness deliberately omits production's text-call salvage
 *  pass; this makes that deviation's incidence measurable per mode instead
 *  of invisible (review finding: such runs recorded finish:"ok"). */
export function proseCallSuspect(answer: string, rosterNames: readonly string[]): boolean {
  if (/<tool_call|<function_call|\[TOOL_CALL\]/i.test(answer)) return true;
  return rosterNames.some((n) =>
    new RegExp(`"name"\\s*:\\s*"${n}"|\\b${n}\\s*\\(`, "i").test(answer));
}

// ── Grading ────────────────────────────────────────────────────────────────

export interface GradeRow {
  qid: string;
  mode: E2Mode;
  type: E2QuestionType;
  /** needle/routing/quote-content: 1 correct, 0 wrong; synthesis: 0..5. */
  score: number;
  maxScore: number;
  /** How the score was decided. */
  by: "accept-list" | "quote-verify" | "judge" | "error";
  quoteChecks?: QuoteCheck[];
  judgeRaw?: string;
  notes?: string;
  /** Run identity, copied from the answer row — grade rows from another
   *  model/fixture/question state are stale and never count. */
  model?: string;
  fixtureSha?: string;
  questionsSha?: string;
}

/** Mechanical accept-list check on a deep-normalized, lowercased answer. */
export function acceptListHit(answer: string, accept: string[] | undefined): boolean {
  if (!accept?.length) return false;
  const hay = normalizeForMatch(answer, "deep").toLowerCase();
  return accept.some((a) => hay.includes(normalizeForMatch(a, "deep").toLowerCase()));
}

/** Do two texts share any ≥`shingle`-char contiguous run (deep-normalized)?
 *  Cheap LCS stand-in: shingles of EACH side tested against the other, stride
 *  10. Bidirectional because one-directional shingling of only `a` misses
 *  genuine 40–59-char overlaps that start mid-shingle (review-verified blind
 *  spot: a verified span carrying a 45-char true overlap behind 30 chars of
 *  adjacent text returned false). Catches "the model quoted a
 *  superset/subset/straddle of the key span" without full LCS machinery. */
export function sharesRun(a: string, b: string, shingle = 40): boolean {
  const na = normalizeForMatch(a, "deep");
  const nb = normalizeForMatch(b, "deep");
  if (na.length < shingle || nb.length < shingle) {
    const [s, l] = na.length <= nb.length ? [na, nb] : [nb, na];
    return s.length >= 20 && l.includes(s);
  }
  const oneWay = (x: string, y: string): boolean => {
    for (let i = 0; ; i += 10) {
      const end = Math.min(i + shingle, x.length);
      if (y.includes(x.slice(end - shingle, end))) return true;
      if (end === x.length) return false;
    }
  };
  return oneWay(na, nb) || oneWay(nb, na);
}

/** Quote-question correctness, fully mechanical: the answer must present at
 *  least one span that (a) verifies verbatim against the books (E3) and
 *  (b) overlaps the author-verified key passage — a real quote from the wrong
 *  paragraph is grounded but not an answer. */
export function quoteQuestionScore(
  answer: string,
  keyQuote: { chapter_id: string; text: string },
  books: BookDocument[],
): { score: 0 | 1; checks: QuoteCheck[] } {
  const checks = verifyQuotes(answer, books);
  let hit = checks.some((c) => c.verified && sharesRun(c.span, keyQuote.text));
  // Zero-extraction fallback (review finding): an answer can present the
  // passage without extractable quote punctuation (unmarked reproduction,
  // fragmented by interior quotes). The key IS verbatim chapter text by
  // validator construction, so answer-shares-a-run-of-the-key preserves the
  // E3 verbatim guarantee without any span extraction.
  if (!hit && checks.length === 0) hit = sharesRun(answer, keyQuote.text);
  return { score: hit ? 1 : 0, checks };
}

export interface ModeStats {
  needleCorrect: number;
  needleTotal: number;
  quoteCorrect: number;
  quoteTotal: number;
  quoteSpansVerified: number;
  quoteSpansTotal: number;
  synthesisMean: number;
  synthesisTotal: number;
  routingCorrect: number;
  routingTotal: number;
}

export interface E2Report {
  full: ModeStats;
  catalog: ModeStats;
  criteria: {
    needleParity: boolean;
    quoteParity: boolean;
    quoteVerifyRate: number;
    quoteVerifyPass: boolean;
    synthesisRegressionPct: number;
    synthesisPass: boolean;
    verdict: "FLIP" | "HOLD";
  };
}

/** Parity tolerance is ONE QUESTION, counted — never a rate. A rate constant
 *  (the first cut used 1/16 = 0.0625) silently becomes a ZERO-question
 *  tolerance the moment the set has more than 16 of a type (review finding:
 *  15 needles ⇒ one miss is 0.0667 > 0.0625 ⇒ auto-HOLD on single-question
 *  noise, stricter than the documented §8 gate). */
const PARITY_TOLERANCE_QUESTIONS = 1;

function emptyStats(): ModeStats {
  return { needleCorrect: 0, needleTotal: 0, quoteCorrect: 0, quoteTotal: 0, quoteSpansVerified: 0, quoteSpansTotal: 0, synthesisMean: 0, synthesisTotal: 0, routingCorrect: 0, routingTotal: 0 };
}

/** §8 criteria: parity-or-better on needle + quotes (within one-question
 *  tolerance), ≥95% of claimed quote spans mechanically verified (E3), and
 *  ≤10% regression on synthesis. */
export function buildReport(grades: GradeRow[]): E2Report {
  const stats: Record<E2Mode, ModeStats> = { full: emptyStats(), catalog: emptyStats() };
  const synthSum: Record<E2Mode, number> = { full: 0, catalog: 0 };
  for (const g of grades) {
    const s = stats[g.mode];
    if (!s) continue;
    if (g.type === "needle") { s.needleTotal++; s.needleCorrect += g.score >= 1 ? 1 : 0; }
    if (g.type === "routing") { s.routingTotal++; s.routingCorrect += g.score >= 1 ? 1 : 0; }
    if (g.type === "quote") {
      s.quoteTotal++;
      s.quoteCorrect += g.score >= 1 ? 1 : 0;
      for (const qc of g.quoteChecks || []) { s.quoteSpansTotal++; if (qc.verified) s.quoteSpansVerified++; }
    }
    if (g.type === "synthesis") { s.synthesisTotal++; synthSum[g.mode] += g.score; }
  }
  for (const mode of ["full", "catalog"] as const) {
    stats[mode].synthesisMean = stats[mode].synthesisTotal ? synthSum[mode] / stats[mode].synthesisTotal : 0;
  }
  const rate = (c: number, t: number) => (t ? c / t : 0);
  const needleParity = stats.catalog.needleCorrect >= stats.full.needleCorrect - PARITY_TOLERANCE_QUESTIONS;
  const quoteParity = stats.catalog.quoteCorrect >= stats.full.quoteCorrect - PARITY_TOLERANCE_QUESTIONS;
  const catalogSpanRate = rate(stats.catalog.quoteSpansVerified, stats.catalog.quoteSpansTotal);
  const synthesisRegressionPct = stats.full.synthesisMean > 0 ? Math.max(0, (stats.full.synthesisMean - stats.catalog.synthesisMean) / stats.full.synthesisMean) * 100 : 0;
  const quoteVerifyPass = catalogSpanRate >= 0.95;
  const synthesisPass = synthesisRegressionPct <= 10;
  return {
    full: stats.full,
    catalog: stats.catalog,
    criteria: {
      needleParity,
      quoteParity,
      quoteVerifyRate: catalogSpanRate,
      quoteVerifyPass,
      synthesisRegressionPct,
      synthesisPass,
      verdict: needleParity && quoteParity && quoteVerifyPass && synthesisPass ? "FLIP" : "HOLD",
    },
  };
}
