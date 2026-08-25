// Chapter Craft Program Runner — egress lockdown self-test.
//
// This proves, from INSIDE a real gVisor sandbox on the egress network, that a
// program CANNOT open a raw TCP socket to any private / loopback / link-local /
// metadata address. If the proof does not hold, we FAIL CLOSED: the runner then
// serves only network:none jobs (see server.mjs, which gates `egressReady` on
// the boolean this module returns).
//
// Why raw sockets and not the proxy? The proxy (egress-proxy.mjs) is the ONLY
// sanctioned egress path, but a compromised or buggy program could try to skip
// the proxy and dial an internal IP directly. setup-egress.sh installs iptables
// rules that DROP exactly that traffic. This test verifies those rules are live
// by attempting the forbidden connects and requiring every one to be blocked.
//
// Zero npm dependencies: Node built-ins + spawning `docker`.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Internal targets a sandbox must NEVER be able to reach directly.
// Every one of these must come back `blocked` or the lockdown is broken.
const TARGETS = [
  { addr: "169.254.169.254:80",  label: "cloud metadata endpoint" },
  { addr: "127.0.0.1:22",        label: "host loopback (ssh)" },
  { addr: "172.17.0.1:5432",     label: "docker gateway / host postgres" },
  { addr: "10.0.0.1:80",         label: "private RFC1918 range" },
];

// A tiny Python probe. It attempts a 2s-timeout TCP connect to each target and
// prints one line per target: "<host>:<port> reachable" or "<host>:<port> blocked".
// A successful connect() ⇒ reachable (BAD). Any failure (timeout, refused,
// unreachable, exception) ⇒ blocked (GOOD).
const PROBE_PY = [
  "import socket",
  'T=[("169.254.169.254",80),("127.0.0.1",22),("172.17.0.1",5432),("10.0.0.1",80)]',
  "for h,p in T:",
  "    s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)",
  "    s.settimeout(2)",
  "    try:",
  '        s.connect((h,p)); print("%s:%d reachable"%(h,p))',
  "    except Exception:",
  '        print("%s:%d blocked"%(h,p))',
  "    finally:",
  "        try: s.close()",
  "        except Exception: pass",
].join("\n");

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args);
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e?.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: stderr + "\n[selftest] probe timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Parse probe output into { "host:port": "reachable" | "blocked" }.
function parseResults(stdout) {
  const status = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+(reachable|blocked)$/);
    if (m) status[m[1]] = m[2];
  }
  return status;
}

// Core routine used by both the exported boolean and the human `main()`.
// Returns { ok, networkExists, ran, status, raw, error }.
async function probeEgress({ SANDBOX_IMAGE, EGRESS_NETWORK }) {
  const out = { ok: false, networkExists: false, ran: false, status: {}, raw: "", error: "" };
  if (!SANDBOX_IMAGE || !EGRESS_NETWORK) {
    out.error = "missing SANDBOX_IMAGE or EGRESS_NETWORK";
    return out;
  }

  // (a) The egress docker network must exist. If it doesn't, there is nothing
  //     to lock down and allowlist egress must stay disabled.
  const net = await runCmd("docker", ["network", "inspect", EGRESS_NETWORK], 15_000);
  if (net.code !== 0) {
    out.error = `docker network '${EGRESS_NETWORK}' not found (run setup-egress.sh first)`;
    return out;
  }
  out.networkExists = true;

  // (b) Run a throwaway, hardened gVisor container ON the egress network and let
  //     it try the forbidden connects.
  const args = [
    "run", "--rm", "--runtime=runsc",
    "--network", EGRESS_NETWORK,
    "--memory", "64m", "--memory-swap", "64m",
    "--cpus", "0.5", "--pids-limit", "32",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--user", "65534:65534",
    SANDBOX_IMAGE,
    "python3", "-c", PROBE_PY,
  ];
  const probe = await runCmd("docker", args, 40_000);
  out.raw = (probe.stdout || "") + (probe.stderr ? `\n[stderr]\n${probe.stderr}` : "");
  out.status = parseResults(probe.stdout);
  out.ran = Object.keys(out.status).length > 0;

  // (c) FAIL CLOSED: require that we got a verdict for EVERY target and that
  //     every verdict is `blocked`. A missing target, a reachable target, or a
  //     container that never produced output all mean "not proven safe".
  const allBlocked = TARGETS.every((t) => out.status[t.addr] === "blocked");
  const anyReachable = TARGETS.some((t) => out.status[t.addr] === "reachable");
  out.ok = out.ran && allBlocked && !anyReachable;
  if (!out.ok && !out.error) {
    out.error = anyReachable
      ? "an internal target was REACHABLE — egress lockdown is broken"
      : "probe did not confirm all targets blocked";
  }
  return out;
}

// Exported for server.mjs. Returns true ONLY if the lockdown is proven; any
// error, timeout, or ambiguity returns false (fail closed).
export async function runEgressSelfTest({ SANDBOX_IMAGE, EGRESS_NETWORK }) {
  try {
    const r = await probeEgress({ SANDBOX_IMAGE, EGRESS_NETWORK });
    return r.ok === true;
  } catch {
    return false;
  }
}

// `npm run selftest` / `node selftest.mjs` — human-readable report, exits 0/1.
export async function main() {
  const CONFIG_PATH = process.env.RUNNER_CONFIG || join(process.cwd(), "runner.config.json");
  let config = {};
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    console.error(`[selftest] no config at ${CONFIG_PATH} — using defaults`);
  }
  const SANDBOX_IMAGE = config.sandbox_image || "chapter-craft-sandbox:latest";
  const EGRESS_NETWORK = config.egress_network || "ccprog-egress";

  console.log("Chapter Craft Program Runner — egress lockdown self-test");
  console.log(`  sandbox image : ${SANDBOX_IMAGE}`);
  console.log(`  egress network: ${EGRESS_NETWORK}`);
  console.log("");

  const r = await probeEgress({ SANDBOX_IMAGE, EGRESS_NETWORK });

  if (!r.networkExists) {
    console.log(`RESULT: FAIL — ${r.error}`);
    console.log("Allowlist egress will be DISABLED; the runner serves network:none only.");
    process.exit(1);
  }

  console.log("Direct-socket reachability from inside the sandbox:");
  for (const t of TARGETS) {
    const v = r.status[t.addr] || "no-verdict";
    const mark = v === "blocked" ? "OK  " : "FAIL";
    console.log(`  [${mark}] ${t.addr.padEnd(22)} ${v.padEnd(10)} (${t.label})`);
  }
  console.log("");

  if (r.ok) {
    console.log("RESULT: PASS — every internal target is blocked. Allowlist egress is safe to enable.");
    process.exit(0);
  } else {
    console.log(`RESULT: FAIL — ${r.error}`);
    if (r.raw.trim()) {
      console.log("");
      console.log("--- raw probe output ---");
      console.log(r.raw.trim());
    }
    console.log("");
    console.log("The runner will FAIL CLOSED and serve network:none only until this passes.");
    process.exit(1);
  }
}

// Run main() only when invoked directly (not when imported by server.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
