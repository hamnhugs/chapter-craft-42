// Shared client for the user's VPS program runner. Both program-run and
// program-verify sign jobs the same way and validate the runner URL the same
// way, so that security-critical logic lives here, once.
//
// Two boundaries this file owns:
//   1. SSRF: the runner URL is user-set, so before ANY request we require https
//      and resolve every A/AAAA record, refusing private/loopback/link-local/
//      ULA/metadata ranges. This blocks a user (or a mistaken config) from
//      turning the edge function into an SSRF proxy against Supabase internals.
//   2. HMAC request signing: the runner authenticates every job by an
//      HMAC-SHA256 over `${ts}.${method}.${path}.${sha256(body)}`, with a fresh
//      timestamp and nonce so a captured request cannot be replayed. The signing
//      key is the user's own write-only secret, read server-side under RLS.

export interface RunnerConn {
  host: string;     // original hostname (used for SNI + Host header)
  port: number;
  ip: string;       // the VETTED public IP the socket actually connects to
  keyId: string;
  signingKey: string;
}

const PRIVATE_V4 = [
  // [network, maskBits]
  ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10],
  ["0.0.0.0", 8], ["192.0.0.0", 24], ["198.18.0.0", 15],
] as const;

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  for (const [net, bits] of PRIVATE_V4) {
    const base = v4ToInt(net)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd")) return true; // link-local + ULA
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::) → check the embedded v4.
  const mapped = a.match(/(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (a.startsWith("::ffff:")) return true; // hex-form mapped — refuse to be safe
  return false;
}

export interface ValidatedRunner { host: string; port: number; ip: string }

/**
 * Validate a user-set runner URL and resolve it ONCE to a vetted public IP.
 *
 * Returns the exact IP the caller must connect to — never just the hostname —
 * so the connection cannot re-resolve to a private address between check and
 * dial (DNS-rebinding / TOCTOU). Every A/AAAA record is screened; if ANY is
 * internal, or the URL is not https, this throws.
 */
export async function validateRunnerUrl(raw: string): Promise<ValidatedRunner> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("runner_url is not a valid URL"); }
  if (u.protocol !== "https:") throw new Error("runner_url must use https");
  const host = u.hostname.toLowerCase();
  const port = u.port ? Number(u.port) : 443;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("runner_url has an invalid port");

  const literalV4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const literalV6 = host.includes(":");
  let addrs: string[];
  if (literalV4) {
    if (isPrivateV4(host)) throw new Error("runner_url resolves to a private address");
    addrs = [host];
  } else if (literalV6) {
    const bare = host.replace(/^\[|\]$/g, "");
    if (isPrivateV6(bare)) throw new Error("runner_url resolves to a private address");
    addrs = [bare];
  } else {
    addrs = [];
    for (const kind of ["A", "AAAA"] as const) {
      try { addrs = addrs.concat(await Deno.resolveDns(host, kind)); } catch { /* one family may not exist */ }
    }
    if (addrs.length === 0) throw new Error("runner_url host does not resolve");
    for (const ip of addrs) {
      if (ip.includes(":") ? isPrivateV6(ip) : isPrivateV4(ip)) {
        throw new Error("runner_url resolves to a private address");
      }
    }
  }
  // Every resolved address is public. Pin the first — the socket connects to
  // THIS ip, so re-resolution can never swing the target internal.
  return { host: literalV6 ? host.replace(/^\[|\]$/g, "") : host, port, ip: addrs[0] };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_RESPONSE_BYTES = 1_048_576; // 1 MB ceiling on a runner response

/**
 * Send an HMAC-signed request to the runner over a TLS socket PINNED to the
 * vetted IP (conn.ip), with the hostname as SNI + Host header. Because we open
 * the socket to the literal IP ourselves — never a hostname fetch re-resolves —
 * DNS rebinding cannot swing the target, and because we speak HTTP/1.1 with
 * `Connection: close` and read to EOF, there are no redirects to follow (a 3xx
 * is returned verbatim and the caller treats any non-2xx as a hard failure).
 *
 * Resolves { status, body } (body parsed as JSON when possible); throws only on
 * a transport failure or timeout.
 */
export async function callRunner(
  conn: RunnerConn,
  method: "POST" | "GET",
  path: string,
  bodyObj: unknown | null,
  timeoutMs: number,
): Promise<{ status: number; body: any }> {
  const bodyStr = bodyObj === null ? "" : JSON.stringify(bodyObj);
  const bodyBytes = new TextEncoder().encode(bodyStr);
  const bodyHash = await sha256Hex(bodyBytes);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(conn.signingKey, `${ts}.${method}.${path}.${bodyHash}.${nonce}`);

  const requestHead =
    `${method} ${path} HTTP/1.1\r\n` +
    `Host: ${conn.host}\r\n` +
    `Content-Type: application/json\r\n` +
    `X-Key-Id: ${conn.keyId}\r\n` +
    `X-Timestamp: ${ts}\r\n` +
    `X-Nonce: ${nonce}\r\n` +
    `X-Signature: ${signature}\r\n` +
    `Content-Length: ${bodyBytes.length}\r\n` +
    `Connection: close\r\n\r\n`;

  // The IP pin must be two-stage: the Supabase edge runtime ignores
  // Deno.connectTls's `serverName` (no SNI goes out and the certificate is
  // validated against the IP — fatal alert 80 from the proxy, then
  // NotValidForName). A plain TCP connect to the literal IP (no DNS lookup)
  // followed by startTls with the real hostname keeps the anti-rebinding pin
  // AND restores SNI + certificate validation against conn.host.
  const tls = await Promise.race([
    (async () => {
      const tcp = await Deno.connect({ hostname: conn.ip, port: conn.port });
      try {
        return await Deno.startTls(tcp, { hostname: conn.host });
      } catch (e) {
        try { tcp.close(); } catch { /* already closed */ }
        throw e;
      }
    })(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("connect timeout")), timeoutMs)),
  ]);
  try {
    const enc = new TextEncoder();
    await tls.write(enc.encode(requestHead));
    if (bodyBytes.length > 0) await tls.write(bodyBytes);

    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const buf = new Uint8Array(16384);
      const n = await Promise.race([
        tls.read(buf),
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error("read timeout")), Math.max(1, deadline - Date.now()))),
      ]);
      if (n === null) break; // EOF (server closed after Connection: close)
      chunks.push(buf.subarray(0, n));
      total += n;
      if (total > MAX_RESPONSE_BYTES) break;
    }
    const raw = new TextDecoder().decode(concat(chunks, total));
    const headerEnd = raw.indexOf("\r\n\r\n");
    const headText = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
    const bodyText = headerEnd === -1 ? "" : raw.slice(headerEnd + 4);
    const statusLine = headText.split("\r\n")[0] || "";
    const status = Number(statusLine.split(" ")[1]) || 0;
    // Best-effort: strip a single chunked-transfer wrapper if the runner used it.
    const bodyClean = /transfer-encoding:\s*chunked/i.test(headText) ? dechunk(bodyText) : bodyText;
    let body: any = null;
    try { body = bodyClean.trim() ? JSON.parse(bodyClean) : null; } catch { body = { raw: bodyClean.slice(0, 500) }; }
    return { status, body };
  } finally {
    try { tls.close(); } catch { /* already closed */ }
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Minimal HTTP/1.1 chunked-body decoder (the runner uses Content-Length, but
 *  a fronting proxy may re-chunk). Falls back to the raw text on any anomaly. */
function dechunk(s: string): string {
  let out = "";
  let i = 0;
  try {
    while (i < s.length) {
      const nl = s.indexOf("\r\n", i);
      if (nl === -1) break;
      const size = parseInt(s.slice(i, nl).trim(), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      out += s.slice(nl + 2, nl + 2 + size);
      i = nl + 2 + size + 2;
    }
    return out || s;
  } catch { return s; }
}
