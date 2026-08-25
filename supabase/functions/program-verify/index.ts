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

const VERIFY_TIMEOUT_MS = 30_000;
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

    const { data: fp } = await supabase.rpc("program_fingerprint", { p_program_id: programId });
    const fingerprint = String(fp || "");

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
      await service.from("agent_programs").update({
        verified_at: new Date().toISOString(),
        verifier_fingerprint: fingerprint,
        verifier_report: { verdict, checks, fingerprint },
      }).eq("id", programId);
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
    const hermeticManifest = { network: "none", allowed_hosts: [], secrets: [], timeout_ms: Number((program.manifest as any)?.timeout_ms) || 15000 };

    const runOnce = async (args: unknown): Promise<{ ok: boolean; exit: number; stdout: string; sandboxDown: boolean }> => {
      try {
        const r = await callRunner(conn, "POST", "/run", { mode: "verify", language: program.language, code: program.code, manifest: hermeticManifest, args }, VERIFY_TIMEOUT_MS);
        const rb = (r.body || {}) as Record<string, unknown>;
        const status = String(rb.status || (r.status >= 200 && r.status < 300 ? "ok" : "error"));
        if (status === "sandbox_unavailable" || r.status < 200 || r.status >= 300) return { ok: false, exit: -1, stdout: "", sandboxDown: true };
        return { ok: status === "ok", exit: typeof rb.exit_code === "number" ? rb.exit_code : (status === "ok" ? 0 : 1), stdout: typeof rb.stdout === "string" ? rb.stdout : "", sandboxDown: false };
      } catch {
        return { ok: false, exit: -1, stdout: "", sandboxDown: true };
      }
    };

    const checks: Check[] = [];
    let sandboxDown = false;

    // Each author example: run with its args, require exit 0 and (if given) the
    // expected substring in stdout. This is the independent oracle the user
    // approved alongside the code.
    for (let i = 0; i < examples.length; i++) {
      const ex = examples[i];
      const res = await runOnce(ex.args ?? {});
      if (res.sandboxDown) { sandboxDown = true; break; }
      const exitOk = res.exit === 0;
      const expectOk = typeof ex.expect === "string" && ex.expect.length > 0 ? res.stdout.includes(ex.expect) : exitOk;
      checks.push({ id: `example_${i}`, passed: exitOk && expectOk });
    }

    // Invariants evaluated against the first example's run (or an empty run).
    if (!sandboxDown && invariants.length > 0) {
      const res = await runOnce(examples[0]?.args ?? {});
      if (res.sandboxDown) sandboxDown = true;
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
    if (sandboxDown) verdict = "inconclusive";
    else if (checks.length === 0) verdict = "inconclusive";
    else if (checks.every((c) => c.passed)) verdict = "passed";
    else verdict = "failed";

    await writeReport(verdict, checks);
    await service.from("program_runs").update({ status: sandboxDown ? "sandbox_unavailable" : "ok" }).eq("id", verifyRunId);
    return json({ ok: true, verdict, checks });
  } catch (e) {
    return fail("PROGRAM_REQUEST_FAILED", (e as Error)?.message || "program-verify failed", 500);
  }
});
