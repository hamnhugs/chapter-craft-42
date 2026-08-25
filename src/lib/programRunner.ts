import { supabase } from "@/integrations/supabase/client";

/**
 * Program Runner — the client seam to the VPS execution backend.
 *
 * run_program and the isolated verifier both cross an edge function (program-run
 * / program-verify) that HMAC-signs a job to the user's own connected VPS. This
 * module is the browser side of that: it invokes the function, and it turns
 * every outcome into a TYPED result that resolves rather than throws — the same
 * discipline toolSandbox.ts holds, for the same reason. A run is model-visible,
 * so an honest, closed error taxonomy is what keeps a repair loop from chasing
 * an infrastructure failure as if it were a bug in the program.
 *
 * The client NEVER sends program code for a RUN: the edge function reads the
 * pinned-approved code from the database by id and refuses if its fingerprint no
 * longer matches the approval, so a compromised client cannot run arbitrary code
 * — only code the user approved.
 */

// ── error taxonomy (total + honest, mirrors SANDBOX_ERROR_SENTENCES) ──────────
export const PROGRAM_ERROR_SENTENCES = {
  PROGRAM_NOT_MIGRATED:
    "the Program Foundry database setup has not been applied on this account yet, so there is nowhere to store or resolve a program",
  PROGRAM_RUNNER_UNAVAILABLE:
    "no VPS runner is connected, so there is nowhere to execute the program",
  PROGRAM_EDGE_UNAVAILABLE:
    "the program execution service has not been deployed yet, so the request could not be routed to the runner",
  PROGRAM_INTEGRITY_FAILED:
    "the stored program no longer matches what the user approved, so it was refused rather than run",
  PROGRAM_NOT_APPROVED:
    "the program is not approved, so it cannot run — it is waiting for the user in Settings → Program Foundry",
  PROGRAM_RATE_LIMITED:
    "the runner is over its rate limit for now, so this run was declined rather than queued",
  PROGRAM_RUNNER_BUSY:
    "the runner is at capacity right now, so this run was declined rather than queued behind others",
  PROGRAM_SANDBOX_UNAVAILABLE:
    "the runner could not start a sandbox container, so nothing about the program was executed",
  PROGRAM_TIMEOUT:
    "the program hit its time limit and the sandbox was terminated",
  PROGRAM_OOM:
    "the program exceeded its memory limit and the sandbox was terminated",
  PROGRAM_EGRESS_BLOCKED:
    "the program tried to reach a host outside its approved allowlist and the connection was refused",
  PROGRAM_ERROR:
    "the program's own code exited with an error while the sandbox around it was working normally",
  PROGRAM_RUNNER_ERROR:
    "the runner reported a failure this code does not have a more specific name for",
  PROGRAM_REQUEST_FAILED:
    "the request to the execution service failed before the runner could answer",
} as const;

export type ProgramErrorCode = keyof typeof PROGRAM_ERROR_SENTENCES;

/** Statuses that mean "the harness/infra broke, this decides nothing about the
 *  program" — program-verify must treat these as INCONCLUSIVE, never a failure
 *  of the code. Mirrors SANDBOX_UNAVAILABLE_PREFIX's role across files. */
export const PROGRAM_UNAVAILABLE_CODES: ReadonlySet<ProgramErrorCode> = new Set([
  "PROGRAM_NOT_MIGRATED", "PROGRAM_RUNNER_UNAVAILABLE", "PROGRAM_EDGE_UNAVAILABLE",
  "PROGRAM_RATE_LIMITED", "PROGRAM_RUNNER_BUSY", "PROGRAM_SANDBOX_UNAVAILABLE",
  "PROGRAM_RUNNER_ERROR", "PROGRAM_REQUEST_FAILED",
]);

export const PROGRAM_UNAVAILABLE_PREFIX = "runner unavailable: ";

export function isProgramErrorCode(v: unknown): v is ProgramErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PROGRAM_ERROR_SENTENCES, v);
}

export function programErrorText(code: ProgramErrorCode, detail?: string): string {
  const d = typeof detail === "string" ? detail.trim() : "";
  return PROGRAM_ERROR_SENTENCES[code] + (d ? ` — ${d}` : "");
}

export interface ProgramRunResult {
  ok: boolean;
  /** Present on success or a clean non-zero exit. */
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  ms?: number;
  /** Set on EVERY non-ok outcome. */
  code?: ProgramErrorCode;
  error?: string;
  /** True when `code` is in PROGRAM_UNAVAILABLE_CODES (harness/infra, not the program). */
  unavailable?: boolean;
}

export interface ProgramVerifyResult {
  ok: boolean;
  verdict?: "passed" | "failed" | "inconclusive";
  checks?: Array<{ id: string; passed: boolean }>;
  code?: ProgramErrorCode;
  error?: string;
  unavailable?: boolean;
}

// ── edge-fn availability cache (R9: one 404 marks the fns absent for the session)
let edgeUnavailable = false;
export function resetProgramEdgeAvailability(): void { edgeUnavailable = false; }

function fail(code: ProgramErrorCode, detail?: string): ProgramRunResult {
  return {
    ok: false,
    code,
    error: (PROGRAM_UNAVAILABLE_CODES.has(code) ? PROGRAM_UNAVAILABLE_PREFIX : "") + programErrorText(code, detail),
    unavailable: PROGRAM_UNAVAILABLE_CODES.has(code),
  };
}

/** Map an edge-function response body to a typed code. The edge fn always
 *  returns { code } from this same enum on failure; a body without one is a
 *  transport-level problem. */
function codeFromBody(body: unknown): ProgramErrorCode {
  const c = (body as { code?: unknown } | null)?.code;
  return isProgramErrorCode(c) ? c : "PROGRAM_RUNNER_ERROR";
}

async function invoke<T = any>(fn: string, body: unknown): Promise<{ data: T | null; status: number; error: unknown }> {
  try {
    // supabase.functions.invoke attaches the user's JWT. It resolves { data,
    // error }; a non-2xx sets error and, for FunctionsHttpError, exposes the
    // response so the typed { code } body can still be read.
    const res: any = await (supabase as any).functions.invoke(fn, { body });
    if (res?.error) {
      const ctx = res.error?.context;
      let parsed: any = null;
      let status = Number(ctx?.status) || 0;
      try { parsed = typeof ctx?.json === "function" ? await ctx.json() : (ctx?.body ?? null); } catch { /* opaque */ }
      return { data: parsed, status, error: res.error };
    }
    return { data: res?.data ?? null, status: 200, error: null };
  } catch (e) {
    return { data: null, status: 0, error: e };
  }
}

/**
 * Run an APPROVED program by id on the user's VPS. Resolves a typed result; the
 * edge function does the fingerprint-pin integrity check server-side, so a
 * mismatch comes back as PROGRAM_INTEGRITY_FAILED rather than executing.
 */
export async function runProgramRemote(programId: string, args: unknown): Promise<ProgramRunResult> {
  if (edgeUnavailable) return fail("PROGRAM_EDGE_UNAVAILABLE");
  const { data, status, error } = await invoke("program-run", { program_id: programId, args: args ?? {} });
  if (status === 404) { edgeUnavailable = true; return fail("PROGRAM_EDGE_UNAVAILABLE"); }
  if (error && !data) return fail("PROGRAM_REQUEST_FAILED", String((error as any)?.message || "").slice(0, 200));

  const b = (data || {}) as Record<string, unknown>;
  if (b.ok === true) {
    return {
      ok: true,
      exit_code: typeof b.exit_code === "number" ? b.exit_code : 0,
      stdout: typeof b.stdout === "string" ? b.stdout : "",
      stderr: typeof b.stderr === "string" ? b.stderr : "",
      ms: typeof b.ms === "number" ? b.ms : undefined,
    };
  }
  const code = codeFromBody(b);
  const detail = typeof b.error === "string" ? b.error : "";
  const out = fail(code, detail);
  // A clean program error carries the exit code / captured streams for the model
  // to diagnose from, still typed as PROGRAM_ERROR.
  if (code === "PROGRAM_ERROR") {
    out.exit_code = typeof b.exit_code === "number" ? b.exit_code : null;
    out.stdout = typeof b.stdout === "string" ? b.stdout : "";
    out.stderr = typeof b.stderr === "string" ? b.stderr : "";
    out.ms = typeof b.ms === "number" ? b.ms : undefined;
  }
  return out;
}

/**
 * Trigger the isolated verifier for a DRAFT program. The edge function runs the
 * draft HERMETICALLY (no secrets, no egress) on the VPS, computes the verdict
 * mechanically, and writes the (service-role-only) verifier_report bound to the
 * program's fingerprint. Returns the verdict for the approval card. An infra
 * failure comes back INCONCLUSIVE, never a program failure.
 */
export async function verifyProgramRemote(programId: string): Promise<ProgramVerifyResult> {
  if (edgeUnavailable) return { ok: false, code: "PROGRAM_EDGE_UNAVAILABLE", error: PROGRAM_UNAVAILABLE_PREFIX + programErrorText("PROGRAM_EDGE_UNAVAILABLE"), unavailable: true };
  const { data, status, error } = await invoke("program-verify", { program_id: programId });
  if (status === 404) { edgeUnavailable = true; return { ok: false, code: "PROGRAM_EDGE_UNAVAILABLE", error: PROGRAM_UNAVAILABLE_PREFIX + programErrorText("PROGRAM_EDGE_UNAVAILABLE"), unavailable: true }; }
  if (error && !data) return { ok: false, code: "PROGRAM_REQUEST_FAILED", error: PROGRAM_UNAVAILABLE_PREFIX + programErrorText("PROGRAM_REQUEST_FAILED"), unavailable: true };

  const b = (data || {}) as Record<string, unknown>;
  if (b.ok === true && (b.verdict === "passed" || b.verdict === "failed" || b.verdict === "inconclusive")) {
    return {
      ok: true,
      verdict: b.verdict,
      checks: Array.isArray(b.checks)
        ? (b.checks as any[]).map((c) => ({ id: String(c?.id || "check"), passed: c?.passed === true })).slice(0, 40)
        : [],
    };
  }
  const code = codeFromBody(b);
  return { ok: false, code, error: (PROGRAM_UNAVAILABLE_CODES.has(code) ? PROGRAM_UNAVAILABLE_PREFIX : "") + programErrorText(code, typeof b.error === "string" ? b.error : ""), unavailable: PROGRAM_UNAVAILABLE_CODES.has(code) };
}
