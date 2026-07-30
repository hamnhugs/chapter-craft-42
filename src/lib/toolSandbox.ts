import workerUrl from "@/sandbox/toolWorker?worker&url";

/**
 * Tool Foundry sandbox — the OUTER boundary and run orchestration.
 *
 * Production architecture (Figma's, validated by their plugin-security
 * incident): a fresh opaque-origin iframe per run (`sandbox="allow-scripts"`,
 * srcdoc, meta CSP with connect-src 'none') hosting a blob: Worker (inherits
 * the iframe CSP → still no network; terminate() = unconditional kill) that
 * runs the QuickJS-WASM VM (toolWorker.ts). Tool code and args cross the
 * boundary ONLY as MessageChannel data — SANDBOX_SRCDOC below is a
 * compile-time constant with ZERO interpolation (unit-test enforced).
 *
 * Dev-mode note: Vite serves the worker as an ES module whose imports can't
 * resolve inside a blob worker in an opaque origin, so in dev the worker runs
 * directly in the page (module worker, no iframe). The QuickJS boundary still
 * holds there; the full double boundary is exercised by the production build.
 */

export interface SandboxRunRequest {
  code: string;
  args: unknown;
  /** Exact capability names this run may call (the APPROVED manifest). */
  capabilities: string[];
  onCapability: (cap: string, args: unknown) => Promise<unknown>;
  timeoutMs?: number;
  resultCapBytes?: number;
}

export interface SandboxRunResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  ms: number;
  killed?: boolean;
  capabilityCalls: Array<{ cap: string; args: unknown; ok: boolean; bytes: number }>;
}

const CAP_RESULT_BYTES = 16 * 1024;   // per capability call
const CAP_TOTAL_BYTES = 64 * 1024;    // per run, across calls
const DEFAULT_RESULT_CAP = 32 * 1024; // tool return value
const DEFAULT_TIMEOUT_MS = 10_000;

// The iframe bootstrap. STATIC — never build this string from run data.
// It accepts exactly one window message (the boot: a MessagePort + the built
// worker source text), creates the blob worker, then relays port<->worker.
export const SANDBOX_SRCDOC = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; child-src blob:; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<meta http-equiv="x-dns-prefetch-control" content="off">
</head><body><script>
(function () {
  "use strict";
  var booted = false;
  var worker = null;
  var port = null;
  window.addEventListener("message", function (e) {
    if (booted) return;
    var d = e.data;
    if (!d || d.type !== "boot" || !e.ports || !e.ports[0] || typeof d.workerSource !== "string") return;
    booted = true;
    port = e.ports[0];
    try {
      var blob = new Blob([d.workerSource], { type: "text/javascript" });
      worker = new Worker(URL.createObjectURL(blob), { type: "module" });
    } catch (err) {
      port.postMessage({ type: "bootError", error: String(err && err.message || err) });
      return;
    }
    worker.onmessage = function (we) { port.postMessage(we.data); };
    worker.onerror = function (we) { port.postMessage({ type: "workerError", error: String(we.message || "worker error") }); };
    port.onmessage = function (pe) {
      var m = pe.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "kill") { try { worker.terminate(); } catch (x) {} port.postMessage({ type: "killed" }); return; }
      worker.postMessage(m);
    };
    port.postMessage({ type: "ready" });
  });
})();
</script></body></html>`;

let workerSourcePromise: Promise<string> | null = null;
async function getWorkerSource(): Promise<string> {
  if (!workerSourcePromise) {
    workerSourcePromise = fetch(workerUrl).then((r) => {
      if (!r.ok) throw new Error(`worker asset fetch failed: ${r.status}`);
      return r.text();
    });
    workerSourcePromise.catch(() => { workerSourcePromise = null; });
  }
  return workerSourcePromise;
}

interface Channel {
  post: (msg: Record<string, unknown>) => void;
  onMessage: (fn: (data: any) => void) => void;
  kill: () => void;
  dispose: () => void;
}

/** Dev: module worker directly in the page (see header note). */
function openDevChannel(): Channel {
  const worker = new Worker(workerUrl, { type: "module" });
  let handler: (data: any) => void = () => undefined;
  worker.onmessage = (e) => handler(e.data);
  return {
    post: (m) => worker.postMessage(m),
    onMessage: (fn) => { handler = fn; },
    kill: () => worker.terminate(),
    dispose: () => worker.terminate(),
  };
}

/** Prod: fresh sandboxed iframe + blob worker per run. */
async function openProdChannel(): Promise<Channel> {
  const workerSource = await getWorkerSource();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");
  iframe.srcdoc = SANDBOX_SRCDOC;
  const loaded = new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("sandbox frame load timeout")), 8000);
    iframe.onload = () => { window.clearTimeout(t); resolve(); };
  });
  document.body.appendChild(iframe);
  await loaded;
  const channel = new MessageChannel();
  let handler: (data: any) => void = () => undefined;
  channel.port1.onmessage = (e) => handler(e.data);
  // Opaque-origin frame: targetOrigin must be "*", which is fine — the only
  // payload crossing here is our own worker source; secrets never do.
  iframe.contentWindow?.postMessage({ type: "boot", workerSource }, "*", [channel.port2]);
  const ready = new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("sandbox boot timeout")), 8000);
    const prev = handler;
    handler = (d) => {
      if (d?.type === "ready") { window.clearTimeout(t); handler = prev; resolve(); }
      else if (d?.type === "bootError") { window.clearTimeout(t); reject(new Error(String(d.error))); }
    };
  });
  await ready;
  return {
    post: (m) => channel.port1.postMessage(m),
    onMessage: (fn) => { handler = fn; },
    kill: () => channel.port1.postMessage({ type: "kill" }),
    dispose: () => {
      try { channel.port1.close(); } catch { /* closed */ }
      try { iframe.remove(); } catch { /* removed */ }
    },
  };
}

export async function runToolSandboxed(req: SandboxRunRequest): Promise<SandboxRunResult> {
  const runId = crypto.randomUUID();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resultCap = req.resultCapBytes ?? DEFAULT_RESULT_CAP;
  const capabilityCalls: SandboxRunResult["capabilityCalls"] = [];
  let capBytesTotal = 0;
  const started = Date.now();

  let channel: Channel;
  try {
    channel = import.meta.env.DEV ? openDevChannel() : await openProdChannel();
  } catch (e) {
    return { ok: false, error: `sandbox unavailable: ${String((e as Error)?.message || e)}`, ms: Date.now() - started, capabilityCalls };
  }

  return await new Promise<SandboxRunResult>((resolve) => {
    let settled = false;
    const finish = (r: SandboxRunResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(hardTimer);
      channel.dispose();
      resolve(r);
    };
    const hardTimer = window.setTimeout(() => {
      channel.kill();
      finish({ ok: false, error: `timed out after ${timeoutMs}ms`, killed: true, ms: Date.now() - started, capabilityCalls });
    }, timeoutMs);

    channel.onMessage((d) => {
      if (!d || typeof d !== "object" || d.runId !== runId) {
        // "killed"/"workerError" arrive without runId from the bootstrap.
        if (d?.type === "workerError") finish({ ok: false, error: String(d.error), ms: Date.now() - started, capabilityCalls });
        return;
      }
      if (d.type === "capViolation") {
        // The tool called outside its approved manifest — approval was for a
        // different program. Hard-fail the run.
        channel.kill();
        finish({ ok: false, error: `capability violation: '${String(d.cap)}' is not in the approved manifest`, killed: true, ms: Date.now() - started, capabilityCalls });
        return;
      }
      if (d.type === "cap") {
        const cap = String(d.cap);
        let args: unknown = {};
        try { args = JSON.parse(String(d.argsJson || "{}")); } catch { /* keep {} */ }
        void (async () => {
          try {
            if (!req.capabilities.includes(cap)) throw new Error(`capability '${cap}' not approved`);
            if (capBytesTotal >= CAP_TOTAL_BYTES) throw new Error("capability data budget exhausted for this run");
            const value = await req.onCapability(cap, args);
            let json = JSON.stringify(value === undefined ? null : value);
            if (json.length > CAP_RESULT_BYTES) json = JSON.stringify({ error: `capability result too large (${json.length} bytes; cap ${CAP_RESULT_BYTES})` });
            capBytesTotal += json.length;
            capabilityCalls.push({ cap, args, ok: true, bytes: json.length });
            channel.post({ type: "capResult", runId, callId: d.callId, ok: true, valueJson: json });
          } catch (err) {
            capabilityCalls.push({ cap, args, ok: false, bytes: 0 });
            channel.post({ type: "capResult", runId, callId: d.callId, ok: false, error: String((err as Error)?.message || err).slice(0, 300) });
          }
        })();
        return;
      }
      if (d.type === "result") {
        if (d.ok) {
          let value: unknown = null;
          try { value = JSON.parse(String(d.valueJson ?? "null")); } catch { value = null; }
          const bytes = String(d.valueJson ?? "").length;
          if (bytes > resultCap) {
            finish({ ok: false, error: `result too large (${bytes} bytes)`, ms: Number(d.ms) || Date.now() - started, capabilityCalls });
          } else {
            finish({ ok: true, value, ms: Number(d.ms) || Date.now() - started, capabilityCalls });
          }
        } else {
          finish({ ok: false, error: String(d.error || "tool failed"), ms: Number(d.ms) || Date.now() - started, capabilityCalls });
        }
      }
    });

    channel.post({
      type: "run",
      runId,
      code: req.code,
      argsJson: JSON.stringify(req.args ?? {}),
      capabilities: req.capabilities,
      limits: { memBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, deadlineMs: timeoutMs, resultCapBytes: resultCap },
    });
  });
}
