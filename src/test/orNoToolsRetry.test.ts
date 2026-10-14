import { afterEach, describe, expect, it, vi } from "vitest";
import { openrouterAdapter } from "@/lib/providers/openrouterAdapter";
import { cachedOrToolSupport } from "@/lib/openrouterCatalog";

// perplexity/sonar-pro as the Deep Research model (2026-10-13): OpenRouter
// answered 404 "No endpoints found that support tool use" and the turn failed.
describe("OpenRouter model with no tool-calling endpoint", () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it("answers without tools and remembers the model can't take them", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools) return new Response(JSON.stringify({ error: { message: 'No endpoints found that support tool use. Try disabling "list_books".' } }), { status: 404 });
      return new Response('data: {"choices":[{"delta":{"content":"From Greek typos."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }));
    const tools = [{ type: "function", function: { name: "list_books", parameters: { type: "object", properties: {} } } }];
    const events: any[] = [];
    for await (const e of openrouterAdapter.streamChat({ apiKey: "k", model: "perplexity/sonar-pro", messages: [{ role: "user", content: "hi" }], tools } as any)) events.push(e);
    expect(bodies.map((b) => !!b.tools)).toEqual([true, false]);
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toContain("typos");
    expect(cachedOrToolSupport("perplexity/sonar-pro")).toBe(false);
  });

  it("still reports other 404s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "No such model" } }), { status: 404 })));
    const run = async () => { for await (const _ of openrouterAdapter.streamChat({ apiKey: "k", model: "x/y", messages: [], tools: [{}] } as any)) { /* drain */ } };
    await expect(run()).rejects.toThrow(/404/);
  });
});
