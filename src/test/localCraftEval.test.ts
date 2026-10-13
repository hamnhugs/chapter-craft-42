// Live model eval: the user's purple-cat PhotoCraft session (2026-10-13,
// docs/local-ai/PHOTOCRAFT-AI-FINDINGS.md) replayed through a real model, the
// craft tool's own code and the real PhotoCraft engine. Every request must be
// finished — or answered with a question — in ONE reply within the craft
// budget, nothing may land on the wrong layer, and taste requests may ask.
//
//   LIVE_CRAFT_EVAL=1 npx vitest run src/test/localCraftEval.test.ts
//
// Needs the app up (scripts/local-up.sh); runs on the headless engine, so close
// the PhotoCraft window first. LIVE_OLLAMA_MODEL picks the model, CRAFT_EVAL_RUNS
// the repeats (default 3).
import { beforeAll, describe, expect, it } from "vitest";
import { CRAFT_TOOL_DEFINITION, runCraftTool } from "@/lib/craftApps";
import { slimToolDef } from "@/lib/localRoster";

const APP = process.env.CC_APP_URL || "http://127.0.0.1:8080";
const OLLAMA = process.env.LIVE_OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.LIVE_OLLAMA_MODEL || "hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K";
const RUNS = Number(process.env.CRAFT_EVAL_RUNS || 3);
const ROUNDS = 8; // ChatContext CRAFT_TOOL_ITERATIONS
const TOOL = slimToolDef(CRAFT_TOOL_DEFINITION as any);
const SYSTEM =
  "You are Counsel, the user's creative assistant in Chapter Craft. You can act in their apps with the craft tool. Reply briefly. PhotoCraft has a document open.";

type Layer = { id: number; name: string; kind: string; box?: { x: number; y: number; w: number; h: number }; text?: string };

async function bridge(path: string, body: unknown) {
  const r = await fetch(`${APP}/local/crafts${path}`, {
    method: "POST", headers: { "X-Chapter-Craft": "1", "Content-Type": "application/json", Origin: APP }, body: JSON.stringify(body),
  });
  return r.json();
}

async function layers(): Promise<Layer[]> {
  const r = await bridge("/call", { app: "photocraft", tool: "doc_inspect", arguments: {} });
  const top = r.result?.layers ?? [];
  return top.map((l: any) => ({ id: l.id, name: l.name, kind: l.kind, text: l.text?.text, font: l.text?.font }));
}

/** One user turn: the model gets ROUNDS rounds of craft calls, then must answer. */
async function turn(history: any[], user: string) {
  history.push({ role: "user", content: user });
  const calls: string[] = [];
  for (let round = 0; round <= ROUNDS; round++) {
    const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, temperature: 0.2, messages: [{ role: "system", content: SYSTEM }, ...history],
        ...(round < ROUNDS ? { tools: [TOOL] } : {}),
      }),
    });
    const msg = (await res.json()).choices?.[0]?.message ?? { role: "assistant", content: "" };
    history.push({ role: "assistant", content: msg.content || "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) return { text: String(msg.content || ""), calls, rounds: round };
    for (const tc of msg.tool_calls) {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* bad json → tool error */ }
      const out = await runCraftTool(args, { books: [] });
      calls.push(`${args.action}${args.steps ? ":" + args.steps.map((s: any) => s.id).join("+") : ""}${args.layer ? `@${args.layer}` : ""}${out.event.ok ? "" : "!"}`);
      const { __vision: _v, __images: _i, ...forModel } = out.result || {};
      history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(forModel).slice(0, 8000) });
    }
  }
  return { text: "", calls, rounds: ROUNDS + 1 };
}

const asks = (t: string) => /\?/.test(t) && /(or|which|would you|prefer|like)/i.test(t);
const outOfSteps = (t: string) => /(ran out|tool budget|steps ran|say "?continue|reply "?continue)/i.test(t);

describe.skipIf(process.env.LIVE_CRAFT_EVAL !== "1")(`PhotoCraft cat session, ${MODEL}`, () => {
  beforeAll(() => {
    const real = globalThis.fetch;
    globalThis.fetch = ((url: any, { signal: _s, ...init }: any = {}) => real(typeof url === "string" && url.startsWith("/") ? APP + url : url, {
      ...init, headers: { ...(init?.headers || {}), Origin: APP },
    })) as typeof fetch;
    if (typeof (AbortSignal as any).timeout !== "function") (AbortSignal as any).timeout = () => new AbortController().signal;
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`run ${run}`, async () => {
      // A fresh document with the cat, as in the user's session.
      const s = await bridge("/call", { app: "photocraft", tool: "session_list", arguments: {} });
      for (let i = (s.result?.documents?.length ?? 0) - 1; i >= 0; i--) await bridge("/call", { app: "photocraft", tool: "doc_close", arguments: { index: i } });
      const img = process.env.CRAFT_EVAL_IMAGE;
      expect(img, "CRAFT_EVAL_IMAGE: a picture inside the craft workspace").toBeTruthy();
      await bridge("/import", { app: "photocraft", path: img, new_document: true });
      const catId = (await layers()).at(-1)!.id;
      const log: string[] = [];
      const note = (x: string) => { log.push(x); console.log(x); };
      const h: any[] = [];

      // 1. Clear and undoable: just do it, in one reply.
      let r = await turn(h, "please create a new layer without touching the layer with the purple cat image");
      note(`new layer: ${r.calls.join(" ")} → ${r.text.slice(0, 120)}`);
      let L = await layers();
      expect(outOfSteps(r.text), r.text).toBe(false);
      expect(L.filter((l) => l.kind === "Pixel").length, JSON.stringify(L)).toBeGreaterThanOrEqual(2);

      // 2. Taste: may ask (with choices) or just write one.
      r = await turn(h, "now add a funny headline without touching any other layer");
      note(`headline: ${r.calls.join(" ")} → ${r.text.slice(0, 160)}`);
      if (!(await layers()).some((l) => l.kind === "Type")) {
        expect(asks(r.text), `neither made a headline nor asked: ${r.text}`).toBe(true);
        r = await turn(h, "go with your first idea");
        note(`headline (after answer): ${r.calls.join(" ")} → ${r.text.slice(0, 120)}`);
      }
      L = await layers();
      expect(L.some((l) => l.kind === "Type"), JSON.stringify(L)).toBe(true);
      expect(outOfSteps(r.text), r.text).toBe(false);

      // 3. Clear: change only the headline's font.
      const before = await layers();
      r = await turn(h, "please change the font of the headline to something more playful without touching anything else");
      note(`font: ${r.calls.join(" ")} → ${r.text.slice(0, 120)}`);
      L = await layers();
      expect(outOfSteps(r.text), r.text).toBe(false);
      const fontOf = (ls: any[]) => ls.find((l) => l.kind === "Type")?.font;
      expect(fontOf(L), r.text).not.toBe(fontOf(before));
      expect(L.length).toBe(before.length);

      // 4. Taste: "look better". Asking is right; acting must not touch the text.
      r = await turn(h, "please adjust the image settings to make it look better");
      note(`look better: ${r.calls.join(" ")} → ${r.text.slice(0, 200)}`);
      if (!(await layers()).some((l) => l.kind === "Adjustment") && asks(r.text)) {
        r = await turn(h, "brighter and punchier");
        note(`look better (after answer): ${r.calls.join(" ")} → ${r.text.slice(0, 120)}`);
      }
      L = await layers();
      expect(outOfSteps(r.text), r.text).toBe(false);
      const adj = L.findIndex((l) => l.kind === "Adjustment");
      const type = L.findIndex((l) => l.kind === "Type");
      const catAt = L.findIndex((l) => l.id === catId);
      expect(adj, JSON.stringify(L)).toBeGreaterThanOrEqual(0);
      // Top first: the adjustment sits below the text and above the cat.
      expect(adj, JSON.stringify(L)).toBeGreaterThan(type);
      expect(adj).toBeLessThan(catAt);
      console.log(`\n[run ${run}]\n  ${log.join("\n  ")}`);
    }, 900_000);
  }
});
