/**
 * Tool Foundry sandbox worker — the INNER boundary.
 *
 * Runs AI-authored tool code inside QuickJS compiled to WebAssembly (the
 * Figma plugin architecture): a separate JS engine whose world contains ONLY
 * what we inject. No fetch, no DOM, no timers, no globals leak — host and
 * guest object representations are structurally different, which kills the
 * object-identity-confusion escape class.
 *
 * In production this file's built text is fetched by the parent and
 * re-instantiated as a blob: Worker INSIDE an opaque-origin, connect-src
 * 'none' iframe (the OUTER boundary) — so even a total VM compromise lands in
 * a realm with no network and no storage. worker.terminate() is the hard kill.
 *
 * THE PUMP CONTRACT — read before touching anything below.
 * QuickJS does not run its own microtask queue. Every VM promise reaction is
 * a "pending job" that only executes when the host calls executePendingJobs().
 * `ctx.resolvePromise(h)` works by installing VM-side .then callbacks that
 * call back out to the host — so those callbacks are themselves pending jobs.
 * Awaiting resolvePromise() WITHOUT draining afterwards therefore waits for a
 * callback that can never run: no error, no rejection, no result, forever.
 * Rule: drain AFTER anything that can queue a job, never only before.
 *
 * Protocol (run frames carry the runId; anything else is dropped):
 *   out: { type: "ready", ms }                          QuickJS booted + usable
 *   out: { type: "bootError", error, stack, ms }        QuickJS failed to boot
 *   out: { type: "fatal", phase, message, stack, … }    uncaught error anywhere
 *   in:  { type: "ping" }
 *   out: { type: "pong", state: "booting"|"ready"|"failed", error? }
 *   in:  { type: "run", runId, code, argsJson, capabilities, limits }
 *   out: { type: "cap", runId, callId, cap, argsJson }   capability request
 *   in:  { type: "capResult", runId, callId, ok, valueJson?, error? }
 *   out: { type: "capViolation", runId, cap }            off-manifest call
 *   out: { type: "result", runId, ok, valueJson?, error?, ms }
 */

import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";

interface RunMsg {
  type: "run";
  runId: string;
  code: string;
  argsJson: string;
  capabilities: string[];
  limits: { memBytes: number; stackBytes: number; deadlineMs: number; resultCapBytes: number };
}

interface CapResultMsg {
  type: "capResult";
  runId: string;
  callId: number;
  ok: boolean;
  valueJson?: string;
  error?: string;
}

// The VM-side prelude. `__cap(name, argsJson)` is the single injected host
// function; `caps` wraps it in a friendly proxy: `await caps.memory_search({...})`.
const PRELUDE = `"use strict";
globalThis.caps = new Proxy(Object.create(null), {
  get: (_, name) => (args) => __cap(String(name), JSON.stringify(args === undefined ? {} : args)).then((s) => JSON.parse(s)),
});
`;

/** Everything the worker says. Only structured-cloneable primitives cross. */
const emit = (out: Record<string, unknown>): void => {
  (self as unknown as Worker).postMessage(out);
};

const describeError = (err: unknown): { message: string; stack: string } => {
  const e = err as { message?: unknown; stack?: unknown } | null | undefined;
  return {
    message: String((e && e.message) ?? err ?? "unknown error").slice(0, 500),
    stack: String((e && e.stack) ?? "").slice(0, 2000),
  };
};

// The worker must never be able to die quietly again. An ErrorEvent's `.error`
// and a rejection's `.reason` are frequently NOT structured-cloneable (Error
// subclasses with host objects attached), so only strings/numbers are posted.
self.addEventListener("error", (e: ErrorEvent) => {
  emit({
    type: "fatal",
    phase: "error",
    message: String(e.message || "uncaught error in sandbox worker").slice(0, 500),
    stack: describeError(e.error).stack,
    filename: String(e.filename || ""),
    lineno: Number(e.lineno || 0),
    colno: Number(e.colno || 0),
  });
});

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const d = describeError(e.reason);
  emit({ type: "fatal", phase: "unhandledrejection", message: d.message, stack: d.stack, filename: "", lineno: 0, colno: 0 });
});

// ---------------------------------------------------------------------------
// QuickJS module lifecycle
// ---------------------------------------------------------------------------

type BootState = "booting" | "ready" | "failed";
let bootState: BootState = "booting";
let bootError = "";

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Lazy + memoised so two runs can never build two VMs — but a REJECTION is
 *  evicted, so one transient boot failure does not poison the sandbox for the
 *  rest of the session. */
function getQuickJS(): Promise<QuickJSWASMModule> {
  if (modulePromise) return modulePromise;
  const attempt: Promise<QuickJSWASMModule> = newQuickJSWASMModuleFromVariant(variant).catch((err) => {
    if (modulePromise === attempt) modulePromise = null;
    throw err;
  });
  modulePromise = attempt;
  return attempt;
}

function markReady(ms: number): void {
  if (bootState === "ready") return;
  bootState = "ready";
  bootError = "";
  emit({ type: "ready", ms });
}

/** Warm the VM at startup and tell the host. "ready" means *usable*, not
 *  merely "the promise settled" — a throwaway runtime is built and evaluated
 *  in, so the host's handshake can distinguish "never booted" from
 *  "booted and busy" without lying about a half-initialised module. */
async function boot(): Promise<void> {
  const started = Date.now();
  try {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    try {
      const ctx = runtime.newContext();
      try {
        const probe = ctx.evalCode("1+1");
        if ("error" in probe && probe.error) {
          probe.error.dispose();
          throw new Error("QuickJS smoke test failed to evaluate");
        }
        const value = probe.unwrap();
        const n = ctx.getNumber(value);
        value.dispose();
        if (n !== 2) throw new Error(`QuickJS smoke test returned ${String(n)}`);
      } finally {
        ctx.dispose();
      }
    } finally {
      runtime.dispose();
    }
    markReady(Date.now() - started);
  } catch (err) {
    bootState = "failed";
    const d = describeError(err);
    bootError = d.message;
    emit({ type: "bootError", error: d.message, stack: d.stack, ms: Date.now() - started });
  }
}
void boot();

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------

let activeRunId: string | null = null;
const pendingCaps = new Map<number, { resolve: (json: string) => void; reject: (err: string) => void }>();

/** Runs are serialised. Two overlapping runs would share activeRunId and the
 *  pendingCaps map and silently steal each other's capability results — which
 *  presents as exactly the hang this module exists to make impossible. */
let runQueue: Promise<void> = Promise.resolve();

// addEventListener, not `self.onmessage = …`: the onmessage slot has exactly
// one owner, so assigning it makes this module fight anything else that ships
// in the same worker (emscripten glue, an injected prelude, a host shim) with
// last-writer-wins — and the loser's messages vanish without a trace.
self.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "run") {
    const run = msg as RunMsg;
    // The .catch is load-bearing: handleRun is written not to reject, but if it
    // ever did (a non-cloneable postMessage, say) a rejected runQueue would
    // swallow every subsequent run without a word.
    runQueue = runQueue.then(() => handleRun(run)).catch((err) => {
      try {
        const d = describeError(err);
        emit({ type: "result", runId: run.runId, ok: false, error: `sandbox worker failed: ${d.message}`, ms: 0 });
      } catch { /* the host is gone; nothing left to report to */ }
    });
  } else if (msg.type === "capResult") {
    handleCapResult(msg as CapResultMsg);
  } else if (msg.type === "ping") {
    emit({ type: "pong", state: bootState, error: bootError || undefined });
  }
});

function handleCapResult(msg: CapResultMsg): void {
  if (msg.runId !== activeRunId) return;
  const pending = pendingCaps.get(msg.callId);
  if (!pending) return;
  pendingCaps.delete(msg.callId);
  if (msg.ok) pending.resolve(msg.valueJson ?? "null");
  else pending.reject(String(msg.error || "capability failed"));
}

async function handleRun(msg: RunMsg): Promise<void> {
  const started = Date.now();
  activeRunId = msg.runId;
  const post = (out: Record<string, unknown>) => emit({ runId: msg.runId, ...out });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const QuickJS = await getQuickJS();
    markReady(Date.now() - started);
    const runtime = QuickJS.newRuntime();
    const budgetMs = Math.min(60000, Math.max(1000, msg.limits.deadlineMs));
    const deadline = Date.now() + budgetMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    runtime.setMemoryLimit(Math.min(128 * 1024 * 1024, Math.max(8 * 1024 * 1024, msg.limits.memBytes)));
    runtime.setMaxStackSize(Math.min(2 * 1024 * 1024, Math.max(256 * 1024, msg.limits.stackBytes)));
    const ctx = runtime.newContext();
    const allowed = new Set(msg.capabilities);
    let nextCallId = 1;
    let vmDisposed = false;

    // Lets a failure raised while pumping from inside a message handler settle
    // the run. Throwing there would only surface as an uncaught exception and
    // leave the awaiting run suspended — another silent hang.
    let failRun: (err: Error) => void = () => {};
    const runFailure = new Promise<never>((_, reject) => { failRun = reject; });

    /** Run every VM microtask that is currently due, plus anything they queue.
     *  QuickJS never does this by itself. Bounded by the same deadline so a
     *  job that re-queues itself forever cannot spin the host loop. */
    const drain = (): void => {
      while (!vmDisposed && runtime.hasPendingJob()) {
        if (Date.now() > deadline) throw new Error(`tool exceeded its ${budgetMs}ms deadline`);
        const jobs = runtime.executePendingJobs();
        if ("error" in jobs && jobs.error) {
          const errText = ctx.dump(jobs.error);
          jobs.error.dispose();
          throw new Error(`tool threw: ${JSON.stringify(errText).slice(0, 300)}`);
        }
      }
    };
    const drainSafely = (): void => {
      if (vmDisposed) return;
      try { drain(); } catch (err) { failRun(err as Error); }
    };

    try {
      // The single host bridge. Returns a VM promise; resolution is pumped
      // through executePendingJobs when the host's capResult arrives.
      const capFn = ctx.newFunction("__cap", (nameH, argsH) => {
        const cap = ctx.getString(nameH);
        const argsJson = ctx.getString(argsH);
        const deferred = ctx.newPromise();
        if (!allowed.has(cap)) {
          // .consume: reject() does NOT take ownership of the handle, so a
          // bare newError() leaks a JSValue per rejected call — a tool looping
          // on a failing capability would OOM against the 64MB runtime limit.
          ctx.newError(`capability '${cap}' is not in this tool's approved manifest`).consume((h) => deferred.reject(h));
          // Deferred to a host microtask on purpose: __cap is running INSIDE
          // the VM right now, and pumping jobs re-entrantly from a job is not
          // allowed. The microtask lands after the current drain unwinds.
          deferred.settled.then(drainSafely).catch(() => { /* pumped */ });
          // Out-of-manifest calls are also reported so the host can audit and
          // kill the run — approval was granted for a different program.
          post({ type: "capViolation", cap });
          return deferred.handle;
        }
        const callId = nextCallId++;
        pendingCaps.set(callId, {
          resolve: (json) => {
            const h = ctx.newString(json);
            deferred.resolve(h);
            h.dispose();
            drainSafely();
          },
          reject: (err) => {
            ctx.newError(String(err).slice(0, 300)).consume((h) => deferred.reject(h));
            drainSafely();
          },
        });
        deferred.settled.then(drainSafely).catch(() => { /* pumped */ });
        post({ type: "cap", callId, cap, argsJson });
        return deferred.handle;
      });
      capFn.consume((f) => ctx.setProp(ctx.global, "__cap", f));

      const argsStr = ctx.newString(msg.argsJson);
      argsStr.consume((s) => ctx.setProp(ctx.global, "__argsJson", s));

      const prelude = ctx.evalCode(PRELUDE);
      if ("error" in prelude && prelude.error) { prelude.error.dispose(); throw new Error("sandbox prelude failed"); }
      prelude.unwrap().dispose();

      const defined = ctx.evalCode(`${msg.code}\n;if (typeof run !== "function") { throw new Error("tool code must define function run(args, caps)"); }`);
      if ("error" in defined && defined.error) {
        const errText = ctx.dump(defined.error);
        defined.error.dispose();
        throw new Error(`tool code failed to load: ${JSON.stringify(errText).slice(0, 300)}`);
      }
      defined.unwrap().dispose();

      const call = ctx.evalCode(`Promise.resolve(run(JSON.parse(__argsJson), caps)).then((v) => JSON.stringify(v === undefined ? null : v))`);
      if ("error" in call && call.error) {
        const errText = ctx.dump(call.error);
        call.error.dispose();
        throw new Error(`tool invocation failed: ${JSON.stringify(errText).slice(0, 300)}`);
      }
      const callHandle = call.unwrap();
      // resolvePromise does its work synchronously (it installs VM-side .then
      // reactions), so the handle is dead weight the moment it returns —
      // dropping it here means the deadline path cannot leak it either.
      const settledPromise = ctx.resolvePromise(callHandle);
      callHandle.dispose();
      // THE PUMP. Those reactions are pending jobs; without this the await
      // below never settles. Draining before resolvePromise (as this once did)
      // pumps a queue that does not yet contain the callback we are waiting on.
      drain();

      // The interrupt handler only bites while the VM is executing. A tool
      // parked on a capability the host never answers is not executing, so the
      // deadline needs a host-side timer too or the run hangs forever.
      const deadlineExceeded = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error(`tool exceeded its ${budgetMs}ms deadline`)),
          Math.max(0, deadline - Date.now()),
        );
      });

      const settled = await Promise.race([settledPromise, runFailure, deadlineExceeded]);
      if ("error" in settled && settled.error) {
        const errText = ctx.dump(settled.error);
        settled.error.dispose();
        throw new Error(`tool threw: ${JSON.stringify(errText).slice(0, 300)}`);
      }
      const resultHandle = settled.unwrap();
      const valueJson = ctx.getString(resultHandle);
      resultHandle.dispose();
      if (valueJson.length > msg.limits.resultCapBytes) {
        throw new Error(`result too large (${valueJson.length} bytes; cap ${msg.limits.resultCapBytes})`);
      }
      post({ type: "result", ok: true, valueJson, ms: Date.now() - started });
    } finally {
      // vmDisposed first: a late capResult or a settled-microtask must not
      // pump a runtime that is about to be freed.
      vmDisposed = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      pendingCaps.clear();
      // Both races lose once the run is over; keep their rejections attached
      // so a timer that already fired cannot surface as an unhandledrejection.
      runFailure.catch(() => { /* run already settled */ });
      try { ctx.dispose(); } catch { /* leak-only failure */ }
      try { runtime.dispose(); } catch { /* leak-only failure */ }
    }
  } catch (err) {
    post({ type: "result", ok: false, error: String((err as Error)?.message || err).slice(0, 500), ms: Date.now() - started });
  } finally {
    activeRunId = null;
  }
}
