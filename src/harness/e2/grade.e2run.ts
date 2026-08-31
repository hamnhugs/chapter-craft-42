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
  acceptListHit, buildReport, matchesRun, parseJsonlSafe, proseCallSuspect, quoteQuestionScore, rowKey, verifyQuotes,
  type AnswerRow, type E2Mode, type E2Question, type GradeRow, type RunIdentity,
} from "@/harness/e2/harnessCore";
import type { BookDocument } from "@/types/library";
import { createHash } from "node:crypto";

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
const fixtureSha = ready ? createHash("sha256").update(readFileSync(fixturesPath)).digest("hex").slice(0, 16) : "";
const questionsSha = ready ? createHash("sha256").update(readFileSync(questionsPath)).digest("hex").slice(0, 16) : "";

/** Latest successful answer per (qid, mode) — CURRENT fixture/question bytes
 *  only, and exactly ONE answer model across the board. Stale rows (edited
 *  questions, re-exported fixtures) would be graded against keys they never
 *  saw; mixed models would compare arms across models (review finding: the
 *  recorded shas/model were never checked). Returns the run identity so
 *  grade rows inherit it. */
function loadAnswers(): { rows: Map<string, AnswerRow>; identity: RunIdentity | null } {
  const current = parseJsonlSafe<AnswerRow>(readFileSync(ANSWERS, "utf8"))
    .filter((r) => !r.error && r.fixtureSha === fixtureSha && r.questionsSha === questionsSha && qById.has(r.qid));
  const models = [...new Set(current.map((r) => r.model))];
  if (models.length > 1) {
    throw new Error(`answers.jsonl holds rows from ${models.length} models (${models.join(", ")}) for the current question set — a mixed-model A/B is invalid. Delete the stale rows or rerun the answer phase on one model.`);
  }
  const out = new Map<string, AnswerRow>();
  for (const r of current) out.set(rowKey(r), r);
  return { rows: out, identity: models.length ? { model: models[0], fixtureSha, questionsSha } : null };
}

function loadGrades(id: RunIdentity | null): Map<string, GradeRow> {
  const out = new Map<string, GradeRow>();
  if (!existsSync(GRADES) || !id) return out;
  for (const g of parseJsonlSafe<GradeRow>(readFileSync(GRADES, "utf8"))) {
    if (g.by !== "error" && qById.has(g.qid) && matchesRun(g, id)) out.set(rowKey(g), g);
  }
  return out;
}

async function judgeCall(prompt: string): Promise<string> {
  // Mandatory-reasoning models (measured on this account's default) spend
  // hundreds of tokens thinking before the JSON appears; if 2k still comes
  // back contentless, one escalation to 6k prevents the permanent
  // error-row/re-pay loop a fixed cap would create (review finding).
  const caps = [2_000, 6_000];
  for (let capIdx = 0; capIdx < caps.length; capIdx++) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: JUDGE,
          stream: false,
          temperature: 0,
          max_tokens: caps[capIdx],
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
      const content = String(data?.choices?.[0]?.message?.content || "");
      if (content.trim() || capIdx === caps.length - 1) return content;
      break; // contentless at this cap — escalate once
    }
  }
  return "";
}

function parseJudgeJson(raw: string): any {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

describe.skipIf(!ready)("E2 grade phase", () => {
  const loaded = ready ? loadAnswers() : { rows: new Map<string, AnswerRow>(), identity: null };
  const answers = loaded.rows;
  const identity = loaded.identity;
  const graded = ready ? loadGrades(identity) : new Map<string, GradeRow>();

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
                `Candidate answer to grade:\n---\n${a.answer.slice(0, 20000)}\n---\n\n` +
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
              `\n\nCandidate answer to grade:\n---\n${a.answer.slice(0, 20000)}\n---\n\n` +
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
        // Grade rows inherit the answer row's run identity — loadGrades
        // filters on it, so an unstamped row is invisible to the report.
        row = { ...row, model: a.model, fixtureSha: a.fixtureSha, questionsSha: a.questionsSha };
        appendFileSync(GRADES, JSON.stringify(row) + "\n");
        if (row.by === "error") console.warn(`[e2] grade ${key} ERROR: ${row.notes}`);
        else console.log(`[e2] grade ${key}: ${row.score}/${row.maxScore} (${row.by})`);
        expect(row.qid).toBe(q.id);
      });
    }
  }

  it("emits the report when every pair is graded", () => {
    const gradeMap = loadGrades(identity);
    // EVERY current (question, mode) pair must be present — a row-count gate
    // let stale rows pad past the threshold while current pairs were missing
    // (review finding: renamed questions double-counted, removed ones voted).
    const missing = questions
      .flatMap((q) => (["full", "catalog"] as const).map((m) => rowKey({ qid: q.id, mode: m })))
      .filter((k) => !gradeMap.has(k));
    if (missing.length > 0) {
      console.warn(`[e2] report deferred — ungraded pairs: ${missing.join(", ")}`);
      expect(missing, "rerun the grade phase until all pairs are graded").toEqual([]);
      return;
    }
    const report = buildReport([...gradeMap.values()]);
    const ans = [...answers.values()];
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const ROSTER = ["list_books", "get_book", "get_chapter_text"] as const;
    const agg = (mode: E2Mode) => {
      const rowsM = ans.filter((r) => r.mode === mode);
      // Informational E3-wide readout: quote spans claimed ANYWHERE (all
      // question types), verified against the fixtures — the gating rate in
      // the report covers quote questions; this covers the rest.
      let spans = 0, verified = 0;
      for (const r of rowsM) for (const c of verifyQuotes(r.answer, books)) { spans++; if (c.verified) verified++; }
      return {
        n: rowsM.length,
        meanFirstSendChars: Math.round(mean(rowsM.map((r) => r.sentChars[0] || 0))),
        meanTotalSentChars: Math.round(mean(rowsM.map((r) => r.sentChars.reduce((a, b) => a + b, 0)))),
        meanToolCalls: +mean(rowsM.map((r) => r.toolTrace.length)).toFixed(2),
        meanMs: Math.round(mean(rowsM.map((r) => r.ms))),
        cutShort: rowsM.filter((r) => r.finish === "cut_short").length,
        maxIterations: rowsM.filter((r) => r.finish === "max_iterations").length,
        // The salvage-pass deviation, made measurable: answers whose prose
        // looks like an unexecuted roster call (production would salvage).
        proseCallSuspects: rowsM.filter((r) => proseCallSuspect(r.answer, ROSTER)).length,
        allSpanVerifyRate: spans ? +(verified / spans).toFixed(4) : null,
        allSpansChecked: spans,
      };
    };
    const metaPath = resolve(DATA, "meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
    const out = {
      report,
      run: { identity, judge: JUDGE, meta, note: "routing questions are informational — they gate nothing in the verdict (§8)" },
      cost: { full: agg("full"), catalog: agg("catalog") },
      at: new Date().toISOString(),
    };
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
