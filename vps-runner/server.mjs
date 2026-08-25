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
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
const MAX_TIMEOUT_MS = Number(config.max_timeout_ms) || 60_000;
const CONCURRENCY = Math.max(1, Number(config.concurrency) || 3);
const QUEUE_MAX = Math.max(0, Number(config.queue_max) ?? 10);
const PORT = Number(config.port) || 8752;
const MEMORY = String(config.memory || "512m");
const CPUS = String(config.cpus || "1");
const PIDS = Number(config.pids_limit) || 256;
const OUTPUT_CAP = 128 * 1024;
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
let active = 0;
const waiters = [];
function acquire() {
  if (active < CONCURRENCY) { active++; return Promise.resolve(true); }
  if (waiters.length >= QUEUE_MAX) return Promise.resolve(false); // shed load → 429
  return new Promise((res) => waiters.push(res));
}
function release() { active--; const next = waiters.shift(); if (next) { active++; next(true); } }

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

async function runJob(job) {
  const mode = job.mode === "verify" ? "verify" : "run";
  const language = String(job.language || "");
  if (!INTERP[language]) return { status: "error", exit_code: null, stdout: "", stderr: `unsupported language: ${language}`, ms: 0 };
  const code = String(job.code || "");
  const manifest = job.manifest || {};
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(manifest.timeout_ms) || 15000));

  // VERIFY is forced hermetic: no network, no secrets, whatever was asked.
  const wantsAllowlist = mode === "run" && manifest.network === "allowlist";
  const secretNames = mode === "run" && Array.isArray(manifest.secrets) ? manifest.secrets.filter((n) => typeof n === "string" && own(SECRETS, n) !== undefined) : [];

  if (wantsAllowlist && !egressReady) {
    return { status: "error", exit_code: null, stdout: "", stderr: "this runner cannot serve allowlist egress (the egress lockdown self-test did not pass); re-forge the program with network 'none' or fix the runner's egress setup", ms: 0 };
  }

  const dir = await mkdtemp(join(tmpdir(), "ccprog-"));
  const name = `ccprog_${crypto.randomUUID().slice(0, 12)}`;
  const started = Date.now();
  try {
    const codeFile = join(dir, "prog");
    await writeFile(codeFile, code, "utf8");

    const netArgs = wantsAllowlist
      ? ["--network", EGRESS_NETWORK, "--env", `CCPROG_ALLOWED_HOSTS=${(manifest.allowed_hosts || []).join(",")}`,
         "--env", "HTTP_PROXY=http://ccprog-proxy:8753", "--env", "HTTPS_PROXY=http://ccprog-proxy:8753",
         "--env", "http_proxy=http://ccprog-proxy:8753", "--env", "https_proxy=http://ccprog-proxy:8753"]
      : ["--network", "none"];

    const secretEnv = [];
    for (const n of secretNames) { secretEnv.push("--env", `${n}=${own(SECRETS, n)}`); }

    const dockerArgs = [
      "run", "--name", name, "--runtime=runsc",
      ...netArgs,
      "--memory", MEMORY, "--memory-swap", MEMORY, "--cpus", CPUS, "--pids-limit", String(PIDS),
      "--read-only",
      "--tmpfs", "/tmp:size=64m,mode=1777,noexec,nosuid,nodev",
      "--tmpfs", "/dev/shm:size=16m,noexec,nosuid,nodev",
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
    stdout = truncate(redact(stdout, secretNames));
    stderr = truncate(redact(stderr, secretNames));
    if (killedForTimeout) return { status: "timeout", exit_code: exitCode, stdout, stderr, ms };
    if (oomKilled) return { status: "oom", exit_code: exitCode, stdout, stderr, ms };
    if (wantsAllowlist && /ccprog: egress blocked/i.test(stderr)) return { status: "egress_blocked", exit_code: exitCode, stdout, stderr, ms };
    if (exitCode === 0) return { status: "ok", exit_code: 0, stdout, stderr, ms };
    return { status: "error", exit_code: exitCode, stdout, stderr, ms };
  } finally {
    // Always clean up — the container (belt-and-suspenders over the backstop) and
    // the per-job temp dir, whatever path we left by.
    spawn("docker", ["rm", "-f", name]);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
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
      "--memory", "64m", "--cpus", "0.5", "--pids-limit", String(PIDS), "--read-only",
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

    const auth = verify(req, req.method, path, raw);
    if (!auth.ok) return send(res, 401, { ok: false, error: `unauthorized: ${auth.why}` });

    if (req.method === "GET" && path === "/health") {
      const sandbox_ok = await healthCanary();
      return send(res, 200, { ok: true, sandbox_ok, egress_ready: egressReady, runner: "chapter-craft-runner" });
    }

    if (req.method === "POST" && path === "/run") {
      let job;
      try { job = JSON.parse(raw.toString() || "{}"); } catch { return send(res, 400, { status: "error", error: "invalid json" }); }
      const got = await acquire();
      if (!got) return send(res, 429, { status: "error", error: "runner busy" });
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
  // Re-prove the lockdown continuously: host firewall rules (ufw reload, a manual
  // flush, an incomplete netfilter restore) can drop the iptables constraints
  // WITHOUT restarting this process. Latching egressReady=true at boot would then
  // keep serving allowlist jobs on a network that no longer blocks metadata/host.
  // Re-running the self-test on an interval flips it back to false the moment the
  // lockdown stops holding. (network:none jobs are unaffected either way.)
  setInterval(() => { void revalidateEgress(); }, 90_000).unref?.();
  server.listen(PORT, "127.0.0.1", () => console.log(`[runner] listening on 127.0.0.1:${PORT} (put TLS in front — see README)`));
})();
