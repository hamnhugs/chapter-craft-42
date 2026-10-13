// Live tool-selection eval through the REAL local pipeline: planLocalRoster
// (live embeddings, LOCAL_EMBED_MODEL), buildChatSystemPrompt, slimToolDef and the Ollama
// adapter. Skipped unless LIVE_OLLAMA=1. Writes its log to
// docs/local-ai/results/ when LIVE_EVAL_OUT is set.
import { describe, it, expect, vi } from "vitest";
import { appendFileSync } from "node:fs";

vi.mock("@/lib/knowledgeApi", () => ({
  fetchKnowledgeEntries: async () => [],
  fetchConversationMemory: async () => null,
  retrieveKnowledge: async () => ({ nodes: [], edges: [] }),
  filterSupersededNodes: async (nodes: unknown[]) => nodes,
  fetchCardPointers: async () => new Map(),
}));
vi.mock("@/lib/imageGen", async (o) => ({ ...(await o<typeof import("@/lib/imageGen")>()), fetchImagesForEntries: async () => [] }));
vi.mock("@/lib/memoryLens", async (o) => ({ ...(await o<typeof import("@/lib/memoryLens")>()), getRecallStates: async () => new Map() }));
vi.mock("@/lib/toolFoundry", async (o) => ({ ...(await o<typeof import("@/lib/toolFoundry")>()), listTools: async () => [] }));

const { FIND_TOOLS_DEFINITION, planLocalRoster, resetRoster, slimToolDef } = await import("@/lib/localRoster");
const { CHAT_TOOL_DEFINITIONS } = await import("@/lib/chatTools");
const { buildChatSystemPrompt } = await import("@/lib/buildChatSystemPrompt");
const { ollamaAdapter } = await import("@/lib/providers/ollamaAdapter");

const live = process.env.LIVE_OLLAMA === "1";
const model = process.env.LIVE_OLLAMA_MODEL || "qwen3.5:4b";
const ALL: any[] = CHAT_TOOL_DEFINITIONS as unknown as any[];

// [request, acceptable first tools] — a lookup that a careful agent makes
// before acting (list_wikis to find an id) counts as correct.
const CASES: Array<[string, string[]]> = [
  ["What books do I have?", ["list_books"]],
  ["Find the line 'the river remembers' in my books", ["search_book_text"]],
  ["Rename chapter 3 of Dune to 'Arrakis'", ["rename_chapter", "get_book", "list_books"]],
  ["Remember that my protagonist Mara is left-handed", ["create_memory_entry"]],
  ["Search the web for the latest news on the Booker Prize", ["web_search"]],
  ["Make me an image of a lighthouse in a storm, watercolor", ["generate_image"]],
  ["Show me my generated videos", ["list_videos"]],
  ["Switch to my Worldbuilding wiki", ["switch_wiki", "list_wikis"]],
  ["Put Dune and Foundation on a new shelf called Sci-Fi", ["manage_shelf", "list_books"]],
  ["Read me the text of chapter 2 of The Hobbit", ["get_chapter_text", "get_book", "list_books"]],
  ["What contradictions are in my wiki?", ["list_conflicts"]],
  ["Save this outline as a file in my workspace: 1. Intro 2. Body", ["save_file"]],
  ["Write a tiny tool that counts words in a string", ["forge_tool", "find_tools"]],
  ["Open Foundation in the reader", ["set_active_book", "list_books"]],
];

describe.skipIf(!live)("local tool eval (real pipeline)", () => {
  it("picks a correct first tool on most requests", async () => {
    let ok = 0;
    const lines: string[] = [`# ${new Date().toISOString()} model=${model} pipeline=planLocalRoster+buildChatSystemPrompt+slimToolDef+ollamaAdapter`];
    for (const [q, want] of CASES) {
      resetRoster("eval");
      const plan = await planLocalRoster({ userId: "eval", query: q, pool: ALL });
      const defs = [...plan.names.map((n) => slimToolDef(ALL.find((d) => d.function.name === n))), FIND_TOOLS_DEFINITION];
      const { stablePrompt } = await buildChatSystemPrompt({ books: [], selectedBook: undefined, deepResearch: false, offeredTools: plan.names, latestUserQuery: q });
      const t0 = Date.now();
      let first = ""; let text = ""; let inTok: number | undefined;
      for await (const e of ollamaAdapter.streamChat({ model, messages: [{ role: "system", content: stablePrompt }, { role: "user", content: q }], tools: defs })) {
        if (e.type === "tool_call_delta" && !first) first = e.name || "";
        if (e.type === "text") text += e.delta;
        if (e.type === "usage") inTok = e.usage.inputTokens;
      }
      const hit = want.includes(first);
      ok += hit ? 1 : 0;
      lines.push(`${hit ? "OK " : "BAD"} ${((Date.now() - t0) / 1000).toFixed(1)}s in=${inTok} roster=${plan.names.length} first=${first || "TEXT:" + text.slice(0, 50).replace(/\n/g, " ")} | ${q}`);
      console.log(lines.at(-1));
    }
    lines.push(`${model}: ${ok}/${CASES.length}`);
    console.log(lines.at(-1));
    if (process.env.LIVE_EVAL_OUT) appendFileSync(process.env.LIVE_EVAL_OUT, lines.join("\n") + "\n\n");
    expect(ok).toBeGreaterThanOrEqual(11);
  }, 1_800_000);
});
