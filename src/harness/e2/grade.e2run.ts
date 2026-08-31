import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * E2 GRADE + REPORT PHASE — mechanical first, judge only where mechanics
 * can't decide, blind to mode throughout. Run after the answer phase:
 *
 *   npx vitest run --config vitest.e2.config.ts src/harness/e2/grade.e2run.ts
 *
 * Grading order per question type:
 *  - quote:    fully mechanical (E3) — spans verified verbatim against the
 *              fixture chapters AND overlapping the author-verified key span.
 *  - needle /
 *    routing:  accept-list hit = correct; misses go to the judge with the
 *              reference answer (a miss can still be a correct paraphrase).
 *  - synthesis: judge scores 0–5 against the authored key points.
 *
 * The judge never sees which mode produced an answer. Checkpoints to
 * e2-data/grades.jsonl; emits e2-data/report.json + report.md at the end.
 */
import {
  acceptListHit, buildReport, quoteQuestionScore, rowKey,
  type AnswerRow, type E2Mode, type E2Question, type GradeRow,
} from "@/harness/e2/harnessCore";
import type { BookDocument } from "@/types/library";

const ROOT = process.cwd();
const DATA = resolve(ROOT, "e2-data");
const ANSWERS = resolve(DATA, "answers.jsonl");
const GRADES = resolve(DATA, "grades.jsonl");

function readEnvFile(): Record<string, string> {
  const p = resolve(ROOT, ".env.e2.local");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = readEnvFile();
const API_KEY = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || "";
const JUDGE = process.env.E2_JUDGE || env.E2_JUDGE || process.env.E2_MODEL || env.E2_MODEL || "google/gemini-3.7-flash";

const fixturesPath = resolve(DATA, "fixtures", "books.json");
const questionsPath = resolve(DATA, "questions.json");
const ready = existsSync(fixturesPath) && existsSync(questionsPath) && existsSync(ANSWERS) && !!API_KEY;

const books: BookDocument[] = ready ? JSON.parse(readFileSync(fixturesPath, "utf8")) : [];
const questions: E2Question[] = ready ? JSON.parse(readFileSync(questionsPath, "utf8")) : [];
const qById = new Map(questions.map((q) => [q.id, q]));

/** Latest successful answer per (qid, mode). */
function loadAnswers(): Map<string, AnswerRow> {
  const out = new Map<string, AnswerRow>();
  for (const line of readFileSync(ANSWERS, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as AnswerRow;
    if (!r.error) out.set(rowKey(r), r);
  }
  return out;
}

function loadGrades(): Map<string, GradeRow> {
  const out = new Map<string, GradeRow>();
  if (!existsSync(GRADES)) return out;
  for (const line of readFileSync(GRADES, "utf8").split("\n").filter(Boolean)) {
    const g = JSON.parse(line) as GradeRow;
    if (g.by !== "error") out.set(rowKey(g), g);
  }
  return out;
}

async function judgeCall(prompt: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: JUDGE,
        stream: false,
        temperature: 0,
        // Mandatory-reasoning models (measured on this account's default)
        // spend hundreds of tokens thinking before the JSON appears.
        max_tokens: 2_000,
        messages: [
          {
            role: "system",
            content:
              "You are a strict, terse exam grader. Judge ONLY against the reference material given. " +
              "Answer length must not influence the grade. Reply with a single JSON object and nothing else.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 15_000));
        continue;
      }
      throw new Error(`judge ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = JSON.parse(body);
    return String(data?.choices?.[0]?.message?.content || "");
  }
}

function parseJudgeJson(raw: string): any {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

describe.skipIf(!ready)("E2 grade phase", () => {
  const answers = ready ? loadAnswers() : new Map<string, AnswerRow>();
  const graded = ready ? loadGrades() : new Map<string, GradeRow>();

  for (const q of questions) {
    for (const mode of ["full", "catalog"] as const) {
      const key = rowKey({ qid: q.id, mode });
      it.skipIf(graded.has(key) || !answers.has(key))(`grade ${q.id} · ${mode}`, async () => {
        const a = answers.get(key)!;
        let row: GradeRow;
        try {
          if (q.type === "quote") {
            const { score, checks } = quoteQuestionScore(a.answer, q.key.quote!, books);
            row = { qid: q.id, mode, type: q.type, score, maxScore: 1, by: "quote-verify", quoteChecks: checks };
          } else if (q.type === "needle" || q.type === "routing") {
            if (acceptListHit(a.answer, q.key.accept)) {
              row = { qid: q.id, mode, type: q.type, score: 1, maxScore: 1, by: "accept-list" };
            } else {
              const raw = await judgeCall(
                `Question a reader asked about a book:\n${q.question}\n\n` +
                `Reference answer (ground truth from the book):\n${q.key.expected}\n\n` +
                `Candidate answer to grade:\n---\n${a.answer.slice(0, 6000)}\n---\n\n` +
                `Does the candidate answer state the reference fact correctly (paraphrase is fine; extra correct context is fine; a wrong, missing, or evasive core fact is not)? ` +
                `Reply JSON: {"correct": true|false, "why": "<one sentence>"}`,
              );
              const j = parseJudgeJson(raw);
              row = { qid: q.id, mode, type: q.type, score: j.correct === true ? 1 : 0, maxScore: 1, by: "judge", judgeRaw: raw.slice(0, 400) };
            }
          } else {
            const raw = await judgeCall(
              `Question a reader asked about a book:\n${q.question}\n\n` +
              `Key points a full-credit answer must cover (from the book):\n` +
              q.key.points!.map((p, i) => `${i + 1}. ${p}`).join("\n") +
              `\n\nCandidate answer to grade:\n---\n${a.answer.slice(0, 8000)}\n---\n\n` +
              `Score 0-5: 5 = all key points covered accurately; subtract for each key point missing, wrong, or contradicted; 0 = off-topic or fabricated. ` +
              `Reply JSON: {"score": <0-5>, "why": "<one sentence>"}`,
            );
            const j = parseJudgeJson(raw);
            const score = Math.max(0, Math.min(5, Number(j.score)));
            if (!Number.isFinite(score)) throw new Error(`judge score not a number: ${raw.slice(0, 200)}`);
            row = { qid: q.id, mode, type: q.type, score, maxScore: 5, by: "judge", judgeRaw: raw.slice(0, 400) };
          }
        } catch (e: any) {
          row = { qid: q.id, mode, type: q.type, score: 0, maxScore: q.type === "synthesis" ? 5 : 1, by: "error", notes: String(e?.message || e) };
        }
        appendFileSync(GRADES, JSON.stringify(row) + "\n");
        if (row.by === "error") console.warn(`[e2] grade ${key} ERROR: ${row.notes}`);
        else console.log(`[e2] grade ${key}: ${row.score}/${row.maxScore} (${row.by})`);
        expect(row.qid).toBe(q.id);
      });
    }
  }

  it("emits the report when every pair is graded", () => {
    const rows = [...loadGrades().values()];
    const expected = questions.length * 2;
    if (rows.length < expected) {
      console.warn(`[e2] report deferred: ${rows.length}/${expected} graded (rerun to retry error rows)`);
      expect(rows.length, "rerun the grade phase until all pairs are graded").toBe(expected);
      return;
    }
    const report = buildReport(rows);
    // Cost/latency readout from the answer rows, per mode.
    const ans = [...loadAnswers().values()];
    const agg = (mode: E2Mode) => {
      const rowsM = ans.filter((r) => r.mode === mode);
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      return {
        n: rowsM.length,
        meanFirstSendChars: Math.round(mean(rowsM.map((r) => r.sentChars[0] || 0))),
        meanTotalSentChars: Math.round(mean(rowsM.map((r) => r.sentChars.reduce((a, b) => a + b, 0)))),
        meanToolCalls: +mean(rowsM.map((r) => r.toolTrace.length)).toFixed(2),
        meanMs: Math.round(mean(rowsM.map((r) => r.ms))),
      };
    };
    const out = { report, cost: { full: agg("full"), catalog: agg("catalog") }, judge: JUDGE, at: new Date().toISOString() };
    writeFileSync(resolve(DATA, "report.json"), JSON.stringify(out, null, 2));
    console.log("[e2] report:", JSON.stringify(out, null, 2));
    expect(report.criteria.verdict).toMatch(/FLIP|HOLD/);
  });
});

describe.skipIf(ready)("E2 grade phase (not configured)", () => {
  it("explains what is missing", () => {
    console.warn("[e2] grade skipped — need fixtures, questions, answers.jsonl, and the API key");
    expect(true).toBe(true);
  });
});
