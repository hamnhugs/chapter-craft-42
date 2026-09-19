import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { validateQuestions, type E2Question } from "@/harness/e2/harnessCore";
import type { BookDocument } from "@/types/library";

/**
 * Standalone validation of e2-data/questions.json against the fixtures —
 * the same gate answer.e2run.ts runs in its beforeAll, runnable on its own
 * so key problems surface BEFORE any provider spend:
 *
 *   npx vitest run --config vitest.e2.config.ts src/harness/e2/validate.e2run.ts
 */
const DATA = resolve(process.cwd(), "e2-data");
const fixturesPath = resolve(DATA, "fixtures", "books.json");
const questionsPath = resolve(DATA, "questions.json");
const ready = existsSync(fixturesPath) && existsSync(questionsPath);

describe.skipIf(!ready)("E2 question set validation", () => {
  it("every key is mechanically sound against the fixtures", () => {
    const books: BookDocument[] = JSON.parse(readFileSync(fixturesPath, "utf8"));
    const questions: E2Question[] = JSON.parse(readFileSync(questionsPath, "utf8"));
    const issues = validateQuestions(questions, books);
    expect(issues).toEqual([]);
    const byType = questions.reduce<Record<string, number>>((a, q) => ((a[q.type] = (a[q.type] || 0) + 1), a), {});
    console.log(`[e2] ${questions.length} questions validated:`, JSON.stringify(byType));
  });
});

describe.skipIf(ready)("E2 question set validation (not configured)", () => {
  it("needs fixtures + questions", () => expect(true).toBe(true));
});
