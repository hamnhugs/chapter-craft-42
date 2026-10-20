import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MEMORY A/B — does the pointer design (notes index + one-line summaries,
 * open on demand) answer as well as the old design (retrieved note text
 * pasted into every turn), and what does each cost? Runs on the LOCAL stack:
 * your real notes, the real knowledge-retrieve function, your local Ollama
 * chat model. Never part of the normal suite:
 *
 *   npm run eval:memory
 *
 * 1. Questions: for a sample of notes, the local model writes one question
 *    whose answer is a detail in the note's TEXT but not in its one-line
 *    summary — the hard case for pointers, where answering well means
 *    opening the note. Cached in e2-data/memory-questions.json.
 * 2. Each question runs in both modes with the app's real prompt builder and
 *    one tool, search_wiki (search, or open a note by id/ref).
 * 3. The same model grades each answer against the reference detail.
 * Results: e2-data/memory-ab.json (rows + summary).
 *
 * Harness deviations from the live app, mode-neutral: one tool instead of the
 * full roster, single-turn conversations, no books loaded, no highlights.
 */

const { supabase } = await import("@/integrations/supabase/client");
const { buildChatSystemPrompt } = await import("@/lib/buildChatSystemPrompt");
const { CHAT_TOOL_DEFINITIONS } = await import("@/lib/chatTools");
const { resolveNoteRef } = await import("@/lib/notesIndex");
const { rankedKeywordSearch } = await import("@/lib/knowledgeApi");

const ROOT = process.cwd();
const DATA = resolve(ROOT, "e2-data");
const QUESTIONS = resolve(DATA, "memory-questions.json");
const RESULTS = resolve(DATA, "memory-ab.json");
const OLLAMA = "http://127.0.0.1:11434/v1/chat/completions";
const MODEL = process.env.LOCAL_LLM_MODEL || "hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K";
const SAMPLE = Number(process.env.MEMORY_AB_SAMPLE || 16);
const MAX_ROUNDS = 4;

type Msg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
type Question = { entryId: string; wikiId: string; title: string; question: string; answer: string };

async function chat(messages: Msg[], extra: Record<string, unknown> = {}) {
  const t0 = Date.now();
  const r = await fetch(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, ...extra }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { msg: j.choices[0].message as Msg, usage: j.usage as { prompt_tokens: number; completion_tokens: number }, ms: Date.now() - t0 };
}

async function chatJson<T>(system: string, user: string): Promise<T | null> {
  const { msg } = await chat([{ role: "system", content: system }, { role: "user", content: user }], { response_format: { type: "json_object" } });
  try { return JSON.parse(String(msg.content || "")) as T; } catch { return null; }
}

/** The one tool: search notes, or open one by id / [ref]. */
async function runSearchWiki(args: any): Promise<unknown> {
  const id = resolveNoteRef(args?.entry_id);
  if (typeof id === "string" && id) {
    const { data } = await supabase.from("knowledge_entries").select("id, title, content").eq("id", id).maybeSingle();
    return data ? { entry: { id: data.id, title: data.title, content: String(data.content).slice(0, 4000) } } : { error: "No note with that id" };
  }
  const hits = await rankedKeywordSearch(String(args?.query || ""), Number(args?.limit) || 5, null);
  return { results: (hits?.data || []).slice(0, 5).map((h: any) => ({ entry_id: h.id, title: h.title, snippet: String(h.content || "").slice(0, 300) })) };
}

const SEARCH_TOOL = CHAT_TOOL_DEFINITIONS.find((t: any) => t.function?.name === "search_wiki");

async function answer(q: Question, mode: "full" | "pointers", wikiName: string) {
  const built = await buildChatSystemPrompt({
    books: [], selectedBook: undefined, deepResearch: false, reflex: false,
    latestUserQuery: q.question,
    activeNeurons: [{ id: q.wikiId, name: wikiName }],
    offeredTools: ["search_wiki"],
    memoryContext: mode,
  });
  const messages: Msg[] = [
    { role: "system", content: built.stablePrompt },
    { role: "user", content: built.turnContext ? `${q.question}\n\n${built.turnContext}` : q.question },
  ];
  const promptChars = built.stablePrompt.length + built.turnContext.length;
  let firstPromptTokens = 0, totalPromptTokens = 0, ms = 0, toolCalls = 0, opened = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { msg, usage, ms: dt } = await chat(messages, { tools: [SEARCH_TOOL] });
    ms += dt;
    totalPromptTokens += usage?.prompt_tokens ?? 0;
    if (round === 0) firstPromptTokens = usage?.prompt_tokens ?? 0;
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { text: String(msg.content || ""), promptChars, firstPromptTokens, totalPromptTokens, ms, toolCalls, opened, rounds: round + 1 };
    }
    for (const tc of msg.tool_calls) {
      toolCalls++;
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* bad args */ }
      if (args?.entry_id) opened++;
      const result = tc.function.name === "search_wiki" ? await runSearchWiki(args) : { error: "unknown tool" };
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { text: "(no answer within the round limit)", promptChars, firstPromptTokens, totalPromptTokens, ms, toolCalls, opened, rounds: MAX_ROUNDS };
}

describe("memory A/B (local stack)", () => {
  it("pointers vs full", async () => {
    mkdirSync(DATA, { recursive: true });
    const email = (/^VITE_LOCAL_AUTO_EMAIL="?([^"\n]+)/m.exec(readFileSync(resolve(ROOT, ".env.local"), "utf8")) || [])[1];
    const password = readFileSync(resolve(ROOT, ".local-state/owner-password"), "utf8").trim();
    const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    expect(authErr).toBeNull();

    const { data: wikis } = await supabase.from("wikis").select("id, name");
    const wikiName = new Map((wikis || []).map((w: any) => [w.id, w.name]));

    // ── 1. Questions (cached) ──
    let questions: Question[] = existsSync(QUESTIONS) ? JSON.parse(readFileSync(QUESTIONS, "utf8")) : [];
    if (questions.length === 0) {
      const { data: notes } = await supabase
        .from("knowledge_entries")
        .select("id, wiki_id, title, hook, content, entry_type")
        .is("superseded_by", null)
        .not("entry_type", "in", "(tool,program)")
        .not("hook", "is", null);
      const pool = (notes || []).filter((n: any) => n.wiki_id && String(n.content).length > 400).sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
      const step = Math.max(1, Math.floor(pool.length / SAMPLE));
      for (let i = 0; i < pool.length && questions.length < SAMPLE; i += step) {
        const n: any = pool[i];
        const qa = await chatJson<{ question: string; answer: string }>(
          "You write one quiz question for a reader about a note they saved. The answer must be a SPECIFIC detail (a number, name, rule or step) stated in the NOTE TEXT but NOT in the SUMMARY. Phrase the question the way the reader would ask their assistant about their own notes; do not quote the answer. Reply as JSON {\"question\": \"...\", \"answer\": \"...\"} with a short answer.",
          `TITLE: ${n.title}\nSUMMARY: ${n.hook}\nNOTE TEXT:\n${String(n.content).slice(0, 3000)}`,
        );
        if (qa?.question && qa?.answer) questions.push({ entryId: n.id, wikiId: n.wiki_id, title: n.title, question: qa.question, answer: qa.answer });
      }
      writeFileSync(QUESTIONS, JSON.stringify(questions, null, 2));
    }
    expect(questions.length).toBeGreaterThan(0);

    // ── 2–3. Answer + grade ──
    const rows: any[] = [];
    for (const q of questions) {
      for (const mode of ["full", "pointers"] as const) {
        const a = await answer(q, mode, wikiName.get(q.wikiId) || "Notebook");
        const verdict = await chatJson<{ correct: boolean }>(
          "You grade an assistant's answer against a reference fact. correct = true only if the ANSWER states the reference fact (paraphrase is fine; extra detail is fine; a wrong or missing fact is false). Reply as JSON {\"correct\": true|false}.",
          `QUESTION: ${q.question}\nREFERENCE: ${q.answer}\nANSWER: ${a.text.slice(0, 2000)}`,
        );
        const row = { entryId: q.entryId, question: q.question, mode, correct: verdict?.correct === true, ...a };
        rows.push(row);
        console.log(`${mode.padEnd(8)} ${row.correct ? "✓" : "✗"} ${String(a.firstPromptTokens).padStart(6)} tok ${String(Math.round(a.ms / 100) / 10).padStart(5)}s opened=${a.opened}  ${q.question.slice(0, 70)}`);
      }
    }

    const summarize = (mode: string) => {
      const r = rows.filter((x) => x.mode === mode);
      const avg = (k: string) => Math.round(r.reduce((s, x) => s + x[k], 0) / r.length);
      return {
        questions: r.length,
        correct: r.filter((x) => x.correct).length,
        avg_prompt_chars: avg("promptChars"),
        avg_first_prompt_tokens: avg("firstPromptTokens"),
        avg_total_prompt_tokens: avg("totalPromptTokens"),
        avg_seconds: Math.round(r.reduce((s, x) => s + x.ms, 0) / r.length / 100) / 10,
        opened_a_note: r.filter((x) => x.opened > 0).length,
        avg_rounds: Math.round((r.reduce((s, x) => s + x.rounds, 0) / r.length) * 10) / 10,
      };
    };
    const summary = { model: MODEL, ran_at: new Date().toISOString(), full: summarize("full"), pointers: summarize("pointers") };
    writeFileSync(RESULTS, JSON.stringify({ summary, rows }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  });
});
