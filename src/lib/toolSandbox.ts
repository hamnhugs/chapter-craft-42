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
// Byte budgets alone don't bound a tool that LOOPS on a failing capability:
// failures return no bytes, so a `for(;;) try { await caps.memory_get(...) }
// catch {}` would issue authenticated queries for the whole timeout. Count
// calls too, and make exhaustion terminal rather than another catchable error.
const CAP_MAX_CALLS = 64;
const CAP_FAILED_CALL_COST = 256;     // failures still charge against the budget
const DEFAULT_RESULT_CAP = 32 * 1024; // tool return value
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The sandbox document is a STATIC same-origin asset (public/tool-sandbox.html),
 * deliberately not an iframe srcdoc: srcdoc is a local scheme and inherits the
 * embedder's CSP, and the app's policy has no 'unsafe-inline', so a srcdoc
 * bootstrap silently never executes in a production build (dev has no CSP, so
 * the failure is invisible there). A real-URL document carries only its own
 * policy. `sandbox="allow-scripts"` without allow-same-origin still makes it
 * opaque-origin, and `frame-src 'self'` already admits it.
 */
export const SANDBOX_DOC_PATH = "tool-sandbox.html";

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
  iframe.src = new URL(SANDBOX_DOC_PATH, document.baseURI).href;
  let channel: MessageChannel | null = null;
  document.body.appendChild(iframe);
  // Everything past the append must tear the frame down on failure, or every
  // boot error leaks a hidden frame (potentially still running a worker with
  // no kill timer attached, since runToolSandboxed returns before arming one).
  try {
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => reject(new Error("sandbox frame load timeout")), 8000);
      iframe.onload = () => { window.clearTimeout(t); resolve(); };
      iframe.onerror = () => { window.clearTimeout(t); reject(new Error("sandbox frame failed to load")); };
    });
    channel = new MessageChannel();
    let handler: (data: any) => void = () => undefined;
    channel.port1.onmessage = (e) => handler(e.data);
    // Opaque-origin frame: targetOrigin must be "*", which is fine — the only
    // payload crossing here is our own worker source; secrets never do. The
    // frame checks e.source === window.parent before accepting this.
    iframe.contentWindow?.postMessage({ type: "boot", workerSource }, "*", [channel.port2]);
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => reject(new Error("sandbox boot timeout")), 8000);
      handler = (d) => {
        if (d?.type === "ready") { window.clearTimeout(t); resolve(); }
        else if (d?.type === "bootError") { window.clearTimeout(t); reject(new Error(String(d.error))); }
      };
    });
    const port = channel.port1;
    return {
      post: (m) => port.postMessage(m),
      onMessage: (fn) => { handler = fn; },
      kill: () => port.postMessage({ type: "kill" }),
      dispose: () => {
        try { port.close(); } catch { /* closed */ }
        try { iframe.remove(); } catch { /* removed */ }
      },
    };
  } catch (e) {
    try { channel?.port1.close(); } catch { /* closed */ }
    try { iframe.remove(); } catch { /* removed */ }
    throw e;
  }
}

export async function runToolSandboxed(req: SandboxRunRequest): Promise<SandboxRunResult> {
  const runId = crypto.randomUUID();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resultCap = req.resultCapBytes ?? DEFAULT_RESULT_CAP;
  const capabilityCalls: SandboxRunResult["capabilityCalls"] = [];
  let capBytesTotal = 0;
  let capCalls = 0;
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
        capCalls++;
        if (capCalls > CAP_MAX_CALLS) {
          // Terminal, like a capability violation: returning an error here
          // would just feed the loop that caused it.
          channel.kill();
          finish({ ok: false, error: `capability call limit reached (${CAP_MAX_CALLS} per run)`, killed: true, ms: Date.now() - started, capabilityCalls });
          return;
        }
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
            capBytesTotal += CAP_FAILED_CALL_COST;
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
