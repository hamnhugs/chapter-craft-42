// Live model eval: the user's Cashflow Quadrant flyer session (2026-10-13)
// replayed through a real model, the craft tool's own code and a headless
// DesignCraft behind a private bridge, so the user's open window is never
// touched. Each request must be done in ONE reply, and the page is checked
// after it: the parts are where they were asked for, nothing overlaps, nothing
// is cut off or off the page.
//
//   CC_CRAFTS_HEADLESS=1 CC_CRAFTS_PORT=8799 CC_DESIGNCRAFT_PORT=7999 node scripts/local-ai/craft-bridge.mjs &
//   DESIGN_EVAL_IMAGE=<png in crafts/workspace> LIVE_DESIGN_EVAL=1 npx vitest run src/test/localDesignEval.test.ts
//
// Model: local Ollama by default (LIVE_OLLAMA_MODEL); any OpenAI-style endpoint
// with EVAL_BASE_URL + EVAL_API_KEY + EVAL_MODEL (e.g. OpenRouter and the user's
// cloud model). DESIGN_EVAL_CONTEXT: a text file with the book passage the user
// had in context (not committed). CRAFT_EVAL_RUNS: repeats (default 3).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const BRIDGE = process.env.DESIGN_EVAL_BRIDGE || "http://127.0.0.1:8799";
const IMAGE = process.env.DESIGN_EVAL_IMAGE || "";
vi.mock("@/lib/imageGen", () => ({
  // The library picture, served from the craft workspace by the private bridge.
  getSignedImageUrl: async () => `${BRIDGE}/files?path=${encodeURIComponent(IMAGE)}`,
  storeGeneratedImage: async (o: any) => ({ id: "exported", storage_path: "x", prompt: o.prompt }),
}));

import { CRAFT_TOOL_DEFINITION, resolveAction, runCraftTool } from "@/lib/craftApps";
import { slimToolDef } from "@/lib/localRoster";

const CLOUD = !!process.env.EVAL_BASE_URL;
const BASE = process.env.EVAL_BASE_URL || `${process.env.LIVE_OLLAMA_URL || "http://127.0.0.1:11434"}/v1`;
const MODEL = process.env.EVAL_MODEL || process.env.LIVE_OLLAMA_MODEL || "hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K";
const RUNS = Number(process.env.CRAFT_EVAL_RUNS || 3);
const ROUNDS = 8; // ChatContext CRAFT_TOOL_ITERATIONS
const TOOL = CLOUD ? CRAFT_TOOL_DEFINITION : slimToolDef(CRAFT_TOOL_DEFINITION as any);
const IMAGE_ID = "b9fe2624-d08f-43bb-bd55-d4648d2e4302";
const passage = (() => { try { return readFileSync(String(process.env.DESIGN_EVAL_CONTEXT), "utf8").slice(0, 2000); } catch { return "Chapter 2: Why Do You Need a Plan? Writing a winning business plan is necessary whether you need outside investors or not."; } })();
const SYSTEM = [
  "You are Counsel, the user's creative assistant in Chapter Craft. You can act in their apps with the craft tool. Reply briefly.",
  "Open book: \"Rich Dad's Advisors: The ABCs of Writing Winning Business Plans\" by Garrett Sutton.",
  `Book passage in context:\n${passage}`,
  `Image library: "Cashflow Quadrant (PhotoCraft edit)" image_id ${IMAGE_ID} — the E/S/B/I grid with a "PLAN TO WIN" arrow from S to B.`,
  "DesignCraft is open on the user's screen.",
].join("\n\n");

async function bridge(path: string, body: unknown) {
  const r = await fetch(`${BRIDGE}${path}`, { method: "POST", headers: { "X-Chapter-Craft": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

type Part = { id: number; role: string; fill?: string; box: { x: number; y: number; w: number; h: number }; text?: string };
async function page(): Promise<{ items: Part[]; issues: string[]; settings: any; look: string | null }> {
  const d = (await bridge("/inspect", { app: "designcraft" })).result || {};
  const sp = d.spreads?.[0] || { items: [], pages: [] };
  // A page look draws its background, fades and rules as "Look …"/"Deco …"; they aren't parts.
  const look = (sp.items || []).map((it: any) => String(it.name || "")).find((n: string) => n.startsWith("Look "))?.slice(5) ?? null;
  const items: Part[] = (sp.items || []).filter((it: any) => !/^(Look|Deco) /.test(String(it.name || ""))).map((it: any) => ({
    id: it.id, role: String(it.name || "").split(" · ")[0].toLowerCase() || (it.story != null ? "text" : "image"), fill: it.fill,
    box: { x: it.bounds[0], y: it.bounds[1], w: it.bounds[2] - it.bounds[0], h: it.bounds[3] - it.bounds[1] },
  })).sort((a: Part, b: Part) => a.box.y - b.box.y);
  const issues: string[] = [];
  const [px0, py0, px1, py1] = sp.pages?.[0]?.bounds || [0, 0, 1e9, 1e9];
  for (const it of items) {
    const s = (await bridge("/call", { app: "designcraft", tool: "get_story", arguments: { frame: it.id } })).result;
    if (s && typeof s === "object" && "overset" in s) {
      it.text = s.text;
      if (s.overset != null) issues.push(`${it.role} cut off`);
      // "Make the headline red" once painted the box behind it instead.
      if (it.fill && it.fill !== "[None]") issues.push(`${it.role} box filled with ${it.fill}`);
    }
    if (it.box.x < px0 - 1 || it.box.y < py0 - 1 || it.box.x + it.box.w > px1 + 1 || it.box.y + it.box.h > py1 + 1) issues.push(`${it.role} off the page`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].box, b = items[j].box;
    // Cinematic sets its type on the full-page photo, over a fade: that's the design.
    if (look === "cinematic" && (items[i].role === "image" || items[j].role === "image")) continue;
    if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) issues.push(`${items[i].role} overlaps ${items[j].role}`);
  }
  return { items, issues, settings: d.settings, look };
}

async function turn(history: any[], user: string) {
  history.push({ role: "user", content: user });
  const calls: string[] = [];
  const t0 = Date.now();
  for (let round = 0; round <= ROUNDS; round++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.EVAL_API_KEY ? { Authorization: `Bearer ${process.env.EVAL_API_KEY}` } : {}) },
      body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: "system", content: SYSTEM }, ...history], ...(round < ROUNDS ? { tools: [TOOL] } : {}) }),
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(`model: ${JSON.stringify(j.error ?? j).slice(0, 300)}`);
    const msg = j.choices?.[0]?.message ?? { role: "assistant", content: "" };
    history.push({ role: "assistant", content: msg.content || "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) return { text: String(msg.content || ""), calls, rounds: round, seconds: (Date.now() - t0) / 1000 };
    for (const tc of msg.tool_calls) {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* bad json → tool error */ }
      if (process.env.DESIGN_EVAL_DEBUG) console.log("ARGS", tc.function.name, tc.function.arguments);
      // Only the headless DesignCraft: the private bridge would open the
      // user's real PhotoCraft or FilmCraft window.
      const out = args.app && args.app !== "designcraft"
        ? { result: { error: "Only DesignCraft is available right now." }, event: { ok: false } }
        : await runCraftTool(args, { books: [], fetchImage: async (id) => (id === IMAGE_ID ? { id, storage_path: "x" } : null) });
      calls.push(`${resolveAction(args)}${args.look ? ":look=" + args.look : ""}${args.role ? ":" + args.role : ""}${args.steps ? ":" + args.steps.map((s: any) => s.id).join("+") : ""}${out.event.ok ? "" : `!(${String(out.result?.error ?? "").slice(0, 160)})`}`);
      const { __vision: _v, __images: _i, ...forModel } = out.result || {};
      history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(forModel).slice(0, 8000) });
    }
  }
  return { text: "", calls, rounds: ROUNDS + 1, seconds: (Date.now() - t0) / 1000 };
}

const roles = (p: { items: Part[] }) => p.items.map((i) => i.role);

describe.skipIf(process.env.LIVE_DESIGN_EVAL !== "1")(`DesignCraft flyer session, ${MODEL}`, () => {
  beforeAll(() => {
    if (typeof (AbortSignal as any).timeout !== "function") (AbortSignal as any).timeout = () => new AbortController().signal;
    const real = globalThis.fetch;
    // The craft tool calls /local/crafts (the app's proxy); here that is the private bridge.
    // Under jsdom a Blob body reaches Node's fetch as the text "[object Blob]";
    // send its bytes instead.
    const bytes = (b: any): Promise<ArrayBuffer> => typeof b.arrayBuffer === "function" ? b.arrayBuffer() : new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.onerror = () => rej(r.error); r.readAsArrayBuffer(b);
    });
    globalThis.fetch = (async (url: any, { signal: _s, ...init }: any = {}) => {
      const body = init.body && typeof init.body === "object" && typeof init.body.size === "number" ? await bytes(init.body) : init.body;
      return real(typeof url === "string" && url.startsWith("/local/crafts") ? BRIDGE + url.slice("/local/crafts".length) : url, {
        ...init, body, headers: { ...(init?.headers || {}), "X-Chapter-Craft": "1" },
      });
    }) as typeof fetch;
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`run ${run}`, async () => {
      expect(IMAGE, "DESIGN_EVAL_IMAGE: a picture inside the craft workspace").toBeTruthy();
      // No document open, as when the user said "open the appropriate page size".
      for (let i = 0; i < 6; i++) { const r = await bridge("/call", { app: "designcraft", tool: "execute", arguments: { command: "file.close", params: { save: false } } }); if (!r.ok) break; }
      const h: any[] = [];
      const log = (x: string) => console.log(`[${MODEL} run ${run}] ${x}`);

      let r = await turn(h, "please open the appropriate page size to create a flyer");
      let p = await page();
      log(`page size: ${r.calls.join(" ")} (${r.seconds.toFixed(0)} s) ${p.settings?.pageWidth?.toFixed?.(0)}x${p.settings?.pageHeight?.toFixed?.(0)} → ${r.text.slice(0, 100)}`);
      expect(r.rounds, "finished in one reply").toBeLessThanOrEqual(ROUNDS);

      r = await turn(h, "place the cashflow quadrant image into our flyer and then add a headline to the top");
      p = await page();
      log(`image+headline: ${r.calls.join(" ")} (${r.rounds} rounds, ${r.seconds.toFixed(0)} s) ${JSON.stringify(roles(p))} "${p.items.find((i) => i.role === "headline")?.text ?? ""}" issues=${p.issues.join("; ") || "none"} → ${r.text.slice(0, process.env.DESIGN_EVAL_DEBUG ? 2000 : 160)}`);
      expect(r.rounds).toBeLessThanOrEqual(ROUNDS);
      expect(roles(p)).toContain("image");
      expect(roles(p)[0], "headline on top").toBe("headline");
      expect(p.issues).toEqual([]);

      r = await turn(h, "make the headline red");
      p = await page();
      log(`red: ${r.calls.join(" ")} (${r.seconds.toFixed(0)} s) ${JSON.stringify(roles(p))} issues=${p.issues.join("; ") || "none"}`);
      expect(roles(p).filter((x) => x === "headline")).toHaveLength(1);
      expect(p.issues).toEqual([]);

      r = await turn(h, "add the book title and author at the bottom");
      p = await page();
      log(`footer: ${r.calls.join(" ")} (${r.seconds.toFixed(0)} s) ${JSON.stringify(roles(p))} issues=${p.issues.join("; ") || "none"} → ${r.text.slice(0, 160)}`);
      expect(roles(p).at(-1)).toMatch(/footer|caption|body|text/);
      expect(p.issues).toEqual([]);

      // Taste, said plainly: act on it with a look rather than ask.
      r = await turn(h, "make it look amazing, like a pro designer made it");
      p = await page();
      log(`pro: ${r.calls.join(" ")} (${r.seconds.toFixed(0)} s) look=${p.look} issues=${p.issues.join("; ") || "none"} → ${r.text.slice(0, 160)}`);
      expect(r.calls.some((c) => /^(send|open)/.test(c)), "acted instead of asking").toBe(true);
      expect(p.issues).toEqual([]);

      r = await turn(h, "now try it as a movie poster");
      p = await page();
      log(`movie poster: ${r.calls.join(" ")} (${r.seconds.toFixed(0)} s) look=${p.look} issues=${p.issues.join("; ") || "none"}`);
      expect(p.look).toBe("cinematic");
      expect(p.issues).toEqual([]);
      await bridge("/preview", { app: "designcraft", page: 0 }).then((x) => log(`preview ${x.path}`));
    }, 15 * 60_000);
  }
});
