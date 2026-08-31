import { describe, it, expect } from "vitest";
import {
  acceptListHit, buildReport, completedKeys, extractQuotedSpans, normalizeForMatch,
  quoteQuestionScore, runToolLoop, sharesRun, validateQuestions, verifyQuotes,
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

  it("stops at the app's iteration cap and says so", async () => {
    const adapter = scriptedAdapter([[
      { type: "tool_call_delta", index: 0, id: "c", name: "get_book", argsDelta: "{}" },
      { type: "finish", reason: "tool_calls" },
    ]]);
    const res = await runToolLoop({
      adapter, model: "m", apiKey: "k", cacheStablePrefixCount: 0, messages: [], tools: [],
      executeTool: async () => ({ result: { ok: true }, event: { name: "get_book", summary: "", ok: true } }),
    });
    expect(res.iterations).toBe(E2_MAX_TOOL_ITERATIONS);
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
      grades.push(g(`n${i}`, "catalog", "needle", i < 6 ? 1 : 0)); // 25% drop
    }
    expect(buildReport(grades).criteria.needleParity).toBe(false);
    expect(buildReport(grades).criteria.verdict).toBe("HOLD");
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
