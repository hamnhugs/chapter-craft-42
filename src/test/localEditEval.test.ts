// Live eval: after an image is made, does a follow-up edit reach edit_image?
// Real pipeline (planLocalRoster with live embeddings, buildChatSystemPrompt,
// slimToolDef, ollamaAdapter) over a synthetic generate -> edit conversation.
// Skipped unless LIVE_OLLAMA=1; TRIALS and LIVE_OLLAMA_MODEL adjust it.
// Results: docs/local-ai/results/2026-10-13-qwen-image.txt.
import { describe, it, vi } from "vitest";
vi.mock("@/lib/knowledgeApi", () => ({ fetchKnowledgeEntries: async () => [], fetchConversationMemory: async () => null, retrieveKnowledge: async () => ({ nodes: [], edges: [] }), filterSupersededNodes: async (n: unknown[]) => n, fetchCardPointers: async () => new Map() }));
vi.mock("@/lib/imageGen", async (o) => ({ ...(await o<typeof import("@/lib/imageGen")>()), fetchImagesForEntries: async () => [] }));
vi.mock("@/lib/memoryLens", async (o) => ({ ...(await o<typeof import("@/lib/memoryLens")>()), getRecallStates: async () => new Map() }));
vi.mock("@/lib/toolFoundry", async (o) => ({ ...(await o<typeof import("@/lib/toolFoundry")>()), listTools: async () => [] }));
const { FIND_TOOLS_DEFINITION, planLocalRoster, resetRoster, slimToolDef } = await import("@/lib/localRoster");
const { CHAT_TOOL_DEFINITIONS } = await import("@/lib/chatTools");
const { buildChatSystemPrompt } = await import("@/lib/buildChatSystemPrompt");
const { ollamaAdapter } = await import("@/lib/providers/ollamaAdapter");
const ALL: any[] = CHAT_TOOL_DEFINITIONS as unknown as any[];
const model = process.env.LIVE_OLLAMA_MODEL || "hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K";
const Q1 = "Generate an image: a cozy reading nook by a rainy window, a cat asleep on a stack of books, watercolor.";
const EDITS = ["Edit that image: make the cat orange and put a steaming mug of tea on the windowsill.", "Now make the cat orange.", "Can you add a steaming mug of tea on the windowsill in that picture?"];
describe.skipIf(process.env.LIVE_OLLAMA !== "1")("local edit follow-up eval", () => it("a follow-up edit calls edit_image", async () => {
  for (const q2 of EDITS) for (let trial = 0; trial < (Number(process.env.TRIALS) || 4); trial++) {
    resetRoster("p");
    await planLocalRoster({ userId: "p", query: Q1, pool: ALL });
    const plan = await planLocalRoster({ userId: "p", query: q2, pool: ALL });
    const defs = [...plan.names.map((n) => slimToolDef(ALL.find((d) => d.function.name === n))), FIND_TOOLS_DEFINITION];
    const { stablePrompt } = await buildChatSystemPrompt({ books: [], selectedBook: undefined, deepResearch: false, offeredTools: plan.names, latestUserQuery: q2 });
    const messages: any[] = [
      { role: "system", content: stablePrompt },
      { role: "user", content: Q1 },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "A cozy reading nook by a rainy window, a cat asleep on a stack of books, watercolor" }) } }] },
      { role: "tool", tool_call_id: "c1", name: "generate_image", content: JSON.stringify({ ok: true, images: [{ image_id: "22cff38f-2605-4e30-aec0-c8a9dc960499", entry_id: "e1", model: "local:qwen-image-2.1-turbo-Q4_K_M" }], note: "The image is shown to the user inline." }) },
      { role: "assistant", content: "Here's your watercolor reading nook with the cat asleep on the books. It's saved to your memory." },
      { role: "user", content: q2 },
    ];
    let first = ""; let args = ""; let text = "";
    for await (const e of ollamaAdapter.streamChat({ model, messages, tools: defs })) {
      if (e.type === "tool_call_delta") { if (!first) first = e.name || ""; args += e.argumentsDelta || ""; }
      if (e.type === "text") text += e.delta;
    }
    console.log(`${first === "edit_image" ? "OK " : "BAD"} offered_edit=${plan.names.includes("edit_image")} first=${first || "TEXT:" + text.slice(0, 70).replace(/\n/g, " ")} ${args.slice(0, 90)} | ${q2}`);
  }
}, 1_800_000));
