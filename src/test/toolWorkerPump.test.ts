import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression coverage for the sandbox worker's INNER loop.
 *
 * The bug these tests exist to prevent: QuickJS does not run its own microtask
 * queue. `ctx.resolvePromise(handle)` works by installing VM-side .then
 * callbacks that call back out to the host — so those callbacks are themselves
 * *pending jobs*. Awaiting resolvePromise() without draining afterwards waits
 * on a callback that can never run: no result, no error, no rejection, no
 * timeout. The worker just goes quiet forever.
 *
 * Every "must not hang" test below is therefore load-bearing: before the fix
 * they did not fail with a wrong value, they failed by never finishing.
 *
 * toolWorker.ts is a worker module, but nothing in its run path touches a
 * worker-only API — it talks to `self` via addEventListener/postMessage, both
 * of which jsdom's window provides. So the real QuickJS-WASM pipeline runs
 * here, in-process, exactly as it does in the browser.
 */

const WORKER_SRC = readFileSync(resolve(process.cwd(), "src/sandbox/toolWorker.ts"), "utf8");
const VITE_CONFIG = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

type Frame = Record<string, unknown> & { type?: string };

let frames: Frame[] = [];

const DEFAULT_LIMITS = { memBytes: 67108864, stackBytes: 524288, deadlineMs: 8000, resultCapBytes: 32768 };

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

/** Wait for a frame matching `match`, or explode with what actually arrived —
 *  a bare timeout would hide whether the worker hung or answered wrongly. */
async function waitFor(match: (f: Frame) => boolean, ms = 15000, label = "frame"): Promise<Frame> {
  const started = Date.now();
  for (;;) {
    const hit = frames.find(match);
    if (hit) return hit;
    if (Date.now() - started > ms) {
      throw new Error(`timed out waiting for ${label}; frames so far: ${JSON.stringify(frames).slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Answer every capability request the worker makes, from the host side. */
function autoAnswerCaps(reply: (cap: string, args: unknown, callId: number) => unknown, delayMs = 5): () => void {
  let stopped = false;
  // Keyed by run AND call: callIds restart at 1 for every run, so deduping on
  // callId alone would starve the second run and fake a serialisation failure.
  const seen = new Set<string>();
  const tick = setInterval(() => {
    if (stopped) return;
    for (const f of frames) {
      if (f.type !== "cap") continue;
      const callId = f.callId as number;
      const runId = f.runId as string;
      const key = `${runId}#${callId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cap = f.cap as string;
      const args = JSON.parse(String(f.argsJson));
      setTimeout(() => {
        if (stopped) return;
        try {
          send({ type: "capResult", runId, callId, ok: true, valueJson: JSON.stringify(reply(cap, args, callId)) });
        } catch (err) {
          send({ type: "capResult", runId, callId, ok: false, error: String(err) });
        }
      }, delayMs);
    }
  }, 5);
  return () => { stopped = true; clearInterval(tick); };
}

async function runTool(opts: {
  runId: string;
  code: string;
  argsJson?: string;
  capabilities?: string[];
  limits?: Partial<typeof DEFAULT_LIMITS>;
}): Promise<Frame> {
  send({
    type: "run",
    runId: opts.runId,
    code: opts.code,
    argsJson: opts.argsJson ?? "{}",
    capabilities: opts.capabilities ?? [],
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
  });
  return waitFor((f) => f.type === "result" && f.runId === opts.runId, 15000, `result for ${opts.runId}`);
}

beforeAll(async () => {
  // Intercept before importing: the module starts booting QuickJS at import
  // time and posts `ready` as soon as it can. jsdom's own window.postMessage
  // would re-deliver into our own message listener and confuse every test.
  Object.defineProperty(window, "postMessage", {
    configurable: true,
    writable: true,
    value: (data: Frame) => { frames.push(data); },
  });
  await import("@/sandbox/toolWorker");
  await waitFor((f) => f.type === "ready" || f.type === "bootError", 30000, "boot signal");
}, 40000);

afterEach(() => { frames = []; });

describe("sandbox worker boot handshake", () => {
  it("announces readiness instead of leaving the host to guess", async () => {
    // "never booted" and "booted and busy" look identical from outside without
    // this — which is how a silent hang stayed unexplained for so long.
    const ready = await waitFor((f) => f.type === "ready", 1000, "ready");
    expect(ready.type).toBe("ready");
    expect(typeof ready.ms).toBe("number");
  });

  it("answers a ping with its boot state so a late host can still sync", async () => {
    send({ type: "ping" });
    const pong = await waitFor((f) => f.type === "pong", 2000, "pong");
    expect(pong.state).toBe("ready");
  });
});

describe("sandbox worker run loop", () => {
  it("returns a result for a pure-compute tool (the hang regression)", async () => {
    const result = await runTool({ runId: "pure", code: "async function run(a, c) { return { ok: 1 }; }" });
    expect(result.ok).toBe(true);
    expect(result.valueJson).toBe('{"ok":1}');
  }, 20000);

  it("passes args through and JSON-round-trips the return value", async () => {
    const result = await runTool({
      runId: "args",
      code: "async function run(a, c) { return { doubled: a.n * 2 }; }",
      argsJson: JSON.stringify({ n: 21 }),
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.valueJson))).toEqual({ doubled: 42 });
  }, 20000);

  it("reports a thrown tool as an error, never as silence", async () => {
    const result = await runTool({ runId: "boom", code: 'async function run(a, c) { throw new Error("boom"); }' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("tool threw");
    expect(String(result.error)).toContain("boom");
  }, 20000);

  it("rejects a tool that never defines run()", async () => {
    const result = await runTool({ runId: "norun", code: "const x = 1;" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("must define function run");
  }, 20000);

  it("enforces the result cap", async () => {
    const result = await runTool({
      runId: "big",
      code: 'async function run(a, c) { return "x".repeat(5000); }',
      limits: { resultCapBytes: 100 },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("result too large");
  }, 20000);

  it("interrupts an infinite loop at the deadline", async () => {
    const result = await runTool({
      runId: "spin",
      code: "function run(a, c) { while (true) {} }",
      limits: { deadlineMs: 1000 },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/interrupted|deadline/);
  }, 20000);
});

describe("capability bridge", () => {
  it("round-trips two sequential capability calls", async () => {
    const stop = autoAnswerCaps((cap, args, callId) => ({ cap, args, callId }));
    try {
      const result = await runTool({
        runId: "seq",
        code: "async function run(a, c) { const x = await c.alpha({ i: 1 }); const y = await c.beta({ i: 2 }); return [x.cap, y.cap, x.callId, y.callId]; }",
        capabilities: ["alpha", "beta"],
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(String(result.valueJson))).toEqual(["alpha", "beta", 1, 2]);
    } finally { stop(); }
  }, 25000);

  it("supports Promise.all over concurrent capability calls", async () => {
    // The reason the SYNC variant plus executePendingJobs exists: ASYNCIFY
    // permits exactly one in-flight async action per module, so this shape
    // would break the moment a tool fanned out. If this ever regresses,
    // someone has swapped the variant.
    const stop = autoAnswerCaps((cap, args) => ({ cap, i: (args as { i: number }).i }));
    try {
      const result = await runTool({
        runId: "fanout",
        code: "async function run(a, c) { const rs = await Promise.all([1,2,3,4,5].map((i) => c.alpha({ i }))); return rs.map((r) => r.i); }",
        capabilities: ["alpha"],
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(String(result.valueJson))).toEqual([1, 2, 3, 4, 5]);
    } finally { stop(); }
  }, 25000);

  it("rejects an off-manifest capability and reports the violation", async () => {
    const result = await runTool({
      runId: "violation",
      code: "async function run(a, c) { try { await c.forbidden({}); } catch (e) { return { caught: e.message }; } return { caught: null }; }",
      capabilities: ["alpha"],
    });
    expect(result.ok).toBe(true);
    expect(String(JSON.parse(String(result.valueJson)).caught)).toContain("not in this tool's approved manifest");
    expect(frames.some((f) => f.type === "capViolation" && f.cap === "forbidden")).toBe(true);
  }, 25000);

  it("times out instead of hanging when the host never answers a capability", async () => {
    // The interrupt handler only bites while the VM is executing; a tool parked
    // on an unanswered capability is not executing, so only a host-side timer
    // can end this run.
    const result = await runTool({
      runId: "stranded",
      code: "async function run(a, c) { return await c.alpha({}); }",
      capabilities: ["alpha"],
      limits: { deadlineMs: 1000 },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("deadline");
  }, 25000);

  it("surfaces a capability rejection to the tool", async () => {
    let stop = () => {};
    try {
      const pending = runTool({
        runId: "caprej",
        code: "async function run(a, c) { try { await c.alpha({}); } catch (e) { return { caught: String(e.message) }; } return { caught: null }; }",
        capabilities: ["alpha"],
      });
      const capFrame = await waitFor((f) => f.type === "cap" && f.runId === "caprej", 15000, "cap request");
      send({ type: "capResult", runId: "caprej", callId: capFrame.callId, ok: false, error: "host said no" });
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(JSON.parse(String(result.valueJson)).caught).toContain("host said no");
    } finally { stop(); }
  }, 25000);
});

describe("run isolation", () => {
  it("serialises overlapping runs so they cannot steal each other's capability results", async () => {
    // activeRunId and the pendingCaps map are module-global; two interleaved
    // runs would drop one another's capResults, which presents as a hang.
    const stop = autoAnswerCaps((cap, args, callId) => ({ callId }));
    try {
      const a = runTool({
        runId: "A",
        code: 'async function run(x, c) { const p = await c.alpha({}); const q = await c.alpha({}); return { who: "A", ids: [p.callId, q.callId] }; }',
        capabilities: ["alpha"],
      });
      const b = runTool({
        runId: "B",
        code: 'async function run(x, c) { const p = await c.alpha({}); return { who: "B", ids: [p.callId] }; }',
        capabilities: ["alpha"],
      });
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
      expect(JSON.parse(String(ra.valueJson))).toEqual({ who: "A", ids: [1, 2] });
      expect(JSON.parse(String(rb.valueJson))).toEqual({ who: "B", ids: [1] });
      // Serialised, not interleaved: A's result frame precedes B's cap request.
      const order = frames.filter((f) => f.type === "result" || f.type === "cap").map((f) => `${String(f.type)}:${String(f.runId)}`);
      expect(order.indexOf("result:A")).toBeLessThan(order.indexOf("cap:B"));
    } finally { stop(); }
  }, 30000);

  it("does not leak globals between runs", async () => {
    const first = await runTool({ runId: "leak1", code: "async function run(a, c) { globalThis.__leaked = 1; return 1; }" });
    expect(first.ok).toBe(true);
    const second = await runTool({ runId: "leak2", code: 'async function run(a, c) { return typeof globalThis.__leaked; }' });
    expect(second.ok).toBe(true);
    expect(JSON.parse(String(second.valueJson))).toBe("undefined");
  }, 25000);

  it("keeps working after a failed run", async () => {
    const bad = await runTool({ runId: "bad", code: 'async function run(a, c) { throw new Error("nope"); }' });
    expect(bad.ok).toBe(false);
    const good = await runTool({ runId: "good", code: "async function run(a, c) { return 7; }" });
    expect(good.ok).toBe(true);
    expect(good.valueJson).toBe("7");
  }, 25000);
});

describe("silent-failure guards", () => {
  it("reports an uncaught error as a structured, cloneable frame", async () => {
    const evt = new ErrorEvent("error", { message: "kaboom", filename: "worker.js", lineno: 42, colno: 7 });
    window.dispatchEvent(evt);
    const fatal = await waitFor((f) => f.type === "fatal" && f.phase === "error", 2000, "fatal error frame");
    expect(fatal.message).toContain("kaboom");
    // Only primitives cross postMessage; an Error instance would throw a
    // DataCloneError and lose the very report we are trying to deliver.
    for (const v of Object.values(fatal)) expect(["string", "number"]).toContain(typeof v);
  });

  it("reports an unhandled rejection as a structured, cloneable frame", async () => {
    const evt = new Event("unhandledrejection") as Event & { reason?: unknown };
    evt.reason = new Error("stray rejection");
    window.dispatchEvent(evt);
    const fatal = await waitFor((f) => f.type === "fatal" && f.phase === "unhandledrejection", 2000, "fatal rejection frame");
    expect(fatal.message).toContain("stray rejection");
    for (const v of Object.values(fatal)) expect(["string", "number"]).toContain(typeof v);
  });
});

describe("source invariants", () => {
  it("drains pending jobs AFTER resolvePromise, never only before", () => {
    // The whole fault in one assertion. resolvePromise installs VM-side .then
    // reactions; those reactions ARE pending jobs. Pumping before it registers
    // them pumps an empty queue and the await never settles.
    const resolveAt = WORKER_SRC.indexOf("ctx.resolvePromise(");
    const drainAt = WORKER_SRC.indexOf("drain();", resolveAt);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(resolveAt);
  });

  it("listens for messages instead of owning the single onmessage slot", () => {
    // Comments stripped: the file explains why onmessage is wrong, and that
    // prose must not be mistaken for the code doing it.
    const code = WORKER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/self\.onmessage\s*=/);
    expect(code).toContain('self.addEventListener("message"');
  });

  it("installs both silent-failure listeners", () => {
    expect(WORKER_SRC).toContain('self.addEventListener("error"');
    expect(WORKER_SRC).toContain('self.addEventListener("unhandledrejection"');
  });

  it("does not cache a boot rejection for the life of the worker", () => {
    // A memoised rejected promise would turn one transient WASM failure into a
    // sandbox that is dead until the tab is reloaded.
    expect(WORKER_SRC).toMatch(/if \(modulePromise === attempt\) modulePromise = null;/);
  });

  it("keeps the built worker free of import.meta so a classic worker can load it", () => {
    // A single import.meta token is a hard SyntaxError in a classic worker.
    // The rewrite lives in vite.config.ts's worker block; losing it silently
    // re-pins the sandbox transport to { type: "module" }.
    expect(VITE_CONFIG).toContain("sandbox-worker-drop-import-meta");
    expect(VITE_CONFIG).toContain('"(location.href)"');
  });
});
