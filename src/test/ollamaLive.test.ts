// Live check against the Ollama on this machine. Skipped unless LIVE_OLLAMA=1
// (CI and the normal suite stay offline). Model: LIVE_OLLAMA_MODEL or qwen3.5:4b.
import { describe, it, expect } from "vitest";
import { ollamaAdapter } from "@/lib/providers/ollamaAdapter";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";

const live = process.env.LIVE_OLLAMA === "1";
const model = process.env.LIVE_OLLAMA_MODEL || "qwen3.5:4b";
const pick = (names: string[]) => (CHAT_TOOL_DEFINITIONS as any[]).filter((t) => names.includes(t.function.name));

describe.skipIf(!live)("live Ollama", () => {
  it("streams a real app tool call through the adapter", async () => {
    const events: any[] = [];
    for await (const e of ollamaAdapter.streamChat({
      model,
      messages: [
        { role: "system", content: "You are BookWorm, an assistant in a reading app. Use tools for app data." },
        { role: "user", content: "What books do I have?" },
      ],
      tools: pick(["list_books", "get_book", "search_book_text", "web_search"]),
    })) events.push(e);
    const call = events.find((e) => e.type === "tool_call_delta");
    expect(call?.name).toBe("list_books");
    expect(() => JSON.parse(call.argsDelta)).not.toThrow();
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_calls" });
  }, 180_000);

  it("completes a tool round trip into prose", async () => {
    const events: any[] = [];
    for await (const e of ollamaAdapter.streamChat({
      model,
      messages: [
        { role: "user", content: "What books do I have?" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_books", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: JSON.stringify({ books: [{ id: "b1", title: "Dune", pages: 412 }, { id: "b2", title: "Foundation", pages: 255 }] }) },
      ],
      tools: pick(["list_books"]),
    })) events.push(e);
    const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
    expect(text).toMatch(/Dune/);
    expect(text).toMatch(/Foundation/);
  }, 180_000);

  it("completeChat returns a summary", async () => {
    const out = await ollamaAdapter.completeChat({
      model,
      maxTokens: 80,
      messages: [{ role: "user", content: "Summarize in one sentence: Paul Atreides moves to the desert planet Arrakis, where his family is betrayed." }],
    });
    expect(out.length).toBeGreaterThan(10);
  }, 180_000);
});
