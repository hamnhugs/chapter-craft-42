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
 * Protocol (every message carries the runId; anything else is dropped):
 *   in:  { type: "run", runId, code, argsJson, capabilities, limits }
 *   out: { type: "cap", runId, callId, cap, argsJson }   capability request
 *   in:  { type: "capResult", runId, callId, ok, valueJson?, error? }
 *   out: { type: "result", runId, ok, valueJson?, error?, ms }
 */

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
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

const modulePromise = newQuickJSWASMModuleFromVariant(variant);

let activeRunId: string | null = null;
const pendingCaps = new Map<number, { resolve: (json: string) => void; reject: (err: string) => void }>();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "run") void handleRun(msg as RunMsg);
  else if (msg.type === "capResult") handleCapResult(msg as CapResultMsg);
};

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
  const post = (out: Record<string, unknown>) => (self as unknown as Worker).postMessage({ runId: msg.runId, ...out });
  try {
    const QuickJS = await modulePromise;
    const runtime = QuickJS.newRuntime();
    const deadline = Date.now() + Math.min(60000, Math.max(1000, msg.limits.deadlineMs));
    runtime.setInterruptHandler(() => Date.now() > deadline);
    runtime.setMemoryLimit(Math.min(128 * 1024 * 1024, Math.max(8 * 1024 * 1024, msg.limits.memBytes)));
    runtime.setMaxStackSize(Math.min(2 * 1024 * 1024, Math.max(256 * 1024, msg.limits.stackBytes)));
    const ctx = runtime.newContext();
    const allowed = new Set(msg.capabilities);
    let nextCallId = 1;

    try {
      // The single host bridge. Returns a VM promise; resolution is pumped
      // through executePendingJobs when the host's capResult arrives.
      const capFn = ctx.newFunction("__cap", (nameH, argsH) => {
        const cap = ctx.getString(nameH);
        const argsJson = ctx.getString(argsH);
        const deferred = ctx.newPromise();
        if (!allowed.has(cap)) {
          deferred.reject(ctx.newError(`capability '${cap}' is not in this tool's approved manifest`));
          deferred.settled.then(() => ctx.runtime.executePendingJobs()).catch(() => { /* pumped */ });
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
            ctx.runtime.executePendingJobs();
          },
          reject: (err) => {
            const h = ctx.newError(String(err).slice(0, 300));
            deferred.reject(h);
            ctx.runtime.executePendingJobs();
          },
        });
        deferred.settled.then(() => ctx.runtime.executePendingJobs()).catch(() => { /* pumped */ });
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
      ctx.runtime.executePendingJobs();
      const settled = await ctx.resolvePromise(callHandle);
      callHandle.dispose();
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
      pendingCaps.clear();
      try { ctx.dispose(); } catch { /* leak-only failure */ }
      try { runtime.dispose(); } catch { /* leak-only failure */ }
    }
  } catch (err) {
    post({ type: "result", ok: false, error: String((err as Error)?.message || err).slice(0, 500), ms: Date.now() - started });
  } finally {
    activeRunId = null;
  }
}
