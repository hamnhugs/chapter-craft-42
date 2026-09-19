import workerUrl from "@/sandbox/toolWorker?worker&url";

/**
 * Tool Foundry sandbox — the OUTER boundary and run orchestration.
 *
 * Production architecture (Figma's, validated by their plugin-security
 * incident): a fresh opaque-origin iframe per run (`sandbox="allow-scripts"`,
 * a real-URL static document, meta CSP with connect-src 'none') hosting a
 * Worker that runs the QuickJS-WASM VM (toolWorker.ts). Tool code and args
 * cross the boundary ONLY as MessageChannel data; the sandbox document is a
 * static asset with ZERO interpolation (unit-test enforced).
 *
 * TRANSPORT. The worker is handed over as a `data:text/javascript;base64,...`
 * URL, not a blob: URL. Loading a top-level MODULE worker script sets the
 * request's mode to "same-origin" (HTML, "fetch a single module script"); a
 * blob URL minted inside an opaque origin serialises as "blob:null/<uuid>",
 * and re-deriving an origin from that string yields a FRESH opaque origin,
 * which can never compare equal. Measured on Chrome 148 in exactly this
 * architecture: blob: + {type:"module"} never loads and reports a bare Event
 * with no message; data: + {type:"module"} loads, WASM included. Same bug and
 * same fix as vitejs/vite#12002 / PR #12014. Measured on the real build: a
 * 731 KB worker becomes a 975 KB URL (133.3%), encoded once per session in
 * ~5 ms (the URL is memoised); the per-run cost is one structured clone of
 * that string across postMessage, where the old code cloned the 663 K-char
 * source instead. It costs the boundary nothing: the frame stays opaque, keeps
 * connect-src 'none', and terminate() plus removing the frame remain
 * unconditional kills. `data:` is added to the frame's worker-src (and to
 * script-src/child-src, which engines without worker-src fall back to) — that
 * is the ONE scheme the transport needs and the only CSP change.
 *
 * blob: + a CLASSIC worker also loads in an opaque origin (measured), but it
 * would make production correctness depend on a build-only rewrite of
 * `import.meta.url` and on the worker bundle never gaining an import/export —
 * a constraint whose violation is invisible in dev and fatal in the build.
 * That is the failure class this codebase keeps paying for; 244 KB and 5 ms
 * is the cheaper side of that trade.
 *
 * ERRORS. A load-phase worker failure fires a plain Event with no `message`,
 * so the old `String(we.message || "worker error")` was structurally incapable
 * of saying anything true. Every failure now carries a SandboxErrorCode and a
 * sentence composed HERE, from SANDBOX_ERROR_SENTENCES — the frame supplies a
 * code and optional detail, never the user-visible string.
 *
 * Dev-mode note: Vite serves the worker as an ES module whose imports can't
 * resolve from a data: URL, so in dev the worker runs directly in the page
 * (module worker, no iframe). The QuickJS boundary still holds there; the full
 * double boundary is exercised by the production build. The dev path has no
 * worker boot handshake (there is nowhere to inject the probe), and says so in
 * words rather than pretending to know.
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
  /** Set on EVERY failure. `error` is the human sentence for this code. */
  code?: SandboxErrorCode;
  ms: number;
  killed?: boolean;
  capabilityCalls: Array<{ cap: string; args: unknown; ok: boolean; bytes: number }>;
}

/* ------------------------------------------------------------------ */
/* Error taxonomy                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every way a run can fail, with a human sentence for each. Two rules hold
 * these together and are unit-tested:
 *   1. TOTAL — no failure path may resolve without a code.
 *   2. HONEST — every sentence says what actually happened, in words. There is
 *      no code whose sentence is a shrug, and no path that emits a raw event
 *      field, an empty string, or a bare "worker error".
 */
export const SANDBOX_ERROR_SENTENCES = {
  SANDBOX_WORKER_SOURCE_UNAVAILABLE:
    "the sandbox worker's code could not be read out of this build, so no sandbox could be started",
  SANDBOX_FRAME_LOAD_FAILED:
    "the sandbox frame failed to load, so there was nowhere to run the tool",
  SANDBOX_FRAME_LOAD_TIMEOUT:
    "the sandbox frame never finished loading",
  SANDBOX_FRAME_NOT_READY:
    "the sandbox frame loaded but its bootstrap never reported ready, so nothing inside it is running",
  SANDBOX_ORIGIN_NOT_OPAQUE:
    "the sandbox frame reported a real origin instead of an opaque one, which means the isolation boundary is not in place; the run was refused rather than trusted",
  SANDBOX_TRANSPORT_REJECTED:
    "the sandbox frame refused the worker payload it was handed",
  SANDBOX_WORKER_CONSTRUCTOR_THREW:
    "constructing the sandbox worker threw before its script was ever fetched",
  SANDBOX_WORKER_NEVER_STARTED:
    "the sandbox worker never started — the browser refused to load its script and not one statement of it ran",
  SANDBOX_WORKER_BOOT_TIMEOUT:
    "the sandbox worker was constructed without error but never reported in, so its script either never executed or stalled before its first statement",
  SANDBOX_WORKER_RUNTIME_ERROR:
    "the sandbox worker threw after starting and stopped running",
  SANDBOX_MESSAGE_UNDELIVERABLE:
    "a message between the host and the sandbox worker could not be delivered, so this run's result is incomplete and was not trusted",
  SANDBOX_UNEXPECTED:
    "starting the sandbox failed in a way this code does not have a name for",
  RUN_TIMEOUT:
    "the run hit its time limit and the sandbox was terminated",
  TOOL_ERROR:
    "the tool's own run() function failed while the sandbox around it was working normally",
  TOOL_RESULT_TOO_LARGE:
    "the tool returned more data than one run is allowed to return",
  CAPABILITY_VIOLATION:
    "the tool called a capability outside the approved manifest",
  CAPABILITY_CALL_LIMIT:
    "the tool made more capability calls than one run is allowed",
} as const;

export type SandboxErrorCode = keyof typeof SANDBOX_ERROR_SENTENCES;

export const SANDBOX_ERROR_CODES = Object.keys(SANDBOX_ERROR_SENTENCES) as SandboxErrorCode[];

export function isSandboxErrorCode(v: unknown): v is SandboxErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SANDBOX_ERROR_SENTENCES, v);
}

/**
 * Prefix that marks "the harness broke, this decides nothing about the tool".
 * `foundryTools.ts` and `toolConformance.ts` both regex for it (`/^sandbox
 * unavailable/i`) to keep a dead sandbox from being scored as a failing tool —
 * so this string is load-bearing across files, not decoration.
 */
export const SANDBOX_UNAVAILABLE_PREFIX = "sandbox unavailable: ";

/** Compose the one and only user-visible sentence for a code. Never empty. */
export function sandboxErrorText(code: SandboxErrorCode, detail?: string): string {
  const d = typeof detail === "string" ? detail.trim() : "";
  return SANDBOX_ERROR_SENTENCES[code] + (d ? ` — ${d}` : "");
}

/** A failure that prevented a sandbox from existing at all. */
export class SandboxFailure extends Error {
  readonly code: SandboxErrorCode;
  readonly detail: string;
  constructor(code: SandboxErrorCode, detail = "") {
    super(sandboxErrorText(code, detail));
    this.name = "SandboxFailure";
    this.code = code;
    this.detail = typeof detail === "string" ? detail.trim() : "";
  }
}

function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message ? `${err.name}: ${err.message}` : `${err.name} (no message)`;
  const s = String(err ?? "");
  return s.trim() || "the browser gave no detail";
}

export function asSandboxFailure(err: unknown): SandboxFailure {
  return err instanceof SandboxFailure ? err : new SandboxFailure("SANDBOX_UNEXPECTED", describeThrown(err));
}

export interface CspViolation {
  type: "sandbox:cspViolation";
  /** Diagnostic context, deliberately NOT a SandboxErrorCode: a violation is
   *  never how a run fails, it is why the failure that follows happened. */
  code: "SANDBOX_CSP_VIOLATION";
  directive: string;
  blockedURI: string;
  sourceFile: string;
  lineno: number;
  disposition: string;
}

/**
 * Meta-delivered CSP strips report-uri/report-to, so the frame's
 * `securitypolicyviolation` listener is the only violation channel that frame
 * will ever have. Whatever it saw is appended to the failure that follows —
 * that is the entire point of collecting them.
 */
export function violationSuffix(violations: CspViolation[]): string {
  if (!violations.length) return "";
  const first = violations[0];
  const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
  return `; the frame's own CSP blocked ${first.blockedURI || "a load"} under ${first.directive}${more}`;
}

/**
 * Turn a `{code, detail}` message from the frame into a typed failure. The
 * frame is trusted for the CODE only; the sentence always comes from the table
 * above, so no string the frame could ever produce reaches a user unexplained.
 */
export function failureFromFrame(msg: unknown, violations: CspViolation[] = []): SandboxFailure {
  const m = (msg ?? {}) as Record<string, unknown>;
  const raw = m.code;
  const code: SandboxErrorCode = isSandboxErrorCode(raw) ? raw : "SANDBOX_UNEXPECTED";
  const detailParts: string[] = [];
  if (typeof m.detail === "string" && m.detail.trim()) detailParts.push(m.detail.trim().slice(0, 400));
  if (!isSandboxErrorCode(raw)) {
    detailParts.push(`the sandbox frame reported an unrecognised code ${JSON.stringify(String(raw ?? "<missing>")).slice(0, 80)}`);
  }
  const suffix = violationSuffix(violations);
  return new SandboxFailure(code, detailParts.join("; ") + suffix);
}

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

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

/** Frame document load. A 404 fires `load`, not `error`, and then trips the
 *  ready budget instead — which is the honest answer for a missing asset. */
const FRAME_LOAD_BUDGET_MS = 8_000;
/** Host backstop for the worker handshake. Deliberately LONGER than the
 *  frame's own 10s budget so the frame's more specific message wins the race
 *  whenever the frame is alive; this only fires if the frame itself is dead. */
const HOST_WORKER_BOOT_BUDGET_MS = 11_000;

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

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

/** The only worker transport the frame accepts. Mirrored in the frame. */
export const WORKER_URL_PREFIX = "data:text/javascript;base64,";
export const WORKER_BOOT_PROBE = "__sandboxWorkerBoot";
export const WORKER_EVALUATED_PROBE = "__sandboxWorkerEvaluated";

/**
 * Frame ↔ host control messages, namespaced so they can never be confused with
 * anything toolWorker.ts emits. This is not hygiene, it is a bug fix: the
 * worker has its own `ready` and `bootError` messages, and the frame forwards
 * worker messages verbatim — un-namespaced, a worker `ready` reads as the
 * frame's ready (and fails the opaque-origin assertion, because it carries no
 * origin), and a worker `bootError` reads as a transport failure. The frame
 * also refuses to forward anything from the worker in this namespace, so the
 * worker cannot forge frame-level control traffic.
 */
export const FRAME_MSG = {
  /** frame → host: the bootstrap ran; carries the frame's own origin. */
  frameReady: "sandbox:frameReady",
  /** frame → host: the worker could not be constructed at all. */
  bootError: "sandbox:bootError",
  /** frame → host: the injected probe fired — the worker script is running. */
  workerBoot: "sandbox:workerBoot",
  /** frame → host: the worker module body finished evaluating. */
  workerEvaluated: "sandbox:workerEvaluated",
  /** frame → host: the worker failed, before or after starting. */
  workerError: "sandbox:workerError",
  /** frame → host: constructed, no error, and never reported in. */
  workerBootTimeout: "sandbox:workerBootTimeout",
  /** frame → host: the frame's own CSP blocked something. */
  cspViolation: "sandbox:cspViolation",
  /** frame → host: terminate() was called. */
  killed: "sandbox:killed",
  /** host → frame: terminate the worker now. */
  kill: "sandbox:kill",
} as const;

/**
 * What toolWorker.ts has told us about the VM inside it. Purely observed —
 * the worker pushes `ready`/`bootError`/`fatal` unprompted, and the frame
 * installs its `onmessage` synchronously with `new Worker()`, so none of them
 * can be missed and the worker's `ping`/`pong` liveness query is not needed
 * here. Used to make a run timeout say which side of the VM boot it is on.
 */
export interface WorkerVmObservations {
  /** ms the worker reported for "QuickJS booted and smoke-tested". */
  readyMs: number | null;
  /** the worker's own words if its VM boot failed (it stays alive and retries). */
  bootError: string;
  /** an uncaught error or rejection the worker reported. */
  fatal: string;
}

/**
 * Prepended to the built worker text, so it is the FIRST statement of the
 * module body. Receiving it proves the script was fetched, parsed and started
 * executing — precisely the fact a bare load-phase `Event` cannot tell us, and
 * the thing that separates "never started" from "started and hung".
 *
 * Constant text. Nothing from a tool, a user or a model is ever interpolated
 * into the worker source; see the static-payload test.
 */
export const WORKER_BOOT_PROBE_SOURCE =
  "/* injected by toolSandbox.ts: worker liveness probe */\n" +
  'try { self.postMessage({ type: "' + WORKER_BOOT_PROBE + '" }); } catch (e) { /* no host */ }\n';

/**
 * Appended. Fires once the module body has finished evaluating, which
 * distinguishes "top-level code is still running" from "top-level finished and
 * we are waiting on a handler". Informational only — it never fails a run, so
 * a worker whose top level legitimately takes a while is not punished for it.
 */
export const WORKER_EVALUATED_PROBE_SOURCE =
  '\n;try { self.postMessage({ type: "' + WORKER_EVALUATED_PROBE + '" }); } catch (e) { /* no host */ }\n';

/**
 * UTF-8 bytes → base64, chunked so a ~730 KB payload never hits the argument
 * limit of Function.prototype.apply. The binary string is assembled in full
 * and encoded ONCE: base64 may only be concatenated at 3-byte boundaries, and
 * encoding per chunk is the classic way to get that subtly wrong.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const STEP = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]);
  }
  return btoa(binary);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export interface WorkerPayload {
  /** data:text/javascript;base64,... — ready to hand to the frame. */
  url: string;
  /** Bytes of JavaScript, probes included. */
  sourceBytes: number;
  /** Characters of data: URL. sourceBytes × ~1.34 + the scheme prefix. */
  urlChars: number;
}

/**
 * Build the worker's data: URL once per session. The bytes are taken from the
 * response as an ArrayBuffer rather than as text, so the built asset crosses
 * byte-exact — no decode/re-encode round trip that a non-ASCII character
 * (a smart quote or an emoji inside a string literal) could survive wrongly.
 */
export function buildWorkerPayload(assetBytes: Uint8Array): WorkerPayload {
  const enc = new TextEncoder();
  const bytes = concatBytes([
    enc.encode(WORKER_BOOT_PROBE_SOURCE),
    assetBytes,
    enc.encode(WORKER_EVALUATED_PROBE_SOURCE),
  ]);
  const url = WORKER_URL_PREFIX + bytesToBase64(bytes);
  return { url, sourceBytes: bytes.length, urlChars: url.length };
}

let workerPayloadPromise: Promise<WorkerPayload> | null = null;

async function getWorkerPayload(): Promise<WorkerPayload> {
  if (!workerPayloadPromise) {
    workerPayloadPromise = (async () => {
      let res: Response;
      try {
        res = await fetch(workerUrl);
      } catch (e) {
        throw new SandboxFailure("SANDBOX_WORKER_SOURCE_UNAVAILABLE", `fetching ${workerUrl} threw: ${describeThrown(e)}`);
      }
      if (!res.ok) {
        throw new SandboxFailure("SANDBOX_WORKER_SOURCE_UNAVAILABLE", `fetching ${workerUrl} returned HTTP ${res.status}`);
      }
      const assetBytes = new Uint8Array(await res.arrayBuffer());
      if (assetBytes.length === 0) {
        throw new SandboxFailure("SANDBOX_WORKER_SOURCE_UNAVAILABLE", `${workerUrl} was empty`);
      }
      return buildWorkerPayload(assetBytes);
    })();
    // Don't cache a failure: a transient fetch error must not disable the
    // sandbox for the rest of the session.
    workerPayloadPromise.catch(() => { workerPayloadPromise = null; });
  }
  return workerPayloadPromise;
}

/**
 * Anything that arrives over the port: from the frame, or forwarded from the
 * worker. Deliberately untyped beyond "a bag of fields" — the sender is across
 * a boundary, so every field is checked at the point of use rather than
 * trusted from a declaration.
 */
type WireMessage = Record<string, unknown> | null | undefined;

type WireHandler = (data: WireMessage) => void;

interface Channel {
  post: (msg: Record<string, unknown>) => void;
  onMessage: (fn: WireHandler) => void;
  kill: () => void;
  dispose: () => void;
  /** ms from Worker construction to the worker's first sign of life, or null
   *  on a path that has no boot probe (dev). Never guessed. */
  workerBootMs: number | null;
  /** CSP violations reported by the frame, oldest first. */
  violations: CspViolation[];
  /** Whatever the worker has volunteered about its own VM. */
  vm: WorkerVmObservations;
}

function clip(v: unknown, n: number): string {
  const s = String(v ?? "").trim();
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/**
 * A message sink that buffers until a real handler is installed. There is a
 * microtask gap between openProdChannel() resolving and runToolSandboxed()
 * registering its handler; a worker error landing in that gap used to be
 * dropped, turning a precise failure into a ten-second timeout.
 */
function makeSink(violations: CspViolation[], vm: WorkerVmObservations) {
  let live: WireHandler | null = null;
  let queued: WireMessage[] = [];
  return {
    deliver(d: WireMessage) {
      if (d && typeof d === "object") {
        // Recorded on the way past, wherever in the lifecycle it arrives, so a
        // later failure can quote it instead of guessing.
        if (d.type === FRAME_MSG.cspViolation) violations.push(d as unknown as CspViolation);
        else if (d.type === "ready") vm.readyMs = Number(d.ms) || 0;
        else if (d.type === "bootError") vm.bootError = clip(d.error, 300) || "the worker reported a VM boot failure with no message";
        else if (d.type === "fatal") vm.fatal = `${clip(d.phase, 40) || "error"}: ${clip(d.message, 300) || "no message"}`;
      }
      if (live) live(d);
      else queued.push(d);
    },
    install(fn: WireHandler) {
      live = fn;
      const q = queued;
      queued = [];
      for (const d of q) fn(d);
    },
    /** Go back to buffering. Used the moment the boot handshake settles, so
     *  the gap before the run handler is installed queues instead of leaking. */
    detach() { live = null; },
  };
}

/** Dev: module worker directly in the page (see header note). */
function openDevChannel(): Channel {
  const violations: CspViolation[] = [];
  const vm: WorkerVmObservations = { readyMs: null, bootError: "", fatal: "" };
  const sink = makeSink(violations, vm);
  const worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = (e) => sink.deliver(e.data);
  worker.onerror = (we) => {
    // Dev has no injected probe, so "never started" and "threw at runtime" are
    // told apart by the only signal available: a same-origin module worker
    // that throws at runtime carries a message; a load failure does not.
    const message = we && typeof (we as ErrorEvent).message === "string" ? (we as ErrorEvent).message : "";
    const cls = (we as { constructor?: { name?: string } })?.constructor?.name || "Event";
    sink.deliver({
      type: FRAME_MSG.workerError,
      code: message ? "SANDBOX_WORKER_RUNTIME_ERROR" : "SANDBOX_WORKER_NEVER_STARTED",
      detail: message || `the browser reported a bare ${cls} with no message while loading ${workerUrl}`,
    });
  };
  worker.onmessageerror = () => {
    sink.deliver({
      type: FRAME_MSG.workerError,
      code: "SANDBOX_MESSAGE_UNDELIVERABLE",
      detail: "a message posted by the dev-mode worker could not be deserialised",
    });
  };
  return {
    post: (m) => { try { worker.postMessage(m); } catch { /* terminated */ } },
    onMessage: (fn) => sink.install(fn),
    kill: () => worker.terminate(),
    dispose: () => worker.terminate(),
    workerBootMs: null,
    violations,
    vm,
  };
}

function awaitFrameLoad(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(
      () => reject(new SandboxFailure("SANDBOX_FRAME_LOAD_TIMEOUT", `${SANDBOX_DOC_PATH} did not fire load within ${FRAME_LOAD_BUDGET_MS}ms`)),
      FRAME_LOAD_BUDGET_MS,
    );
    iframe.onload = () => { window.clearTimeout(t); resolve(); };
    iframe.onerror = () => {
      window.clearTimeout(t);
      reject(new SandboxFailure("SANDBOX_FRAME_LOAD_FAILED", `the browser could not load ${SANDBOX_DOC_PATH}`));
    };
  });
}

/** Prod: fresh sandboxed iframe + data: module worker per run. */
async function openProdChannel(): Promise<Channel> {
  const payload = await getWorkerPayload();
  const iframe = document.createElement("iframe");
  // NEVER add allow-same-origin. Combined with allow-scripts it lets the
  // framed document remove its own sandbox attribute, which would hand
  // model-authored code this app's origin, its Supabase session and its
  // storage. The frame reports its origin on ready and we refuse anything but
  // "null" below, so a regression here fails loudly instead of silently.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");
  iframe.src = new URL(SANDBOX_DOC_PATH, document.baseURI).href;

  const violations: CspViolation[] = [];
  const vm: WorkerVmObservations = { readyMs: null, bootError: "", fatal: "" };
  const sink = makeSink(violations, vm);
  let bootHandler: WireHandler = () => undefined;
  let channel: MessageChannel | null = null;
  document.body.appendChild(iframe);
  // Everything past the append must tear the frame down on failure, or every
  // boot error leaks a hidden frame (potentially still running a worker with
  // no kill timer attached, since runToolSandboxed returns before arming one).
  try {
    await awaitFrameLoad(iframe);
    channel = new MessageChannel();
    channel.port1.onmessage = (e) => sink.deliver(e.data);
    sink.install((d) => bootHandler(d));
    // Opaque-origin frame: targetOrigin must be "*", which is fine — the only
    // payload crossing here is our own worker code; secrets never do. The
    // frame checks e.source === window.parent before accepting this.
    iframe.contentWindow?.postMessage({ type: "boot", workerUrl: payload.url }, "*", [channel.port2]);

    const bootStarted = Date.now();
    let sawReady = false;
    let workerBootMs: number | null = null;

    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => {
        // Which silence this is depends on how far the frame got, and that is
        // exactly the distinction the old single timeout could not make.
        reject(sawReady
          ? new SandboxFailure("SANDBOX_WORKER_BOOT_TIMEOUT", `no sign of life ${HOST_WORKER_BOOT_BUDGET_MS}ms after the frame said it had constructed the worker, and the frame reported nothing either${violationSuffix(violations)}`)
          : new SandboxFailure("SANDBOX_FRAME_NOT_READY", `${SANDBOX_DOC_PATH} loaded but posted nothing back within ${HOST_WORKER_BOOT_BUDGET_MS}ms${violationSuffix(violations)}`));
      }, HOST_WORKER_BOOT_BUDGET_MS);
      const settle = (fn: () => void) => { window.clearTimeout(t); fn(); };
      bootHandler = (d) => {
        if (!d || typeof d !== "object") return;
        switch (d.type) {
          case FRAME_MSG.frameReady:
            sawReady = true;
            // Runtime proof that the boundary is what the code claims. The
            // only way this is not "null" is if allow-same-origin came back.
            if (String(d.origin) !== "null") {
              settle(() => reject(new SandboxFailure(
                "SANDBOX_ORIGIN_NOT_OPAQUE",
                `the frame reported origin ${JSON.stringify(String(d.origin)).slice(0, 120)}`,
              )));
            }
            return;
          case FRAME_MSG.workerBoot:
            workerBootMs = Date.now() - bootStarted;
            settle(resolve);
            return;
          case FRAME_MSG.bootError:
          case FRAME_MSG.workerError:
          case FRAME_MSG.workerBootTimeout:
            settle(() => reject(failureFromFrame(d, violations)));
            return;
          default:
            // Everything else — including the worker's own `ready`/`bootError`
            // /`fatal` — is recorded by the sink and read later. A VM boot
            // failure deliberately does NOT fail the channel: the worker stays
            // alive and retries, and the run itself will report the reason.
            return;
        }
      };
    });

    // The boot handler is done; anything the worker says between here and the
    // run handler being installed must queue, not vanish.
    sink.detach();

    const port = channel.port1;
    return {
      post: (m) => { try { port.postMessage(m); } catch { /* disposed */ } },
      onMessage: (fn) => sink.install(fn),
      kill: () => { try { port.postMessage({ type: FRAME_MSG.kill }); } catch { /* disposed */ } },
      dispose: () => {
        // Two independent kills: terminate() inside the frame, and destroying
        // the frame's document — which terminates its workers whether or not
        // the message above was ever processed.
        try { port.postMessage({ type: FRAME_MSG.kill }); } catch { /* disposed */ }
        try { iframe.remove(); } catch { /* removed */ }
        try { port.close(); } catch { /* closed */ }
      },
      workerBootMs,
      violations,
      vm,
    };
  } catch (e) {
    try { channel?.port1.close(); } catch { /* closed */ }
    try { iframe.remove(); } catch { /* removed */ }
    throw asSandboxFailure(e);
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

/**
 * What to say when a run hits the wall. The boot handshake is what makes this
 * honest: with it we can state that the worker DID start, so the stall is
 * inside the worker rather than in loading it.
 */
export function runTimeoutDetail(
  workerBootMs: number | null,
  vm: WorkerVmObservations = { readyMs: null, bootError: "", fatal: "" },
): string {
  const notes: string[] = [];
  if (workerBootMs === null) {
    notes.push("this path has no worker boot handshake, so a worker that never started and a tool that never returned look the same from here");
  } else {
    notes.push(`the sandbox worker did start (it reported in ${workerBootMs}ms after construction) but produced no result`);
  }
  // What the worker said about its own VM turns "it hung" into "it hung HERE".
  if (vm.readyMs !== null) notes.push(`its QuickJS VM reported itself usable after ${vm.readyMs}ms, so the stall is in the run, not the VM boot`);
  else if (vm.bootError) notes.push(`its QuickJS VM never became usable: ${vm.bootError}`);
  else notes.push("its QuickJS VM never reported itself usable, so the stall is at or before the VM boot");
  if (vm.fatal) notes.push(`it also reported an uncaught ${vm.fatal}`);
  notes.push("the sandbox was terminated");
  return notes.join("; ");
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
    const f = asSandboxFailure(e);
    return {
      ok: false,
      code: f.code,
      error: SANDBOX_UNAVAILABLE_PREFIX + f.message,
      ms: Date.now() - started,
      capabilityCalls,
    };
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
      finish({
        ok: false,
        code: "RUN_TIMEOUT",
        // The "timed out after Nms" opening is kept because it is what a human
        // reads first; everything after it is the part that was missing.
        error: `timed out after ${timeoutMs}ms — ${runTimeoutDetail(channel.workerBootMs, channel.vm)}${violationSuffix(channel.violations)}`,
        killed: true,
        ms: Date.now() - started,
        capabilityCalls,
      });
    }, timeoutMs);

    channel.onMessage((d) => {
      if (!d || typeof d !== "object") return;
      if (d.runId !== runId) {
        // Control traffic — from the frame or from the worker — arrives
        // without a runId. Anything that ends the run must end it HERE, or it
        // becomes a ten-second silence followed by a misleading timeout.
        if (d.type === FRAME_MSG.workerError) {
          const f = failureFromFrame(d, channel.violations);
          finish({
            ok: false,
            code: f.code,
            // Infrastructure, not the tool: the "sandbox unavailable" prefix is
            // what keeps the conformance harness from scoring this against a
            // program that may be perfectly correct.
            error: SANDBOX_UNAVAILABLE_PREFIX + f.message,
            ms: Date.now() - started,
            capabilityCalls,
          });
          return;
        }
        // The worker's own uncaught-error channel. An uncaught *error* means
        // the task that threw cannot go on to post a result, so waiting for
        // one is waiting for nothing. An unhandled *rejection* is ambiguous —
        // the run may still finish — so it is only recorded, and surfaces in
        // the timeout message if the run never does finish.
        if (d.type === "fatal" && String(d.phase) === "error") {
          channel.kill();
          finish({
            ok: false,
            code: "SANDBOX_WORKER_RUNTIME_ERROR",
            error: SANDBOX_UNAVAILABLE_PREFIX + sandboxErrorText(
              "SANDBOX_WORKER_RUNTIME_ERROR",
              `the worker reported an uncaught error: ${clip(d.message, 300) || "no message"}${d.filename ? ` (at ${clip(d.filename, 160)}:${Number(d.lineno) || 0})` : ""}`,
            ),
            killed: true,
            ms: Date.now() - started,
            capabilityCalls,
          });
        }
        return;
      }
      if (d.type === "capViolation") {
        // The tool called outside its approved manifest — approval was for a
        // different program. Hard-fail the run.
        channel.kill();
        finish({
          ok: false,
          code: "CAPABILITY_VIOLATION",
          error: `capability violation: '${String(d.cap)}' is not in the approved manifest`,
          killed: true,
          ms: Date.now() - started,
          capabilityCalls,
        });
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
          finish({
            ok: false,
            code: "CAPABILITY_CALL_LIMIT",
            error: `capability call limit reached (${CAP_MAX_CALLS} per run)`,
            killed: true,
            ms: Date.now() - started,
            capabilityCalls,
          });
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
            finish({
              ok: false,
              code: "TOOL_RESULT_TOO_LARGE",
              error: `result too large (${bytes} bytes; the cap for one run is ${resultCap})`,
              ms: Number(d.ms) || Date.now() - started,
              capabilityCalls,
            });
          } else {
            finish({ ok: true, value, ms: Number(d.ms) || Date.now() - started, capabilityCalls });
          }
        } else {
          // The worker's own words when it has any — it is closest to the
          // failure. When it has none, say so rather than inventing "tool
          // failed" and letting a repair loop chase a message that means
          // nothing.
          const reported = String(d.error ?? "").trim();
          finish({
            ok: false,
            code: "TOOL_ERROR",
            error: reported || `${SANDBOX_ERROR_SENTENCES.TOOL_ERROR} and the sandbox worker reported no message with it`,
            ms: Number(d.ms) || Date.now() - started,
            capabilityCalls,
          });
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
