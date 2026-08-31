import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * E2 ANSWER PHASE — runs each fixed question through BOTH book-context modes
 * on the live provider, with the app's real builders, adapter, and tool
 * executor. Run explicitly (never part of the normal suite):
 *
 *   npx vitest run --config vitest.e2.config.ts src/harness/e2/answer.e2run.ts
 *
 * Requires .env.e2.local (OPENROUTER_API_KEY, E2_MODEL) and e2-data/
 * (fixtures + questions). Checkpoints to e2-data/answers.jsonl — rerunning
 * skips completed (question, mode) pairs, so provider deaths cost nothing.
 *
 * Harness deviations from the live app, all mode-neutral (documented in the
 * E2 report): 3-tool roster (list_books/get_book/get_chapter_text) instead
 * of the full 73; knowledge/focus/memory surfaces empty; single-turn
 * conversations; no text-call salvage pass; the fixture library IS the whole
 * library.
 */

// ── Hermetic mocks (the stage0PromptStability pattern) ─────────────────────
vi.mock("@/lib/knowledgeApi", () => ({
  fetchKnowledgeEntries: async () => [],
  fetchConversationMemory: async () => null,
  retrieveKnowledge: async () => ({ nodes: [], edges: [] }),
  filterSupersededNodes: async (nodes: unknown[]) => nodes,
}));
vi.mock("@/lib/imageGen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/imageGen")>()),
  fetchImagesForEntries: async () => [],
}));
vi.mock("@/lib/memoryLens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memoryLens")>()),
  getRecallStates: async () => new Map(),
}));
vi.mock("@/lib/toolFoundry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toolFoundry")>()),
  listTools: async () => [],
}));

const { buildChatSystemPrompt } = await import("@/lib/buildChatSystemPrompt");
const { buildBookContextBlock, bookContextCharBudget, bookContextStore, selectContextBooks } = await import("@/lib/chatBooks");
const { CHAT_TOOL_DEFINITIONS, executeChatTool } = await import("@/lib/chatTools");
const { openrouterAdapter } = await import("@/lib/providers/openrouterAdapter");
const { runToolLoop, completedKeys, rowKey, validateQuestions } = await import("@/harness/e2/harnessCore");
import type { AnswerRow, E2Mode, E2Question } from "@/harness/e2/harnessCore";
import type { BookDocument } from "@/types/library";

// ── Environment & data ─────────────────────────────────────────────────────
const ROOT = process.cwd();
const DATA = resolve(ROOT, "e2-data");
const ANSWERS = resolve(DATA, "answers.jsonl");

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
const MODEL = process.env.E2_MODEL || env.E2_MODEL || "google/gemini-3.7-flash";

const fixturesPath = resolve(DATA, "fixtures", "books.json");
const questionsPath = resolve(DATA, "questions.json");
const ready = existsSync(fixturesPath) && existsSync(questionsPath) && !!API_KEY;

const books: BookDocument[] = ready ? JSON.parse(readFileSync(fixturesPath, "utf8")) : [];
const questions: E2Question[] = ready ? JSON.parse(readFileSync(questionsPath, "utf8")) : [];
const fixtureSha = ready ? createHash("sha256").update(readFileSync(fixturesPath)).digest("hex").slice(0, 16) : "";
const questionsSha = ready ? createHash("sha256").update(readFileSync(questionsPath)).digest("hex").slice(0, 16) : "";

const done = existsSync(ANSWERS)
  ? completedKeys(readFileSync(ANSWERS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AnswerRow))
  : new Set<string>();

// The harness roster: the reading pathway under test, identical in both arms.
const ROSTER = ["list_books", "get_book", "get_chapter_text"] as const;
const toolDefs = [...(CHAT_TOOL_DEFINITIONS as readonly any[])].filter((t) => (ROSTER as readonly string[]).includes(t.function.name));

const textById = new Map(books.flatMap((b) => b.chapters.map((c) => [c.id, c.textContent] as const)));
const toolDeps = {
  books,
  activeBookId: null as string | null,
  setActiveBookId: () => {},
  addChapter: async () => { throw new Error("write tool reached the E2 harness"); },
  updateChapter: () => { throw new Error("write tool reached the E2 harness"); },
  removeChapter: () => { throw new Error("write tool reached the E2 harness"); },
  loadChapterText: async (id: string) => textById.get(id) || "",
  userId: "e2-harness",
  leanMode: "full" as const,
  permissionsSnapshot: {} as Record<string, boolean>,
};

const blocks: Record<E2Mode, string> = { full: "", catalog: "" };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!ready)("E2 answer phase", () => {
  beforeAll(() => {
    mkdirSync(DATA, { recursive: true });
    // A run against an invalid set would burn provider spend answering
    // questions whose keys can't grade — refuse up front.
    expect(validateQuestions(questions, books)).toEqual([]);
    // The same persisted selection shape the app reads at send time —
    // get_chapter_text's recovery scope reads this module store directly.
    bookContextStore.set({ shelfId: null, bookIds: books.map((b) => b.id), excludedIds: [] });
    const ordered = selectContextBooks(books, bookContextStore.get(), null);
    expect(ordered.map((b) => b.id)).toEqual(books.map((b) => b.id).sort());
    for (const mode of ["full", "catalog"] as const) {
      const built = buildBookContextBlock(ordered, {
        offeredTools: [...ROSTER],
        totalCharBudget: bookContextCharBudget(MODEL),
        mode,
      });
      expect(built?.message, `book block (${mode})`).toBeTruthy();
      blocks[mode] = built!.message!;
      const states = built!.used.map((u) => `${u.title.slice(0, 24)}:${u.state}(${u.chaptersSent}/${u.chaptersTotal})`);
      console.log(`[e2] block ${mode}: ${blocks[mode].length} chars — ${states.join(" · ")}`);
    }
  });

  for (const q of questions) {
    for (const mode of ["full", "catalog"] as const) {
      const key = rowKey({ qid: q.id, mode });
      it.skipIf(done.has(key))(`${q.id} [${q.type}] · ${mode}`, async () => {
        const { prompt } = await buildChatSystemPrompt({
          books,
          selectedBook: undefined,
          deepResearch: false,
          voiceMode: false,
          latestUserQuery: q.question,
          activeNeurons: [],
          allNeurons: false,
          reflex: false,
          maxReplySentences: 0,
          leanMode: "full",
          foundryTools: false,
          programTools: false,
          offeredTools: [...ROSTER],
        });
        const messages = [
          { role: "system", content: blocks[mode] },
          { role: "system", content: prompt },
          { role: "user", content: q.question },
        ];
        const started = Date.now();
        let row: AnswerRow;
        let attempt = 0;
        for (;;) {
          try {
            const res = await runToolLoop({
              adapter: openrouterAdapter,
              model: MODEL,
              apiKey: API_KEY,
              messages,
              tools: toolDefs,
              cacheStablePrefixCount: 1,
              executeTool: (name, rawArgs) => executeChatTool(name, rawArgs, toolDeps as any),
            });
            row = {
              qid: q.id, mode, model: MODEL, answer: res.text, toolTrace: res.toolTrace,
              iterations: res.iterations, sentChars: res.sentChars, finish: res.finish,
              ms: Date.now() - started, fixtureSha, questionsSha, at: new Date().toISOString(),
            };
            break;
          } catch (e: any) {
            const code = e?.code as string | undefined;
            if (attempt < 2 && (code === "rate_limit" || code === "network" || code === "server" || code === "upstream")) {
              attempt++;
              console.warn(`[e2] ${key}: ${code} — retry ${attempt} in ${attempt * 15}s`);
              await sleep(attempt * 15_000);
              continue;
            }
            row = {
              qid: q.id, mode, model: MODEL, answer: "", toolTrace: [], iterations: 0, sentChars: [],
              finish: "error", ms: Date.now() - started, fixtureSha, questionsSha, at: new Date().toISOString(),
              error: `${code || "error"}: ${e?.message || e}`,
            };
            break;
          }
        }
        appendFileSync(ANSWERS, JSON.stringify(row) + "\n");
        if (row.error) console.warn(`[e2] ${key} recorded ERROR row: ${row.error}`);
        else console.log(`[e2] ${key}: ${row.answer.length} chars, ${row.toolTrace.length} tool calls, ${row.ms}ms`);
        expect(row.qid).toBe(q.id);
      });
    }
  }

  it("all question×mode pairs have a successful answer row", () => {
    const rows = existsSync(ANSWERS)
      ? readFileSync(ANSWERS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AnswerRow)
      : [];
    const have = completedKeys(rows);
    const missing = questions.flatMap((q) => (["full", "catalog"] as const).map((m) => rowKey({ qid: q.id, mode: m }))).filter((k) => !have.has(k));
    expect(missing, `rerun the answer phase to retry: ${missing.join(", ")}`).toEqual([]);
  });
});

describe.skipIf(ready)("E2 answer phase (not configured)", () => {
  it("explains what is missing", () => {
    console.warn(
      `[e2] skipped — missing: ${[
        !existsSync(fixturesPath) && "e2-data/fixtures/books.json",
        !existsSync(questionsPath) && "e2-data/questions.json",
        !API_KEY && ".env.e2.local OPENROUTER_API_KEY",
      ].filter(Boolean).join(", ")}`,
    );
    expect(true).toBe(true);
  });
});
