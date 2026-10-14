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
import { DESIGN_FAMILIES, FONT_DIR, LOOK_NAMES, TEMPLATE_PREFIX, autoLook, imagePalette, isDecoName, layoutLook, lookOf } from "./design-looks.mjs";
import { deleteTemplate, describeTemplate, designcraftJson, findTemplate, guessSlots, listTemplates, slugify, writeTemplate } from "./design-templates.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SERVICES = JSON.parse(readFileSync(join(ROOT, "local-services.json"), "utf8"));
const PORT = Number(process.env.CC_CRAFTS_PORT || new URL(SERVICES.crafts).port);
const CC_HOME = process.env.CC_HOME || join(homedir(), ".local/share/chapter-craft-local");
const CRAFTS = join(CC_HOME, "crafts");
const WS = join(CRAFTS, "workspace");
const STATE = join(CRAFTS, ".state");
/** Saved page templates (design-templates.mjs), inside the workspace so their
 *  screenshots can be served like any other workspace file. */
const TEMPLATES = process.env.CC_TEMPLATES_DIR || join(WS, "templates");
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
  let recoloured;
  if (app === "designcraft") {
    // "Make the headline red" reaches for object.color, which paints the
    // frame's box (all five eval runs did). On a text frame the user means
    // the letters; a box behind the text is object.fill.
    const doc = norm.some((st) => st.id === "object.color" && (st.params.target ?? "fill") === "fill") ? await designDoc() : null;
    if (doc) {
      const textIds = new Set((doc.spreads || []).flatMap((sp) => sp.items || []).filter((it) => it.story != null).map((it) => it.id));
      const selected = doc.selection?.items || [];
      norm = norm.flatMap((st) => {
        if (st.id !== "object.color" || (st.params.target ?? "fill") !== "fill") return [st];
        const ids = Array.isArray(st.params.ids) ? st.params.ids : selected;
        if (!ids.length || !ids.every((id) => textIds.has(id))) return [st];
        (recoloured ||= []).push(...ids);
        return [
          { id: "selection.set", params: { ids } },
          { id: "swatch.create", params: { color: st.params.color } },
          { id: "type.char", params: { attrs: { fill: "$last.name" } } },
        ];
      });
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
    ...(recoloured ? { coloured_text_of: recoloured, note: "Coloured the text itself, not its box. For a coloured box behind the text use object.fill. Next time: send with the part's role and options.color." } : {}),
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
  // Test bridges (CC_CRAFTS_HEADLESS=1) never put a window on the user's screen.
  if (process.env.CC_CRAFTS_HEADLESS === "1" && !(await portOpen(a.control))) {
    const placed = path ? await importFile(app, path, opts) : null;
    return { launched: false, window_open: false, headless: true, ...(placed ? { imported: placed } : {}) };
  }
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

// --- DesignCraft pages by role (flyers, posters, covers) ---------------------------
//
// "Place the image and put a headline at the top" is one ask, but in commands
// it is: make a frame, size the type, move the picture down, refit it, check
// nothing is cut off. A model doing that by coordinates took most of a reply
// and got it wrong. So the page is a set of named parts — Headline, Subhead,
// Image, Body, Caption, Footer — and the model only says what goes in which.
// A page look (design-looks.mjs: bold, cinematic, editorial, …) then lays
// them out the way a designer would: fonts, type scale, palette from the
// picture, background, fades and rules — measured and checked here.

export const DESIGN_ROLES = ["headline", "subhead", "image", "body", "caption", "footer"];
const ONE_PER_PAGE = new Set(["headline", "subhead", "caption", "footer"]);
const roleName = (r) => r[0].toUpperCase() + r.slice(1);
/** What the user set by hand on a part ("make the headline red") rides in
 *  its name after the role — "Headline · color #E63946 · size 60" — so it
 *  survives saving, reopening and every later layout. */
const OVERRIDE_KEYS = ["color", "size", "font", "align"];
/** "· template" marks a part of a page started from a template that still
 *  holds the template's own words or picture. */
export function partName(role, over = {}, placeholder = false) {
  const extra = OVERRIDE_KEYS.filter((k) => over[k] != null && over[k] !== "").map((k) => `${k} ${over[k]}`);
  return [roleName(role), ...extra, ...(placeholder ? ["template"] : [])].join(" · ");
}
export function parsePartName(name) {
  const [head, ...rest] = String(name || "").split(" · ");
  const over = {};
  for (const r of rest) { const i = r.indexOf(" "); if (i > 0 && OVERRIDE_KEYS.includes(r.slice(0, i))) over[r.slice(0, i)] = r.slice(i + 1); }
  if (over.size != null) over.size = Number(over.size) || undefined;
  return { role: head.toLowerCase().replace(/\s*\d+$/, ""), over, placeholder: rest.includes("template") };
}

/** Page `index` of the document → its bounds, content box and the parts on
 *  it (centre inside the page), each with a role: its name when it is one of
 *  ours, otherwise what it looks like (a picture → image, text → body). What
 *  a page look drew (background, fades, rules) isn't a part. */
export function designPage(doc, index) {
  const pages = [];
  (doc?.spreads || []).forEach((sp, si) => (sp.pages || []).forEach((p) => pages.push({ ...p, spread: si, items: sp.items || [] })));
  if (!pages.length) return null;
  const i = index == null || index === "" ? pages.length - 1 : Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
  const p = pages[i];
  const [x0, y0, x1, y1] = p.bounds || [0, 0, 612, 792];
  const m = p.margins || {};
  const left = x0 + (p.side === "left" ? m.outside ?? 36 : m.inside ?? 36);
  const right = x1 - (p.side === "left" ? m.inside ?? 36 : m.outside ?? 36);
  const content = { left, right, top: y0 + (m.top ?? 36), bottom: y1 - (m.bottom ?? 36) };
  const onPage = (it) => { const cx = (it.bounds[0] + it.bounds[2]) / 2, cy = (it.bounds[1] + it.bounds[3]) / 2; return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1; };
  const all = p.items.filter((it) => Array.isArray(it.bounds) && onPage(it));
  const items = all
    .filter((it) => !it.hidden && !it.locked && !isDecoName(it.name))
    .map((it) => {
      const { role: named, over, placeholder } = parsePartName(it.name);
      const isText = /text/.test(String(it.kind)) || it.story != null;
      const isImage = /image|graphic/.test(String(it.kind)) || it.asset != null;
      if (!isText && !isImage) return null;
      const ours = DESIGN_ROLES.includes(named);
      return { id: it.id, story: it.story, kind: isText ? "text" : "image", role: ours ? named : isText ? "body" : "image", named: ours, over, placeholder, bounds: it.bounds };
    })
    .filter(Boolean)
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
  const marker = all.find((it) => String(it.name || "").startsWith(TEMPLATE_PREFIX));
  return { index: i, spread: p.spread, bounds: [x0, y0, x1, y1], content, items, look: lookOf(all), template: marker ? String(marker.name).slice(TEMPLATE_PREFIX.length).trim() : null, others: all.filter((it) => !isDecoName(it.name)) };
}

/** A role for text sent without one: short text heads the page (headline,
 *  then subhead), anything longer is body. */
export function autoRole(items, text) {
  const n = String(text || "").length;
  const has = (r) => items.some((it) => it.role === r);
  if (n && n <= 80 && !/\n/.test(String(text))) return !has("headline") ? "headline" : !has("subhead") ? "subhead" : "body";
  return "body";
}

/** A look by name, or a word close to one ("cinema", "movie poster",
 *  "magazine") — small models paraphrase. */
export function pickLook(v) {
  const s = String(v || "").toLowerCase();
  if (!s) return null;
  if (LOOK_NAMES.includes(s)) return s;
  const words = { cinematic: /cinem|movie|film|cover|dramatic|epic|moody/, editorial: /editor|magazine|article|newsletter|journal/, swiss: /swiss|grid|modern|corporate|business|helvetica/, classic: /classic|elegant|literary|invitation|vintage|wedding|formal/, minimal: /minimal|clean|simple|calm|premium|quiet/, split: /split|half|two/, pop: /pop|fun|bright|playful|kids|colorful|colourful|vibrant/, bold: /bold|loud|strong|event|impact|flyer/ };
  for (const [k, re] of Object.entries(words)) if (re.test(s)) return k;
  return null;
}

/** The installed design-font family a name means ("Montserrat SemiBold" →
 *  Montserrat), or null. */
export function installedFamily(name, dir = FONT_DIR) {
  let files = [];
  try { files = readdirSync(dir); } catch { return null; }
  const key = String(name || "").replace(/\s+/g, "").toLowerCase();
  const hit = [...DESIGN_FAMILIES].sort((a, b) => b.length - a.length).find((f) => key.startsWith(f.replace(/ /g, "").toLowerCase()));
  return hit && files.some((f) => f.startsWith(`${hit.replace(/ /g, "")}-`)) ? hit : null;
}

const dc = (command, params = {}) => mustCall("designcraft", "execute", { command, params });
const dcJson = async (tool, args) => (await mustCall("designcraft", tool, args)).json;

/** Where each picture's eye goes (sharp's attention), as a DesignCraft
 *  reference point 0..8, so a crop keeps the face rather than the middle. */
const focusCache = new Map();
async function imageFocus(path) {
  if (!path) return 4;
  if (focusCache.has(path)) return focusCache.get(path);
  let ref = 4;
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(path).metadata();
    const { info } = await sharp(path).resize(64, 64, { fit: "cover", position: sharp.strategy.attention }).toBuffer({ resolveWithObject: true });
    const fx = info.attentionX / meta.width, fy = info.attentionY / meta.height;
    ref = (fy < 0.36 ? 0 : fy > 0.64 ? 6 : 3) + (fx < 0.36 ? 0 : fx > 0.64 ? 2 : 1);
  } catch { /* no sharp, or a file it can't read: centre */ }
  focusCache.set(path, ref);
  return ref;
}

/** Lay page `index` out in `look` (or the look it already has, or one picked
 *  for its content). Returns the plan's issues. */
async function layoutPage(index, lookArg) {
  const doc = await designDoc();
  const page = designPage(doc, index);
  if (!page?.items.length) return { look: null, issues: [] };
  // A page from a template keeps the template's design unless a look is asked for.
  if (page.template && !pickLook(lookArg)) return fitTemplate(page);
  const links = (await callTool("designcraft", "execute", { command: "links.list", params: {} })).json || [];
  const linkOf = (id) => (Array.isArray(links) ? links : []).find((l) => (l.uses || []).some((u) => u.id === id));
  const parts = [];
  for (const it of page.items) {
    if (it.kind === "image") {
      const l = linkOf(it.id);
      const [x0, y0, x1, y1] = it.bounds;
      const aspect = l?.pixels?.[0] && l?.pixels?.[1] ? l.pixels[0] / l.pixels[1] : (x1 - x0) / Math.max(1, y1 - y0);
      parts.push({ id: it.id, role: "image", kind: "image", aspect, path: l?.path, over: it.over });
    } else {
      const text = String((await dcJson("get_story", { frame: it.id }))?.text || "").trim();
      if (text) parts.push({ id: it.id, role: it.role, kind: "text", text, over: it.over });
    }
  }
  const look = pickLook(lookArg) || page.look || autoLook(parts);
  const hero = parts.find((p) => p.kind === "image");
  const pal = await imagePalette(hero?.path);
  const [x0, y0, x1, y1] = page.bounds;
  const call = async (tool, args) => (await mustCall("designcraft", tool, args)).json;
  const { plan, issues } = await layoutLook(call, look, { x: x0, y: y0, W: x1 - x0, H: y1 - y0 }, parts, pal);
  // Crops keep what the eye goes to.
  const steps = [];
  for (const f of plan.frames.filter((g) => g.image?.fill)) {
    const ref = await imageFocus(parts.find((p) => p.id === f.id)?.path);
    if (ref !== 4) steps.push({ command: "object.fittingOptions", params: { fitting: "fillProportionally", align: ref, ids: [f.id] } }, { command: "object.fit", params: { mode: "fillProportionally", ids: [f.id] } });
  }
  if (steps.length) await mustCall("designcraft", "batch", { commands: steps });
  return { look, issues, palette: { background: plan.bg, accent: pal.accent } };
}

/** Put a part on a DesignCraft page by role and lay the page out again. */
async function composeDesign(opts) {
  let doc = await designDoc();
  if (!doc) { await mustCall("designcraft", "new_document", { preset: opts.preset || "Letter", facingPages: false }); doc = await designDoc(); }
  let page = designPage(doc, opts.page);
  if (!page) throw httpError(422, "DesignCraft has no page to put it on");
  const W = page.content.right - page.content.left;
  const text = opts.text != null && String(opts.text).trim() ? plainText(String(opts.text)).trim() : null;
  const over = Object.fromEntries(OVERRIDE_KEYS.filter((k) => opts[k] != null && opts[k] !== "").map((k) => [k, opts[k]]));
  // "28pt" → 28; "bigger", "+20%" stay words until there's a size to scale.
  if (over.size != null && /^\s*\d+(\.\d+)?\s*(pt|px)?\s*$/i.test(String(over.size))) over.size = parseFloat(over.size);
  if (over.color && /^[0-9a-f]{6}$/i.test(over.color)) over.color = `#${over.color}`;
  if (over.color) over.color = String(over.color).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(String(over.color || "#000000"))) delete over.color;
  if (over.size != null && !(Number(over.size) > 0) && !/^(bigger|larger|big|large|up|smaller|small|down|[+-]?\d+(\.\d+)?%?)$/i.test(String(over.size).trim())) delete over.size;
  // A font that isn't installed would fall back to whatever DesignCraft
  // substitutes ("Impact", "Arial" — what models reach for): keep the look's.
  let fontNote = null;
  if (over.font) { const f = installedFamily(over.font); if (f) over.font = f; else { fontNote = `"${over.font}" isn't installed, so the look's fonts stay.`; delete over.font; } }
  // The items the user selected (or ids the model names): act on those.
  // Without a role, text, picture or look, a style change means the selection.
  if ((Array.isArray(opts.ids) && opts.ids.length) || (opts.selection === true) || (!opts.role && !text && !opts.path && !pickLook(opts.look) && Object.keys(over).length)) {
    return editSelection(opts, over);
  }
  // A style for one part while the user has several selected ("make these
  // red", sent as role headline): it goes on all of them.
  if (opts.role && !text && !opts.path && Object.keys(over).length) {
    const sel = await designSelection();
    if (sel.items.length > 1 && sel.items.some((i) => i.role === opts.role)) return editSelection({ ...opts, ids: sel.items.map((i) => i.id) }, over);
  }
  // Words with no part named while one text frame is selected: they replace
  // that frame's words ("change this to …").
  if (!opts.role && text && !opts.path) {
    const sel = await designSelection();
    const texts = sel.items.filter((i) => i.kind === "text");
    if (texts.length === 1 && sel.items.length === 1) return editSelection({ ...opts, ids: [texts[0].id] }, over);
  }
  // Just a look ("make it look like a movie poster"): lay the page out again.
  // Also with a role that isn't a part to restyle ("page", "image" with no picture).
  const restylesPart = DESIGN_ROLES.includes(String(opts.role)) && opts.role !== "image" && Object.keys(over).length > 0;
  if (!text && !opts.path && pickLook(opts.look) && !restylesPart) {
    const lay = await layoutPage(page.index, opts.look);
    return designSummary(page.index, lay, opts, `Restyled the page: ${lay.look}.`);
  }
  const role = DESIGN_ROLES.includes(String(opts.role)) ? String(opts.role) : opts.path ? "image" : autoRole(page.items, text);
  const tpl = page.template && !pickLook(opts.look);
  // On a template page, new words go into the template's frame for that part
  // (the first one still holding the template's text), and a picture into its
  // first picture frame still holding the template's picture (else the main one).
  let target = role === "image" ? null
    : tpl && !opts.add ? page.items.find((it) => it.role === role && it.placeholder) || page.items.find((it) => it.role === role)
    : ONE_PER_PAGE.has(role) && !opts.add ? page.items.find((it) => it.role === role) : null;
  let replaced = false;
  if (role === "image") {
    if (!opts.path) throw httpError(400, "image needs a picture");
    const imgs = page.items.filter((it) => it.kind === "image");
    // The same picture sent again ("add a border to the image" came with its
    // image_id) is that picture, not a second copy of it.
    const links = !opts.add && !tpl && !opts.replace ? (await callTool("designcraft", "execute", { command: "links.list", params: {} })).json || [] : [];
    const same = (Array.isArray(links) ? links : []).find((l) => samePicture(l.path, opts.path) && (l.uses || []).some((u) => imgs.some((i) => i.id === u.id)));
    if (same) {
      const lay = await layoutPage(page.index, opts.look);
      return designSummary(page.index, lay, opts, "That picture is already on the page (nothing added).");
    }
    const into = tpl && !opts.add ? imgs.find((it) => it.placeholder) || [...imgs].sort((a, b) => area(b.bounds) - area(a.bounds))[0] : opts.replace ? imgs[0] : null;
    await dc("selection.set", { ids: [] });
    const r = await mustCall("designcraft", "place_image", into ? { path: opts.path, frame: into.id } : { path: opts.path, spread: page.spread, x: page.content.left, y: page.content.top, width: W });
    const id = into?.id ?? r.json?.id;
    if (id == null) throw httpError(422, `DesignCraft placed the picture but didn't say where: ${r.text}`);
    if (!into || into.placeholder) await dc("object.rename", { id, name: partName("image", into?.over || {}) });
    replaced = !!into;
  } else {
    // No text with a part that's there: restyle it ("make the headline red").
    if (!text && !target) throw httpError(400, `text is empty${ONE_PER_PAGE.has(role) ? ` and the page has no ${role} to change` : ""}`);
    if (target) {
      if (text) await mustCall("designcraft", "set_story_text", { frame: target.id, text });
      replaced = true;
    } else {
      const r = await dc("frame.create", { spread: page.spread, rect: [page.content.left, page.content.top, page.content.right, page.content.top + 40], content: "text", text });
      target = { id: r.json?.id, over: {} };
    }
    const keep = target.over || {};
    if (over.size != null && !(Number(over.size) > 0)) {
      await dc("selection.set", { ids: [target.id] });
      const z = resolveSize(over.size, Number((await dc("type.selectionAttrs", {})).json?.chars?.size) || null);
      if (z) over.size = z; else delete over.size;
    }
    await dc("object.rename", { id: target.id, name: partName(role, { ...keep, ...over }, !text && !!target.placeholder) });
  }
  if (opts.layout === false) return designSummary(page.index, { issues: [] }, opts);
  const lay = await layoutPage(page.index, opts.look);
  return designSummary(page.index, lay, opts, [replaced ? `Changed the ${role}.` : null, fontNote].filter(Boolean).join(" ") || null);
}

/** One page edit at a time: two composes interleaving would each lay out a
 *  page the other is still changing. */
let composeLock = Promise.resolve();
function serialCompose(b) {
  if (b.app && b.app !== "designcraft") throw httpError(400, "compose is for DesignCraft pages");
  const run = composeLock.then(() => (b._do ? b._do(b) : composeDesign(b)));
  composeLock = run.catch(() => {});
  return run;
}

const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const LOOK_USES = "bold: event flyer; cinematic: book cover, movie poster; editorial: magazine; swiss: modern; classic: elegant; minimal: calm; split: announcement; pop: fun";

/** What the user has selected in the DesignCraft window — items they
 *  clicked or shift-clicked, or text they highlighted inside a frame — so the
 *  chat can tell the model where to act. Only the open window counts: this
 *  never starts a headless session, and an empty answer means "nothing
 *  selected" or "no window". */
async function designSelection() {
  // Test bridges (CC_CRAFTS_HEADLESS=1) read their headless document's selection.
  const windowOpen = installed("designcraft") && (await portOpen(APPS.designcraft.control));
  if (!windowOpen && process.env.CC_CRAFTS_HEADLESS !== "1") return { window_open: false, items: [] };
  const doc = await designDoc().catch(() => null);
  if (!doc) return { window_open: windowOpen, items: [] };
  const sel = doc.selection || {};
  const all = (doc.spreads || []).flatMap((sp) => sp.items || []);
  let ids = (sel.items || []).slice(0, 24);
  let range = null;
  if (sel.text?.story != null) {
    const st = await dcJson("get_story", { story: sel.text.story }).catch(() => null);
    const frame = st?.frames?.[0];
    if (frame != null && !ids.includes(frame)) ids = [frame, ...ids];
    const [a, b] = [sel.text.anchor, sel.text.focus].sort((x, y) => x - y);
    if (st?.text && b > a) range = { frame, story: sel.text.story, start: a, end: b, text: Buffer.from(st.text).subarray(a, b).toString("utf8") };
  }
  const items = [];
  for (const id of ids) {
    const it = all.find((x) => x.id === id);
    if (!it) continue;
    const isText = it.story != null || /text/.test(String(it.kind));
    const isImage = !isText && (it.asset != null || /image|graphic/.test(String(it.kind)));
    const { role, over } = parsePartName(it.name);
    const row = { id, kind: isText ? "text" : isImage ? "image" : "shape", ...(DESIGN_ROLES.includes(role) ? { role } : {}), ...(it.name && !DESIGN_ROLES.includes(role) ? { name: String(it.name) } : {}), ...(Object.keys(over).length ? { set_by_hand: over } : {}) };
    if (isText) row.text = String((await dcJson("get_story", { frame: id }).catch(() => null))?.text || "").slice(0, 120);
    items.push(row);
  }
  return { window_open: windowOpen, document: doc.title || null, items, ...(range ? { text_range: range } : {}) };
}

/** Two workspace copies of one library picture ("<time>-image-ab12cd34.png"). */
export function samePicture(a, b) {
  const key = (p) => basename(String(p || "")).replace(/^\d+-/, "");
  return !!a && !!b && key(a) === key(b);
}

/** "make this bigger", "+20%", "smaller" → a size in points from `current`. */
export function resolveSize(v, current) {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  const n = parseFloat(s);
  if (/^(bigger|larger|big|large|up)$/.test(s)) return current ? Math.round(current * 1.25 * 2) / 2 : null;
  if (/^(smaller|small|down)$/.test(s)) return current ? Math.round(current * 0.8 * 2) / 2 : null;
  if (/%$/.test(s) && Number.isFinite(n)) return current ? Math.round(current * (/^[+-]/.test(s) ? 1 + n / 100 : n / 100) * 2) / 2 : null;
  if (/^[+-]/.test(s) && Number.isFinite(n)) return current ? Math.max(4, current + n) : null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function swatchFor(hex) {
  const name = `CC ${String(hex).toUpperCase()}`;
  const doc = await designDoc();
  if (!(doc.swatches || []).some((sw) => (sw.name || sw) === name)) await dc("swatch.create", { color: hex, name });
  return name;
}

/** Act on what the user selected (or on `ids` the model names): new words
 *  into a selected text frame, a picture into a selected picture frame, a
 *  colour, size, font or alignment onto each. On a page part the change is
 *  kept in its name, so later layouts keep it; highlighted text inside a
 *  frame gets the change on just those words. */
async function editSelection(opts, over) {
  const sel = Array.isArray(opts.ids) && opts.ids.length ? null : await designSelection();
  const ids = Array.isArray(opts.ids) && opts.ids.length ? opts.ids.map(Number).filter(Number.isFinite) : (sel?.items || []).map((i) => i.id);
  if (!ids.length) throw httpError(400, "Nothing is selected in DesignCraft. Name the part (role) instead, or ask the user to click the item first.");
  const doc = await designDoc();
  const all = (doc.spreads || []).flatMap((sp) => sp.items || []);
  const acted = [], notes = [];
  let relayout = false, pageIndex = null;
  const text = opts.text != null && String(opts.text).trim() ? plainText(String(opts.text)).trim() : null;
  // Highlighted words only, when that's what is selected and only a style is asked for.
  if (sel?.text_range && !text && !opts.path && Object.keys(over).length) {
    const r = sel.text_range;
    await dc("text.select", { story: r.story, anchor: r.start, focus: r.end });
    const cur = Number((await dc("type.selectionAttrs", {})).json?.chars?.size) || null;
    const attrs = {};
    if (over.color) attrs.fill = await swatchFor(over.color);
    if (over.size != null) { const z = resolveSize(over.size, cur); if (z) attrs.size = z; }
    if (over.font) attrs.fontFamily = over.font;
    if (Object.keys(attrs).length) await dc("type.char", { attrs });
    if (over.align) await dc("type.para", { attrs: { align: over.align } });
    await dc("text.exitToFrame", {}).catch(() => {});
    acted.push({ id: r.frame, words: r.text, changed: Object.keys(over) });
    notes.push("Changed just the highlighted words. A later restyle of the whole page (a look) sets them back.");
  } else {
    for (const id of ids) {
      const it = all.find((x) => x.id === id);
      if (!it) { notes.push(`No item ${id} on the page.`); continue; }
      const isText = it.story != null || /text/.test(String(it.kind));
      const isImage = !isText && (it.asset != null || /image|graphic/.test(String(it.kind)));
      const { role, over: keep, placeholder } = parsePartName(it.name);
      const part = DESIGN_ROLES.includes(role);
      const changed = [];
      if (isText) {
        if (text && ids.length === 1) { await mustCall("designcraft", "set_story_text", { frame: id, text }); changed.push("text"); }
        await dc("selection.set", { ids: [id] });
        const cur = Number((await dc("type.selectionAttrs", {})).json?.chars?.size) || null;
        const o = { ...over };
        if (o.size != null) { const z = resolveSize(o.size, cur); if (z) o.size = z; else delete o.size; }
        if (part) {
          // Kept in the name; the layout applies it (and keeps it next time).
          await dc("object.rename", { id, name: partName(role, { ...keep, ...o }, placeholder && !text) });
          relayout = true;
        } else {
          const attrs = {};
          if (o.color) attrs.fill = await swatchFor(o.color);
          if (o.size) attrs.size = o.size;
          if (o.font) attrs.fontFamily = o.font;
          if (Object.keys(attrs).length) await dc("type.char", { attrs });
          if (o.align) await dc("type.para", { attrs: { align: o.align } });
        }
        changed.push(...Object.keys(o));
      } else if (isImage || opts.path) {
        if (opts.path) {
          await mustCall("designcraft", "place_image", { path: opts.path, frame: id });
          await dc("object.fit", { mode: "fillProportionally", ids: [id] });
          if (part && placeholder) await dc("object.rename", { id, name: partName("image", keep) });
          changed.push("picture");
        }
        if (over.color) { await dc("object.fill", { swatch: await swatchFor(over.color), ids: [id] }); changed.push("background colour"); }
      } else if (over.color) {
        await dc("object.fill", { swatch: await swatchFor(over.color), ids: [id] });
        changed.push("colour");
      }
      if (!changed.length) notes.push(`Nothing to change on item ${id} with what was sent${isText ? "" : " (it isn't text)"}.`);
      acted.push({ id, ...(part ? { role } : {}), changed });
      if (pageIndex == null) {
        const pages = (doc.spreads || []).flatMap((sp) => sp.pages || []);
        const cx = (it.bounds[0] + it.bounds[2]) / 2, cy = (it.bounds[1] + it.bounds[3]) / 2;
        const pi = pages.findIndex((p) => p.bounds && cx >= p.bounds[0] && cx <= p.bounds[2] && cy >= p.bounds[1] && cy <= p.bounds[3]);
        if (pi >= 0) pageIndex = pi;
      }
    }
  }
  await dc("selection.set", { ids: [] }).catch(() => {});
  const lay = relayout ? await layoutPage(pageIndex ?? opts.page, opts.look) : { issues: [] };
  const sum = await designSummary(pageIndex ?? opts.page, lay, opts, notes.join(" ") || null);
  return { ...sum, acted_on: acted };
}
const templateRow = (t) => ({ name: t.name, slug: t.slug, about: describeTemplate(t), width: t.width, height: t.height, parts: t.slots.map((x) => x.role), created: t.created, thumb: join(TEMPLATES, t.slug, "thumb.png") });

/** Save page `page` (default: the last) of the open document as a template:
 *  DesignCraft's own file with the pictures in it, a screenshot of the page,
 *  and which frame is which part. Same name again replaces it. */
async function saveTemplate(opts) {
  const name = String(opts.name || "").trim().slice(0, 80);
  if (!name) throw httpError(400, "Give the template a name (title).");
  const doc = await designDoc();
  if (!doc) throw httpError(422, "DesignCraft has no document open to save as a template.");
  const page = designPage(doc, opts.page);
  if (!page?.items.length && !page?.others.length) throw httpError(422, "That page is empty — design something first.");
  const ser = (await dc("file.serialize", {})).json;
  const buf = Buffer.from(String(ser?.base64 || ""), "base64");
  const docJson = designcraftJson(buf);
  const slots = guessSlots(page.items, page, docJson);
  const slug = slugify(name);
  const existed = !!findTemplate(TEMPLATES, slug) && findTemplate(TEMPLATES, slug).slug === slug;
  mkdirSync(join(TEMPLATES, slug), { recursive: true });
  const thumbPath = join(TEMPLATES, slug, "thumb.png");
  await mustCall("designcraft", "render_page", { page: page.index, path: thumbPath });
  const [x0, y0, x1, y1] = page.bounds;
  const manifest = { name, slug, created: new Date().toISOString(), page: page.index, width: x1 - x0, height: y1 - y0, look: page.look, from: doc.title || null, slots };
  writeTemplate(TEMPLATES, manifest, buf, null);
  return { saved: name, replaced: existed, ...templateRow(manifest) };
}

/** Start a new document from a template: its file opens as a new document
 *  (in the window, a new tab), other pages go, the parts are named by role
 *  and marked as still holding the template's content, and everything else
 *  on the page is named as decoration, so a look can replace it later. */
async function useTemplate(opts) {
  const t = findTemplate(TEMPLATES, opts.name);
  if (!t) {
    const all = listTemplates(TEMPLATES);
    throw httpError(404, all.length ? `No template "${opts.name}". Saved templates: ${all.map((x) => x.name).join(", ")}.` : "No templates saved yet. Design a page, then save it as a template.");
  }
  const buf = readFileSync(join(TEMPLATES, t.slug, "template.designcraft"));
  await dc("file.openBytes", { name: `${t.name}.designcraft`, base64: buf.toString("base64") });
  let doc = await designDoc();
  const pages = (doc.spreads || []).flatMap((sp) => sp.pages || []);
  const drop = pages.map((_, i) => i).filter((i) => i !== t.page);
  if (drop.length && pages.length > 1) await dc("layout.pages.delete", { pages: drop });
  doc = await designDoc();
  const page = designPage(doc, 0);
  const steps = [];
  const slotIds = new Set(t.slots.map((x) => x.id));
  for (const sl of t.slots) {
    const it = page.items.find((i) => i.id === sl.id);
    if (it) steps.push({ command: "object.rename", params: { id: sl.id, name: partName(sl.role, it.over, true) } });
  }
  for (const it of page.others) if (!slotIds.has(it.id)) steps.push({ command: "object.rename", params: { id: it.id, name: `Deco tpl ${String(it.name || it.kind || "").replace(/[<>]/g, "").trim()}`.trim() } });
  const [x0, y0] = page.bounds;
  const m = (await dc("frame.create", { rect: [x0, y0, x0 + 1, y0 + 1], content: "unassigned" })).json;
  steps.push(
    { command: "object.rename", params: { id: m.id, name: `${TEMPLATE_PREFIX}${t.slug}` } },
    { command: "object.stroke", params: { swatch: "[None]", ids: [m.id] } },
    { command: "object.setFlags", params: { ids: [m.id], hidden: true } },
    { command: "selection.set", params: { ids: [] } },
  );
  await mustCall("designcraft", "batch", { commands: steps });
  return designSummary(0, { issues: [] }, opts, `A new document from the "${t.name}" template is open.`);
}

/** Lay out a template page: frames stay where the template put them. Text is
 *  set at the size the template designed it at and steps down only when it
 *  wouldn't otherwise fit; pictures fill their frame, cropped toward what the
 *  eye goes to; a part the template has no frame for goes into free room,
 *  set like the template's nearest text. */
async function fitTemplate(page) {
  const t = findTemplate(TEMPLATES, page.template);
  const slots = t?.slots || [];
  const issues = [];
  const links = (await callTool("designcraft", "execute", { command: "links.list", params: {} })).json || [];
  const linkOf = (id) => (Array.isArray(links) ? links : []).find((l) => (l.uses || []).some((u) => u.id === id));
  for (const it of page.items.filter((i) => i.kind === "image")) {
    const ref = await imageFocus(linkOf(it.id)?.path);
    await mustCall("designcraft", "batch", { commands: [
      { command: "object.fittingOptions", params: { fitting: "fillProportionally", align: ref, ids: [it.id] } },
      { command: "object.fit", params: { mode: "fillProportionally", ids: [it.id] } },
    ] });
  }
  for (const it of page.items.filter((i) => i.kind === "text")) {
    const slot = slots.find((x) => x.id === it.id);
    if (!slot) await placeNewPart(page, it, slots);
    const cut = await fitTextSize(it.id, slot?.size, it.over);
    if (cut) issues.push(`${roleName(it.role)} (id ${it.id}) is cut off even at the smallest size: shorten it.`);
  }
  await dc("selection.set", { ids: [] });
  return { template: t?.name || page.template, issues };
}

async function charAttrs(id) {
  await dc("selection.set", { ids: [id] });
  return (await dc("type.selectionAttrs", {})).json || {};
}

/** Text frame `id` at its designed size if that fits, else stepped down
 *  (leading with it) until it does. Returns true when even the smallest step
 *  is cut off. Hand-set colour and font are applied too. */
async function fitTextSize(id, designed, over = {}) {
  const story = async () => (await dcJson("get_story", { frame: id })) || {};
  const a = await charAttrs(id);
  const cur = Number(a.chars?.size) || null;
  const lead = a.chars?.leading?.kind === "points" && cur ? a.chars.leading.value / cur : null;
  const extra = {};
  if (over.color) {
    const name = `CC ${String(over.color).toUpperCase()}`;
    const doc = await designDoc();
    if (!(doc.swatches || []).some((sw) => (sw.name || sw) === name)) await dc("swatch.create", { color: over.color, name });
    extra.fill = name;
  }
  if (over.font) extra.fontFamily = over.font;
  const setSize = async (size) => { await dc("selection.set", { ids: [id] }); await dc("type.char", { attrs: { size, ...(lead ? { leading: { kind: "points", value: Math.round(size * lead * 10) / 10 } } : {}), ...extra } }); };
  const start = Number(over.size) || designed || cur;
  if (!start) return false;
  if (Object.keys(extra).length || (cur && Math.abs(cur - start) > 0.25)) await setSize(start);
  let s = await story();
  let size = start;
  for (let k = 0; s.overset != null && k < 14 && size > Math.max(6, start * 0.4); k++) {
    size = Math.round(size * 0.92 * 2) / 2;
    await setSize(size);
    s = await story();
  }
  return s.overset != null;
}

/** How deep text frame `id` needs to be for its text: the shallowest height
 *  with nothing cut off (the frame is put back as it was). */
async function usedHeight(id, bounds) {
  const [x0, y0, x1, y1] = bounds;
  let lo = 4, hi = y1 - y0;
  const fits = async (h) => { await dc("transform.set", { height: h, ref: 0, ids: [id] }); return ((await dcJson("get_story", { frame: id })) || {}).overset == null; };
  if (!(await fits(hi))) { await dc("transform.set", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, ref: 0, ids: [id] }); return hi; }
  for (let k = 0; k < 9 && hi - lo > 2; k++) { const mid = (lo + hi) / 2; if (await fits(mid)) hi = mid; else lo = mid; }
  await dc("transform.set", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, ref: 0, ids: [id] });
  return Math.ceil(hi);
}

/** A part the template has no frame for (a caption on a page without one):
 *  set like the template's nearest kind of text, in the free band the role
 *  belongs in — a footer at the foot, a headline at the top, anything else
 *  in the biggest gap. */
async function placeNewPart(page, it, slots) {
  const { left, right, top, bottom } = page.content;
  const like = { headline: ["headline", "subhead"], subhead: ["subhead", "headline", "body"], footer: ["footer", "caption", "body"], caption: ["caption", "footer", "body"], body: ["body", "subhead"] }[it.role] || ["body"];
  const ref = like.map((r) => page.items.find((i) => i.kind === "text" && i.id !== it.id && i.role === r)).find(Boolean);
  if (ref) {
    const a = (await charAttrs(ref.id)).chars || {};
    const pick = Object.fromEntries(["fontFamily", "fontStyle", "size", "leading", "tracking", "capitalization", "fill"].filter((k) => a[k] != null).map((k) => [k, a[k]]));
    if (["footer", "caption"].includes(it.role) && ref.role !== it.role && pick.size) pick.size = Math.max(7, Math.round(pick.size * 0.8));
    // Running text borrowed from a label or heading: the family and colour,
    // but plain, readable setting.
    if (it.role === "body" && ref.role !== "body") {
      Object.assign(pick, { capitalization: "normal", tracking: 0, size: Math.max(10, Math.round((right - left) / 46)), leading: { kind: "auto" } });
      if (!/Italic/.test(String(pick.fontStyle))) pick.fontStyle = "Regular";
      const head = page.items.find((i) => i.kind === "text" && i.role === "headline" && i.id !== it.id);
      if (head) { const f = (await charAttrs(head.id)).chars?.fill; if (f) pick.fill = f; }
    }
    await dc("selection.set", { ids: [it.id] });
    await dc("type.char", { attrs: pick });
    if (it.role === "body") await dc("type.para", { attrs: { align: "left", hyphenate: false } });
  }
  // Free vertical bands inside the margins, between the other parts — a text
  // frame counts only as deep as its text goes.
  const taken = [];
  for (const i of page.items.filter((x) => x.id !== it.id)) taken.push([i.bounds[1], i.kind === "text" ? i.bounds[1] + (await usedHeight(i.id, i.bounds)) : i.bounds[3]]);
  taken.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let y = top;
  for (const [a, b] of taken) { if (a > y + 4) gaps.push([y, Math.min(a, bottom)]); y = Math.max(y, b); }
  if (bottom > y + 4) gaps.push([y, bottom]);
  const W = right - left;
  await dc("transform.set", { x: left, y: top, width: W, height: 400, ref: 0, ids: [it.id] });
  const s = (await dcJson("get_story", { frame: it.id })) || {};
  const a = (await charAttrs(it.id)).chars || {};
  const size = Number(a.size) || 12;
  const h = Math.ceil((s.lines || 1) * size * 1.3 + size * 0.4);
  const gap = it.role === "footer" ? gaps.filter((g) => g[1] - g[0] >= h).pop() || gaps[gaps.length - 1]
    : it.role === "headline" ? gaps.find((g) => g[1] - g[0] >= h) || gaps[0]
    : [...gaps].sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
  const [g0, g1] = gap || [bottom - h, bottom];
  const yy = it.role === "footer" ? Math.max(g0, g1 - h) : g0 + Math.min(12, Math.max(0, (g1 - g0 - h) / 2));
  await dc("transform.set", { x: left, y: yy, width: W, height: Math.max(h, Math.min(h, g1 - yy)), ref: 0, ids: [it.id] });
}

/** The page after an edit, compact: its look, what's on it, top first, and
 *  anything cut off, off the page or hard to read — checked here, so the
 *  model needn't look. */
async function designSummary(index, lay, opts, note) {
  const page = designPage(await designDoc(), index);
  const issues = [...(lay.issues || [])];
  const items = [];
  for (const it of page.items) {
    const [x0, y0, x1, y1] = it.bounds;
    const row = { id: it.id, role: it.role, box: { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) } };
    if (it.kind === "text") {
      const s = (await callTool("designcraft", "get_story", { frame: it.id })).json || {};
      row.text = String(s.text || "").slice(0, 80);
      if (s.overset != null && !issues.some((i) => i.startsWith(it.role))) issues.push(`${roleName(it.role)} (id ${it.id}) is cut off: its text doesn't fit.`);
    }
    if (Object.keys(it.over || {}).length) row.set_by_hand = it.over;
    items.push(row);
  }
  if (page.template && !lay.look) {
    const t = findTemplate(TEMPLATES, page.template);
    const placeholders = page.items.filter((it) => it.placeholder).map((it) => ({ role: it.role, id: it.id, ...(it.kind === "text" ? { text: items.find((r) => r.id === it.id)?.text } : { picture: "the template's own" }) }));
    return {
      page: page.index, template: t?.name || page.template, items,
      ...(placeholders.length ? { placeholders } : {}),
      ...(issues.length ? { issues } : {}), ...(note ? { note } : {}),
      looks: `a look (${LOOK_NAMES.join(", ")}) replaces the template's design`,
    };
  }
  return {
    page: page.index, look: lay.look || page.look, items,
    ...(issues.length ? { issues } : {}), ...(note ? { note } : {}),
    // Every look and what it's for, the current one included: listing only
    // the others sent "now try it as a movie poster" on a page that was already
    // cinematic to bold (2 of 4 sessions, 2026-10-14).
    looks: LOOK_USES,
  };
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
    // The format comes from the file name. The open window refuses an explicit
    // `format` ("bridge mode saves with the app's current settings"), which
    // broke every export from the window; headless gets it as a fallback.
    const r = await callTool(app, "doc_export", { path });
    if (r.isError) await mustCall(app, "doc_export", { path, format: fmt });
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
  "POST /compose": (b) => serialCompose(b),
  "POST /template/save": (b) => serialCompose({ ...b, _do: saveTemplate }),
  "POST /template/use": (b) => serialCompose({ ...b, _do: useTemplate }),
  "POST /design/selection": () => designSelection(),
  "POST /template/list": () => ({ templates: listTemplates(TEMPLATES).map(templateRow) }),
  "POST /template/delete": (b) => { const t = findTemplate(TEMPLATES, b.name); if (!t || !deleteTemplate(TEMPLATES, t.slug)) throw httpError(404, `No template "${b.name}".`); return { deleted: t.name }; },
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
    if (url.pathname === "/template/thumb" && req.method === "GET") {
      const t = findTemplate(TEMPLATES, String(url.searchParams.get("slug") || ""));
      const path = t && join(TEMPLATES, t.slug, "thumb.png");
      if (!path || !existsSync(path)) return send(404, { error: "no such template" });
      return send(200, readFileSync(path), "image/png");
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
