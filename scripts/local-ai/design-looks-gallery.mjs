#!/usr/bin/env node
// Renders every page look (design-looks.mjs) with the same content in a
// private headless DesignCraft, so the looks can be judged by eye side by side.
//
//   node scripts/local-ai/design-looks-gallery.mjs [image] [outdir] [preset] [looks,…]
//
// Never touches an open DesignCraft window: it runs its own `designcraft-cli mcp`.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LOOK_NAMES, layoutLook, imagePalette, defaultPalette } from "./design-looks.mjs";

const CLI = join(process.env.CC_HOME || join(homedir(), ".local/share/chapter-craft-local"), "crafts/designcraft/usr/bin/designcraft-cli");
const [image, outArg, preset = "Letter", lookArg] = process.argv.slice(2);
const out = resolve(outArg || "design-gallery");
mkdirSync(out, { recursive: true });
const CONTENT = JSON.parse(process.env.GALLERY_CONTENT || "null") || {
  subhead: "A new book by Chapter Craft",
  headline: "Plan to Win",
  body: "Fred mowed lawns with borrowed money. Ted built a team, learned the business first and owned the assets. Same street, same start — one planned, one didn't.",
  footer: "Out now · chaptercraft.app",
};

const proc = spawn(CLI, ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
let next = 0; const pend = new Map();
createInterface({ input: proc.stdout }).on("line", (l) => { try { const m = JSON.parse(l); pend.get(m.id)?.(m); pend.delete(m.id); } catch { /* not ours */ } });
const rpc = (method, params) => new Promise((r) => { const id = ++next; pend.set(id, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
async function call(name, args = {}) {
  const m = await rpc("tools/call", { name, arguments: args });
  const r = m.result || {};
  const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError || m.error) throw new Error(`${name}: ${text || JSON.stringify(m.error)}`);
  try { return JSON.parse(text); } catch { return text; }
}
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gallery", version: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const pal = image ? await imagePalette(resolve(image)) : defaultPalette();
console.log("palette", JSON.stringify(pal));
for (const look of lookArg ? lookArg.split(",") : LOOK_NAMES) {
  const t0 = Date.now();
  await call("new_document", preset.includes("x") ? { width: +preset.split("x")[0], height: +preset.split("x")[1], facingPages: false } : { preset, facingPages: false });
  const parts = [];
  const exec = (command, params) => call("execute", { command, params });
  for (const role of ["subhead", "headline", "body", "caption", "footer"]) {
    if (!CONTENT[role]) continue;
    const r = await exec("frame.create", { rect: [36, 36, 300, 100], content: "text", text: CONTENT[role] });
    await exec("object.rename", { id: r.id, name: role[0].toUpperCase() + role.slice(1) });
    parts.push({ id: r.id, role, kind: "text", text: CONTENT[role] });
  }
  if (image) {
    await exec("selection.set", { ids: [] });
    const r = await call("place_image", { path: resolve(image), x: 36, y: 200, width: 200 });
    const d = await call("inspect_document", {});
    const it = d.spreads[0].items.find((i) => i.id === r.id);
    const [a, b, c, e] = it.bounds;
    parts.push({ id: r.id, role: "image", kind: "image", aspect: (c - a) / (e - b) });
  }
  const doc = await call("inspect_document", {});
  const pg = doc.spreads[0].pages[0];
  const [x0, y0, x1, y1] = pg.bounds;
  const page = { x: x0, y: y0, W: x1 - x0, H: y1 - y0 };
  const res = await layoutLook(call, look, page, parts, pal);
  const file = join(out, `${look}.png`);
  await call("render_page", { page: 0, path: file });
  console.log(look, `${Date.now() - t0} ms`, file, res.issues.join("; ") || "ok");
}
proc.kill();
