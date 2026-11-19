import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTranscriber } from "@/lib/pageTranscribe";

/** A Gemini-shaped streamed reply: the page's JSON in small pieces. */
function sse(json: string, pieces = 7): Response {
  const size = Math.ceil(json.length / pieces);
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += size) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: json.slice(i, i + size) } }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } }), { status: 200 });
}

const PAGE = JSON.stringify({
  kind: "page", book_title: null, author: null, problem: null,
  pages: [{ page_number: "12", chapter_title: null, body: "The keeper had a rule about weather.\n\nHe never spoke of it before breakfast.", footnotes: [], figures: [], starts_mid_sentence: false, ends_mid_sentence: false, legibility: "clear" }],
});

afterEach(() => vi.unstubAllGlobals());

describe("the page reader on the wire", () => {
  it("streams, asks the model not to think first, and reports the words as they come", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return sse(PAGE); }));
    const seen: string[] = [];
    const read = makeTranscriber({ visionModel: "gemini:gemini-2.5-flash", keys: { geminiApiKey: "k" } });
    const out = await read("data:image/jpeg;base64,AAAA", { onText: (t) => seen.push(t) });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ stream: true, reasoning_effort: "none", temperature: 0, max_tokens: 6000 });
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].printed).toBe("12");
    expect(out.pages[0].text).toBe("The keeper had a rule about weather.\n\nHe never spoke of it before breakfast.");
    // Words were reported before the reply was finished, and only ever grew.
    expect(seen.length).toBeGreaterThan(1);
    seen.forEach((t, i) => { expect(out.pages[0].text.startsWith(t)).toBe(true); if (i) expect(t.length).toBeGreaterThan(seen[i - 1].length); });
  });

  it("asks again without the setting when a model refuses it, and does not ask that model twice", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if ("reasoning_effort" in body) return new Response(JSON.stringify({ error: { code: 400, message: "Unsupported reasoning_effort", status: "INVALID_ARGUMENT" } }), { status: 400 });
      return sse(PAGE);
    }));
    const read = makeTranscriber({ visionModel: "gemini:gemini-9-odd", keys: { geminiApiKey: "k" } });
    expect((await read("data:image/jpeg;base64,AAAA", {})).pages).toHaveLength(1);
    expect(bodies.map((b) => "reasoning_effort" in b)).toEqual([true, false]);
    expect((await read("data:image/jpeg;base64,AAAA", {})).pages).toHaveLength(1);
    expect(bodies.map((b) => "reasoning_effort" in b)).toEqual([true, false, false]);
  });

  it("does not retry a busy provider or a bad key as if the setting were the problem", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return new Response(JSON.stringify({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }), { status: 429 }); }));
    const read = makeTranscriber({ visionModel: "gemini:gemini-2.5-flash", keys: { geminiApiKey: "k" } });
    await expect(read("data:image/jpeg;base64,AAAA", {})).rejects.toMatchObject({ code: "rate" });
    expect(calls).toBe(1);
  });
});
