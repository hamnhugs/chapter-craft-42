import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FRAME_MSG,
  SANDBOX_DOC_PATH,
  SANDBOX_ERROR_CODES,
  SANDBOX_ERROR_SENTENCES,
  SANDBOX_UNAVAILABLE_PREFIX,
  SandboxFailure,
  WORKER_BOOT_PROBE,
  WORKER_BOOT_PROBE_SOURCE,
  WORKER_EVALUATED_PROBE,
  WORKER_EVALUATED_PROBE_SOURCE,
  WORKER_URL_PREFIX,
  asSandboxFailure,
  bytesToBase64,
  buildWorkerPayload,
  failureFromFrame,
  isSandboxErrorCode,
  runTimeoutDetail,
  sandboxErrorText,
  violationSuffix,
  type CspViolation,
  type SandboxErrorCode,
} from "@/lib/toolSandbox";

const readPublic = (name: string) => readFileSync(resolve(process.cwd(), "public", name), "utf8");
const sandboxDoc = readPublic(SANDBOX_DOC_PATH);
const hostSource = readFileSync(resolve(process.cwd(), "src/lib/toolSandbox.ts"), "utf8");

/** The frame's executable body, with the explanatory comments stripped out.
 *  The header comment has to be able to NAME the defect it replaced
 *  (`String(we.message || "worker error")`) without that mention tripping the
 *  assertions that the code itself no longer does it. */
const frameScript = (() => {
  const m = /<body><script>([\s\S]*?)<\/script>/.exec(sandboxDoc);
  if (!m) throw new Error("public/tool-sandbox.html has no body script");
  return m[1]
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
})();

/**
 * The defect this file exists to prevent recurring:
 *   worker.onerror = (we) => post({ error: String(we.message || "worker error") })
 * A load-phase worker failure fires a bare Event with no `message`, so that
 * line could only ever say "worker error". Everything below is a check that no
 * failure can collapse into an unexplained string again.
 */

/** Strings that would mean the taxonomy had regressed to a shrug. */
const GENERIC = [
  "worker error",
  "unknown error",
  "error",
  "failed",
  "tool failed",
  "something went wrong",
  "undefined",
  "null",
  "[object object]",
];

function assertExplains(text: string, label: string) {
  const t = text.trim();
  expect(t, `${label} must not be empty`).not.toBe("");
  expect(GENERIC, `${label} must not be a generic shrug: ${JSON.stringify(t)}`).not.toContain(t.toLowerCase());
  // A sentence, not a token: at least a handful of words of actual explanation.
  expect(t.split(/\s+/).length, `${label} must read as a sentence: ${JSON.stringify(t)}`).toBeGreaterThanOrEqual(6);
}

describe("sandbox error taxonomy is total", () => {
  it("every code has a distinct explanatory sentence", () => {
    expect(SANDBOX_ERROR_CODES.length).toBeGreaterThanOrEqual(12);
    const seen = new Set<string>();
    for (const code of SANDBOX_ERROR_CODES) {
      const sentence = SANDBOX_ERROR_SENTENCES[code];
      assertExplains(sentence, code);
      expect(seen.has(sentence), `${code} reuses another code's sentence`).toBe(false);
      seen.add(sentence);
    }
  });

  it("names every failure the brief requires be distinguishable", () => {
    // Frame failed to load · frame loaded but never said ready · worker
    // constructor threw · worker script never loaded · worker threw at
    // runtime · run timed out. Six distinct outcomes, six distinct codes.
    for (const code of [
      "SANDBOX_FRAME_LOAD_FAILED",
      "SANDBOX_FRAME_NOT_READY",
      "SANDBOX_WORKER_CONSTRUCTOR_THREW",
      "SANDBOX_WORKER_NEVER_STARTED",
      "SANDBOX_WORKER_RUNTIME_ERROR",
      "RUN_TIMEOUT",
    ] as SandboxErrorCode[]) {
      expect(SANDBOX_ERROR_CODES).toContain(code);
    }
  });

  it("says 'never started' in words, not 'worker error'", () => {
    const s = SANDBOX_ERROR_SENTENCES.SANDBOX_WORKER_NEVER_STARTED;
    expect(s).toMatch(/never started/i);
    expect(s).not.toMatch(/^worker error$/i);
    // The distinguishing fact: nothing ran, as opposed to ran-and-threw.
    expect(s).toMatch(/refused to load|not one statement/i);
    expect(SANDBOX_ERROR_SENTENCES.SANDBOX_WORKER_RUNTIME_ERROR).toMatch(/after starting/i);
  });

  it("composes a non-empty sentence for every code, with and without detail", () => {
    for (const code of SANDBOX_ERROR_CODES) {
      assertExplains(sandboxErrorText(code), `${code} (no detail)`);
      assertExplains(sandboxErrorText(code, "  "), `${code} (blank detail)`);
      const withDetail = sandboxErrorText(code, "because reasons");
      expect(withDetail).toContain(SANDBOX_ERROR_SENTENCES[code]);
      expect(withDetail).toContain("because reasons");
    }
  });

  it("recognises its own codes and nothing else", () => {
    for (const code of SANDBOX_ERROR_CODES) expect(isSandboxErrorCode(code)).toBe(true);
    for (const junk of ["", "nope", null, undefined, 7, {}, "toString", "constructor"]) {
      expect(isSandboxErrorCode(junk)).toBe(false);
    }
  });
});

describe("no failure can escape without a code and a sentence", () => {
  it("an unrecognised thrown value still becomes a coded failure", () => {
    for (const junk of [undefined, null, "", 0, {}, new Error(""), "boom"]) {
      const f = asSandboxFailure(junk);
      expect(f).toBeInstanceOf(SandboxFailure);
      expect(isSandboxErrorCode(f.code)).toBe(true);
      assertExplains(f.message, `asSandboxFailure(${JSON.stringify(String(junk))})`);
    }
  });

  it("a SandboxFailure passes through with its own code", () => {
    const original = new SandboxFailure("SANDBOX_FRAME_LOAD_TIMEOUT", "detail");
    expect(asSandboxFailure(original)).toBe(original);
  });

  it("a frame message with a missing, empty or bogus code lands on SANDBOX_UNEXPECTED and still explains itself", () => {
    for (const msg of [
      {},
      { type: "workerError" },
      { type: "workerError", code: "" },
      { type: "workerError", code: "NOT_A_REAL_CODE" },
      { type: "workerError", code: 42, detail: "" },
      null,
      undefined,
    ]) {
      const f = failureFromFrame(msg);
      expect(f.code).toBe("SANDBOX_UNEXPECTED");
      assertExplains(f.message, `failureFromFrame(${JSON.stringify(msg)})`);
      expect(f.message).toMatch(/unrecognised code/);
    }
  });

  it("a well-formed frame message keeps its code but takes its wording from the host table", () => {
    const f = failureFromFrame({
      type: "workerError",
      code: "SANDBOX_WORKER_NEVER_STARTED",
      // Exactly the kind of string the old code shipped to users verbatim.
      detail: "worker error",
    });
    expect(f.code).toBe("SANDBOX_WORKER_NEVER_STARTED");
    expect(f.message.startsWith(SANDBOX_ERROR_SENTENCES.SANDBOX_WORKER_NEVER_STARTED)).toBe(true);
    // The frame's detail survives as detail — it never stands alone.
    expect(f.message).not.toBe("worker error");
    assertExplains(f.message, "frame message");
  });

  it("the 'sandbox unavailable' prefix that foundryTools/toolConformance regex for is intact", () => {
    // Both files test /^sandbox unavailable/i to keep a dead harness from
    // being scored as a broken tool. Changing this string breaks them silently.
    expect(SANDBOX_UNAVAILABLE_PREFIX).toBe("sandbox unavailable: ");
    expect(/^sandbox unavailable/i.test(SANDBOX_UNAVAILABLE_PREFIX + sandboxErrorText("SANDBOX_FRAME_NOT_READY"))).toBe(true);
  });

  it("CSP violations are appended to whatever failure follows them", () => {
    const v: CspViolation = {
      type: "sandbox:cspViolation", code: "SANDBOX_CSP_VIOLATION",
      directive: "worker-src", blockedURI: "data", sourceFile: "", lineno: 0, disposition: "enforce",
    };
    expect(violationSuffix([])).toBe("");
    expect(violationSuffix([v])).toContain("worker-src");
    expect(violationSuffix([v, v, v])).toContain("2 more");
    expect(failureFromFrame({ code: "SANDBOX_WORKER_NEVER_STARTED" }, [v]).message).toContain("worker-src");
  });
});

describe("the run timeout says which side of the handshake it is on", () => {
  const noVm = { readyMs: null, bootError: "", fatal: "" };

  it("a path with a boot handshake states the worker did start", () => {
    const s = runTimeoutDetail(37, noVm);
    assertExplains(s, "runTimeoutDetail(booted)");
    expect(s).toMatch(/did start/);
    expect(s).toContain("37ms");
    expect(s).toMatch(/never reported itself usable/);
  });

  it("a path with no handshake admits it cannot tell the two apart", () => {
    const s = runTimeoutDetail(null, noVm);
    assertExplains(s, "runTimeoutDetail(no handshake)");
    expect(s).toMatch(/no worker boot handshake/);
    expect(s).not.toMatch(/did start/);
  });

  it("separates a stall in the VM boot from a stall in the run", () => {
    // The worker volunteers `ready`/`bootError`/`fatal`; using them is what
    // turns "it hung" into "it hung here".
    const usable = runTimeoutDetail(9, { readyMs: 21, bootError: "", fatal: "" });
    expect(usable).toContain("usable after 21ms");
    expect(usable).toMatch(/stall is in the run, not the VM boot/);

    const dead = runTimeoutDetail(9, { readyMs: null, bootError: "wasm compile refused", fatal: "" });
    expect(dead).toContain("wasm compile refused");
    expect(dead).toMatch(/never became usable/);

    const noisy = runTimeoutDetail(9, { readyMs: 5, bootError: "", fatal: "unhandledrejection: nope" });
    expect(noisy).toContain("uncaught unhandledrejection: nope");
    for (const s of [usable, dead, noisy]) {
      assertExplains(s, "runTimeoutDetail");
      expect(s).toContain("the sandbox was terminated");
    }
  });
});

describe("data: transport encoding", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("matches a reference encoder on ASCII, empty, and non-ASCII input", () => {
    for (const s of [
      "",
      "a",
      "ab",
      "abc",
      "abcd",
      'postMessage({ok:true});',
      // The payload is 729 KB of built JS — a single smart quote or emoji in a
      // string literal is enough to make btoa(str) throw InvalidCharacterError.
      'const s = "café — naïve “smart quotes” · emoji 🙂🇬🇧 ·  ÿ";',
      " ÿ￿",
    ]) {
      expect(bytesToBase64(new TextEncoder().encode(s)), JSON.stringify(s)).toBe(b64(s));
    }
  });

  it("is correct across the internal chunk boundary, where naive chunking breaks", () => {
    // The chunk is 8192 bytes; base64 only pads at 3-byte boundaries, so an
    // encoder that base64s each chunk separately goes wrong here.
    for (const n of [8190, 8191, 8192, 8193, 8194, 16384, 16385, 24577]) {
      const s = "x".repeat(n);
      expect(bytesToBase64(new TextEncoder().encode(s)), `length ${n}`).toBe(b64(s));
    }
  });

  it("handles a payload the size of the real worker asset", () => {
    // ~760 KB, the order of the built toolWorker bundle.
    const s = "/*pad*/".repeat(110_000);
    const bytes = new TextEncoder().encode(s);
    expect(bytes.length).toBeGreaterThan(700_000);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(b64(s));
    // 4 base64 chars per 3 bytes, i.e. ~133.4% — the size cost of the fix.
    expect(encoded.length / bytes.length).toBeGreaterThan(1.33);
    expect(encoded.length / bytes.length).toBeLessThan(1.34);
  });

  it("wraps the asset in liveness probes and produces a usable data: URL", () => {
    const asset = new TextEncoder().encode('self.onmessage = () => {};\n');
    const payload = buildWorkerPayload(asset);
    expect(payload.url.startsWith(WORKER_URL_PREFIX)).toBe(true);
    expect(payload.urlChars).toBe(payload.url.length);

    const decoded = Buffer.from(payload.url.slice(WORKER_URL_PREFIX.length), "base64").toString("utf8");
    expect(payload.sourceBytes).toBe(Buffer.byteLength(decoded, "utf8"));
    // The boot probe must be the FIRST statement: that is what makes receiving
    // it proof that the script loaded, rather than proof it finished.
    expect(decoded.indexOf(WORKER_BOOT_PROBE)).toBeLessThan(decoded.indexOf("self.onmessage"));
    expect(decoded.indexOf(WORKER_EVALUATED_PROBE)).toBeGreaterThan(decoded.indexOf("self.onmessage"));
    expect(decoded).toContain('self.onmessage = () => {};');
  });

  it("the injected probes are constant text with no interpolation seam", () => {
    for (const src of [WORKER_BOOT_PROBE_SOURCE, WORKER_EVALUATED_PROBE_SOURCE]) {
      expect(src).not.toContain("${");
      // Every probe is wrapped, so a worker global without postMessage cannot
      // turn a diagnostic into the failure it was meant to diagnose.
      expect(src).toContain("try {");
      expect(src).toContain("catch");
    }
    // The postamble must start a fresh statement: the asset may end in a line
    // comment or without a terminator.
    expect(WORKER_EVALUATED_PROBE_SOURCE.startsWith("\n;")).toBe(true);
  });
});

const frameCsp = (() => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(sandboxDoc);
  if (!m) throw new Error("public/tool-sandbox.html has no meta CSP");
  return m[1];
})();

const harnessPath = resolve(process.cwd(), "scripts/sandbox-repro.html");
const harness = readFileSync(harnessPath, "utf8");

describe("the boundary is not traded for a working transport", () => {
  it("no sandbox attribute anywhere asks for allow-same-origin", () => {
    // MDN: allow-scripts + allow-same-origin lets the framed document remove
    // its own sandbox attribute, "making it no more secure than not using the
    // sandbox attribute at all" — it would hand model-authored code this app's
    // origin, its Supabase session and its storage. The strings below are
    // every place a sandbox attribute is written in the files this fix owns.
    expect(hostSource).toContain('setAttribute("sandbox", "allow-scripts")');
    for (const [label, text] of [["host", hostSource], ["frame", sandboxDoc], ["harness", harness]] as const) {
      expect(text, `${label} sets a sandbox attribute containing allow-same-origin`)
        .not.toMatch(/sandbox"?\s*,?\s*"?[^"\n]{0,20}allow-scripts[^"\n]*allow-same-origin/);
    }
    // Mentioning it in a warning comment is the point; setting it is not.
    expect(sandboxDoc).toMatch(/WITHOUT\s*\n?\s*allow-same-origin/);
  });

  it("the frame keeps the network shut and adds only the one scheme the transport needs", () => {
    expect(frameCsp).toContain("connect-src 'none'");
    expect(frameCsp).toContain("worker-src blob: data:");
    expect(frameCsp).toContain("'wasm-unsafe-eval'");
    // Nothing was widened to a host, a wildcard, or 'unsafe-eval'.
    expect(frameCsp).not.toContain("'unsafe-eval'");
    expect(frameCsp).not.toContain("*");
    expect(frameCsp).not.toMatch(/https?:/);
    // `data:` is the one scheme the fix adds, and only where the transport
    // needs it: worker creation (worker-src, with child-src/script-src as the
    // fallbacks engines without worker-src support consult).
    for (const directive of frameCsp.split(";").map((d) => d.trim())) {
      if (!directive.includes("data:")) continue;
      expect(["script-src", "worker-src", "child-src"], `data: appears in ${directive}`)
        .toContain(directive.split(" ")[0]);
    }
    for (const shut of ["img-src 'none'", "media-src 'none'", "font-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'"]) {
      expect(frameCsp).toContain(shut);
    }
  });

  it("keeps the permanent repro harness alongside the code it diagnoses", () => {
    expect(harness).toContain("?transport=");
    expect(harness).toContain("?direct=1");
    for (const t of ["data", "blob", "classic"]) expect(harness).toContain('transport === "' + t + '"');
    // It must drive the REAL frame, not only a replica of it.
    expect(harness).toContain("./tool-sandbox.html");
    expect(harness).toContain("npx vite build");
  });

  it("terminate() stays an unconditional kill on every disposal path", () => {
    expect(sandboxDoc).toContain("worker.terminate()");
    // Host disposal destroys the frame's document as well as asking politely,
    // so a worker that ignores the message still dies.
    expect(hostSource).toContain("iframe.remove()");
  });
});

describe("the sandbox document stays static and speaks the host's protocol", () => {
  it("has no interpolation seam", () => {
    // Also asserted by toolFoundry.test.ts; repeated here because this file is
    // where the document's protocol is now checked. No template literals at
    // all in the executable body, so there is nowhere for a seam to open.
    expect(sandboxDoc).not.toContain("${");
    expect(frameScript).not.toContain("`");
  });

  it("only accepts a boot message from its embedder", () => {
    expect(sandboxDoc).toContain("e.source !== window.parent");
  });

  it("agrees with the host on every wire constant", () => {
    // These strings are the whole contract between the two files. A typo in
    // either one is a silent hang, which is the failure mode this whole change
    // exists to eliminate.
    expect(sandboxDoc).toContain('var WORKER_URL_PREFIX = "' + WORKER_URL_PREFIX + '"');
    expect(sandboxDoc).toContain('var BOOT_PROBE = "' + WORKER_BOOT_PROBE + '"');
    expect(sandboxDoc).toContain('var EVALUATED_PROBE = "' + WORKER_EVALUATED_PROBE + '"');
    expect(sandboxDoc).toContain('d.type !== "boot"');
    expect(sandboxDoc).toContain("workerUrl");
    for (const type of Object.values(FRAME_MSG)) {
      expect(frameScript, `the frame never sends or accepts ${type}`).toContain('"' + type + '"');
    }
  });

  it("namespaces its own messages so the worker's cannot be mistaken for them", () => {
    // toolWorker.ts emits its own `ready`, `bootError`, `fatal` and `pong`,
    // and this frame forwards worker messages verbatim. Without the namespace
    // a worker `ready` would be read as the frame's (failing the opaque-origin
    // check, since it carries no origin) and a worker `bootError` as a
    // transport failure.
    for (const type of Object.values(FRAME_MSG)) expect(type.startsWith("sandbox:")).toBe(true);
    for (const collidable of ["ready", "bootError", "fatal", "pong"]) {
      expect(Object.values(FRAME_MSG) as string[]).not.toContain(collidable);
      // ...and the frame must not react to the bare name either.
      expect(frameScript, `the frame still matches the bare type "${collidable}"`)
        .not.toMatch(new RegExp('type\\s*[=!]==?\\s*"' + collidable + '"'));
    }
    // The frame refuses to relay anything from the worker in its own namespace,
    // so a worker that went wrong cannot forge frame-level control traffic.
    expect(frameScript).toContain("FRAME_MSG_PREFIX");
    expect(frameScript).toMatch(/lastIndexOf\(FRAME_MSG_PREFIX, 0\) === 0\) return;/);
  });

  it("emits only codes the host knows, and never a bare message string", () => {
    const emitted = [...frameScript.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThanOrEqual(6);
    for (const code of emitted) {
      // SANDBOX_CSP_VIOLATION is diagnostic context, not a way a run fails, so
      // it is deliberately not in the run-failure taxonomy.
      expect(isSandboxErrorCode(code) || code === "SANDBOX_CSP_VIOLATION", `frame emits unknown code ${code}`).toBe(true);
    }
    // Every failure the frame sends carries a code; none carries a
    // pre-composed user-facing error string of its own. This is the exact
    // defect being fenced off.
    expect(frameScript).not.toContain("we.message ||");
    expect(frameScript).not.toContain("worker error");
    expect(frameScript).not.toMatch(/\berror:\s/);
    expect(frameScript).not.toMatch(/type:\s*"(bootError|workerError|workerBootTimeout)"(?![\s\S]{0,120}code:)/);
  });

  it("never quotes the data: URL back at the reader", () => {
    // ErrorEvent.filename for this worker IS the ~975 KB data: URL. Reporting
    // it would bury the actual message under a wall of base64.
    expect(frameScript).toContain('file = "the sandbox worker script"');
    expect(frameScript).toMatch(/file\.lastIndexOf\(WORKER_URL_PREFIX, 0\) === 0/);
  });

  it("distinguishes a load-phase bare Event from a runtime ErrorEvent", () => {
    // The measured signature: constructor.name === "Event", message undefined.
    expect(sandboxDoc).toContain("workerStarted");
    expect(sandboxDoc).toContain("eventClass");
    expect(sandboxDoc).toContain("hasMessage");
    expect(sandboxDoc).toContain("SANDBOX_WORKER_NEVER_STARTED");
    expect(sandboxDoc).toContain("SANDBOX_WORKER_RUNTIME_ERROR");
  });

  it("has the only CSP violation channel a meta-delivered policy can have", () => {
    // Meta CSP strips report-uri/report-to for good, so this listener is it.
    expect(sandboxDoc).toContain("securitypolicyviolation");
    expect(sandboxDoc).toContain("SANDBOX_CSP_VIOLATION");
  });

  it("gives the worker its own boot deadline, generous enough not to fire on a healthy boot", () => {
    const m = /var WORKER_BOOT_BUDGET_MS = (\d+);/.exec(sandboxDoc);
    expect(m, "the frame must define its own worker boot budget").toBeTruthy();
    const budget = Number(m![1]);
    // Only has to cover parsing a ~1 MB data: URL and running one statement.
    expect(budget).toBeGreaterThanOrEqual(5000);
    expect(sandboxDoc).toContain("SANDBOX_WORKER_BOOT_TIMEOUT");
  });
});
