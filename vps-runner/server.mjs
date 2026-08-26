// Chapter Craft Program Runner — the service you deploy on your own VPS so the
// in-app AI can execute the programs YOU approve, in a hardened gVisor sandbox.
//
// Zero npm dependencies (Node built-ins only): you need node, docker, and the
// gVisor runtime (runsc). See README.md for the one-time host setup.
//
// SECURITY MODEL (each line closes a finding from the design review):
//   • HMAC request signing with a 60s skew window + a persisted replay-nonce
//     cache, constant-time comparison, and hard rejection of unknown/empty key
//     ids — a captured request cannot be replayed and an empty secret never
//     authenticates.
//   • Every job runs in a fresh container destroyed afterward:
//       --runtime=runsc (gVisor) --cap-drop ALL --security-opt no-new-privileges
//       --read-only --tmpfs /tmp:...,noexec,nosuid,nodev --user 65534:65534
//       --memory/--memory-swap equal (no swap) --cpus --pids-limit --ulimits
//   • VERIFY jobs are forced hermetic: --network none and NO secrets, whatever
//     the caller asked for. An unapproved draft can only ever run offline and
//     secretless.
//   • Default egress is --network none (bulletproof). "allowlist" egress is
//     served ONLY if the operator ran setup-egress.sh AND the startup self-test
//     proved raw sockets to private/metadata ranges are refused; otherwise the
//     runner FAILS CLOSED and serves network:none only.
//   • Declared secret VALUES are injected as env from THIS host's config and
//     REDACTED out of stdout/stderr before anything is returned.
//   • Bounded concurrency + queue; OOM detected from docker inspect, not a
//     guessed exit code; timeouts, egress blocks and sandbox failures are typed.

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile, mkdir, stat, readdir, rename } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

// ── config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = process.env.RUNNER_CONFIG || join(process.cwd(), "runner.config.json");
if (!existsSync(CONFIG_PATH)) {
  console.error(`No config at ${CONFIG_PATH}. Copy runner.config.example.json and fill it in.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const KEYS = config.keys || {};                       // { keyId: signingKey }
const SECRETS = config.secrets || {};                 // { NAME: value }
const SANDBOX_IMAGE = config.sandbox_image || "chapter-craft-sandbox:latest";
const EGRESS_NETWORK = config.egress_network || "ccprog-egress"; // docker network for allowlist jobs
const EGRESS_PROXY_IP = String(config.egress_proxy_ip || "172.31.99.2"); // setup-egress.sh's CCPROG_PROXY_IP
const MAX_TIMEOUT_MS = Number(config.max_timeout_ms) || 60_000;
const CONCURRENCY = Math.max(1, Number(config.concurrency) || 3);
// NOTE: Number(undefined) is NaN, and NaN is not nullish — `Number(x) ?? 10`
// never fell back, making `waiters.length >= NaN` always false (an unbounded
// queue) when the config omitted queue_max. Coalesce BEFORE converting.
const QUEUE_MAX = Math.max(0, Number(config.queue_max ?? 10) || 0);
const PORT = Number(config.port) || 8752;
// ── resource helpers + operator ceilings ─────────────────────────────────────
const MB = 1024 * 1024;
const memToBytes = (s) => { const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([bkmg]?)$/i); if (!m) return null; return Math.floor(parseFloat(m[1]) * ({ "": 1, b: 1, k: 1024, m: MB, g: 1024 * MB }[m[2].toLowerCase()])); };
const bytesToMem = (b) => `${Math.floor(b / MB)}m`;
const cpuToMilli = (s) => { const n = parseFloat(String(s)); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null; };
// 0 / -1 / NaN / "unlimited" NEVER means infinity — it falls back to the safe default.
const ceil = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);

// Per-job DEFAULTS (when a manifest omits a request) and operator CEILINGS (a manifest
// request is clamped to these). Raising a *_max lets an approved program ask for more;
// a program can never exceed the ceiling and can never drop below the floor that keeps
// the gVisor sentry alive.
const MEM_DEFAULT  = memToBytes(config.memory) ?? 512 * MB;
const MEM_MAX      = ceil(memToBytes(config.max_memory), MEM_DEFAULT);
const CPU_DEFAULT  = cpuToMilli(config.cpus) ?? 1000;
const CPU_MAX      = ceil(cpuToMilli(config.max_cpus), CPU_DEFAULT);
const PIDS_DEFAULT = Number(config.pids_limit) || 256;
const PIDS_MAX     = ceil(Number(config.max_pids), PIDS_DEFAULT);
const OUTPUT_CAP   = ceil(Number(config.max_output_kb), 128) * 1024;
const MEM_FLOOR = 64 * MB, PIDS_FLOOR = 128; // too-low kills the runsc sentry at spawn (pids counts THREADS)

// Host reservation: the boot guard clamps effective concurrency so the box always keeps
// headroom for docker/the runner/the user's other services (e.g. Hermes bots).
const RESERVE_CORES    = Math.max(0, Number(config.reserve_cores) || 1);
const RESERVE_RAM_FRAC = Math.min(0.9, Math.max(0.15, Number(config.reserve_ram_frac) || 0.15));

// ── persistence (master switch OFF = today; /state is only ever ephemeral) ────
const PERSIST_ENABLED    = config.persist_enabled === true;
const STATE_DIR          = String(config.state_dir || "/var/lib/chapter-craft-runner/state");
const STATE_QUOTA_MB     = Math.max(16, Number(config.state_quota_mb) || 256);
const STATE_MAX_TOTAL_MB = Math.max(STATE_QUOTA_MB, Number(config.state_max_total_mb) || 4096);

// ── async (long unattended) runs: accepted immediately, executed in background,
// result persisted to disk so a restart never loses a finished run, collected
// later via signed GET /result. The runner stays inbound-only — it never calls
// anyone back.
const RESULTS_DIR          = String(config.results_dir || "/var/lib/chapter-craft-runner/results");
// Hard ceiling on an async job's wall-clock, whatever the caller asks: 2..60 min.
// The default matches the app's largest offered allowance (1 hour) so the
// out-of-box config never silently clamps a granted schedule into guaranteed
// timeouts; operators may lower it, and the accept response reports the
// effective value so the scheduler can tell the truth about the clamp.
const ASYNC_MAX_TIMEOUT_MS = Math.min(3_600_000, Math.max(120_000, Number(config.async_max_timeout_ms) || 3_600_000));
const RESULT_TTL_MS        = Math.max(1, Number(config.result_ttl_hours) || 48) * 3_600_000;
// Aggregate disk bound for persisted results (same discipline as /state's cap).
const RESULTS_MAX_TOTAL_MB = Math.max(64, Number(config.results_max_total_mb) || 1024);
// Keep every serialized result comfortably under the poller's 1MB read cap —
// an over-cap response would be truncated mid-JSON and unrecognizable.
const RESULT_JSON_BUDGET   = 700 * 1024;
const SKEW_SEC = 60;
const NONCE_FILE = join(process.cwd(), ".nonce-cache.json");

if (Object.keys(KEYS).length === 0) { console.error("config.keys is empty — no way to authenticate requests."); process.exit(1); }

// ── replay-nonce cache (persisted so a restart doesn't reopen the window) ──────
let nonceCache = new Map(); // nonce -> expiry(unix sec)
try { if (existsSync(NONCE_FILE)) { const o = JSON.parse(readFileSync(NONCE_FILE, "utf8")); for (const [n, e] of Object.entries(o)) nonceCache.set(n, e); } } catch { /* ignore */ }
function pruneNonces() { const now = Math.floor(Date.now() / 1000); for (const [n, e] of nonceCache) if (e < now) nonceCache.delete(n); }
async function persistNonces() { try { const o = {}; for (const [n, e] of nonceCache) o[n] = e; await writeFile(NONCE_FILE, JSON.stringify(o)); } catch { /* best-effort */ } }

// ── HMAC auth ──────────────────────────────────────────────────────────────
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function hmacHex(key, msg) { return crypto.createHmac("sha256", key).update(msg).digest("hex"); }
function safeEqual(a, b) { const ba = Buffer.from(a); const bb = Buffer.from(b); return ba.length === bb.length && crypto.timingSafeEqual(ba, bb); }

/** Own-property lookup — NEVER walks the prototype chain. `KEYS["__proto__"]`,
 *  `KEYS["constructor"]`, etc. would otherwise return a truthy inherited value,
 *  sail past the unknown-key guard, and reach createHmac with a non-string key,
 *  which throws and (unguarded) crashes the process — a fully unauthenticated,
 *  repeatable DoS from the public internet. */
function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function verify(req, method, path, rawBody) {
  const keyId = req.headers["x-key-id"];
  const ts = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  const sig = req.headers["x-signature"];
  if (!keyId || !ts || !nonce || !sig) return { ok: false, why: "missing signature headers" };
  const signingKey = own(KEYS, String(keyId));
  if (typeof signingKey !== "string" || signingKey.length === 0) return { ok: false, why: "unknown key id" };
  const now = Math.floor(Date.now() / 1000);
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > SKEW_SEC) return { ok: false, why: "timestamp skew" };
  pruneNonces();
  if (nonceCache.has(String(nonce))) return { ok: false, why: "replay" };
  const expected = hmacHex(signingKey, `${ts}.${method}.${path}.${sha256Hex(rawBody)}.${nonce}`);
  if (!safeEqual(String(sig), expected)) return { ok: false, why: "bad signature" };
  nonceCache.set(String(nonce), now + SKEW_SEC + 5);
  void persistNonces();
  return { ok: true };
}

// ── concurrency + queue ──────────────────────────────────────────────────────
// CONCURRENCY_EFF may be clamped BELOW the configured concurrency at boot (see the
// startup safety governor) so raised per-job ceilings can never overcommit host RAM/cores.
let CONCURRENCY_EFF = CONCURRENCY;
let active = 0;
const waiters = [];
function acquire() {
  if (active < CONCURRENCY_EFF) { active++; return Promise.resolve(true); }
  if (waiters.length >= QUEUE_MAX) return Promise.resolve(false); // shed load → 429
  return new Promise((res) => waiters.push(res));
}
// Take a slot only if one is free RIGHT NOW — cron dispatches must never sit in
// the queue behind a long job and then time out on the caller's side (a queued
// wait would be settled as a program failure when it was really contention).
function acquireNoWait() { if (active < CONCURRENCY_EFF) { active++; return true; } return false; }
function release() { active--; const next = waiters.shift(); if (next) { active++; next(true); } }

// Async jobs can hold a slot for up to ASYNC_MAX_TIMEOUT_MS, so cap the lane:
// on a multi-slot box at least one slot always stays free for interactive runs;
// on a single-slot box the one slot is shared. Callers that must not wait
// behind a long hold (cron dispatches, interactive runs) send no_wait and get
// an honest "busy"; only hermetic verify jobs still queue.
let asyncActive = 0;
const asyncLaneMax = () => Math.max(1, CONCURRENCY_EFF - 1);

// ── egress self-test state (fail-closed for allowlist) ───────────────────────
let egressReady = false;

// ── job execution ───────────────────────────────────────────────────────────
const INTERP = { bash: ["bash", "/work/prog"], python: ["python3", "/work/prog"], node: ["node", "/work/prog"] };

function truncate(s) { return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + "\n[...truncated]" : s; }
function redact(s, secretNames) {
  // Best-effort defense in depth ONLY: this removes the literal secret substring,
  // which a program can trivially defeat (base64/split/reverse the value). Any
  // secret a program declares must be considered fully exposed to whoever reads
  // its output — the approval card warns the user when a program uses secrets.
  let out = s;
  for (const name of secretNames) { const v = own(SECRETS, name); if (typeof v === "string" && v.length >= 4) out = out.split(v).join("«redacted»"); }
  return out;
}

// ── persistent state (per-lineage-epoch directory; opt-in, fenced at approval) ─
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function sanitizeUuid(x) { const s = String(x || "").toLowerCase(); return UUID_RE.test(s) ? s : null; }

// Run a command to completion. Resolves { code, stdout, stderr } — never throws.
function runCmd(cmd, args) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let p;
    try { p = spawn(cmd, args); } catch (e) { resolve({ code: -1, stdout: "", stderr: String(e?.message || e) }); return; }
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    p.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e?.message || e) }));
  });
}
async function duBytes(p) { const r = await runCmd("du", ["-sb", p]); if (r.code === 0) { const n = Number(String(r.stdout).split(/\s+/)[0]); return Number.isFinite(n) ? n : 0; } return 0; }

// A 'fresh' epoch bump orphans the prior epoch's directory for this lineage —
// remove those so state does not accumulate across versions.
async function gcSiblingEpochs(key, keepEpoch) {
  let entries = [];
  try { entries = await readdir(STATE_DIR); } catch { return; }
  for (const e of entries) {
    const m = e.match(/^([0-9a-f-]{36})-(\d+)$/);
    if (m && m[1] === key && Number(m[2]) !== keepEpoch) {
      // Never yank a directory a concurrent run at a different epoch (e.g. a
      // still-executing superseded version) still has bind-mounted.
      if (stateChains.has(`${m[1]}:${Number(m[2])}`)) continue;
      await runCmd("rm", ["-rf", join(STATE_DIR, e)]);
    }
  }
}

// Ensure the durable directory for this (lineage, epoch). The parent STATE_DIR is
// 0700 owned by the runner user, so host access is gated there; the per-program
// dir is 0777 only so the container's --user 65534 can write into it (the parent
// still blocks any other host user). Returns { path } or { error }.
async function ensureStateDir(key, epoch) {
  // Enforce the 0700 parent in code rather than trusting operator setup — it is
  // the ONLY thing gating other local host users out of the 0777 per-program dirs
  // (which hold persisted state + any secret an ancestor wrote). install -d
  // creates it if missing; the chmod forces 0700 even on a pre-existing looser dir.
  const pd = await runCmd("install", ["-d", "-m", "0700", STATE_DIR]);
  if (pd.code !== 0) return { error: `could not secure the state parent directory: ${String(pd.stderr).slice(0, 200)}` };
  await runCmd("chmod", ["0700", STATE_DIR]);
  const path = join(STATE_DIR, `${key}-${epoch}`);
  // Aggregate cap is a SOFT, pre-run bound (a single runaway run can still exceed
  // it mid-run — see the config doc); re-check it on BOTH the existing and new
  // paths so accumulated state can't drift past the cap unnoticed.
  const total = await duBytes(STATE_DIR);
  if (total >= STATE_MAX_TOTAL_MB * MB)
    return { error: `state storage is at the ${STATE_MAX_TOTAL_MB}MB cap — free some or raise state_max_total_mb` };
  if (existsSync(path)) {
    if (await duBytes(path) > STATE_QUOTA_MB * MB)
      return { error: `this program's stored state exceeds its ${STATE_QUOTA_MB}MB quota — clear it or raise state_quota_mb` };
    // Re-attempt sibling GC even when this epoch's dir already exists: the
    // create-time sweep skips an epoch a still-executing superseded run holds
    // (the stateChains guard), and without a retry that skip was permanent —
    // the stale epoch (possibly ancestor-written secrets) leaked until the
    // aggregate cap wedged the lineage. Fire-and-forget; the in-use guard
    // still protects live epochs.
    void gcSiblingEpochs(key, epoch);
    return { path };
  }
  await gcSiblingEpochs(key, epoch);                 // reclaim old epochs of this lineage (a 'fresh' bump)
  const r = await runCmd("install", ["-d", "-m", "0777", path]);
  if (r.code !== 0) return { error: `could not create state directory: ${String(r.stderr).slice(0, 200)}` };
  return { path };
}

// ── async result store (survives restarts; the poll endpoint reads it) ────────
const resultPath  = (id) => join(RESULTS_DIR, `${id}.json`);
const startedPath = (id) => join(RESULTS_DIR, `${id}.started.json`);

// Same 0700-parent discipline as STATE_DIR: results carry program output, which
// may include anything the program printed.
async function ensureResultsDir() {
  const r = await runCmd("install", ["-d", "-m", "0700", RESULTS_DIR]);
  if (r.code !== 0) return { error: `could not secure the results directory: ${String(r.stderr).slice(0, 200)}` };
  await runCmd("chmod", ["0700", RESULTS_DIR]);
  return {};
}

// The serialized result must fit the poller's read cap: control-char-heavy
// output inflates ~6x under JSON escaping, so OUTPUT_CAP-sized streams can
// exceed 1MB of JSON. Re-truncate stdout (then stderr) until it fits — a
// truncated-but-parseable result beats an unreadable complete one.
function fitResultBudget(obj) {
  const size = () => Buffer.byteLength(JSON.stringify(obj), "utf8");
  for (const key of ["stdout", "stderr"]) {
    let over = size() - RESULT_JSON_BUDGET;
    if (over <= 0) return obj;
    const s = typeof obj[key] === "string" ? obj[key] : "";
    // JSON escaping inflates at most 6x, so cutting over/1 chars always
    // converges; cut generously (escaped bytes >= chars) then re-measure.
    if (s.length > 0) obj[key] = s.slice(0, Math.max(0, s.length - over)) + "\n[...truncated to fit the result envelope]";
  }
  return obj;
}

// Atomic write (tmp + rename): a poll can never read a half-written result, and
// a crash mid-write leaves the .started marker in place → reconciled as lost.
async function writeResultFile(id, obj) {
  const tmp = resultPath(id) + ".tmp";
  await writeFile(tmp, JSON.stringify(fitResultBudget(obj)), "utf8");
  await rename(tmp, resultPath(id));
}

// Boot-time truth: no job survives a runner restart. Kill orphaned sandbox
// containers (dockerd keeps them running after our child processes die), and
// turn every dangling .started marker into an honest "lost" result so pollers
// settle instead of waiting forever.
async function reconcileOrphanedAsyncRuns() {
  const ps = await runCmd("docker", ["ps", "-aq", "--filter", "name=ccprog_"]);
  for (const cid of ps.stdout.split(/\s+/).filter(Boolean)) await runCmd("docker", ["rm", "-f", cid]);
  let entries = [];
  try { entries = await readdir(RESULTS_DIR); } catch { return; }
  for (const e of entries) {
    const m = e.match(/^([0-9a-f-]{36})\.started\.json$/);
    if (!m) continue;
    if (!existsSync(resultPath(m[1]))) {
      try {
        await writeResultFile(m[1], { v: 1, run_id: m[1], finished_at: Date.now(), status: "lost", exit_code: null, stdout: "", stderr: "the runner restarted while this job was in flight", ms: 0 });
        console.error(`[runner] async run ${m[1]} marked lost (restart while in flight)`);
      } catch (err) { console.error(`[runner] could not write lost-marker for ${m[1]}:`, err); }
    }
    await rm(join(RESULTS_DIR, e), { force: true }).catch(() => {});
  }
}

// Results are collected within a few ticks; anything older than the TTL was
// abandoned (deleted schedule, dead project) — reclaim the disk. NEVER touch
// .started markers here: with a short TTL and a max-length job the marker can
// be older than the TTL while its job is STILL RUNNING, and deleting it would
// make the poll see "unknown" and reap a live run as lost. Boot reconciliation
// owns marker cleanup.
async function gcResultFiles() {
  let entries = [];
  try { entries = await readdir(RESULTS_DIR); } catch { return; }
  const now = Date.now();
  for (const e of entries) {
    if (e.endsWith(".started.json")) continue;
    const full = join(RESULTS_DIR, e);
    try { const st = await stat(full); if (now - st.mtimeMs > RESULT_TTL_MS) await rm(full, { force: true }); } catch { /* raced */ }
  }
}

// Serialize runs that share one (lineage, epoch) directory so concurrent jobs
// cannot interleave writes into the same state.
const stateChains = new Map();
async function acquireStateLock(key) {
  const prev = stateChains.get(key) || Promise.resolve();
  let resolveNext;
  const next = new Promise((r) => (resolveNext = r));
  const chained = prev.then(() => next, () => next);
  stateChains.set(key, chained);
  await prev.catch(() => {});
  return () => { resolveNext(); if (stateChains.get(key) === chained) stateChains.delete(key); };
}

async function runJob(job) {
  const mode = job.mode === "verify" ? "verify" : "run";
  const language = String(job.language || "");
  if (!INTERP[language]) return { status: "error", exit_code: null, stdout: "", stderr: `unsupported language: ${language}`, ms: 0 };
  const code = String(job.code || "");
  const manifest = job.manifest || {};
  // Async jobs (accepted-then-polled) may run past the sync cap, up to the
  // operator's async ceiling. Only a real run can be async — mode "verify"
  // stays on the sync cap whatever the caller claims.
  const timeoutCap = job.async === true && mode === "run" ? ASYNC_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS;
  const timeoutMs = Math.min(timeoutCap, Math.max(1000, Number(manifest.timeout_ms) || 15000));

  // VERIFY is forced hermetic: no network, no secrets, no durable state.
  const wantsAllowlist = mode === "run" && manifest.network === "allowlist";
  const secretNames = mode === "run" && Array.isArray(manifest.secrets) ? manifest.secrets.filter((n) => typeof n === "string" && own(SECRETS, n) !== undefined) : [];
  // A persist run mounts durable state that an ANCESTOR version may have written a
  // secret into, so declared-names redaction is not enough — redact the FULL
  // configured secrets map from a persist run's output (defense in depth).
  const persistRun = mode === "run" && manifest.persist === true && PERSIST_ENABLED;
  const redactNames = persistRun ? Object.keys(SECRETS) : secretNames;

  if (wantsAllowlist && !egressReady) {
    return { status: "error", exit_code: null, stdout: "", stderr: "this runner cannot serve allowlist egress (the egress lockdown self-test did not pass); re-forge the program with network 'none' or fix the runner's egress setup", ms: 0 };
  }

  const dir = await mkdtemp(join(tmpdir(), "ccprog-"));
  const name = `ccprog_${crypto.randomUUID().slice(0, 12)}`;
  const started = Date.now();
  let releaseStateLock = null;
  try {
    const codeFile = join(dir, "prog");
    await writeFile(codeFile, code, "utf8");

    // /state: verify gets a throwaway tmpfs (hermetic — an unapproved draft can
    // neither read accumulated state nor persist anything); a real persist run
    // gets its durable per-(lineage,epoch) directory; a persist request with the
    // operator switch OFF falls back to an ephemeral tmpfs so it still runs.
    let stateArgs = [];
    if (mode === "verify") {
      stateArgs = ["--tmpfs", "/state:size=16m,mode=0700,noexec,nosuid,nodev"];
    } else if (persistRun) {
      const key = sanitizeUuid(job.state_key);
      const epoch = Number.isInteger(job.state_epoch) && job.state_epoch > 0 ? job.state_epoch : null;
      if (!key || !epoch) return { status: "error", exit_code: null, stdout: "", stderr: "persistent state requested but no valid state key/epoch was provided", ms: Date.now() - started };
      releaseStateLock = await acquireStateLock(`${key}:${epoch}`);
      const sd = await ensureStateDir(key, epoch);
      if (sd.error) return { status: "error", exit_code: null, stdout: "", stderr: sd.error, ms: Date.now() - started };
      stateArgs = ["-v", `${sd.path}:/state`];
    } else if (mode === "run" && manifest.persist === true) {
      stateArgs = ["--tmpfs", "/state:size=64m,mode=0700,nosuid,nodev"];
    }

    const netArgs = wantsAllowlist
      ? ["--network", EGRESS_NETWORK,
         // Docker's embedded DNS (127.0.0.11) does not work inside a gVisor
         // sandbox (the resolver socket is host-bound; getaddrinfo gets
         // EAI_AGAIN), so the proxy name must resolve from a static
         // /etc/hosts entry, pinned to the same IP setup-egress.sh assigns.
         "--add-host", `ccprog-proxy:${EGRESS_PROXY_IP}`,
         "--env", `CCPROG_ALLOWED_HOSTS=${(manifest.allowed_hosts || []).join(",")}`,
         "--env", "HTTP_PROXY=http://ccprog-proxy:8753", "--env", "HTTPS_PROXY=http://ccprog-proxy:8753",
         "--env", "http_proxy=http://ccprog-proxy:8753", "--env", "https_proxy=http://ccprog-proxy:8753"]
      : ["--network", "none"];

    const secretEnv = [];
    for (const n of secretNames) { secretEnv.push("--env", `${n}=${own(SECRETS, n)}`); }

    // Map the (fingerprinted, human-approved) manifest resource requests to docker limits,
    // clamped to the operator ceilings. `req()` honors a request ONLY on a real run — an
    // unapproved verify draft can never ask for more than the defaults, so forge-time
    // verification can never be used to DoS the box.
    const req = (raw, parse, dflt, cap) => {
      let v = dflt;
      if (mode === "run" && raw != null) { const p = parse(raw); if (p != null && p > 0) v = p; }
      return Math.min(v, cap);
    };
    const memB = Math.max(MEM_FLOOR,  req(manifest.memory, memToBytes,        MEM_DEFAULT,  MEM_MAX));
    const cpuM =                      req(manifest.cpus,   cpuToMilli,        CPU_DEFAULT,  CPU_MAX);
    const pids = Math.max(PIDS_FLOOR, req(manifest.pids,   (x) => Number(x) || null, PIDS_DEFAULT, PIDS_MAX));

    const dockerArgs = [
      "run", "--name", name, "--runtime=runsc",
      ...netArgs,
      // swap pinned equal to memory (no swap); --cpu-shares 512 puts the sandbox cgroup
      // weight BELOW host services (docker/Hermes default 1024) so jobs yield under contention.
      "--memory", bytesToMem(memB), "--memory-swap", bytesToMem(memB),
      "--cpus", (cpuM / 1000).toFixed(3),
      "--cpu-shares", "512",
      "--pids-limit", String(pids),
      "--read-only",
      "--tmpfs", "/tmp:size=64m,mode=1777,noexec,nosuid,nodev",
      "--tmpfs", "/dev/shm:size=16m,noexec,nosuid,nodev",
      ...stateArgs,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "65534:65534",
      "--ulimit", "nofile=1024:1024", "--ulimit", "nproc=256:256",
      "--env", `PROGRAM_ARGS=${JSON.stringify(job.args ?? {})}`,
      ...secretEnv,
      "-v", `${codeFile}:/work/prog:ro`,
      "-w", "/work",
      SANDBOX_IMAGE,
      ...INTERP[language],
    ];

    let stdout = "", stderr = "", killedForTimeout = false, startError = "";
    const done = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      let child;
      try { child = spawn("docker", dockerArgs); }
      catch (e) { startError = String(e?.message || e); finish(false); return; }
      // Soft kill at the wall-clock limit.
      const killTimer = setTimeout(() => { killedForTimeout = true; spawn("docker", ["kill", name]); }, timeoutMs + 2000);
      // HARD backstop: if docker kill did not take (wedged daemon, container not
      // yet registered), force-kill the child + container and resolve anyway, so
      // the concurrency slot is NEVER leaked by a stuck job.
      const hardTimer = setTimeout(() => {
        killedForTimeout = true;
        try { child.kill("SIGKILL"); } catch { /* */ }
        spawn("docker", ["kill", name]);
        spawn("docker", ["rm", "-f", name]);
        finish(true);
      }, timeoutMs + 15000);
      child.stdout.on("data", (d) => { if (stdout.length < OUTPUT_CAP * 2) stdout += d.toString(); });
      child.stderr.on("data", (d) => { if (stderr.length < OUTPUT_CAP * 2) stderr += d.toString(); });
      child.on("error", (e) => { startError = String(e?.message || e); clearTimeout(killTimer); clearTimeout(hardTimer); finish(false); });
      child.on("close", () => { clearTimeout(killTimer); clearTimeout(hardTimer); finish(true); });
    });

    // Inspect before removing so OOM is read from the source of truth.
    let oomKilled = false, exitCode = null;
    if (done) {
      try {
        const insp = await new Promise((resolve) => {
          let out = "";
          const p = spawn("docker", ["inspect", "--format", "{{.State.OOMKilled}} {{.State.ExitCode}}", name]);
          p.stdout.on("data", (d) => (out += d.toString()));
          p.on("close", () => resolve(out.trim()));
          p.on("error", () => resolve(""));
        });
        const [oom, ec] = insp.split(/\s+/);
        oomKilled = oom === "true";
        exitCode = Number.isFinite(Number(ec)) ? Number(ec) : null;
      } catch { /* ignore */ }
    }

    const ms = Date.now() - started;
    if (startError || (!done && !killedForTimeout)) {
      return { status: "sandbox_unavailable", exit_code: null, stdout: "", stderr: truncate(startError || "the sandbox container could not start"), ms };
    }
    stdout = truncate(redact(stdout, redactNames));
    stderr = truncate(redact(stderr, redactNames));
    if (killedForTimeout) return { status: "timeout", exit_code: exitCode, stdout, stderr, ms };
    if (oomKilled) return { status: "oom", exit_code: exitCode, stdout, stderr, ms };
    if (wantsAllowlist && /ccprog: egress blocked/i.test(stderr)) return { status: "egress_blocked", exit_code: exitCode, stdout, stderr, ms };
    if (exitCode === 0) return { status: "ok", exit_code: 0, stdout, stderr, ms };
    return { status: "error", exit_code: exitCode, stdout, stderr, ms };
  } finally {
    // Always clean up — the container (belt-and-suspenders over the backstop) and
    // the per-job temp dir, whatever path we left by. The durable /state directory
    // is NEVER removed here — only gcSiblingEpochs (a fresh-epoch bump) prunes it.
    spawn("docker", ["rm", "-f", name]);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (releaseStateLock) releaseStateLock();
  }
}

// ── health canary ────────────────────────────────────────────────────────────
async function healthCanary() {
  // A real gVisor container that echoes — proves runsc + docker actually work,
  // not just that the process is up (a non-KVM/broken host fails here).
  return await new Promise((resolve) => {
    let out = "";
    let err = "";
    // Use the real job pids ceiling: the pids cgroup counts THREADS, and the
    // gVisor sentry needs dozens just to boot — a tighter canary-only cap
    // fails the sandbox at spawn even though actual jobs would run.
    const p = spawn("docker", ["run", "--rm", "--runtime=runsc", "--network", "none",
      "--memory", "64m", "--cpus", "0.5", "--pids-limit", String(PIDS_MAX), "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
      SANDBOX_IMAGE, "bash", "-c", "echo ccprog-canary-ok"]);
    const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } resolve(false); }, 15000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", () => {
      clearTimeout(timer);
      const ok = out.includes("ccprog-canary-ok");
      if (!ok) console.error(`[runner] health canary FAILED: ${err.trim().slice(0, 500) || "(no stderr)"}`);
      resolve(ok);
    });
    p.on("error", (e) => { clearTimeout(timer); console.error(`[runner] health canary spawn error: ${e.message}`); resolve(false); });
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= 2 * 1024 * 1024) chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.from("")));
  });
}
const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { "Content-Type": "application/json" }); res.end(b); };

// A single request must NEVER be able to crash the process. The whole handler
// body is wrapped, and the process-level guards below are a last resort.
process.on("unhandledRejection", (e) => { console.error("[runner] unhandledRejection:", e); });
process.on("uncaughtException", (e) => { console.error("[runner] uncaughtException:", e); });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const raw = await readBody(req);

    // The signature covers pathname + query (identical to pathname when there is
    // no query, so pre-query clients keep verifying): /result?run_id=… must not
    // be tamperable below the MAC.
    const auth = verify(req, req.method, url.pathname + url.search, raw);
    if (!auth.ok) return send(res, 401, { ok: false, error: `unauthorized: ${auth.why}` });

    if (req.method === "GET" && path === "/health") {
      const sandbox_ok = await healthCanary();
      return send(res, 200, { ok: true, sandbox_ok, egress_ready: egressReady, async_max_ms: ASYNC_MAX_TIMEOUT_MS, runner: "chapter-craft-runner" });
    }

    // Poll a previously-accepted async run. Three truthful states:
    //   done    → the persisted result (survives restarts)
    //   running → accepted, still executing
    //   unknown → this runner has no record (never dispatched here, lost before
    //             the marker was written, or already GC'd past the TTL)
    if (req.method === "GET" && path === "/result") {
      const runId = sanitizeUuid(url.searchParams.get("run_id"));
      if (!runId) return send(res, 400, { ok: false, error: "run_id must be a uuid" });
      try {
        const txt = await readFile(resultPath(runId), "utf8");
        return send(res, 200, { ok: true, done: true, result: JSON.parse(txt) });
      } catch { /* not finished (or never here) */ }
      if (existsSync(startedPath(runId))) return send(res, 200, { ok: true, done: false, running: true });
      return send(res, 200, { ok: true, done: false, unknown: true });
    }

    if (req.method === "POST" && path === "/run") {
      let job;
      try { job = JSON.parse(raw.toString() || "{}"); } catch { return send(res, 400, { status: "error", error: "invalid json" }); }

      // ── async accept: validate cheaply, persist a started-marker, respond
      // immediately, execute in background. The caller supplies the run_id (it
      // is also its DB row id); we only ever use a sanitized UUID as a filename.
      if (job.async === true) {
        if (job.mode === "verify") return send(res, 400, { status: "error", error: "verification cannot run async" });
        const runId = sanitizeUuid(job.run_id);
        if (!runId) return send(res, 400, { status: "error", error: "async requires a uuid run_id" });
        if (!INTERP[String(job.language || "")]) return send(res, 400, { status: "error", error: `unsupported language: ${String(job.language || "")}` });
        if (job?.manifest?.network === "allowlist" && !egressReady) {
          return send(res, 200, { status: "error", error: "this runner cannot serve allowlist egress (the egress lockdown self-test did not pass); re-forge the program with network 'none' or fix the runner's egress setup" });
        }
        const rd = await ensureResultsDir();
        if (rd.error) return send(res, 200, { status: "sandbox_unavailable", error: rd.error });
        // The effective wall-clock this runner will actually grant — echoed so
        // the scheduler can set an honest deadline and name any operator clamp.
        const effectiveMs = Math.min(ASYNC_MAX_TIMEOUT_MS, Math.max(1000, Number(job?.manifest?.timeout_ms) || 15000));
        // Idempotent re-dispatch: if we already know this run_id, don't start it twice.
        if (existsSync(resultPath(runId)) || existsSync(startedPath(runId))) {
          return send(res, 200, { status: "accepted", run_id: runId, effective_timeout_ms: effectiveMs, duplicate: true });
        }
        // Aggregate disk bound (mirrors the /state discipline): stop accepting
        // new async work once the results store is at its cap.
        if (await duBytes(RESULTS_DIR) >= RESULTS_MAX_TOTAL_MB * MB) {
          return send(res, 429, { status: "busy", error: `the async results store is at its ${RESULTS_MAX_TOTAL_MB}MB cap — collect or GC results, or raise results_max_total_mb` });
        }
        if (asyncActive >= asyncLaneMax() || !acquireNoWait()) {
          return send(res, 429, { status: "busy", error: "runner busy — the async lane is full; retry on a later tick" });
        }
        asyncActive++;
        try {
          await writeFile(startedPath(runId), JSON.stringify({ run_id: runId, started_at: Date.now() }), "utf8");
        } catch (e) {
          asyncActive--; release();
          return send(res, 200, { status: "sandbox_unavailable", error: `could not persist the run marker: ${String(e?.message || e).slice(0, 200)}` });
        }
        void (async () => {
          let result;
          try { result = await runJob(job); }
          catch (e) { result = { status: "error", exit_code: null, stdout: "", stderr: String(e?.message || e).slice(0, 500), ms: 0 }; }
          try {
            await writeResultFile(runId, { v: 1, run_id: runId, finished_at: Date.now(), ...result });
            await rm(startedPath(runId), { force: true }).catch(() => {});
          } catch (e) {
            console.error(`[runner] async result write FAILED for ${runId}:`, e);
          } finally {
            asyncActive--; release();
          }
        })();
        return send(res, 200, { status: "accepted", run_id: runId, effective_timeout_ms: effectiveMs });
      }

      // ── sync path. no_wait callers (cron) shed instead of queueing: a queued
      // wait behind a long job would blow the caller's timeout and be recorded
      // as a program failure when it was really contention.
      const got = job.no_wait === true ? acquireNoWait() : await acquire();
      if (!got) return send(res, 429, { status: "busy", error: "runner busy" });
      try {
        const result = await runJob(job);
        return send(res, 200, result);
      } catch (e) {
        return send(res, 200, { status: "sandbox_unavailable", error: String(e?.message || e).slice(0, 300) });
      } finally {
        release();
      }
    }

    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    try { send(res, 500, { ok: false, error: "internal error" }); } catch { /* headers sent */ }
    console.error("[runner] handler error:", e);
  }
});

// ── startup ──────────────────────────────────────────────────────────────────
(async () => {
  // Egress self-test: if the operator set up allowlist egress, prove that the
  // sandbox on the egress network CANNOT reach private/metadata ranges directly.
  // Fail closed — a failing test leaves egressReady=false and only network:none
  // is served.
  const revalidateEgress = async () => {
    try {
      const ok = await import("./selftest.mjs").then((m) => m.runEgressSelfTest({ SANDBOX_IMAGE, EGRESS_NETWORK })).catch(() => null);
      egressReady = ok === true;
    } catch { egressReady = false; }
  };
  await revalidateEgress();
  console.log(`[runner] egress allowlist ${egressReady ? "ENABLED" : "DISABLED (network:none only)"}`);

  // Async-run hygiene: settle the truth about anything that was in flight when
  // the previous process died, then GC expired results periodically.
  await ensureResultsDir().then((r) => { if (r.error) console.error(`[runner] ${r.error}`); });
  await reconcileOrphanedAsyncRuns();
  await gcResultFiles();
  setInterval(() => { void gcResultFiles(); }, 6 * 3_600_000).unref?.();
  console.log(`[runner] async runs: cap ${Math.round(ASYNC_MAX_TIMEOUT_MS / 60000)}min, results in ${RESULTS_DIR} (ttl ${Math.round(RESULT_TTL_MS / 3_600_000)}h)`);
  // Re-prove the lockdown continuously: host firewall rules (ufw reload, a manual
  // flush, an incomplete netfilter restore) can drop the iptables constraints
  // WITHOUT restarting this process. Latching egressReady=true at boot would then
  // keep serving allowlist jobs on a network that no longer blocks metadata/host.
  // Re-running the self-test on an interval flips it back to false the moment the
  // lockdown stops holding. (network:none jobs are unaffected either way.)
  setInterval(() => { void revalidateEgress(); }, 90_000).unref?.();

  // Safety governor: never let raised per-job ceilings overcommit the host. Reserve cores
  // + a RAM fraction for docker/the runner/the user's other services (e.g. Hermes bots),
  // and clamp effective concurrency by BOTH the RAM bound and the CPU bound. This can only
  // LOWER concurrency; on a correctly-sized box it equals the configured value.
  {
    const ram = os.totalmem(), cores = os.cpus().length;
    const effReserveCores = cores > RESERVE_CORES ? RESERVE_CORES : Math.max(0, cores - 1);
    const ramBound = Math.max(1, Math.floor((ram * (1 - RESERVE_RAM_FRAC)) / MEM_MAX));
    const cpuBound = Math.max(1, Math.floor((cores - effReserveCores) / (CPU_MAX / 1000)));
    CONCURRENCY_EFF = Math.max(1, Math.min(CONCURRENCY, ramBound, cpuBound));
    if (CONCURRENCY_EFF < CONCURRENCY)
      console.error(`[runner] SAFETY CLAMP effective concurrency ${CONCURRENCY}→${CONCURRENCY_EFF} `
        + `(RAM-bound ${ramBound}, CPU-bound ${cpuBound}; reserving ${effReserveCores} core(s) + `
        + `${Math.round(RESERVE_RAM_FRAC * 100)}% RAM for the host). Lower the ceilings or size up the box.`);
    console.log(`[runner] ceilings: mem<=${bytesToMem(MEM_MAX)} cpus<=${(CPU_MAX / 1000).toFixed(2)} `
      + `pids<=${PIDS_MAX} output<=${OUTPUT_CAP / 1024}kb concurrency_eff=${CONCURRENCY_EFF}`);
  }
  server.listen(PORT, "127.0.0.1", () => console.log(`[runner] listening on 127.0.0.1:${PORT} (put TLS in front — see README)`));
})();
