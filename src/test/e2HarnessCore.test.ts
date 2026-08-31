import { describe, it, expect } from "vitest";
import {
  acceptListHit, buildReport, completedKeys, extractQuotedSpans, normalizeForMatch, parseJsonlSafe,
  proseCallSuspect, quoteQuestionScore, runToolLoop, sharesRun, validateQuestions, verifyQuotes,
  E2_MAX_TOOL_ITERATIONS, E2_TOOL_RESULT_SLICE,
  type AnswerRow, type E2Question, type GradeRow,
} from "@/harness/e2/harnessCore";
import type { ChatProviderAdapter, ChatStreamEvent } from "@/lib/providers/types";

/**
 * The E2 harness's own mechanics, offline. The harness decides whether the
 * catalog default flips — a grading bug here silently decides product
 * direction, so the quote pipeline, the tool loop, checkpoint resume, and
 * the criteria math each get pinned against synthetic books and a scripted
 * adapter. No network anywhere in this file.
 */

const bookA: any = {
  id: "book-a", title: "Book A", fileName: "a.pdf", fileData: "", pageCount: 10, addedAt: 0, folderIds: [],
  chapters: [
    { id: "a1", name: "One", startPage: 1, endPage: 5, textContent: "The tide tables of Meridian Bay were compiled by hand for forty-one years, and the compiler never once missed a morning reading." },
    { id: "a2", name: "Two", startPage: 6, endPage: 10, textContent: "A long-standing rule of the harbor: no vessel departs on the ebb without a signed manifest from the harbormaster's office." },
  ],
};
const bookB: any = {
  id: "book-b", title: "Book B", fileName: "b.pdf", fileData: "", pageCount: 8, addedAt: 0, folderIds: [],
  chapters: [
    { id: "b1", name: "Uno", startPage: 1, endPage: 8, textContent: "Hyphen-\nated line breaks are a PDF extraction artifact that quote verification must survive without punishing the model." },
  ],
};
const BOOKS = [bookA, bookB];

describe("quote verification (E3 mechanics)", () => {
  it("extracts only quote-shaped spans of substance", () => {
    const spans = extractQuotedSpans('He said "the compiler never once missed a morning reading" and also "tiny".');
    expect(spans).toEqual(["the compiler never once missed a morning reading"]);
  });

  it("verifies verbatim spans strictly and reports the level", () => {
    const checks = verifyQuotes('Quote: "compiled by hand for forty-one years, and the compiler never" — yes.', BOOKS);
    expect(checks).toHaveLength(1);
    expect(checks[0].verified).toBe(true);
    expect(checks[0].level).toBe("strict");
  });

  it("survives whitespace and curly-quote drift at the ws level", () => {
    const checks = verifyQuotes('“compiled  by hand\nfor forty-one years, and the compiler never”', BOOKS);
    expect(checks[0].verified).toBe(true);
    expect(checks[0].level).toBe("ws");
  });

  it("joins hyphenated line breaks only at the deep level", () => {
    const checks = verifyQuotes('"Hyphenated line breaks are a PDF extraction artifact that quote verification must survive"', BOOKS);
    expect(checks[0].verified).toBe(true);
    expect(checks[0].level).toBe("deep");
  });

  it("a fabricated quote does not verify", () => {
    const checks = verifyQuotes('"the compiler was fired after missing a reading in the spring"', BOOKS);
    expect(checks[0].verified).toBe(false);
  });

  it("quote questions need the RIGHT passage, not just any real quote", () => {
    const key = { chapter_id: "a1", text: "compiled by hand for forty-one years, and the compiler never once missed a morning reading" };
    const right = quoteQuestionScore('The book says "for forty-one years, and the compiler never once missed a morning reading".', key, BOOKS);
    expect(right.score).toBe(1);
    const wrongPassage = quoteQuestionScore('It says "no vessel departs on the ebb without a signed manifest from the harbormaster\'s office".', key, BOOKS);
    expect(wrongPassage.checks[0]?.verified).toBe(true);
    expect(wrongPassage.score).toBe(0);
  });

  it("sharesRun catches superset quotes via shingles", () => {
    expect(sharesRun(
      "and the compiler never once missed a morning reading",
      "for forty-one years, and the compiler never once missed a morning reading, which amazed everyone",
    )).toBe(true);
    expect(sharesRun("completely unrelated text about gulls circling the pier at noon", "the tide tables of Meridian Bay")).toBe(false);
  });

  it("sharesRun catches a 45-char true overlap hidden behind adjacent text (the 40-59 blind spot)", () => {
    // Review-verified failure of the one-directional stride-20 version: a
    // span that STRADDLES the key's start — 30 chars of adjacent chapter
    // text, then 45 chars of genuine key overlap.
    const key = "the compiler never once missed a morning reading in all that time, rain or shine";
    const span = "signed by the harbormaster and " + key.slice(0, 45);
    expect(sharesRun(span, key)).toBe(true);
  });

  it("extracts quotes longer than 600 chars (the old cap scored verbatim over-quotes zero)", () => {
    const long = "compiled by hand for forty-one years " + "and checked every dawn without fail ".repeat(20);
    const spans = extractQuotedSpans(`The book says "${long}" plainly.`);
    expect(spans).toHaveLength(1);
    expect(spans[0].length).toBeGreaterThan(600);
  });

  it("bold-wrapped blockquote quotes extract cleanly (measured live: > **\"...\"**)", () => {
    const checks = verifyQuotes(
      '> **"compiled by hand for forty-one years, and the compiler never"** (Book A, ch. 1)',
      BOOKS,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].verified).toBe(true);
  });

  it("blockquote spans shed wrapping quote glyphs and trailing citations (the 50%-rate bug)", () => {
    const checks = verifyQuotes(
      '> "compiled by hand for forty-one years, and the compiler never" (Book A, ch. 1)',
      BOOKS,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].verified).toBe(true);
  });

  it("a quoted chapter name is attribution, not a quote claim", () => {
    const checks = verifyQuotes('That line is from "One" — see also "Chapter 12: The Ebb and Flow of Tides".', BOOKS);
    expect(checks).toHaveLength(0);
  });

  it("the same quote via regex AND blockquote counts once", () => {
    const answer = 'The book says "compiled by hand for forty-one years, and the compiler never".\n> compiled by hand for forty-one years, and the compiler never';
    const checks = verifyQuotes(answer, BOOKS);
    expect(checks).toHaveLength(1);
    expect(checks[0].verified).toBe(true);
  });

  it("quote questions with zero extractable spans fall back to key-overlap on the raw answer", () => {
    const key = { chapter_id: "a1", text: "compiled by hand for forty-one years, and the compiler never once missed a morning reading" };
    const unpunctuated = quoteQuestionScore(
      "The passage states: compiled by hand for forty-one years, and the compiler never once missed a morning reading.",
      key, BOOKS,
    );
    expect(unpunctuated.checks).toHaveLength(0);
    expect(unpunctuated.score).toBe(1);
    const wrong = quoteQuestionScore("The passage talks about harbors and manifests generally.", key, BOOKS);
    expect(wrong.score).toBe(0);
  });
});

describe("accept-list matching", () => {
  it("normalizes both sides before the substring test", () => {
    expect(acceptListHit("The rule requires a SIGNED  manifest.", ["signed manifest"])).toBe(true);
    expect(acceptListHit("No idea.", ["signed manifest"])).toBe(false);
    expect(acceptListHit("anything", undefined)).toBe(false);
  });
});

describe("question validation", () => {
  const good: E2Question[] = [
    { id: "q1", type: "quote", book_id: "book-a", question: "Quote the tide-table sentence.", key: { quote: { chapter_id: "a1", text: "compiled by hand for forty-one years, and the compiler never once missed" } } },
    { id: "q2", type: "needle", book_id: "book-a", question: "How long were the tables compiled by hand?", key: { expected: "forty-one years", accept: ["forty-one years"], chapter_id: "a1" } },
    { id: "q3", type: "synthesis", book_id: "book-a", question: "How do ch1 and ch2 relate?", key: { points: ["tables", "manifest rule"] } },
  ];
  it("passes a well-formed set", () => {
    expect(validateQuestions(good, BOOKS)).toEqual([]);
  });
  it("rejects a quote key that is not verbatim in its chapter", () => {
    const bad = [{ ...good[0], key: { quote: { chapter_id: "a1", text: "this sentence is definitely not in the chapter at all, not even close" } } }];
    expect(validateQuestions(bad as E2Question[], BOOKS).map((i) => i.problem)).toContain("quote key is NOT a verbatim span of its chapter");
  });
  it("rejects a needle whose acceptors never appear in the source chapter", () => {
    const bad = [{ ...good[1], key: { expected: "x", accept: ["completely absent phrase"], chapter_id: "a1" } }];
    expect(validateQuestions(bad as E2Question[], BOOKS).map((i) => i.problem)).toContain("no acceptor appears in the source chapter (deep-normalized)");
  });
  it("routing questions need expected too — the judge fallback interpolates it", () => {
    const bad: E2Question[] = [{ id: "r1", type: "routing", book_id: "both", question: "Which book?", key: { accept: ["book a"] } }];
    expect(validateQuestions(bad, BOOKS)).toHaveLength(1);
    const ok: E2Question[] = [{ id: "r1", type: "routing", book_id: "both", question: "Which book?", key: { accept: ["book a"], expected: "Book A" } }];
    expect(validateQuestions(ok, BOOKS)).toEqual([]);
  });
});

describe("tool loop (scripted adapter)", () => {
  function scriptedAdapter(script: ChatStreamEvent[][]): ChatProviderAdapter {
    let call = 0;
    return {
      id: "openrouter",
      async *streamChat() {
        const events = script[Math.min(call++, script.length - 1)];
        for (const ev of events) yield ev;
      },
      async completeChat() { return ""; },
    };
  }

  it("accumulates split tool_call deltas, executes, slices results at the app cap, and iterates", async () => {
    const adapter = scriptedAdapter([
      [
        { type: "text", delta: "Let me check." },
        { type: "tool_call_delta", index: 0, id: "c1", name: "get_chapter_text" },
        { type: "tool_call_delta", index: 0, argsDelta: '{"chapter_id":' },
        { type: "tool_call_delta", index: 0, argsDelta: '"a1"}' },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", delta: 'Answer: "compiled by hand".' },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const executed: string[] = [];
    const res = await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 1,
      messages: [{ role: "user", content: "q" }], tools: [],
      executeTool: async (name, rawArgs) => {
        executed.push(`${name}:${rawArgs}`);
        return { result: { text: "X".repeat(E2_TOOL_RESULT_SLICE + 500), __images: ["side-channel"] }, event: { name, summary: "ok", ok: true } };
      },
    });
    expect(executed).toEqual(['get_chapter_text:{"chapter_id":"a1"}']);
    expect(res.text).toContain("Let me check.");
    expect(res.text).toContain('Answer: "compiled by hand".');
    expect(res.iterations).toBe(2);
    expect(res.finish).toBe("ok");
    expect(res.toolTrace[0].resultChars).toBe(E2_TOOL_RESULT_SLICE);
    expect(res.sentChars).toHaveLength(2);
    expect(res.sentChars[1]).toBeGreaterThan(res.sentChars[0]);
  });

  it("strips __-side-channel fields before the result reaches the transcript", async () => {
    let toolMessage = "";
    const adapter: ChatProviderAdapter = {
      id: "openrouter",
      async *streamChat(req) {
        const msgs = req.messages as any[];
        const t = msgs.find((m) => m.role === "tool");
        if (t) { toolMessage = t.content; yield { type: "finish", reason: "stop" } as ChatStreamEvent; return; }
        yield { type: "tool_call_delta", index: 0, id: "c1", name: "get_book", argsDelta: "{}" } as ChatStreamEvent;
        yield { type: "finish", reason: "tool_calls" } as ChatStreamEvent;
      },
      async completeChat() { return ""; },
    };
    await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 0, messages: [], tools: [],
      executeTool: async () => ({ result: { ok: true, __images: ["leak"] }, event: { name: "get_book", summary: "", ok: true } }),
    });
    expect(toolMessage).toContain('"ok":true');
    expect(toolMessage).not.toContain("__images");
  });

  it("drops accumulated calls when the stream was cut by length/content_filter (production parity)", async () => {
    // Review finding: production discards calls on a cut stream
    // (streamCutShort); executing half-written JSON granted the model a
    // recovery round it never gets in the app — and recorded finish:"ok".
    const adapter = scriptedAdapter([[
      { type: "text", delta: "Half an answer" },
      { type: "tool_call_delta", index: 0, id: "c", name: "get_book", argsDelta: '{"book_' },
      { type: "finish", reason: "length", native: "MAX_TOKENS" },
    ]]);
    const executed: string[] = [];
    const res = await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 0, messages: [], tools: [],
      executeTool: async (name) => { executed.push(name); return { result: {}, event: { name, summary: "", ok: true } }; },
    });
    expect(executed).toEqual([]);
    expect(res.finish).toBe("cut_short");
    expect(res.iterations).toBe(1);
  });

  it("after the tool budget, the forced answer round runs with tool_choice none + the budget note", async () => {
    // The E2 run measured 6/40 catalog answers coming back BLANK when the
    // budget ran out mid-research; the forced answer round is the fix,
    // mirrored from ChatContext.
    const seen: Array<{ toolChoice?: string; hasNote: boolean }> = [];
    let executions = 0;
    const adapter: ChatProviderAdapter = {
      id: "openrouter",
      async *streamChat(req) {
        seen.push({
          toolChoice: req.toolChoice,
          hasNote: (req.messages as any[]).some((m) => m.role === "system" && /Tool budget for this reply is spent/.test(m.content)),
        });
        if (req.toolChoice === "none") {
          // A provider ignoring the pin: emits BOTH text and a call.
          yield { type: "text", delta: "Final answer from what I read." } as ChatStreamEvent;
          yield { type: "tool_call_delta", index: 0, id: "x", name: "get_book", argsDelta: "{}" } as ChatStreamEvent;
          yield { type: "finish", reason: "stop" } as ChatStreamEvent;
          return;
        }
        yield { type: "tool_call_delta", index: 0, id: "c", name: "get_book", argsDelta: "{}" } as ChatStreamEvent;
        yield { type: "finish", reason: "tool_calls" } as ChatStreamEvent;
      },
      async completeChat() { return ""; },
    };
    const res = await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 0, messages: [], tools: [],
      executeTool: async () => { executions++; return { result: { ok: true }, event: { name: "get_book", summary: "", ok: true } }; },
    });
    expect(res.iterations).toBe(E2_MAX_TOOL_ITERATIONS + 1);
    expect(res.finish).toBe("answered_after_cap");
    expect(res.text).toContain("Final answer from what I read.");
    // Tool rounds executed the budget; the final round's stray call did NOT.
    expect(executions).toBe(E2_MAX_TOOL_ITERATIONS);
    expect(seen.slice(0, E2_MAX_TOOL_ITERATIONS).every((s) => s.toolChoice === undefined && !s.hasNote)).toBe(true);
    expect(seen[E2_MAX_TOOL_ITERATIONS]).toEqual({ toolChoice: "none", hasNote: true });
  });

  it("calls-WITHOUT-prose on the forced round earns one toolless retry (wire-measured: tool_choice none is advisory)", async () => {
    const seen: Array<{ toolChoice?: string; hasTools: boolean; hasStripNote: boolean; hasCallHistory: boolean; hasNotes: boolean }> = [];
    let executions = 0;
    const adapter: ChatProviderAdapter = {
      id: "openrouter",
      async *streamChat(req) {
        seen.push({
          toolChoice: req.toolChoice,
          hasTools: req.tools !== undefined,
          hasStripNote: (req.messages as any[]).some((m) => m.role === "system" && /No tools are attached to this request/.test(m.content)),
          hasCallHistory: (req.messages as any[]).some((m) => m.role === "tool" || m.tool_calls),
          hasNotes: (req.messages as any[]).some((m) => m.role === "system" && /Research notes/.test(m.content)),
        });
        if (req.tools === undefined) {
          yield { type: "text", delta: "Answer from what I read, at last." } as ChatStreamEvent;
          yield { type: "finish", reason: "stop" } as ChatStreamEvent;
          return;
        }
        // Every tooled round — INCLUDING the tool_choice:"none" one — emits
        // only a call, the measured gemini-via-OpenRouter behavior.
        yield { type: "tool_call_delta", index: 0, id: "c", name: "get_book", argsDelta: "{}" } as ChatStreamEvent;
        yield { type: "finish", reason: "tool_calls" } as ChatStreamEvent;
      },
      async completeChat() { return ""; },
    };
    const res = await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 0, messages: [], tools: [],
      executeTool: async () => { executions++; return { result: { ok: true }, event: { name: "get_book", summary: "", ok: true } }; },
    });
    expect(res.iterations).toBe(E2_MAX_TOOL_ITERATIONS + 2);
    expect(res.finish).toBe("answered_after_cap");
    expect(res.text).toContain("Answer from what I read, at last.");
    expect(executions).toBe(E2_MAX_TOOL_ITERATIONS);
    const last = seen[seen.length - 1];
    expect(last.hasTools).toBe(false);
    expect(last.hasStripNote).toBe(true);
    // The retry must not CONTINUE the calling conversation: no tool_calls or
    // tool-result messages ride (wire-measured, the model imitates them even
    // with zero tools declared) — the reads ride as research notes instead.
    expect(last.hasCallHistory).toBe(false);
    expect(last.hasNotes).toBe(true);
    expect(seen[seen.length - 2].hasCallHistory).toBe(true);
  });

  it("a run that stays proseless through the toolless retry records max_iterations", async () => {
    const adapter = scriptedAdapter([[
      { type: "tool_call_delta", index: 0, id: "c", name: "get_book", argsDelta: "{}" },
      { type: "finish", reason: "tool_calls" },
    ]]);
    const res = await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 0, messages: [], tools: [],
      executeTool: async () => ({ result: { ok: true }, event: { name: "get_book", summary: "", ok: true } }),
    });
    expect(res.iterations).toBe(E2_MAX_TOOL_ITERATIONS + 2);
    expect(res.finish).toBe("max_iterations");
  });
});

describe("checkpoint resume", () => {
  it("error rows are retried; successful rows are skipped", () => {
    const rows = [
      { qid: "q1", mode: "full", error: "network: boom" },
      { qid: "q1", mode: "catalog" },
      { qid: "q2", mode: "full" },
    ] as AnswerRow[];
    const done = completedKeys(rows);
    expect(done.has("q1::full")).toBe(false);
    expect(done.has("q1::catalog")).toBe(true);
    expect(done.has("q2::full")).toBe(true);
  });

  it("rows from another model or another fixture/question state are STALE, not done", () => {
    // Review finding: resuming after a model switch used to mix models
    // within one question's A/B pair; a fixture/question edit used to grade
    // stale answers against new keys.
    const id = { model: "m1", fixtureSha: "f1", questionsSha: "s1" };
    const rows = [
      { qid: "q1", mode: "full", model: "m1", fixtureSha: "f1", questionsSha: "s1" },
      { qid: "q1", mode: "catalog", model: "m2", fixtureSha: "f1", questionsSha: "s1" },
      { qid: "q2", mode: "full", model: "m1", fixtureSha: "OLD", questionsSha: "s1" },
      { qid: "q2", mode: "catalog", model: "m1", fixtureSha: "f1", questionsSha: "OLD" },
    ] as AnswerRow[];
    const done = completedKeys(rows, id);
    expect(done).toEqual(new Set(["q1::full"]));
  });

  it("a torn final JSONL line is skipped, never a wall", () => {
    const rows = parseJsonlSafe<AnswerRow>(
      '{"qid":"q1","mode":"full"}\n{"qid":"q2","mo',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].qid).toBe("q1");
  });
});

describe("prose-call detection (the salvage-pass deviation, counted)", () => {
  const ROSTER = ["list_books", "get_book", "get_chapter_text"];
  it("flags call-shaped prose against the roster", () => {
    expect(proseCallSuspect('I will call {"name": "get_chapter_text", "arguments": {}}', ROSTER)).toBe(true);
    expect(proseCallSuspect("<tool_call>get_book</tool_call>", ROSTER)).toBe(true);
    expect(proseCallSuspect("Let me use get_chapter_text(chapter_id) to read it", ROSTER)).toBe(true);
  });
  it("does not flag ordinary prose that merely mentions reading", () => {
    expect(proseCallSuspect("The chapter text says the tide tables were compiled by hand.", ROSTER)).toBe(false);
  });
});

describe("report criteria (§8)", () => {
  const g = (qid: string, mode: "full" | "catalog", type: GradeRow["type"], score: number, extra: Partial<GradeRow> = {}): GradeRow =>
    ({ qid, mode, type, score, maxScore: type === "synthesis" ? 5 : 1, by: "accept-list", ...extra });

  it("flips on parity + verified quotes + bounded synthesis regression", () => {
    const grades: GradeRow[] = [
      g("n1", "full", "needle", 1), g("n1", "catalog", "needle", 1),
      g("n2", "full", "needle", 0), g("n2", "catalog", "needle", 1),
      g("q1", "full", "quote", 1, { quoteChecks: [{ span: "s", verified: true, level: "strict" }] }),
      g("q1", "catalog", "quote", 1, { quoteChecks: [{ span: "s", verified: true, level: "strict" }] }),
      g("s1", "full", "synthesis", 5), g("s1", "catalog", "synthesis", 5),
    ];
    const r = buildReport(grades);
    expect(r.criteria.verdict).toBe("FLIP");
    expect(r.criteria.quoteVerifyRate).toBe(1);
  });

  it("holds when catalog regresses needles beyond the stated tolerance", () => {
    const grades: GradeRow[] = [];
    for (let i = 0; i < 8; i++) {
      grades.push(g(`n${i}`, "full", "needle", 1));
      grades.push(g(`n${i}`, "catalog", "needle", i < 6 ? 1 : 0)); // two questions down
    }
    expect(buildReport(grades).criteria.needleParity).toBe(false);
    expect(buildReport(grades).criteria.verdict).toBe("HOLD");
  });

  it("tolerance is ONE QUESTION counted — a single miss at n=15 stays parity (the 1/16-rate bug)", () => {
    // Review finding: a 0.0625 RATE tolerance was a zero-question tolerance
    // for the real set (one miss of 15 = 0.0667 > 0.0625 → auto-HOLD on
    // single-question noise). The boundary is pinned at the real set size.
    const grades: GradeRow[] = [];
    for (let i = 0; i < 15; i++) {
      grades.push(g(`n${i}`, "full", "needle", 1));
      grades.push(g(`n${i}`, "catalog", "needle", i === 0 ? 0 : 1)); // exactly one miss
    }
    expect(buildReport(grades).criteria.needleParity).toBe(true);
    const worse = grades.map((r) => (r.mode === "catalog" && r.qid === "n1" ? { ...r, score: 0 } : r));
    expect(buildReport(worse).criteria.needleParity).toBe(false);
  });

  it("holds when catalog's claimed quotes stop verifying (E3)", () => {
    const grades: GradeRow[] = [
      g("q1", "full", "quote", 1, { quoteChecks: [{ span: "s", verified: true, level: "strict" }] }),
      g("q1", "catalog", "quote", 1, {
        quoteChecks: [
          { span: "s", verified: true, level: "strict" },
          { span: "fabricated span one", verified: false },
          { span: "fabricated span two", verified: false },
        ],
      }),
    ];
    expect(buildReport(grades).criteria.quoteVerifyPass).toBe(false);
    expect(buildReport(grades).criteria.verdict).toBe("HOLD");
  });

  it("holds on >10% synthesis regression", () => {
    const grades: GradeRow[] = [
      g("s1", "full", "synthesis", 5), g("s1", "catalog", "synthesis", 4),
      g("s2", "full", "synthesis", 5), g("s2", "catalog", "synthesis", 4),
    ];
    const r = buildReport(grades);
    expect(r.criteria.synthesisRegressionPct).toBeCloseTo(20);
    expect(r.criteria.synthesisPass).toBe(false);
  });
});
