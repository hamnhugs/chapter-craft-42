// Chapter Craft Program Runner — egress forward proxy (ccprog-proxy).
//
// This is the ONLY egress path for a sandbox running in "allowlist" mode.
// setup-egress.sh installs iptables rules that DROP every outbound packet from
// the egress network EXCEPT sandbox → this proxy on :8753. So a program can talk
// to the internet only by asking this proxy to dial for it; it can never reach
// the docker gateway, the cloud metadata endpoint, host services, or any other
// private address on its own.
//
// Defense in depth on top of the packet filter: for every CONNECT tunnel and
// every plain HTTP request this proxy
//   1. checks the requested hostname against the operator allowlist
//      (runner.config.json → allowed_hosts_global; empty array = deny all), then
//   2. resolves the hostname (A + AAAA) and REFUSES if ANY resolved address is
//      private / loopback / link-local / ULA / CGNAT / metadata — for BOTH
//      IPv4 and IPv6, including IPv4-mapped and NAT64 forms, then
//   3. dials the RESOLVED public IP itself (not the hostname). Because the
//      check and the dial use the same resolved IP, DNS rebinding / TOCTOU
//      cannot swing the target to an internal address between check and connect.
//
// A refusal is observable: it logs `ccprog: egress blocked <host>` to stderr.
// (The sandbox program only sees a failed connection; the reason is here.)
//
// Zero npm dependencies: Node built-ins only (http, net, dns, fs).

import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.CCPROG_PROXY_PORT) || 8753;
const BIND = process.env.CCPROG_PROXY_BIND || "0.0.0.0";
const MAX_SOCKETS = Number(process.env.CCPROG_PROXY_MAX_SOCKETS) || 256;
const UPSTREAM_TIMEOUT_MS = Number(process.env.CCPROG_PROXY_TIMEOUT_MS) || 30_000;

// ── operator allowlist (hot-reloaded from config) ────────────────────────────
let allowlist = [];
function loadConfig() {
  const path = process.env.RUNNER_CONFIG || "/runner.config.json";
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(cfg.allowed_hosts_global) ? cfg.allowed_hosts_global : [];
    allowlist = list
      .map((h) => String(h).trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean);
  } catch (e) {
    // Can't read config ⇒ deny everything (fail closed).
    allowlist = [];
    console.error(`ccprog: cannot read allowlist from ${path} (${e?.message || e}) — denying all egress`);
  }
}
loadConfig();
// Pick up allowlist edits without restarting the container.
setInterval(loadConfig, 30_000).unref?.();

function hostAllowed(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (allowlist.length === 0) return false; // empty allowlist = deny all
  for (const entry of allowlist) {
    if (entry === h) return true;
    // Optional wildcard: "*.example.com" matches the apex and any subdomain.
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (h === entry.slice(2) || h.endsWith(suffix)) return true;
    }
  }
  return false;
}

// ── IP range screening (fail closed on anything unparseable) ──────────────────
function v4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = n * 256 + x;
  }
  return n >>> 0;
}
function inCidr4(n, baseStr, bits) {
  const base = v4ToInt(baseStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (base & mask);
}
function isBlockedV4Int(n) {
  if (n === null) return true;
  return (
    inCidr4(n, "0.0.0.0", 8) ||        // "this" network / unspecified
    inCidr4(n, "10.0.0.0", 8) ||       // RFC1918
    inCidr4(n, "100.64.0.0", 10) ||    // CGNAT
    inCidr4(n, "127.0.0.0", 8) ||      // loopback
    inCidr4(n, "169.254.0.0", 16) ||   // link-local + cloud metadata
    inCidr4(n, "172.16.0.0", 12) ||    // RFC1918
    inCidr4(n, "192.168.0.0", 16) ||   // RFC1918
    inCidr4(n, "224.0.0.0", 4) ||      // multicast
    inCidr4(n, "240.0.0.0", 4)         // reserved
  );
}
function isBlockedV4(ip) {
  return isBlockedV4Int(v4ToInt(ip));
}

// Parse an IPv6 literal to 8 x 16-bit words (handles "::" and embedded IPv4).
function v6ToWords(addr) {
  addr = String(addr).split("%")[0].trim(); // strip zone id
  if (!addr) return null;
  let embedded = null;
  const m = addr.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (m) {
    const n = v4ToInt(m[2]);
    if (n === null) return null;
    embedded = [(n >>> 16) & 0xffff, n & 0xffff];
    addr = m[1]; // ends with ':'
  }
  const dbl = addr.split("::");
  if (dbl.length > 2) return null;
  const parseSide = (s) =>
    s === "" ? [] : s.split(":").filter((x) => x !== "").map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  let head = parseSide(dbl[0]);
  let tail = dbl.length === 2 ? parseSide(dbl[1]) : null;
  if (embedded) {
    if (tail !== null) tail = tail.concat(embedded);
    else head = head.concat(embedded);
  }
  let words;
  if (tail === null) {
    words = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    words = head.concat(Array(missing).fill(0), tail);
  }
  if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
  return words;
}
function isBlockedV6(ip) {
  const w = v6ToWords(ip);
  if (!w) return true; // unparseable ⇒ block
  const b = [];
  for (const x of w) { b.push((x >>> 8) & 0xff); b.push(x & 0xff); }
  if (w.every((x) => x === 0)) return true;                                   // :: unspecified
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;         // ::1 loopback
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return true; // ::ffff:0:0/96 (IPv4-mapped)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return true; // 64:ff9b::/96 (NAT64)
  if ((b[0] & 0xfe) === 0xfc) return true;                                    // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;                   // fe80::/10 link-local
  return false;
}
function isBlockedIP(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not a valid IP ⇒ block
}

// ── resolve + screen ─────────────────────────────────────────────────────────
async function resolveAll(host) {
  if (net.isIP(host)) return [host]; // literal IP — screened directly below
  const settled = await Promise.allSettled([dns.promises.resolve4(host), dns.promises.resolve6(host)]);
  const ips = [];
  for (const s of settled) if (s.status === "fulfilled") for (const ip of s.value) ips.push(ip);
  return ips;
}

// Returns { ok:true, ips } or { ok:false, reason }.
async function screen(host) {
  if (!host) return { ok: false, reason: "no host" };
  if (!hostAllowed(host)) return { ok: false, reason: "not in allowlist" };
  let ips;
  try { ips = await resolveAll(host); } catch (e) { return { ok: false, reason: `dns error: ${e?.code || e?.message || e}` }; }
  if (!ips.length) return { ok: false, reason: "no DNS records" };
  for (const ip of ips) {
    if (isBlockedIP(ip)) return { ok: false, reason: `resolves to blocked address ${ip}` };
  }
  return { ok: true, ips };
}

function blockLog(host, reason) {
  // Machine-observable marker on the proxy's own stderr.
  console.error(`ccprog: egress blocked ${host} (${reason})`);
}

// ── concurrency bound ────────────────────────────────────────────────────────
let openSockets = 0;
function tooMany() { return openSockets >= MAX_SOCKETS; }

// ── HTTP proxy (plain, absolute-URI requests) ────────────────────────────────
const server = http.createServer(async (req, res) => {
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400).end("bad request-uri\n"); return; }
  if (target.protocol !== "http:") { res.writeHead(400).end("only http:// is proxied here; use CONNECT for https\n"); return; }
  const host = target.hostname;
  const port = Number(target.port) || 80;

  const s = await screen(host);
  if (!s.ok) {
    blockLog(host, s.reason);
    res.writeHead(403, { "Content-Type": "text/plain" }).end("ccprog: egress blocked\n");
    return;
  }
  if (tooMany()) { res.writeHead(429).end("proxy busy\n"); return; }

  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  headers.host = target.host; // preserve the original vhost even though we dial an IP

  openSockets++;
  let decremented = false;
  const dec = () => { if (!decremented) { decremented = true; openSockets--; } };

  const upstream = http.request(
    { host: s.ips[0], port, method: req.method, path: (target.pathname || "/") + (target.search || ""), headers, setHost: false },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => { try { upstream.destroy(); } catch { /* */ } });
  upstream.on("error", () => { if (!res.headersSent) { try { res.writeHead(502); } catch { /* */ } } try { res.end(); } catch { /* */ } });
  upstream.on("close", dec);
  req.on("error", () => { try { upstream.destroy(); } catch { /* */ } });
  req.pipe(upstream);
});

// ── HTTPS proxy (CONNECT tunnels) ────────────────────────────────────────────
server.on("connect", async (req, clientSocket, head) => {
  const [rawHost, rawPort] = splitHostPort(req.url);
  const host = rawHost;
  const port = Number(rawPort) || 443;

  const refuse = (code, msg) => {
    blockLog(host || req.url, msg);
    try { clientSocket.write(`HTTP/1.1 ${code}\r\n\r\n`); } catch { /* */ }
    try { clientSocket.destroy(); } catch { /* */ }
  };

  const s = await screen(host);
  if (!s.ok) return refuse("403 Forbidden", s.reason);
  if (tooMany()) return refuse("429 Too Many Requests", "proxy busy");

  // Dial the screened public IP directly (defeats DNS rebinding).
  const upstream = net.connect(port, s.ips[0]);
  openSockets++;
  let decremented = false;
  const dec = () => { if (!decremented) { decremented = true; openSockets--; } };

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => { try { upstream.destroy(); } catch { /* */ } });
  upstream.on("connect", () => {
    try { clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch { /* */ }
    if (head && head.length) { try { upstream.write(head); } catch { /* */ } }
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => { dec(); try { clientSocket.destroy(); } catch { /* */ } });
  upstream.on("close", () => { dec(); try { clientSocket.destroy(); } catch { /* */ } });
  clientSocket.on("error", () => { dec(); try { upstream.destroy(); } catch { /* */ } });
  clientSocket.on("close", () => { dec(); try { upstream.destroy(); } catch { /* */ } });
});

function splitHostPort(hostport) {
  const s = String(hostport || "");
  // IPv6 literal in brackets: [::1]:443
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end !== -1) return [s.slice(1, end), s.slice(end + 2)];
  }
  const i = s.lastIndexOf(":");
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

server.on("clientError", (_err, socket) => { try { socket.destroy(); } catch { /* */ } });

server.listen(PORT, BIND, () => {
  console.error(`ccprog: egress proxy listening on ${BIND}:${PORT}; allowlist has ${allowlist.length} host(s)`);
});
