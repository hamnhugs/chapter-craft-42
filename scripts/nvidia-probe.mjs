// Live probe suite for NVIDIA's hosted API — run BEFORE trusting the adapter
// with anything, and again whenever a model misbehaves.
//
//   NVAPI_KEY=nvapi-xxxx node scripts/nvidia-probe.mjs [outDir]
//
// Node has no CORS constraints, so this hits integrate.api.nvidia.com
// directly with your key and captures raw SSE transcripts for the cases the
// research could not settle without live credentials:
//   1. streamed tool calls on deepseek-v4-flash  (delta shape: incremental vs whole? index present?)
//   2. streamed tool calls on nemotron-3-nano    (same, second backend)
//   3. reasoning stream on nemotron-3-nano       (reasoning_content on the wire?)
//   4. DiffusionGemma plain stream               (does stream:true work at all? burst sizes?)
//   5. DiffusionGemma with tools                 (hosted function calling real?)
//   6. image + tools on nemotron-nano-12b-v2-vl  (does the combination 400?)
//   7. no max_tokens long reply                  (silent truncation default?)
//   8. tools sent to a non-tool model            (error shape)
// Each case writes <outDir>/probe-N-<name>.txt with status, headers, and the
// raw body/SSE lines. ~8 requests total ≈ 8 credits.

const KEY = process.env.NVAPI_KEY;
if (!KEY) {
  console.error("Set NVAPI_KEY=nvapi-... (build.nvidia.com → Settings → API Keys)");
  process.exit(1);
}
const OUT = process.argv[2] || "nvidia-probe-results";
const BASE = "https://integrate.api.nvidia.com/v1/chat/completions";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
mkdirSync(OUT, { recursive: true });

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}];

// 1x1 red PNG — enough to trigger the image code path.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CASES = [
  { name: "tools-deepseek-flash", body: { model: "deepseek-ai/deepseek-v4-flash", stream: true, max_tokens: 300, tools: TOOLS, tool_choice: "auto", chat_template_kwargs: { thinking: false }, messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }] } },
  { name: "tools-nemotron-nano", body: { model: "nvidia/nemotron-3-nano-30b-a3b", stream: true, max_tokens: 300, tools: TOOLS, tool_choice: "auto", chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }] } },
  { name: "reasoning-nemotron", body: { model: "nvidia/nemotron-3-nano-30b-a3b", stream: true, max_tokens: 400, chat_template_kwargs: { enable_thinking: true }, messages: [{ role: "user", content: "Which is larger, 9.11 or 9.9? Think it through." }] } },
  { name: "diffusiongemma-stream", body: { model: "google/diffusiongemma-26b-a4b-it", stream: true, max_tokens: 400, messages: [{ role: "user", content: "Write two short paragraphs about lighthouses." }] } },
  { name: "diffusiongemma-tools", body: { model: "google/diffusiongemma-26b-a4b-it", stream: true, max_tokens: 300, tools: TOOLS, tool_choice: "auto", messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }] } },
  { name: "vl-image-plus-tools", body: { model: "nvidia/nemotron-nano-12b-v2-vl", stream: true, max_tokens: 200, tools: TOOLS, tool_choice: "auto", messages: [{ role: "user", content: [{ type: "text", text: "What color is this?" }, { type: "image_url", image_url: { url: TINY_PNG } }] } ] } },
  { name: "no-max-tokens", body: { model: "meta/llama-3.3-70b-instruct", stream: true, messages: [{ role: "user", content: "Count from 1 to 80, one number per line." }] } },
  { name: "tools-on-non-tool-model", body: { model: "writer/palmyra-creative-122b", stream: true, max_tokens: 100, tools: TOOLS, tool_choice: "auto", messages: [{ role: "user", content: "Hello!" }] } },
];

for (let i = 0; i < CASES.length; i++) {
  const { name, body } = CASES[i];
  const file = join(OUT, `probe-${i + 1}-${name}.txt`);
  const lines = [`# ${name}`, `# ${new Date().toISOString()}`, `# request: ${JSON.stringify(body)}`, ""];
  try {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    lines.push(`STATUS ${res.status}`);
    res.headers.forEach((v, k) => lines.push(`HDR ${k}: ${v}`));
    lines.push("");
    if (res.body && (res.headers.get("content-type") || "").includes("event-stream")) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let chunkNo = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkNo++;
        const text = dec.decode(value, { stream: true });
        lines.push(`--- chunk ${chunkNo} (${value.byteLength}B) ---`);
        lines.push(text);
      }
    } else {
      lines.push(await res.text());
    }
    console.log(`✔ ${name} → ${file}`);
  } catch (e) {
    lines.push(`ERROR ${e?.message || e}`);
    console.log(`✘ ${name}: ${e?.message || e}`);
  }
  writeFileSync(file, lines.join("\n"));
  // stay far under the 40 RPM account cap
  await new Promise((r) => setTimeout(r, 2500));
}
console.log(`\nDone. Transcripts in ${OUT}/ — the interesting bits: delta.tool_calls shape (index field? whole call in one chunk?), delta.reasoning_content, chunk sizes on diffusiongemma, and the finish_reason values.`);
