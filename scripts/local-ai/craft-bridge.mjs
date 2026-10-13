#!/usr/bin/env node
// Craft bridge — lets Chapter Craft drive PhotoCraft, DesignCraft and FilmCraft
// (github.com/storytold, installed by scripts/local-ai/install-crafts.sh).
//
// Each app ships an MCP server in its CLI (`<app>-cli mcp`). This service keeps
// one MCP session per app and answers the browser over loopback HTTP, reached
// through the app's same-origin /local/crafts proxy:
//   - the desktop window is open with its control port → the session drives it
//     live (what Counsel does shows up on screen);
//   - otherwise → a headless engine session that keeps its document between calls.
// Files move between Chapter Craft and the apps through one workspace folder,
// which is also PhotoCraft's automation read/write root.
//
// Only requests carrying the X-Chapter-Craft header from the app's own origin
// are served: the header can't be sent cross-origin without a CORS preflight,
// which this server never approves, so a web page can't drive the apps.
//
//   node scripts/local-ai/craft-bridge.mjs        (scripts/local-up.sh starts it)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SERVICES = JSON.parse(readFileSync(join(ROOT, "local-services.json"), "utf8"));
const PORT = Number(new URL(SERVICES.crafts).port);
const CC_HOME = process.env.CC_HOME || join(homedir(), ".local/share/chapter-craft-local");
const CRAFTS = join(CC_HOME, "crafts");
const WS = join(CRAFTS, "workspace");
const STATE = join(CRAFTS, ".state");
const ALLOWED_ORIGINS = new Set(["http://127.0.0.1:8080", "http://localhost:8080", ...(process.env.CC_APP_ORIGINS || "").split(",").filter(Boolean)]);
const CALL_TIMEOUT_MS = 120_000;
const EXPORT_TIMEOUT_MS = 30 * 60_000;
const TICKS = 254_016_000_000;

const log = (...a) => console.error(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// The apps. Tool names differ per app; the bridge's verbs map onto them.
// ---------------------------------------------------------------------------

export const APPS = {
  photocraft: {
    label: "PhotoCraft", like: "Photoshop", control: Number(process.env.CC_PHOTOCRAFT_PORT || 7878),
    token: join(STATE, "photocraft.token"),
    tools: { commands: "command_list", run: "command_batch", inspect: "doc_inspect", preview: "render_preview" },
  },
  designcraft: {
    label: "DesignCraft", like: "InDesign", control: Number(process.env.CC_DESIGNCRAFT_PORT || 7979),
    tools: { commands: "list_commands", run: "batch", inspect: "inspect_document", preview: "render_page" },
  },
  filmcraft: {
    label: "FilmCraft", like: "Premiere Pro", control: Number(process.env.CC_FILMCRAFT_PORT || 9876),
    tools: { commands: "command_list", run: "command_batch", inspect: "doc_inspect", preview: "render_preview" },
  },
};

const bin = (app, cli) => join(CRAFTS, app, "usr/bin", cli ? `${app}-cli` : app);
const installed = (app) => existsSync(bin(app, true));
const version = (app) => { try { return readFileSync(join(CRAFTS, app, "VERSION"), "utf8").trim(); } catch { return null; } };

/** Desktop launch arguments: the control port the bridge attaches to. Same as
 *  the menu launchers install-crafts.sh writes, so a window the user opened
 *  themselves is drivable too. */
export function desktopArgs(app) {
  const a = APPS[app];
  if (app === "photocraft") return ["--control", String(a.control), "--control-token-file", a.token, "--automation-read-root", WS, "--automation-write-root", WS];
  return ["--control", String(a.control)];
}

function mcpArgs(app, live) {
  const a = APPS[app];
  if (app === "photocraft") return live
    ? ["mcp", "--bridge", `127.0.0.1:${a.control}`, "--control-token-file", a.token]
    : ["mcp", "--automation-read-root", WS, "--automation-write-root", WS];
  if (app === "designcraft") return live ? ["mcp", "--connect", String(a.control)] : ["mcp"];
  return live ? ["mcp", "--bridge", `127.0.0.1:${a.control}`] : ["mcp"];
}

function portOpen(port) {
  return new Promise((res) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(400, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// ---------------------------------------------------------------------------
// MCP over stdio — newline-delimited JSON-RPC 2.0.
// ---------------------------------------------------------------------------

class McpSession {
  constructor(app, live) {
    this.app = app; this.live = live; this.nextId = 1; this.pending = new Map(); this.dead = false; this.stderr = [];
    this.proc = spawn(bin(app, true), mcpArgs(app, live), { stdio: ["pipe", "pipe", "pipe"], cwd: WS });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: this.proc.stderr }).on("line", (l) => { this.stderr.push(l); if (this.stderr.length > 40) this.stderr.shift(); });
    this.proc.on("exit", (code) => {
      this.dead = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${APPS[app].label} stopped (exit ${code}). ${this.stderr.slice(-3).join(" ")}`.trim())); }
      this.pending.clear();
    });
    this.proc.on("error", (e) => { this.dead = true; log(app, "spawn failed", e.message); });
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chapter-craft", version: "1" },
    }, 30_000).then((r) => { this.notify("notifications/initialized"); return r; });
  }
  onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null || !this.pending.has(msg.id)) return;
    const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n"); }
  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    if (this.dead) return Promise.reject(new Error(`${APPS[this.app].label} session is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        reject(new Error(`${APPS[this.app].label} took longer than ${Math.round(timeoutMs / 1000)} s; it may still have finished — inspect before retrying`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  }
  close() { this.dead = true; try { this.proc.kill(); } catch { /* gone */ } }
}

const sessions = {};
const queues = {};
const catalogs = {};

/** One call at a time per app: the engines are single-document sessions and
 *  interleaved edits from two chat turns would be impossible to reason about. */
function serial(app, fn) {
  const run = (queues[app] || Promise.resolve()).then(fn, fn);
  queues[app] = run.catch(() => {});
  return run;
}

async function session(app) {
  if (!APPS[app]) throw httpError(400, `Unknown app "${app}". Apps: ${Object.keys(APPS).join(", ")}`);
  if (!installed(app)) throw httpError(409, `${APPS[app].label} isn't installed. Run scripts/local-ai/install-crafts.sh`);
  const live = await portOpen(APPS[app].control);
  let s = sessions[app];
  if (s && !s.dead && s.live === live) return s;
  if (s) { s.close(); delete catalogs[app]; }
  log(app, live ? "attaching to the open window" : "starting a headless session");
  s = sessions[app] = new McpSession(app, live);
  await s.ready;
  return s;
}

/** A tools/call result → {isError, text, json, images}. */
function unpack(result) {
  const out = { isError: !!result?.isError, text: "", json: undefined, images: [] };
  const texts = [];
  for (const c of result?.content || []) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") out.images.push({ mime: c.mimeType || "image/png", base64: c.data });
  }
  if (result?.structuredContent !== undefined) out.json = result.structuredContent;
  out.text = texts.join("\n");
  if (out.json === undefined && texts.length === 1) { try { out.json = JSON.parse(texts[0]); } catch { /* prose */ } }
  return out;
}

async function callTool(app, name, args = {}, timeoutMs) {
  return serial(app, async () => {
    const s = await session(app);
    return unpack(await s.request("tools/call", { name, arguments: args }, timeoutMs));
  });
}

async function mustCall(app, name, args, timeoutMs) {
  const r = await callTool(app, name, args, timeoutMs);
  if (r.isError) throw httpError(422, `${APPS[app].label} ${name}: ${r.text || "failed"}`);
  return r;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

async function status() {
  const apps = {};
  for (const [app, a] of Object.entries(APPS)) {
    const s = sessions[app];
    apps[app] = {
      label: a.label, like: a.like, installed: installed(app), version: version(app),
      window_open: await portOpen(a.control),
      session: s && !s.dead ? (s.live ? "live" : "headless") : null,
    };
  }
  return { apps, workspace: WS };
}

async function listTools(app) {
  return serial(app, async () => {
    const s = await session(app);
    const r = await s.request("tools/list", {});
    return { mode: s.live ? "live" : "headless", tools: (r.tools || []).map((t) => ({ name: t.name, description: t.description, input: t.inputSchema?.properties || {} })) };
  });
}

async function catalog(app) {
  const s = await session(app);
  const c = catalogs[app];
  if (c && c.session === s && Date.now() - c.at < 10 * 60_000) return c.list;
  const r = await mustCall(app, APPS[app].tools.commands, {});
  const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.commands) ? r.json.commands : [];
  catalogs[app] = { session: s, at: Date.now(), list };
  return list;
}

/** Commands ranked by how well their id, label, menu and parameter text match
 *  the words of `query`. Catalogs run to ~900 commands; a small model sees the
 *  best handful with their parameter docs. */
/** Everyday words → the apps' own (Photoshop calls text "type"). A synonym
 *  scores like the word itself, so "add text" finds type.create. */
const SYNONYMS = {
  text: ["type"], headline: ["type"], title: ["type"], caption: ["type"], words: ["type"], font: ["type", "style"],
  add: ["new", "create"], make: ["new", "create"], create: ["new"], insert: ["new", "place"],
  picture: ["image"], photo: ["image"], colour: ["color"], bright: ["brightness"], brighter: ["brightness"],
  darker: ["brightness", "exposure"], punchy: ["vibrance", "contrast"], saturation: ["vibrance", "huesaturation"],
};

/** What people ask for most: a nudge so they win ties against the long tail
 *  (type.setStyle over Save Default Type Styles for "change the font"). */
const COMMON = new Set([
  "type.create", "type.setStyle", "layer.new.layer", "layer.select", "layer.newAdjustmentLayer.brightnessContrast",
  "layer.newAdjustmentLayer.vibrance", "layer.newAdjustmentLayer.curves", "layer.newAdjustmentLayer.hueSaturation",
  "image.autoTone", "filter.blur.gaussianBlur", "image.crop", "image.imageSize", "layer.delete", "layer.duplicate",
]);

export function rankCommands(list, query, limit = 12) {
  const base = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const words = [...new Set(base.flatMap((w) => [w, ...(SYNONYMS[w] || [])]))];
  const scored = list.map((c) => {
    const id = String(c.id || "").toLowerCase();
    const label = String(c.label || "").toLowerCase();
    const menu = [].concat(c.menu || []).join(" ").toLowerCase();
    const params = typeof c.params === "string" ? c.params.toLowerCase() : JSON.stringify(c.params || "").toLowerCase();
    let score = 0;
    for (const w of words) {
      if (id.split(/[^a-z0-9]+/).includes(w)) score += 4; else if (id.includes(w)) score += 2.5;
      if (label.includes(w)) score += 2;
      if (menu.includes(w)) score += 1;
      if (params.includes(w)) score += 0.3;
    }
    if (score > 0 && COMMON.has(c.id)) score += 2;
    return { c, score };
  });
  return scored
    .filter((s) => !words.length || s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    // The top hits carry their whole parameter doc: cut at 400, type.create
    // lost its font/size/colour keys and the model spent rounds on
    // command_list to read them.
    .map(({ c }, i) => ({
      id: c.id, label: c.label, menu: [].concat(c.menu || []).join(" › ") || undefined,
      params: typeof c.params === "string" ? c.params.slice(0, i < 3 ? 1500 : 300) : c.params,
      enabled: c.enabled, ...(c.disabledReason ? { disabled_reason: c.disabledReason } : {}),
    }));
}

/** "layer.addText" → "layer add text": a guessed command id as search words. */
export function idWords(id) {
  return String(id).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase();
}

async function commands(app, query, limit) {
  return { commands: rankCommands(await catalog(app), query, Math.min(30, Math.max(1, Number(limit) || 12))) };
}

async function run(app, steps, stopOnError = true, opts = {}) {
  if (!Array.isArray(steps) || !steps.length) throw httpError(400, "steps: a list of {id, params}");
  let norm = steps.map((s) => ({ id: String(s.id || s.command || ""), params: s.params && typeof s.params === "object" ? s.params : {} }));
  const bad = norm.find((s) => !s.id);
  if (bad) throw httpError(400, "every step needs an id");
  let targeted, nonDestructive;
  if (app === "photocraft" && !opts.bake) {
    // Image › Adjustments rewrites the layer's pixels; the same adjustment as
    // an adjustment layer takes the same params and leaves the photo as it
    // was. Small models reach for the former; the user asked for the latter.
    const ids = new Set((await catalog(app).catch(() => [])).map((c) => c.id));
    norm = norm.map((st) => {
      const m = /^image\.adjustments\.(.+)$/.exec(st.id);
      const layerId = m && `layer.newAdjustmentLayer.${m[1]}`;
      if (!layerId || !ids.has(layerId)) return st;
      (nonDestructive ||= []).push(layerId);
      return { ...st, id: layerId };
    });
  }
  if (app === "photocraft" && (await photoDocs())) {
    // Select the layer the edit is for first: new layers go directly above
    // the active one, so an adjustment lands on the photo, not on the text.
    const layers = await photoLayers();
    const id = opts.layer != null && opts.layer !== "" ? findLayer(layers, opts.layer) : lookTarget(layers, norm);
    if (id != null) {
      norm = [{ id: "layer.select", params: { layer: id } }, ...norm];
      const l = layers.find((x) => x.id === id);
      targeted = { id, name: l?.name, ...(opts.layer == null || opts.layer === "" ? { auto: true } : {}) };
    }
  }
  const long = norm.some((s) => /export|render/i.test(s.id));
  const args = app === "designcraft"
    ? { commands: norm.map((s) => ({ command: s.id, params: s.params })) }
    : { steps: norm, stop_on_error: stopOnError };
  const r = await callTool(app, APPS[app].tools.run, args, long ? EXPORT_TIMEOUT_MS : CALL_TIMEOUT_MS);
  // A batch reply is ok even when its steps failed; count those as failures.
  const failed = Number(r.json?.failed) > 0 || (Array.isArray(r.json?.results) && r.json.results.some((x) => x && x.ok === false));
  // A guessed id ("layer.addText") comes back with the real ones that fit,
  // params included, so the next round can run instead of searching.
  const unknown = [...new Set(norm.map((st) => st.id).filter((id) => new RegExp(`unknown command \`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``).test(JSON.stringify(r.json ?? r.text))))];
  let didYouMean;
  if (unknown.length) {
    const list = await catalog(app).catch(() => []);
    didYouMean = Object.fromEntries(unknown.map((id) => [id, rankCommands(list, idWords(id), 3)]));
  }
  return {
    ok: !r.isError && !failed, result: r.json ?? r.text,
    ...(didYouMean ? { did_you_mean: didYouMean, hint: "Those ids don't exist. Run the closest one below with its params." } : {}),
    ...(targeted ? { targeted_layer: targeted } : {}),
    ...(nonDestructive ? { as_adjustment_layers: nonDestructive, note: "Made as adjustment layers, so the photo itself is unchanged (bake:true changes its pixels instead)." } : {}),
    ...(app === "photocraft" ? { layers: await photoLayers() } : {}),
  };
}

async function inspect(app) {
  const r = await mustCall(app, APPS[app].tools.inspect, {});
  return { result: r.json ?? r.text };
}

async function preview(app, opts = {}) {
  const args = app === "designcraft"
    ? { page: Number(opts.page) || 0, scale: 1 }
    : { max_side: Math.min(2048, Number(opts.max_side) || 1024), ...(app === "filmcraft" && opts.seconds != null ? { seconds: Number(opts.seconds) } : {}) };
  const r = await mustCall(app, APPS[app].tools.preview, args);
  const img = r.images[0];
  if (!img) throw httpError(422, `${APPS[app].label} returned no picture${r.text ? `: ${r.text}` : ""}`);
  const path = join(WS, "out", `${app}-preview-${Date.now()}.png`);
  writeFileSync(path, Buffer.from(img.base64, "base64"));
  return { path, mime: img.mime };
}

/** Desktop windows of `app` already running, from /proc: argv[0] is the app
 *  binary itself (the menu launcher execs it), wherever it was installed. */
export function desktopPids(app, procRoot = "/proc") {
  const pids = [];
  let entries = [];
  try { entries = readdirSync(procRoot); } catch { return pids; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let argv0 = "";
    try { argv0 = readFileSync(join(procRoot, e, "cmdline"), "utf8").split("\0")[0]; } catch { continue; }
    if (basename(argv0) === app) pids.push(Number(e));
  }
  return pids;
}

async function waitForPort(port, ms) {
  const until = Date.now() + ms;
  while (!(await portOpen(port))) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
}

/** Bring an already-open window to the front (Hyprland); best effort. */
function focusWindow(app) {
  try {
    const p = spawn("hyprctl", ["dispatch", "focuswindow", `class:(?i).*${app}.*`], { stdio: "ignore" });
    p.on("error", () => {});
  } catch { /* not Hyprland */ }
}

const launching = {};
const openLocks = {};

/** One window per app. Opens are queued per app (a model can call open twice
 *  in one round), a window still starting is waited for rather than launched
 *  again, and a window opened some other way — without the control port — is
 *  reported instead of starting a second, undrivable copy beside it. */
function openApp(app, path, opts = {}) {
  const run = (openLocks[app] || Promise.resolve()).then(() => openAppNow(app, path, opts));
  openLocks[app] = run.catch(() => {});
  return run;
}

async function openAppNow(app, path, opts) {
  if (!APPS[app]) throw httpError(400, `Unknown app "${app}". Apps: ${Object.keys(APPS).join(", ")}`);
  if (!installed(app)) throw httpError(409, `${APPS[app].label} isn't installed. Run scripts/local-ai/install-crafts.sh`);
  const a = APPS[app];
  let launched = false;
  if (await portOpen(a.control)) {
    focusWindow(app);
  } else {
    const child = launching[app];
    const starting = (child && child.exitCode == null && !child.killed) || desktopPids(app).length > 0;
    if (starting) {
      // Ours still starting, or one the user just opened from the menu.
      if (!(await waitForPort(a.control, 45_000))) {
        throw httpError(409, `${a.label} is already open, but not in a way Chapter Craft can drive (it was started without its control link). Close that ${a.label} window and ask again, or open it from the app menu.`);
      }
      focusWindow(app);
    } else {
      log(app, "launching the window");
      const proc = spawn(bin(app, false), desktopArgs(app), { detached: true, stdio: "ignore", cwd: WS });
      proc.on("error", (e) => log(app, "launch failed", e.message));
      proc.unref();
      launching[app] = proc;
      launched = true;
      if (!(await waitForPort(a.control, 60_000))) throw httpError(504, `${a.label} didn't open within 60 s; it may still be starting — check status before opening it again`);
    }
  }
  const placed = path ? await importFile(app, path, opts) : null;
  return { launched, window_open: true, ...(placed ? { imported: placed } : {}) };
}

// --- moving things in ---------------------------------------------------------

/** A path the caller gave → an absolute path inside the workspace. */
export function inWorkspace(p, root = WS) {
  const abs = resolve(root, String(p || ""));
  let real;
  try { real = realpathSync(abs); } catch { throw httpError(404, `No such file in the workspace: ${p}`); }
  const base = realpathSync(root);
  if (real !== base && !real.startsWith(base + sep)) throw httpError(403, "Only files in the craft workspace can be used");
  return real;
}

const AUDIO_EXT = new Set([".wav", ".mp3", ".flac", ".aiff", ".ogg", ".m4a", ".aac"]);

/** Open documents in a session_list reply. Headless it is the engine's
 *  session ({documents}); live it is the window's ui.inspect, where the list
 *  sits under `session`. Reading only the first shape counted 0 with the window
 *  open, so every picture sent opened as a new tab instead of a new layer. */
export function docCount(json) {
  const docs = json?.documents ?? json?.session?.documents ?? json?.docs ?? (Array.isArray(json) ? json : []);
  return Array.isArray(docs) ? docs.length : 0;
}

async function photoDocs() {
  return docCount((await mustCall("photocraft", "session_list", {})).json);
}

// --- PhotoCraft layers -----------------------------------------------------------

const CONTENT_KINDS = new Set(["Pixel", "Smart Object", "Shape", "Fill"]);

/** doc_inspect (headless) or the window's ui.inspect → a compact layer stack,
 *  top first, groups flattened: what the model needs to see where an edit
 *  landed without a separate inspect round. */
export function compactLayers(json) {
  const top = json?.document?.layers ?? json?.layers ?? [];
  const out = [];
  const walk = (list, depth, group) => {
    if (!Array.isArray(list) || depth > 8) return;
    for (const l of list) {
      if (!l || typeof l !== "object" || out.length >= 60) continue;
      // PhotoCraft's bounds are [x, y, width, height].
      const b = Array.isArray(l.bounds) && l.bounds.length === 4 ? l.bounds : null;
      const empty = !b || b[2] <= 0 || b[3] <= 0;
      out.push({
        id: l.id, name: l.name, kind: l.kind,
        ...(group ? { in_group: group } : {}),
        ...(l.selected ? { selected: true } : {}),
        ...(l.clipped ? { clipped: true } : {}),
        ...(l.visible === false ? { hidden: true } : {}),
        ...(b && !empty ? { box: { x: b[0], y: b[1], w: b[2], h: b[3] } } : l.kind === "Pixel" ? { empty: true } : {}),
        ...(l.text?.text ? { text: String(l.text.text).slice(0, 60) } : {}),
      });
      if (Array.isArray(l.children)) walk(l.children, depth + 1, l.name);
      else if (Array.isArray(l.layers)) walk(l.layers, depth + 1, l.name);
    }
  };
  walk(top, 0, null);
  return out;
}

/** A layer the user or model named — an id, or a name (exact, then a unique
 *  partial match, case-insensitive) — to its id. Unknown or ambiguous names
 *  list the choices so the model can ask instead of guessing. */
export function findLayer(layers, ref) {
  if (ref == null || ref === "") return null;
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && layers.some((l) => l.id === asNum)) return asNum;
  const q = String(ref).trim().toLowerCase();
  const exact = layers.filter((l) => String(l.name || "").toLowerCase() === q);
  if (exact.length === 1) return exact[0].id;
  const part = exact.length ? exact : layers.filter((l) => String(l.name || "").toLowerCase().includes(q) || String(l.text || "").toLowerCase().includes(q));
  if (part.length === 1) return part[0].id;
  const names = layers.map((l) => `${l.name} (id ${l.id}, ${l.kind})`).join("; ");
  throw httpError(422, part.length
    ? `More than one layer matches "${ref}": ${part.map((l) => `${l.name} (id ${l.id})`).join(", ")}. Ask the user which one.`
    : `No layer is called "${ref}". Layers, top first: ${names}`);
}

/** Commands that change how a picture looks. Run with the text or an
 *  adjustment layer active, they land on (or above, clipped to) the wrong
 *  thing — the user's "make it look better" brightened the headline. */
const LOOK_COMMAND = /^(layer\.newAdjustmentLayer\.|image\.adjustments\.|image\.auto|filter\.)/;

/** The layer such steps should act on when none was named: the active one
 *  if it holds picture content, else the topmost visible layer that does. */
export function lookTarget(layers, steps) {
  if (!steps.some((st) => LOOK_COMMAND.test(st.id)) || steps.some((st) => st.id === "layer.select")) return null;
  const active = layers.find((l) => l.selected);
  const isContent = (l) => CONTENT_KINDS.has(l.kind) && !l.empty && !l.hidden;
  if (active && isContent(active)) return null;
  return layers.find(isContent)?.id ?? null;
}

/** A picture into the active PhotoCraft document as a new layer. Headless
 *  that's doc_place; the open window refuses it (Place Embedded reads an
 *  ambient path), so there the picture opens in a scratch tab, is scaled to
 *  fit, copied across as a layer (layer.copyToDocument) and the tab closed —
 *  leaving one document, as the user expects. */
async function placePhoto(path) {
  const first = await callTool("photocraft", "doc_place", { path, fit: true });
  if (!first.isError) return first.json ?? { placed: basename(path) };
  if (!/ambient filesystem/i.test(first.text)) throw httpError(422, `PhotoCraft doc_place: ${first.text || "failed"}`);
  const before = (await mustCall("photocraft", "session_list", {})).json;
  const sess = before?.session ?? before;
  const target = Number(sess?.active);
  const dest = sess?.documents?.[target];
  if (!Number.isInteger(target) || !dest) throw httpError(422, "PhotoCraft has no active document to place into");
  await mustCall("photocraft", "doc_open", { path });
  const after = (await mustCall("photocraft", "session_list", {})).json;
  const docs = (after?.session ?? after)?.documents || [];
  const source = Number((after?.session ?? after)?.active);
  const src = docs[source];
  if (!Number.isInteger(source) || source === target || !src) throw httpError(422, "PhotoCraft didn't open the picture in its own tab");
  const steps = [];
  const k = Math.min(1, Number(dest.width) / Number(src.width), Number(dest.height) / Number(src.height));
  if (k > 0 && k < 1) steps.push({ id: "image.imageSize", params: { width: Math.max(1, Math.round(src.width * k)), height: Math.max(1, Math.round(src.height * k)) } });
  const name = basename(path).replace(/\.[^.]+$/, "").replace(/^\d{10,}-/, "").slice(0, 60) || "Picture";
  steps.push({ id: "layer.copyToDocument", params: { document: target, source, center: true, name } });
  try {
    const r = await mustCall("photocraft", "command_batch", { steps, stop_on_error: true });
    if (r.json?.failed) throw httpError(422, `PhotoCraft couldn't copy the picture across: ${JSON.stringify(r.json.results?.find((x) => !x.ok) ?? r.json).slice(0, 300)}`);
    return { placed: name, ...(k < 1 ? { scaled_to_fit: Math.round(k * 100) / 100 } : {}) };
  } finally {
    // Close the scratch tab (now resized, so discard) and go back to the user's document.
    await callTool("photocraft", "command_batch", { steps: [{ id: "file.close", params: { document: source, save: false } }, { id: "document.activate", params: { document: target } }], stop_on_error: false });
  }
}

async function photoLayers() {
  const r = await callTool("photocraft", "doc_inspect", {});
  return r.isError ? [] : compactLayers(r.json);
}

async function designDoc() {
  const r = await mustCall("designcraft", "inspect_document", {});
  const d = r.json;
  return d && typeof d === "object" && (d.pages || d.spreads) ? d : null;
}

async function ensureDesignDoc() {
  return (await designDoc()) || (await mustCall("designcraft", "new_document", { preset: "Letter" }), await designDoc());
}

/** Where new content goes in DesignCraft: inside the margins of the last
 *  page, below whatever is already on it — or on a fresh page when less than
 *  `minHeight` points are left, so nothing lands on top of earlier work. */
export function designSlot(doc, minHeight) {
  const spreads = doc?.spreads || [];
  const si = Math.max(0, spreads.length - 1);
  const sp = spreads[si] || {};
  const page = (sp.pages || []).slice(-1)[0] || { bounds: [0, 0, 612, 792], margins: {} };
  const [x0, y0, x1, y1] = page.bounds || [0, 0, 612, 792];
  const m = page.margins || {};
  const top = y0 + (m.top ?? 36), bottom = y1 - (m.bottom ?? 36);
  const left = x0 + (page.side === "left" ? m.outside ?? 36 : m.inside ?? 36);
  const right = x1 - (page.side === "left" ? m.inside ?? 36 : m.outside ?? 36);
  const below = (sp.items || [])
    .filter((it) => Array.isArray(it.bounds) && !it.hidden && it.bounds[0] < x1 && it.bounds[2] > x0)
    .reduce((y, it) => Math.max(y, it.bounds[3] + 12), top);
  if (bottom - below < minHeight) return { spread: si, newPage: true, rect: null, left, right, top, bottom };
  return { spread: si, newPage: false, rect: [left, below, right, bottom] };
}

async function designTarget(minHeight) {
  let slot = designSlot(await ensureDesignDoc(), minHeight);
  if (slot.newPage) {
    await mustCall("designcraft", "execute", { command: "layout.pages.insert", params: { count: 1 } });
    slot = designSlot(await designDoc(), minHeight);
  }
  return slot;
}

async function ensureSequence() {
  const r = await mustCall("filmcraft", "project_inspect", {});
  if (r.json?.activeSequence == null) {
    await mustCall("filmcraft", "command_run", { id: "file.newSequence", params: { name: "Chapter Craft" } });
  }
}

async function sequenceEndSeconds() {
  const r = await mustCall("filmcraft", "sequence_inspect", {});
  const s = r.json || {};
  // Times are ticks: 254 016 000 000 per second (docs/agents.md).
  return Number(s.duration) > 0 ? Number(s.duration) / TICKS : 0;
}

async function importFile(app, p, opts) {
  const path = inWorkspace(p);
  const ext = extname(path).toLowerCase();
  if (app === "photocraft") {
    if (opts.new_document || !(await photoDocs())) {
      const opened = (await mustCall(app, "doc_open", { path })).json ?? { opened: basename(path) };
      return { opened, layers: await photoLayers() };
    }
    // Into the open document as a new layer, above the named layer if any.
    if (opts.layer != null && opts.layer !== "") await mustCall(app, "command_run", { id: "layer.select", params: { layer: findLayer(await photoLayers(), opts.layer) } });
    const placed = await placePhoto(path);
    return { placed, layers: await photoLayers() };
  }
  if (app === "designcraft") {
    if (ext === ".designcraft") return (await mustCall(app, "open_document", { path })).json;
    const args = { path };
    for (const k of ["x", "y", "width", "frame", "spread"]) if (opts[k] != null) args[k] = opts[k];
    if (args.frame == null && args.x == null) {
      // Full column width, under what's already on the page.
      const slot = await designTarget(200);
      Object.assign(args, { spread: slot.spread, x: slot.rect[0], y: slot.rect[1], width: args.width ?? slot.rect[2] - slot.rect[0] });
    }
    return (await mustCall(app, "place_image", args)).json ?? { placed: basename(path) };
  }
  // filmcraft: import, then append to the active sequence's first video track.
  await ensureSequence();
  const imp = await mustCall(app, "media_import", { paths: [path] });
  const ids = []
    .concat(imp.json?.items || imp.json?.imported || imp.json || [])
    .map((x) => (typeof x === "object" ? x?.id ?? x?.item : x))
    .filter((x) => x != null);
  if (!ids.length || opts.place === false) return { imported: imp.json ?? imp.text };
  const at = opts.seconds != null ? Number(opts.seconds) : await sequenceEndSeconds();
  const placed = await mustCall(app, "command_run", {
    id: "timeline.place",
    params: { item: ids[0], seconds: at, ...(opts.track ? { track: opts.track } : {}) },
  });
  const clips = [].concat(placed.json?.clips || []);
  // Stills and video of another size fill the frame instead of sitting small in the middle.
  if (clips.length && !AUDIO_EXT.has(ext) && opts.fit !== false) await callTool(app, "command_run", { id: "clip.fitToFrame", params: { clips } });
  return { imported: ids, clips, placed_at_seconds: at };
}

/** Markdown → the plain paragraphs DesignCraft lays out. */
export function plainText(md) {
  return String(md)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2");
}

/** Where new text goes in PhotoCraft: the padded canvas, but starting below
 *  the text already there, so a second headline doesn't sit on the first.
 *  Back to the top when there's no room left below. */
export function textBox(layers, w, h, pad) {
  const lowest = layers
    .filter((l) => l.kind === "Type" && l.box && !l.hidden)
    .reduce((y, l) => Math.max(y, l.box.y + l.box.h + pad / 2), pad);
  const y = h - pad - lowest >= h / 6 ? Math.round(lowest) : pad;
  return [pad, y, w - 2 * pad, h - pad - y];
}

async function importText(app, text, opts) {
  text = String(text || "");
  if (!text.trim()) throw httpError(400, "text is empty");
  if (app === "designcraft") {
    // Placed as a text file with autoflow, so a chapter-length text gets as
    // many threaded pages as it needs. DesignCraft 0.7 shows Markdown marks
    // literally, so headings and emphasis markers are taken out first.
    const file = join(WS, "in", `${Date.now()}-${String(opts.name || "text").replace(/[^\w.-]+/g, "-").slice(0, 40)}.txt`);
    writeFileSync(file, plainText(text));
    const slot = opts.rect ? { spread: opts.spread ?? 0, rect: opts.rect } : await designTarget(72);
    const r = await mustCall(app, "execute", { command: "file.place", params: { path: file, spread: slot.spread, rect: slot.rect, autoflow: true } }, EXPORT_TIMEOUT_MS);
    return r.json ?? r.text;
  }
  if (app === "photocraft") {
    if (!(await photoDocs())) await mustCall(app, "doc_new", { width: 1600, height: 900, name: "Chapter Craft" });
    const d = (await mustCall(app, "doc_inspect", {})).json || {};
    const w = Number(d.width) || 1600, h = Number(d.height) || 900;
    const pad = Math.round(Math.min(w, h) * 0.06);
    const layers = compactLayers(d);
    if (opts.layer != null && opts.layer !== "") await mustCall(app, "command_run", { id: "layer.select", params: { layer: findLayer(layers, opts.layer) } });
    const box = opts.box || textBox(layers, w, h, pad);
    // Short text reads as a title; long text as body copy that fits the box.
    const size = opts.size || Math.max(8, Math.round(text.length <= 60 ? Math.min(h / 8, (w * 1.6) / Math.max(8, text.length)) : h / 30));
    const r = await mustCall(app, "command_run", { id: "type.create", params: { x: box[0], y: box[1], box, text, size, ...(opts.color ? { color: opts.color } : {}), ...(opts.align ? { align: opts.align } : {}) } });
    return { created: r.json ?? r.text, layers: await photoLayers() };
  }
  await ensureSequence();
  const r = await mustCall(app, "command_run", {
    id: "graphics.newText",
    params: { text, seconds: Number(opts.seconds) || 5, ...(opts.at_seconds != null ? { time: Math.round(Number(opts.at_seconds) * TICKS) } : {}), ...(opts.size ? { size: opts.size } : {}) },
  });
  return r.json ?? r.text;
}

// --- moving things out -----------------------------------------------------------

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".psd": "image/vnd.adobe.photoshop", ".pdf": "application/pdf",
  ".epub": "application/epub+zip", ".html": "text/html", ".txt": "text/plain", ".rtf": "application/rtf",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".srt": "text/plain",
  ".idml": "application/vnd.adobe.indesign-idml-package", ".svg": "image/svg+xml",
};
export const EXPORT_FORMATS = {
  photocraft: ["png", "jpg", "webp", "tif", "psd", "pcraft"],
  designcraft: ["png", "jpg", "pdf", "epub", "html", "txt", "idml", "designcraft"],
  filmcraft: ["png", "mp4", "gif", "wav", "srt"],
};

async function exportDoc(app, format, opts = {}) {
  const fmt = String(format || "png").toLowerCase().replace(/^\./, "");
  if (!EXPORT_FORMATS[app].includes(fmt)) throw httpError(400, `${APPS[app].label} exports: ${EXPORT_FORMATS[app].join(", ")}`);
  const name = `${(opts.name || app).replace(/[^\w.-]+/g, "-").slice(0, 60)}-${Date.now()}.${fmt === "designcraft" ? "designcraft" : fmt}`;
  const path = join(WS, "out", name);
  if (app === "photocraft") {
    await mustCall(app, "doc_export", { path, format: fmt });
  } else if (app === "designcraft") {
    if (fmt === "png" || fmt === "jpg") await mustCall(app, "export_png", { page: Number(opts.page) || 0, path, scale: Number(opts.scale) || 2 });
    else if (fmt === "designcraft") await mustCall(app, "save_document", { path });
    else {
      const cmd = { pdf: "file.exportPdf", epub: "file.exportEpub", html: "file.exportHtml", txt: "file.exportText", idml: "file.exportIdml" }[fmt];
      await mustCall(app, "execute", { command: cmd, params: { path, ...(opts.title ? { title: opts.title } : {}) } }, EXPORT_TIMEOUT_MS);
    }
  } else if (fmt === "png") {
    const r = await mustCall(app, "render_frame", { max_side: 1920, ...(opts.seconds != null ? { seconds: Number(opts.seconds) } : {}) });
    if (!r.images[0]) throw httpError(422, "FilmCraft returned no frame");
    writeFileSync(path, Buffer.from(r.images[0].base64, "base64"));
  } else if (fmt === "srt") {
    await mustCall(app, "command_run", { id: "captions.export", params: { path } });
  } else {
    const format = fmt === "mp4" ? "h264" : fmt;
    await mustCall(app, "command_run", { id: "file.exportMedia", params: { path, format, wait: true } }, EXPORT_TIMEOUT_MS);
  }
  if (!existsSync(path)) throw httpError(422, `${APPS[app].label} reported success but wrote no file`);
  return fileInfo(path);
}

function fileInfo(path) {
  const ext = extname(path).toLowerCase();
  const info = { path, name: basename(path), mime: MIME[ext] || "application/octet-stream", bytes: statSync(path).size };
  if ((ext === ".txt" || ext === ".srt" || ext === ".html") && info.bytes <= 200_000) info.text = readFileSync(path, "utf8");
  return info;
}

async function transfer(from, to, opts = {}) {
  if (!APPS[from] || !APPS[to]) throw httpError(400, `Apps: ${Object.keys(APPS).join(", ")}`);
  const format = opts.format || (to === "filmcraft" || to === "photocraft" || to === "designcraft" ? "png" : "png");
  const file = await exportDoc(from, format, opts);
  const placed = await importFile(to, file.path, opts);
  return { exported: file, imported: placed };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function body(req, limit = 512 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, "too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

const ROUTES = {
  "GET /status": () => status(),
  "POST /tools": (b) => listTools(b.app),
  "POST /call": (b) => callTool(b.app, String(b.tool || ""), b.arguments || {}, b.timeout_s ? Number(b.timeout_s) * 1000 : undefined)
    .then((r) => ({ ok: !r.isError, result: r.json ?? r.text, images: r.images.map((im) => { const path = join(WS, "out", `${b.app}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`); writeFileSync(path, Buffer.from(im.base64, "base64")); return { path, mime: im.mime }; }) })),
  "POST /commands": (b) => commands(b.app, b.query, b.limit),
  "POST /run": (b) => run(b.app, b.steps, b.stop_on_error !== false, b),
  "POST /inspect": (b) => inspect(b.app),
  "POST /preview": (b) => preview(b.app, b),
  "POST /open": (b) => openApp(b.app, b.path, b),
  "POST /import": (b) => (b.text != null ? importText(b.app, b.text, b) : importFile(b.app, b.path, b)),
  "POST /export": (b) => exportDoc(b.app, b.format, b),
  "POST /transfer": (b) => transfer(b.from, b.to, b),
};

const server = createServer(async (req, res) => {
  const send = (status, obj, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(type === "application/json" ? JSON.stringify(obj) : obj);
  };
  try {
    const origin = req.headers.origin;
    if (req.headers["x-chapter-craft"] !== "1" || (origin && !ALLOWED_ORIGINS.has(origin))) return send(403, { error: "forbidden" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/files" && req.method === "POST") {
      const name = basename(String(url.searchParams.get("name") || "file")).replace(/[^\w.-]+/g, "-").slice(-80) || "file";
      const path = join(WS, "in", `${Date.now()}-${name}`);
      writeFileSync(path, await body(req));
      return send(200, fileInfo(path));
    }
    if (url.pathname === "/files" && req.method === "GET") {
      const path = inWorkspace(url.searchParams.get("path"));
      return send(200, await readFile(path), MIME[extname(path).toLowerCase()] || "application/octet-stream");
    }
    const route = ROUTES[`${req.method} ${url.pathname}`];
    if (!route) return send(404, { error: "not found" });
    const raw = req.method === "POST" ? await body(req, 4 * 1024 * 1024) : null;
    let b = {};
    if (raw && raw.length) { try { b = JSON.parse(raw.toString("utf8")); } catch { return send(400, { error: "body must be JSON" }); } }
    send(200, await route(b));
  } catch (e) {
    if (!e.status) log("error", e.stack || e.message);
    send(e.status || 500, { error: e.message });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(join(WS, "in"), { recursive: true });
  mkdirSync(join(WS, "out"), { recursive: true });
  mkdirSync(STATE, { recursive: true });
  chmodSync(STATE, 0o700);
  server.listen(PORT, "127.0.0.1", () => log(`craft bridge on 127.0.0.1:${PORT}, workspace ${WS}`));
  const stop = () => { for (const s of Object.values(sessions)) s.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
