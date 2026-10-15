#!/usr/bin/env node
// Local control — the one thing the browser can't do itself: change the
// discrete GPU's power state. Chapter Craft calls it when Local AI is
// switched on or off (src/hooks/useLocalAiPower.ts):
//   POST /gpu/hold     card awake + COMPUTE profile (fast prompt reading)
//   POST /gpu/release  stock power management, so the card can sleep
//   GET  /gpu          {held: bool}
// Both verbs run the root helper setup-once.sh installs, through its
// passwordless sudoers rule for exactly those two invocations.
//
// Same guard as craft-bridge.mjs: only requests carrying X-Chapter-Craft from
// the app's own origin are served — a header a web page can't send
// cross-origin without a CORS preflight, which this server never approves.
//
//   node scripts/local-ai/control.mjs        (scripts/local-up.sh starts it)

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SERVICES = JSON.parse(readFileSync(join(ROOT, "local-services.json"), "utf8"));
const PORT = Number(process.env.CC_CONTROL_PORT || new URL(SERVICES.control).port);
const ALLOWED_ORIGINS = new Set(["http://127.0.0.1:8080", "http://localhost:8080", ...(process.env.CC_APP_ORIGINS || "").split(",").filter(Boolean)]);
const HELPER = "/usr/local/bin/cc-amdgpu-compute";

const log = (...a) => console.error(new Date().toISOString(), ...a);

/** The AMD card with the most VRAM — the one the helper acts on. */
function dgpu() {
  let best = null, bestv = 0;
  for (const c of readdirSync("/sys/class/drm").filter((n) => /^card\d+$/.test(n))) {
    const d = join("/sys/class/drm", c, "device");
    try {
      if (readFileSync(join(d, "vendor"), "utf8").trim() !== "0x1002") continue;
      const v = Number(readFileSync(join(d, "mem_info_vram_total"), "utf8"));
      if (v > bestv) { best = d; bestv = v; }
    } catch { /* not a GPU with these files */ }
  }
  return best;
}

function held() {
  const d = dgpu();
  if (!d) return false;
  try { return readFileSync(join(d, "power/control"), "utf8").trim() === "on"; } catch { return false; }
}

function helper(verb) {
  return new Promise((ok) => {
    execFile("sudo", ["-n", HELPER, verb], { timeout: 15_000 }, (err, _out, stderr) => {
      if (err) log(`gpu ${verb} failed:`, (stderr || err.message).trim());
      ok(!err);
    });
  });
}

const ROUTES = {
  "GET /gpu": async () => ({ held: held() }),
  "POST /gpu/hold": async () => {
    const ok = await helper("hold");
    log("gpu hold", ok ? "ok" : "failed");
    return { ok, held: held(), ...(ok ? {} : { error: "GPU helper not installed — run: bash scripts/local-ai/setup-once.sh" }) };
  },
  "POST /gpu/release": async () => {
    const ok = await helper("release");
    log("gpu release", ok ? "ok" : "failed");
    return { ok, held: held() };
  },
};

const server = createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
  };
  try {
    const origin = req.headers.origin;
    if (req.headers["x-chapter-craft"] !== "1" || (origin && !ALLOWED_ORIGINS.has(origin))) return send(403, { error: "forbidden" });
    const route = ROUTES[`${req.method} ${new URL(req.url, "http://127.0.0.1").pathname}`];
    if (!route) return send(404, { error: "not found" });
    req.resume();
    send(200, await route());
  } catch (e) {
    log("error", e.stack || e.message);
    send(500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => log(`local control on 127.0.0.1:${PORT}`));
const stop = () => process.exit(0);
process.on("SIGTERM", stop); process.on("SIGINT", stop);
