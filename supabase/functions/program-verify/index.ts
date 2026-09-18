// program-verify: the isolated, HERMETIC smoke test for a draft VPS program.
//
// The critical property (why this exists, and the shape the design critique
// forced): an UNAPPROVED draft may never run with real power. So this function
// sends the runner a `mode:"verify"` job — the runner strips all secrets and
// forces --network none regardless of the declared profile — and evaluates the
// result MECHANICALLY (exit code + expected-substring + invariants), never by
// asking a model to read stdout and declare pass/fail. The verdict is one of
// passed / failed / inconclusive:
//   • passed       — at least one check ran and all checks passed
//   • failed       — a check ran and failed
//   • inconclusive — nothing could be checked hermetically (no io_spec, or the
//                    program needs network/secrets, or the sandbox was down)
//
// The report is STRUCTURED (verdict + {id, passed} booleans, no free text) so it
// can never launder an instruction or a phantom verb into context, and it is
// written with the SERVICE ROLE (the client has no path to write verifier_*),
// bound to the exact code by the current fingerprint so approve_program can
// require it.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateRunnerUrl, callRunner, type RunnerConn } from "../_shared/runner.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// A verify job's socket deadline must OUTLAST the job it dispatches: the runner
// soft-kills at the program's own timeout + 2s, so a flat 30s deadline meant any
// program declaring timeout_ms above ~25s could never be verified — every case
// threw, sandboxDown latched, and the approval card said "could not be checked"
// for a perfectly good program. Computed per program below, ceilinged so a
// pathological manifest cannot hold the chat turn open.
const VERIFY_SOCKET_CEILING_MS = 90_000;
const VERIFY_SOCKET_HEADROOM_MS = 20_000;
// Whole-call budget. forge_program awaits this verification INLINE, so the
// chat turn is blocked for however long it takes: 6 examples + 1 invariant run
// at up to a minute each is minutes of silence. Once the budget is spent the
// remaining cases are simply not run and the verdict is inconclusive — an
// honest "not fully checked" beats a hung turn.
const VERIFY_BUDGET_MS = 120_000;
const MAX_CASES = 6;
const VERIFY_RATE_PER_MIN = 15; // verify + run share this per-user budget

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (code: string, error: string, s = 200) => json({ ok: false, code, error }, s);

interface Check { id: string; passed: boolean }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail("PROGRAM_REQUEST_FAILED", "POST only", 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return fail("PROGRAM_REQUEST_FAILED", "Missing authorization", 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return fail("PROGRAM_REQUEST_FAILED", "Unauthorized", 401);

    const body = await req.json().catch(() => null);
    const programId = String(body?.program_id || "").trim();
    if (!programId) return fail("PROGRAM_REQUEST_FAILED", "program_id required", 400);

    const { data: program, error: pErr } = await supabase
      .from("agent_programs")
      .select("id, language, code, io_spec, manifest")
      .eq("id", programId)
      .maybeSingle();
    if (pErr) return fail("PROGRAM_NOT_MIGRATED", `Could not read the program: ${pErr.message}`);
    if (!program) return fail("PROGRAM_NOT_APPROVED", "No program with that id.");

    // The report is BOUND to this fingerprint — approve_program refuses a report
    // whose fingerprint is not the program's current one. Swallowing this error
    // wrote a report pinned to "", told the client "passed", and then approval
    // failed with "this program has not been verified for its current code",
    // which is unfixable by retrying. Fail here instead, where it is legible.
    const { data: fp, error: fpErr } = await supabase.rpc("program_fingerprint", { p_program_id: programId });
    const fingerprint = String(fp || "");
    if (fpErr || !fingerprint) {
      return fail("PROGRAM_REQUEST_FAILED", `Could not fingerprint the program: ${fpErr?.message || "empty fingerprint"}`);
    }

    // Runner connection.
    const { data: settings } = await supabase
      .from("user_settings")
      .select("program_runner_url, program_runner_key_id, program_runner_signing_key")
      .eq("user_id", user.id).maybeSingle();
    const runnerUrl = (settings?.program_runner_url || "").trim();
    const keyId = (settings?.program_runner_key_id || "").trim();
    const signingKey = (settings?.program_runner_signing_key || "").trim();

    const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const writeReport = async (verdict: string, checks: Check[]) => {
      // Checked: an unwritten report means approval will refuse later with a
      // message about code that never changed. Better to say so now.
      const { error } = await service.from("agent_programs").update({
        verified_at: new Date().toISOString(),
        verifier_fingerprint: fingerprint,
        verifier_report: { verdict, checks, fingerprint },
      }).eq("id", programId);
      if (error) throw new Error(`Could not record the verification report: ${error.message}`);
    };

    if (!runnerUrl || !signingKey || !keyId) {
      // Can't verify without a runner; record inconclusive so the card is honest.
      await writeReport("inconclusive", []);
      return json({ ok: true, verdict: "inconclusive", checks: [] });
    }
    let vr: { host: string; port: number; ip: string };
    try { vr = await validateRunnerUrl(runnerUrl); }
    catch (e) { return fail("PROGRAM_RUNNER_UNAVAILABLE", `Runner URL rejected: ${(e as Error).message}`); }
    const conn: RunnerConn = { host: vr.host, port: vr.port, ip: vr.ip, keyId, signingKey };

    // Rate limit + record this verify request (a verify amplifies into several
    // runner calls, so it shares the run budget and is logged so the ceiling is
    // enforceable). Insert-then-count, same as program-run.
    const verifyRunId = crypto.randomUUID();
    await service.from("program_runs").insert({ id: verifyRunId, user_id: user.id, program_id: programId, sha256: fingerprint, mode: "verify", status: "pending" });
    const { count: recent } = await service.from("program_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id).in("mode", ["run", "verify"]).gte("created_at", new Date(Date.now() - 60_000).toISOString());
    if ((recent ?? 0) > VERIFY_RATE_PER_MIN) {
      await service.from("program_runs").delete().eq("id", verifyRunId);
      return fail("PROGRAM_RATE_LIMITED", "Too many verifications recently — try again shortly.");
    }

    const ioSpec = (program.io_spec || {}) as { examples?: Array<{ args: unknown; expect?: string }>; invariants?: string[] };
    const examples = Array.isArray(ioSpec.examples) ? ioSpec.examples.slice(0, MAX_CASES) : [];
    const invariants = Array.isArray(ioSpec.invariants) ? ioSpec.invariants.slice(0, MAX_CASES) : [];

    // The hermetic manifest: forced offline + secretless. The runner enforces
    // this for a verify job regardless; sending it neutered is defense in depth.
    const jobTimeoutMs = Number((program.manifest as any)?.timeout_ms) || 15000;
    const hermeticManifest = { network: "none", allowed_hosts: [], secrets: [], timeout_ms: jobTimeoutMs };
    const socketTimeoutMs = Math.min(VERIFY_SOCKET_CEILING_MS, jobTimeoutMs + VERIFY_SOCKET_HEADROOM_MS);
    const startedAt = Date.now();
    const budgetSpent = () => Date.now() - startedAt >= VERIFY_BUDGET_MS;

    const runOnce = async (args: unknown): Promise<{ ok: boolean; exit: number; stdout: string; sandboxDown: boolean; busy?: boolean }> => {
      try {
        // no_wait, exactly as program-run sends it: a scheduled long run can
        // hold the runner's only slot for an hour, and parking in its queue
        // would blow this deadline and report a healthy sandbox as down.
        const r = await callRunner(conn, "POST", "/run", { mode: "verify", language: program.language, code: program.code, manifest: hermeticManifest, no_wait: true, args }, socketTimeoutMs);
        const rb = (r.body || {}) as Record<string, unknown>;
        const status = String(rb.status || (r.status >= 200 && r.status < 300 ? "ok" : "error"));
        // Contention is not a broken sandbox: with no_wait the runner answers
        // 429/busy while a scheduled long run holds the slot. Calling that
        // "sandbox unavailable" would tell the user their VPS is down.
        if (r.status === 429 || status === "busy") return { ok: false, exit: -1, stdout: "", sandboxDown: false, busy: true };
        if (status === "sandbox_unavailable" || r.status < 200 || r.status >= 300) return { ok: false, exit: -1, stdout: "", sandboxDown: true };
        return { ok: status === "ok", exit: typeof rb.exit_code === "number" ? rb.exit_code : (status === "ok" ? 0 : 1), stdout: typeof rb.stdout === "string" ? rb.stdout : "", sandboxDown: false };
      } catch {
        return { ok: false, exit: -1, stdout: "", sandboxDown: true };
      }
    };

    const checks: Check[] = [];
    let sandboxDown = false;
    // Distinct from sandboxDown: the runner is fine, we simply stopped asking
    // it. Recording this as "sandbox_unavailable" would blame a healthy VPS.
    let budgetOut = false;
    let runnerBusy = false;

    // Each author example: run with its args, require exit 0 and (if given) the
    // expected substring in stdout. This is the independent oracle the user
    // approved alongside the code.
    for (let i = 0; i < examples.length; i++) {
      if (budgetSpent()) { budgetOut = true; break; }
      const ex = examples[i];
      const res = await runOnce(ex.args ?? {});
      if (res.busy) { runnerBusy = true; break; }
      if (res.sandboxDown) { sandboxDown = true; break; }
      const exitOk = res.exit === 0;
      const expectOk = typeof ex.expect === "string" && ex.expect.length > 0 ? res.stdout.includes(ex.expect) : exitOk;
      checks.push({ id: `example_${i}`, passed: exitOk && expectOk });
    }

    // Invariants evaluated against the first example's run (or an empty run).
    if (!sandboxDown && !budgetOut && !runnerBusy && !budgetSpent() && invariants.length > 0) {
      const res = await runOnce(examples[0]?.args ?? {});
      if (res.busy) runnerBusy = true;
      else if (res.sandboxDown) sandboxDown = true;
      else {
        for (let i = 0; i < invariants.length; i++) {
          const inv = invariants[i].toLowerCase();
          let passed = res.exit === 0;
          if (inv.includes("json")) { try { JSON.parse(res.stdout.trim()); passed = passed && true; } catch { passed = false; } }
          if (inv.includes("non-empty") || inv.includes("nonempty")) passed = passed && res.stdout.trim().length > 0;
          checks.push({ id: `invariant_${i}`, passed });
        }
      }
    }

    let verdict: string;
    if (sandboxDown || budgetOut || runnerBusy) verdict = "inconclusive";
    else if (checks.length === 0) verdict = "inconclusive";
    else if (checks.every((c) => c.passed)) verdict = "passed";
    else verdict = "failed";

    await writeReport(verdict, checks);
    await service.from("program_runs").update({
      status: sandboxDown ? "sandbox_unavailable" : "ok",
      error: runnerBusy
        ? "runner busy — a scheduled long run is using the sandbox, so the program was not checked"
        : budgetOut
          ? `verification stopped after ${Math.round(VERIFY_BUDGET_MS / 1000)}s — not every case was run`
          : null,
    }).eq("id", verifyRunId);
    return json({ ok: true, verdict, checks });
  } catch (e) {
    return fail("PROGRAM_REQUEST_FAILED", (e as Error)?.message || "program-verify failed", 500);
  }
});
