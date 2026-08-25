// program-run: execute an APPROVED VPS program on the user's connected runner.
//
// Not an open relay, by construction (mirrors nvidia-chat's invariants, plus the
// ones a code executor needs):
//   1. A valid user JWT is required; every DB read is RLS-scoped to the caller.
//   2. The client sends only a program_id and args — NEVER code. This function
//      reads the pinned-approved code from agent_programs itself and refuses
//      unless the row's fingerprint still equals the program_approvals pin, so a
//      compromised client cannot run arbitrary code, only what the user approved.
//   3. The runner URL is the user's own, validated (https + no private/loopback/
//      metadata) before every call, so this cannot be turned into an SSRF proxy.
//   4. Secret VALUES never transit here: the manifest carries only secret NAMES;
//      the runner injects the values from its own config and redacts them from
//      output before returning.
//   5. Per-user rate limits (checked against program_runs) refuse a runaway loop
//      rather than hammering the user's VPS.
//
// Every failure returns a typed { code } from the client's ProgramErrorCode enum.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateRunnerUrl, callRunner, type RunnerConn } from "../_shared/runner.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RUN_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 15_000;
const RATE_PER_MIN = 20;
const RATE_PER_DAY = 500;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (code: string, error: string, status = 200, extra: Record<string, unknown> = {}) =>
  json({ ok: false, code, error, ...extra }, status);

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

    // Read the runner connection (write-only signing key read server-side under RLS).
    const { data: settings, error: setErr } = await supabase
      .from("user_settings")
      .select("program_runner_url, program_runner_key_id, program_runner_signing_key")
      .eq("user_id", user.id)
      .maybeSingle();
    if (setErr) return fail("PROGRAM_NOT_MIGRATED", `Could not read runner settings: ${setErr.message}`);
    const runnerUrl = (settings?.program_runner_url || "").trim();
    const keyId = (settings?.program_runner_key_id || "").trim();
    const signingKey = (settings?.program_runner_signing_key || "").trim();
    if (!runnerUrl || !signingKey || !keyId) return fail("PROGRAM_RUNNER_UNAVAILABLE", "No VPS runner is connected.");

    let vr: { host: string; port: number; ip: string };
    try { vr = await validateRunnerUrl(runnerUrl); }
    catch (e) { return fail("PROGRAM_RUNNER_UNAVAILABLE", `Runner URL rejected: ${(e as Error).message}`); }
    const conn: RunnerConn = { host: vr.host, port: vr.port, ip: vr.ip, keyId, signingKey };

    // ── health check ──────────────────────────────────────────────────────────
    if (body?.action === "health") {
      let r: { status: number; body: any };
      try { r = await callRunner(conn, "GET", "/health", null, HEALTH_TIMEOUT_MS); }
      catch (e) { return fail("PROGRAM_REQUEST_FAILED", `Runner did not respond: ${(e as Error).message}`); }
      if (r.status < 200 || r.status >= 300) return fail("PROGRAM_RUNNER_ERROR", `Runner health returned ${r.status}`);
      return json({ ok: true, sandbox_ok: r.body?.sandbox_ok === true, runner: r.body?.runner ?? null });
    }

    // ── run ─────────────────────────────────────────────────────────────────
    const programId = String(body?.program_id || "").trim();
    if (!programId) return fail("PROGRAM_REQUEST_FAILED", "program_id required", 400);

    const { data: program, error: pErr } = await supabase
      .from("agent_programs")
      .select("id, name, language, code, manifest, status, superseded_by, run_count, fail_count")
      .eq("id", programId)
      .eq("status", "approved")
      .is("superseded_by", null)
      .maybeSingle();
    if (pErr) return fail("PROGRAM_NOT_MIGRATED", `Could not read the program: ${pErr.message}`);
    if (!program) return fail("PROGRAM_NOT_APPROVED", "No approved program with that id.");

    // Integrity: the stored code must still hash to the approvals pin.
    const { data: fp, error: fpErr } = await supabase.rpc("program_fingerprint", { p_program_id: programId });
    if (fpErr) return fail("PROGRAM_INTEGRITY_FAILED", `Could not fingerprint the program: ${fpErr.message}`);
    const { data: pinRows } = await supabase
      .from("program_approvals").select("sha256").eq("program_id", programId)
      .order("approved_at", { ascending: false }).limit(1);
    const pin = (pinRows as Array<{ sha256: string }> | null)?.[0]?.sha256 || null;
    if (!pin || String(fp) !== pin) return fail("PROGRAM_INTEGRITY_FAILED", "The program no longer matches what the user approved.");

    // Rate limit — INSERT-then-count so it is not a check-then-act race. The
    // service role writes a PENDING row first (the client has no write path to
    // the log), then counts a window that now INCLUDES this and every other
    // in-flight run; a burst therefore counts each other and the excess refuses
    // instead of all slipping under a stale pre-dispatch read. The pending row
    // is deleted on refusal (it never ran) and settled after the runner answers.
    const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const runId = crypto.randomUUID();
    await service.from("program_runs").insert({ id: runId, user_id: user.id, program_id: programId, sha256: pin, mode: "run", status: "pending" });
    const nowMs = Date.now();
    const sinceMin = new Date(nowMs - 60_000).toISOString();
    const sinceDay = new Date(nowMs - 86_400_000).toISOString();
    const [{ count: perMin }, { count: perDay }] = await Promise.all([
      service.from("program_runs").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("mode", "run").gte("created_at", sinceMin),
      service.from("program_runs").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("mode", "run").gte("created_at", sinceDay),
    ]);
    if ((perMin ?? 0) > RATE_PER_MIN || (perDay ?? 0) > RATE_PER_DAY) {
      await service.from("program_runs").delete().eq("id", runId);
      return fail("PROGRAM_RATE_LIMITED", "Too many runs recently — try again shortly.");
    }

    const manifest = (program.manifest || {}) as Record<string, unknown>;
    // Send the job. Secret NAMES only; the runner injects values + redacts them.
    let r: { status: number; body: any };
    try {
      r = await callRunner(conn, "POST", "/run", {
        mode: "run",
        language: program.language,
        code: program.code,
        manifest: {
          network: manifest.network === "allowlist" ? "allowlist" : "none",
          allowed_hosts: Array.isArray(manifest.allowed_hosts) ? manifest.allowed_hosts : [],
          secrets: Array.isArray(manifest.secrets) ? manifest.secrets : [],
          timeout_ms: Number(manifest.timeout_ms) || 15000,
        },
        args: body?.args ?? {},
      }, RUN_TIMEOUT_MS);
    } catch (e) {
      await service.from("program_runs").update({ status: "sandbox_unavailable", error: `Runner did not respond: ${(e as Error).message}`.slice(0, 500) }).eq("id", runId);
      return fail("PROGRAM_REQUEST_FAILED", `Runner did not respond: ${(e as Error).message}`);
    }

    // Settle the run row (service role; the log has no client write policy).
    const rb = (r.body || {}) as Record<string, unknown>;
    const runnerStatus = String(rb.status || (r.status >= 200 && r.status < 300 ? "ok" : "error"));
    const statusMap: Record<string, string> = {
      ok: "ok", error: "error", timeout: "timeout", oom: "oom",
      egress_blocked: "egress_blocked", sandbox_unavailable: "sandbox_unavailable",
    };
    const dbStatus = statusMap[runnerStatus] || "error";
    const exitCode = typeof rb.exit_code === "number" ? rb.exit_code : null;
    const ms = typeof rb.ms === "number" ? rb.ms : null;
    const stdout = typeof rb.stdout === "string" ? rb.stdout : "";
    const stderr = typeof rb.stderr === "string" ? rb.stderr : "";
    await service.from("program_runs").update({
      status: dbStatus, exit_code: exitCode, ms,
      stdout_bytes: stdout.length, stderr_bytes: stderr.length,
      error: dbStatus === "ok" ? null : String(rb.error || dbStatus).slice(0, 500),
    }).eq("id", runId);
    // Health counters on the program row (the guard freezes code/identity but
    // permits these). fail_count is a STREAK — reset to 0 on any success — which
    // is what rankToolsForQuery/isToolHealthy read to stop volunteering a broken
    // one. Direct service-role update; the client has no UPDATE policy at all.
    try {
      await service.from("agent_programs").update({
        run_count: (Number((program as any).run_count) || 0) + 1,
        fail_count: dbStatus === "ok" ? 0 : (Number((program as any).fail_count) || 0) + 1,
        last_run_at: new Date().toISOString(),
      }).eq("id", programId);
    } catch { /* counters best-effort */ }

    // rb.error is runner/program-influenced text — length-bound it on every
    // returned path (the client keeps it out of unfenced model context, but
    // capping here is cheap defense in depth, matching the 500-char stored cap).
    const rbError = String(rb.error || "").slice(0, 500);
    if (r.status < 200 || r.status >= 300 || dbStatus === "sandbox_unavailable") {
      return fail("PROGRAM_SANDBOX_UNAVAILABLE", rbError || "the runner could not start a sandbox");
    }
    if (dbStatus === "ok") {
      return json({ ok: true, exit_code: exitCode ?? 0, stdout, stderr, ms });
    }
    const codeMap: Record<string, string> = {
      timeout: "PROGRAM_TIMEOUT", oom: "PROGRAM_OOM", egress_blocked: "PROGRAM_EGRESS_BLOCKED", error: "PROGRAM_ERROR",
    };
    const code = codeMap[dbStatus] || "PROGRAM_ERROR";
    return fail(code, rbError || "the program failed", 200, code === "PROGRAM_ERROR" ? { exit_code: exitCode, stdout, stderr, ms } : {});
  } catch (e) {
    return fail("PROGRAM_REQUEST_FAILED", (e as Error)?.message || "program-run failed", 500);
  }
});
