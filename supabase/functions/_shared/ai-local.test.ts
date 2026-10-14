// deno test --allow-env --allow-net supabase/functions/_shared/ai-local.test.ts
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cloudRequest, fitDims, routeFor, toOllamaMessages, translateChat, wrapChat } from "./ai-local.ts";

Deno.test("forced tool call becomes a JSON-schema format and is wrapped back as tool_calls", async () => {
  const schema = { type: "object", properties: { same_claim: { type: "boolean" } }, required: ["same_claim"] };
  const { req, forcedTool } = await translateChat({
    model: "google/gemini-3-flash-preview",
    messages: [{ role: "user", content: "A vs B" }],
    tools: [{ type: "function", function: { name: "judge", parameters: schema } }],
    tool_choice: { type: "function", function: { name: "judge" } },
    temperature: 0.1,
    max_tokens: 200,
  });
  assertEquals(forcedTool, "judge");
  assertEquals(req.format, schema);
  assertEquals(req.tools, undefined);
  assertEquals(req.think, false);
  assertEquals(req.options.temperature, 0.1);
  assertEquals(req.options.num_predict, 200);
  assert(req.options.num_ctx >= 4096);
  const out = wrapChat({ message: { content: '{"same_claim":true}' }, done_reason: "stop" }, "judge", "x");
  const tc = out.choices[0].message.tool_calls[0];
  assertEquals(tc.function.name, "judge");
  assertEquals(JSON.parse(tc.function.arguments), { same_claim: true });
  assertEquals(out.choices[0].finish_reason, "tool_calls");
});

Deno.test("response_format json_schema and json_object map to format", async () => {
  const s = { type: "object", properties: { tags: { type: "array" } } };
  assertEquals((await translateChat({ messages: [], response_format: { type: "json_schema", json_schema: { name: "t", schema: s } } })).req.format, s);
  assertEquals((await translateChat({ messages: [], response_format: { type: "json_object" } })).req.format, "json");
  assertEquals((await translateChat({ messages: [] })).req.format, undefined);
});

Deno.test("images route to the vision model; text to the utility model", async () => {
  const withImg = await translateChat({ messages: [{ role: "user", content: [{ type: "text", text: "what" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }] });
  const textOnly = await translateChat({ messages: [{ role: "user", content: "hi" }] });
  assert(withImg.req.model !== textOnly.req.model);
  assertEquals(withImg.req.messages[0].images, ["QUJD"]);
});

Deno.test("tool transcript converts: object arguments, named tool replies", async () => {
  const { messages } = await toOllamaMessages([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":1}' } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ]);
  assertEquals(messages[0].tool_calls[0].function.arguments, { a: 1 });
  assertEquals(messages[1].tool_name, "f");
});

Deno.test("unforced tool calls wrap with JSON-string arguments", () => {
  const out = wrapChat({ message: { content: "", tool_calls: [{ function: { name: "g", arguments: { x: 2 } } }] }, done_reason: "stop" }, null, "m");
  assertEquals(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments), { x: 2 });
});

Deno.test("think tags are stripped from content", () => {
  const out = wrapChat({ message: { content: "<think>hmm</think>\nAnswer" } }, null, "m");
  assertEquals(out.choices[0].message.content, "Answer");
});

Deno.test("fitDims: zero-pad keeps cosine exact; truncate when longer", () => {
  const a = [0.3, -0.2, 0.9], b = [0.1, 0.4, -0.5];
  const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0) / Math.hypot(...x) / Math.hypot(...y);
  const pa = fitDims(a, 8), pb = fitDims(b, 8);
  assertEquals(pa.length, 8);
  assert(Math.abs(cos(a, b) - cos(pa, pb)) < 1e-12);
  assertEquals(fitDims([1, 2, 3, 4], 2), [1, 2]);
  assertEquals(fitDims([1, 2], undefined), [1, 2]);
});

Deno.test("Ollama only when a local chat model is selected", () => {
  assertEquals(routeFor(null), { local: true });
  assertEquals(routeFor({ selected_model: "ollama:qwen3:8b" }), { local: true });
  const r = routeFor({ selected_model: "google/gemini-4-argon", openrouter_api_key: " k " });
  assertEquals(r, { local: false, selected: "google/gemini-4-argon", utility: "", openrouterKey: "k" });
});

Deno.test("cloud selected: gateway calls go to OpenRouter on the user's key; keyed OpenRouter calls pass through", () => {
  const route = { local: false as const, selected: "google/gemini-4-argon", utility: "", openrouterKey: "k" };
  const body = { model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] };
  const gw = cloudRequest("https://ai.gateway.lovable.dev/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " } }, body, route)!;
  assertEquals(gw.url, "https://openrouter.ai/api/v1/chat/completions");
  assertEquals(new Headers(gw.init.headers).get("Authorization"), "Bearer k");
  const sent = JSON.parse(String(gw.init.body));
  assertEquals(sent.model, "google/gemini-2.5-flash-lite");
  assertEquals(sent.messages, body.messages);

  const own = { method: "POST", headers: { Authorization: "Bearer theirs" }, body: "{}" };
  assertEquals(cloudRequest("https://openrouter.ai/api/v1/chat/completions", own, body, route)!.init, own);

  const util = cloudRequest("https://ai.gateway.lovable.dev/v1/chat/completions", {}, body, { ...route, utility: "ollama:qwen3:8b" })!;
  assertEquals(JSON.parse(String(util.init.body)).model, "google/gemini-2.5-flash-lite");
  assertEquals(cloudRequest("https://ai.gateway.lovable.dev/v1/chat/completions", {}, body, { ...route, openrouterKey: "" }), null);
});
