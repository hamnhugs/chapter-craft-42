// program-cron: the scheduled-run tick. Woken once a minute by pg_cron (pg_net
// POST) with a Vault bearer; it never trusts a user JWT and is never called by a
// browser. For each DUE schedule it re-verifies the pin INSIDE the DB claim, then
// re-checks + RE-ASSERTS THE LEASE here before dispatch, and runs the SAME
// pinned-approved code path as program-run over the SAME HMAC/IP-pinned callRunner.
// The runner holds no Supabase credential; this function is the only scheduler.
//
// verify_jwt=false in config.toml — the gateway does not require a JWT, so the
// constant-time bearer gate below is the sole, deliberate auth on this endpoint.
//
// Security (see docs/operator-tier-plan.md):
//   • Bearer gate: only a caller holding PROGRAM_CRON_KEY (the Vault secret the
//     heartbeat sends) is served; compared in constant time.
//   • claim_due_schedules authorizes INSIDE the atomic UPDATE (approved head +
//     inline fingerprint == pin + not disabled) and stamps a per-claim lease
//     token; we re-assert that token (reclaim_schedule_lease) right before
//     dispatch, so a slow batch can never dispatch a schedule twice.
//   • Deferrals (rate-limited, runner down) RELEASE the lease without counting a
//     failure; only real dispatch outcomes move fail_count.
//   • Secret VALUES never transit here — the manifest carries only NAMES.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateRunnerUrl, callRunner, type RunnerConn } from "../_shared/runner.ts";

// A scheduled run is clamped to this regardless of the program's interactive
// timeout_ms, so a batch fits the tick's own wall-clock. Longer unattended runs
// need the deferred async report-back path (not in this tier).
const CRON_SYNC_MAX_MS = 60_000;
const RATE_PER_MIN = 20;
const RATE_PER_DAY = 500;
const MAX_PER_TICK = 3;
// Stop starting new dispatches past this wall-clock so the tick finishes well
// inside the 5-minute lease even in the worst case; unstarted rows are released
// (token-scoped) and picked up on a later tick.
const TICK_BUDGET_MS = 180_000;

// Constant-time string compare: always scans the full length, no early-out on a
// differing byte (the length check does not leak the secret's content).
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const expected = Deno.env.get("PROGRAM_CRON_KEY") || "";
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || !ctEq(got, expected)) return json({ ok: false, error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let claimed: Array<{ schedule_id: string; user_id: string; program_id: string; tz: string; lease_token: string }> = [];
  try {
    const { data, error } = await service.rpc("claim_due_schedules", { p_limit: MAX_PER_TICK });
    if (error) { await service.rpc("mark_cron_tick", { p_ok: false, p_note: `claim: ${error.message}` }); return json({ ok: false, error: error.message }); }
    claimed = (data as any[]) || [];
  } catch (e) {
    await service.rpc("mark_cron_tick", { p_ok: false, p_note: `claim threw: ${(e as Error).message}` });
    return json({ ok: false, error: (e as Error).message });
  }

  const tickStart = Date.now();
  let dispatched = 0, skipped = 0, failed = 0, released = 0;

  for (const row of claimed) {
    const { schedule_id: scheduleId, user_id: userId, program_id: programId, lease_token: token } = row;

    // Stop starting new dispatches once the budget is spent; release the rest.
    if (Date.now() - tickStart > TICK_BUDGET_MS - CRON_SYNC_MAX_MS) {
      await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
    }

    try {
      // Re-read + re-verify approval head before dispatch (never trust the claim alone).
      const { data: program } = await service
        .from("agent_programs")
        .select("id, name, root_id, language, code, manifest, status, superseded_by, run_count, fail_count")
        .eq("id", programId).eq("status", "approved").is("superseded_by", null).maybeSingle();
      if (!program) { await service.rpc("autopause_program_schedule", { p_schedule_id: scheduleId, p_reason: "program no longer approved" }); skipped++; continue; }

      // Guard a mid-tick re-approval: the newest pin must still equal the schedule's.
      const { data: pinRows } = await service
        .from("program_approvals").select("sha256").eq("program_id", programId)
        .order("approved_at", { ascending: false }).limit(1);
      const pin = (pinRows as Array<{ sha256: string }> | null)?.[0]?.sha256 || null;
      const { data: sched } = await service
        .from("program_schedules").select("pinned_sha256").eq("id", scheduleId).maybeSingle();
      if (!pin || !sched || pin !== (sched as any).pinned_sha256) {
        await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
      }

      // Runner connection for THIS user (their own write-only signing key).
      const { data: settings } = await service
        .from("user_settings")
        .select("program_runner_url, program_runner_key_id, program_runner_signing_key")
        .eq("user_id", userId).maybeSingle();
      const runnerUrl = (settings?.program_runner_url || "").trim();
      const keyId = (settings?.program_runner_key_id || "").trim();
      const signingKey = (settings?.program_runner_signing_key || "").trim();
      if (!runnerUrl || !keyId || !signingKey) { await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue; }

      let conn: RunnerConn;
      try {
        const vr = await validateRunnerUrl(runnerUrl);
        conn = { host: vr.host, port: vr.port, ip: vr.ip, keyId, signingKey };
      } catch { await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue; }

      // Rate limit against the shared per-user budget (run + cron; verify excluded).
      const nowMs = Date.now();
      const [{ count: perMin }, { count: perDay }] = await Promise.all([
        service.from("program_runs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("mode", ["run", "cron"]).gte("created_at", new Date(nowMs - 60_000).toISOString()),
        service.from("program_runs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("mode", ["run", "cron"]).gte("created_at", new Date(nowMs - 86_400_000).toISOString()),
      ]);
      if ((perMin ?? 0) >= RATE_PER_MIN || (perDay ?? 0) >= RATE_PER_DAY) {
        await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
      }

      // Re-assert the lease immediately before dispatch — the single-flight guard.
      const { data: stillOurs } = await service.rpc("reclaim_schedule_lease", { p_schedule_id: scheduleId, p_token: token });
      if (stillOurs !== true) { skipped++; continue; }  // lost the lease to a newer claim — do NOT touch it

      const runId = crypto.randomUUID();
      await service.from("program_runs").insert({ id: runId, user_id: userId, program_id: programId, sha256: pin, mode: "cron", status: "pending" });

      const manifest = (program.manifest || {}) as Record<string, unknown>;
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
            memory: manifest.memory, cpus: manifest.cpus, pids: manifest.pids,
            timeout_ms: Math.min(CRON_SYNC_MAX_MS, Number(manifest.timeout_ms) || 15000),
          },
          args: {},
        }, CRON_SYNC_MAX_MS);
      } catch (e) {
        await service.from("program_runs").update({ status: "sandbox_unavailable", error: `Runner did not respond: ${(e as Error).message}`.slice(0, 500) }).eq("id", runId);
        await service.rpc("settle_program_schedule", { p_schedule_id: scheduleId, p_token: token, p_ok: false }); failed++; continue;
      }

      const rb = (r.body || {}) as Record<string, unknown>;
      const runnerStatus = String(rb.status || (r.status >= 200 && r.status < 300 ? "ok" : "error"));
      const statusMap: Record<string, string> = {
        ok: "ok", error: "error", timeout: "timeout", oom: "oom",
        egress_blocked: "egress_blocked", sandbox_unavailable: "sandbox_unavailable",
      };
      const dbStatus = statusMap[runnerStatus] || "error";
      const stdout = typeof rb.stdout === "string" ? rb.stdout : "";
      const stderr = typeof rb.stderr === "string" ? rb.stderr : "";
      await service.from("program_runs").update({
        status: dbStatus,
        exit_code: typeof rb.exit_code === "number" ? rb.exit_code : null,
        ms: typeof rb.ms === "number" ? rb.ms : null,
        stdout_bytes: stdout.length, stderr_bytes: stderr.length,
        error: dbStatus === "ok" ? null : String(rb.error || dbStatus).slice(0, 500),
      }).eq("id", runId);
      try {
        await service.from("agent_programs").update({
          run_count: (Number((program as any).run_count) || 0) + 1,
          fail_count: dbStatus === "ok" ? 0 : (Number((program as any).fail_count) || 0) + 1,
          last_run_at: new Date().toISOString(),
        }).eq("id", programId);
      } catch { /* counters best-effort */ }

      const ok = dbStatus === "ok";
      await service.rpc("settle_program_schedule", { p_schedule_id: scheduleId, p_token: token, p_ok: ok });
      if (ok) dispatched++; else failed++;
    } catch (e) {
      failed++;
      try { await service.rpc("settle_program_schedule", { p_schedule_id: scheduleId, p_token: token, p_ok: false }); } catch { /* best-effort */ }
    }
  }

  await service.rpc("mark_cron_tick", { p_ok: true, p_note: `claimed=${claimed.length} dispatched=${dispatched} skipped=${skipped} released=${released} failed=${failed}` });
  return json({ ok: true, claimed: claimed.length, dispatched, skipped, released, failed });
});
