#!/usr/bin/env node
// Chapter Craft TTS audio cache.
//
// Read Along asks Inworld for the same passages again and again (re-reading a
// page, jumping back a sentence, a second device). This service keeps every
// clip Inworld produced, per book, so a repeat is served from disk instead of
// being paid for again.
//
//   • Only the app's `inworld-tts` edge function talks to it. Every request is
//     HMAC-signed (same scheme as the program runner): SHA-256 over
//     `${ts}.${method}.${path}.${sha256(body)}.${nonce}`, 60s skew window,
//     in-memory replay-nonce cache.
//   • Storage is plain files: <data_dir>/<bookId>/<key>.mp3 plus <key>.json
//     (Inworld's word timestamps). Writes are atomic (tmp + rename).
//   • `max_total_mb` caps disk use; the least recently played clips go first.
//   • Binds 127.0.0.1 only — put Caddy (TLS) in front.
//
// Zero npm dependencies. Node 20+.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── config ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = process.env.TTS_CACHE_CONFIG || "./tts-cache.config.json";
let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error(`[tts-cache] cannot read config ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}
const KEYS = config.keys && typeof config.keys === "object" ? config.keys : {};
const DATA_DIR = config.data_dir || "/var/lib/chapter-craft-tts-cache";
const HOST = config.host || "127.0.0.1";
const PORT = Number(config.port) || 8760;
const MAX_TOTAL_BYTES = Math.max(64, Number(config.max_total_mb) || 20480) * 1024 * 1024;
const MAX_CLIP_BYTES = Math.max(64, Number(config.max_clip_kb) || 4096) * 1024;
// A clip upload is base64 audio + timestamps JSON: allow for base64's 4/3.
const MAX_BODY_BYTES = Math.ceil(MAX_CLIP_BYTES * 1.4) + 512 * 1024;
const SKEW_SEC = 60;

if (Object.keys(KEYS).length === 0) {
  console.error("[tts-cache] config.keys is empty — no way to authenticate requests.");
  process.exit(1);
}

const BOOK_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[a-f0-9]{64}$/;

// ── HMAC auth ──────────────────────────────────────────────────────────────
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hmacHex = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest("hex");
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
/** Own-property lookup only: `KEYS["__proto__"]` must not pass as a key. */
const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

const nonces = new Map(); // nonce -> expiry (unix sec)
function verify(req, path, rawBody) {
  const keyId = req.headers["x-key-id"];
  const ts = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  const sig = req.headers["x-signature"];
  if (!keyId || !ts || !nonce || !sig) return "missing signature headers";
  const signingKey = own(KEYS, String(keyId));
  if (typeof signingKey !== "string" || !signingKey) return "unknown key id";
  const now = Math.floor(Date.now() / 1000);
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > SKEW_SEC) return "timestamp skew";
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
  if (nonces.has(String(nonce))) return "replay";
  const expected = hmacHex(signingKey, `${ts}.${req.method}.${path}.${sha256Hex(rawBody)}.${nonce}`);
  if (!safeEqual(String(sig), expected)) return "bad signature";
  nonces.set(String(nonce), now + SKEW_SEC + 5);
  return null;
}

// ── storage ────────────────────────────────────────────────────────────────
const bookDir = (book) => join(DATA_DIR, book);
const clipPaths = (book, key) => ({ mp3: join(bookDir(book), `${key}.mp3`), json: join(bookDir(book), `${key}.json`) });

async function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

async function getClip(book, key) {
  const p = clipPaths(book, key);
  let audio, meta;
  try {
    [audio, meta] = await Promise.all([readFile(p.mp3), readFile(p.json, "utf8")]);
  } catch {
    return null;
  }
  // Mark as recently played for eviction (best-effort).
  const now = new Date();
  utimes(p.mp3, now, now).catch(() => {});
  let parsed = {};
  try { parsed = JSON.parse(meta); } catch { /* a torn sidecar: serve audio without timing */ }
  return { audioContent: audio.toString("base64"), timestampInfo: parsed.timestampInfo ?? null };
}

function looksLikeMp3(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0; // MPEG frame sync
}

async function putClip(book, key, body) {
  const audio = Buffer.from(String(body.audioContent || ""), "base64");
  if (!audio.length) throw Object.assign(new Error("audioContent is empty"), { status: 400 });
  if (audio.length > MAX_CLIP_BYTES) throw Object.assign(new Error("clip too large"), { status: 413 });
  if (!looksLikeMp3(audio)) throw Object.assign(new Error("audioContent is not MP3"), { status: 400 });
  const meta = {
    timestampInfo: body.timestampInfo ?? null,
    voiceId: typeof body.voiceId === "string" ? body.voiceId.slice(0, 128) : undefined,
    model: typeof body.model === "string" ? body.model.slice(0, 64) : undefined,
    chars: Number.isFinite(body.chars) ? body.chars : undefined,
    createdAt: new Date().toISOString(),
  };
  const p = clipPaths(book, key);
  await mkdir(bookDir(book), { recursive: true, mode: 0o700 });
  // Sidecar first: a clip is only visible to GET once its .mp3 lands.
  await atomicWrite(p.json, JSON.stringify(meta));
  let previous = 0;
  try { previous = (await stat(p.mp3)).size; } catch { /* new clip */ }
  await atomicWrite(p.mp3, audio);
  totalBytes += audio.length - previous;
  scheduleEviction();
}

async function deleteBook(book) {
  const dir = bookDir(book);
  let clips = 0;
  let bytes = 0;
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".mp3")) continue;
      clips++;
      try { bytes += (await stat(join(dir, f))).size; } catch { /* raced */ }
    }
  } catch {
    return { clips: 0, bytes: 0 };
  }
  // A clip still being saved can land mid-delete (ENOTEMPTY): retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  totalBytes = Math.max(0, totalBytes - bytes);
  return { clips, bytes };
}

async function scan() {
  const clips = [];
  let books = 0;
  let entries = [];
  try { entries = await readdir(DATA_DIR, { withFileTypes: true }); } catch { return { books, clips }; }
  for (const d of entries) {
    if (!d.isDirectory() || !BOOK_RE.test(d.name)) continue;
    books++;
    let files = [];
    try { files = await readdir(join(DATA_DIR, d.name)); } catch { continue; }
    for (const f of files) {
      const full = join(DATA_DIR, d.name, f);
      if (f.endsWith(".tmp")) {
        // Leftover from a crash mid-write.
        unlink(full).catch(() => {});
        continue;
      }
      if (!f.endsWith(".mp3")) continue;
      try {
        const s = await stat(full);
        clips.push({ path: full, size: s.size, mtime: s.mtimeMs });
      } catch { /* raced */ }
    }
  }
  return { books, clips };
}

let totalBytes = 0;
let evicting = false;
let evictTimer = null;
function scheduleEviction() {
  if (totalBytes <= MAX_TOTAL_BYTES || evicting || evictTimer) return;
  evictTimer = setTimeout(() => { evictTimer = null; void evict(); }, 1000);
}
async function evict() {
  evicting = true;
  try {
    const { clips } = await scan();
    totalBytes = clips.reduce((n, c) => n + c.size, 0);
    // Down to 90% so we don't evict on every single write at the limit.
    const target = MAX_TOTAL_BYTES * 0.9;
    clips.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const c of clips) {
      if (totalBytes <= target) break;
      try {
        await unlink(c.path);
        await unlink(c.path.replace(/\.mp3$/, ".json")).catch(() => {});
        totalBytes -= c.size;
        removed++;
      } catch { /* raced */ }
    }
    if (removed) console.log(`[tts-cache] evicted ${removed} least-recently-played clips`);
  } finally {
    evicting = false;
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────
function send(res, status, obj) {
  const body = obj === undefined ? "" : JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

    const raw = await readBody(req);
    const why = verify(req, path, raw);
    if (why) return send(res, 401, { error: why });

    const clip = path.match(/^\/v1\/clips\/([^/]+)\/([^/]+)$/);
    if (clip) {
      const [, book, key] = clip;
      if (!BOOK_RE.test(book) || !KEY_RE.test(key)) return send(res, 400, { error: "bad book id or key" });
      if (req.method === "GET") {
        const found = await getClip(book, key);
        return found ? send(res, 200, found) : send(res, 404, { error: "not cached" });
      }
      if (req.method === "PUT") {
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "invalid JSON" }); }
        await putClip(book, key, body);
        return send(res, 204);
      }
      return send(res, 405, { error: "method not allowed" });
    }

    const bookRoute = path.match(/^\/v1\/books\/([^/]+)$/);
    if (bookRoute && req.method === "DELETE") {
      if (!BOOK_RE.test(bookRoute[1])) return send(res, 400, { error: "bad book id" });
      return send(res, 200, await deleteBook(bookRoute[1]));
    }

    if (path === "/v1/stats" && req.method === "GET") {
      const { books, clips } = await scan();
      totalBytes = clips.reduce((n, c) => n + c.size, 0);
      return send(res, 200, { books, clips: clips.length, bytes: totalBytes, max_bytes: MAX_TOTAL_BYTES });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    const status = e && typeof e.status === "number" ? e.status : 500;
    if (status === 500) console.error("[tts-cache] error:", e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "internal error" : e.message });
  }
});

await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
{
  const { books, clips } = await scan();
  totalBytes = clips.reduce((n, c) => n + c.size, 0);
  console.log(`[tts-cache] ${clips.length} clips in ${books} books, ${(totalBytes / 1048576).toFixed(1)} MB of ${(MAX_TOTAL_BYTES / 1048576).toFixed(0)} MB`);
  scheduleEviction();
}
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.listen(PORT, HOST, () => console.log(`[tts-cache] listening on ${HOST}:${PORT}`));
