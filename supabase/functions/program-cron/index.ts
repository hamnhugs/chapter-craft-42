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
// LONG RUNS (poll model — the runner stays inbound-only): a schedule with a
// max_runtime_s allowance is dispatched ASYNC — the runner accepts immediately
// and executes in background, persisting the result to disk. Single-flight hands
// off atomically from the claim lease to the schedule's active_run_id marker
// (begin_async_program_run CAS), which blocks re-claim until a LATER tick polls
// the runner's signed GET /result and settles (settle CAS = single winner).
// The tick's own wall-clock never rides a long job.
//
// Security (see docs/operator-tier-plan.md):
//   • Bearer gate: only a caller holding PROGRAM_CRON_KEY (the Vault secret the
//     heartbeat sends) is served; compared in constant time.
//   • claim_due_schedules authorizes INSIDE the atomic UPDATE (approved head +
//     inline fingerprint == pin + not disabled + no active async run) and stamps
//     a per-claim lease token; we re-assert that token before dispatch.
//   • Deferrals (rate-limited, runner busy/down) RELEASE the lease or ABORT the
//     async marker without counting a failure; only real outcomes move fail_count.
//   • Secret VALUES never transit here — the manifest carries only NAMES.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateRunnerUrl, callRunner, type RunnerConn } from "../_shared/runner.ts";

// A scheduled sync run is clamped to this regardless of the program's interactive
// timeout_ms, so a batch fits the tick's own wall-clock. Longer unattended runs
// go through the async path below.
const CRON_SYNC_MAX_MS = 60_000;
const RATE_PER_MIN = 20;
const RATE_PER_DAY = 500;
const MAX_PER_TICK = 3;
// Stop starting new dispatches past this wall-clock so the tick finishes well
// inside the 5-minute lease even in the worst case; unstarted rows are released
// (token-scoped) and picked up on a later tick.
const TICK_BUDGET_MS = 180_000;

// Async poll phase: runs FIRST (settling beats new work) and is tightly budgeted
// so it can never eat the dispatch window.
const ASYNC_POLL_MAX = 10;
const POLL_TIMEOUT_MS = 8_000;
const ASYNC_ACCEPT_TIMEOUT_MS = 15_000;
// A run whose runner reports "unknown" is only settled as lost after this age —
// closes the race where an overlapping tick polls between our begin-marker and
// the runner actually accepting the dispatch.
const UNKNOWN_MIN_AGE_MS = 180_000;
// A run "running" (or unreachable) past its deadline gets this grace before
// being reaped as lost — the runner enforces its own timeout and normally writes
// a timeout result well before this.
const DEADLINE_GRACE_MS = 3_600_000;

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

const STATUS_MAP: Record<string, string> = {
  ok: "ok", error: "error", timeout: "timeout", oom: "oom",
  egress_blocked: "egress_blocked", sandbox_unavailable: "sandbox_unavailable", lost: "lost",
};

// deno-lint-ignore no-explicit-any
type Service = any;

/** Resolve one user's runner connection (their own write-only signing key).
 *  Returns null when unconfigured or the URL fails SSRF vetting. */
async function getRunnerConn(service: Service, userId: string): Promise<RunnerConn | null> {
  const { data: settings } = await service
    .from("user_settings")
    .select("program_runner_url, program_runner_key_id, program_runner_signing_key")
    .eq("user_id", userId).maybeSingle();
  const runnerUrl = (settings?.program_runner_url || "").trim();
  const keyId = (settings?.program_runner_key_id || "").trim();
  const signingKey = (settings?.program_runner_signing_key || "").trim();
  if (!runnerUrl || !keyId || !signingKey) return null;
  try {
    const vr = await validateRunnerUrl(runnerUrl);
    return { host: vr.host, port: vr.port, ip: vr.ip, keyId, signingKey };
  } catch { return null; }
}

/** Record a finished async run: write the run row FIRST (idempotent — a raced
 *  duplicate writes identical values), then CAS-settle; only the CAS winner
 *  moves the program counters. A crash between the two leaves the schedule
 *  active and the durable result still on the runner — the next tick completes
 *  settlement. */
async function recordAsyncOutcome(
  service: Service,
  scheduleId: string,
  programId: string,
  runId: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const runnerStatus = String(result.status || "error");
  const dbStatus = STATUS_MAP[runnerStatus] || "error";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const { error: writeErr } = await service.from("program_runs").update({
    status: dbStatus,
    exit_code: typeof result.exit_code === "number" ? result.exit_code : null,
    ms: typeof result.ms === "number" ? result.ms : null,
    stdout_bytes: stdout.length, stderr_bytes: stderr.length,
    error: dbStatus === "ok" ? null : String(result.error || result.stderr || dbStatus).slice(0, 500),
  }).eq("id", runId);
  // supabase-js resolves {error} instead of throwing. If the run-row write
  // failed, do NOT settle: leaving active_run_id set keeps the schedule out of
  // re-dispatch and the durable result on the runner, so a later tick re-polls
  // and completes settlement — rather than clearing the marker over a row still
  // stuck 'pending' whose result then expires unread.
  if (writeErr) return false;

  const ok = dbStatus === "ok";
  const { data: won } = await service.rpc("settle_async_program_run", {
    p_schedule_id: scheduleId, p_run_id: runId, p_ok: ok,
  });
  if (won === true) {
    try {
      const { data: prog } = await service.from("agent_programs")
        .select("run_count, fail_count").eq("id", programId).maybeSingle();
      await service.from("agent_programs").update({
        run_count: (Number(prog?.run_count) || 0) + 1,
        fail_count: ok ? 0 : (Number(prog?.fail_count) || 0) + 1,
        last_run_at: new Date().toISOString(),
      }).eq("id", programId);
    } catch { /* counters best-effort */ }
  }
  return ok;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const expected = Deno.env.get("PROGRAM_CRON_KEY") || "";
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || !ctEq(got, expected)) return json({ ok: false, error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const tickStart = Date.now();
  let dispatched = 0, skipped = 0, failed = 0, released = 0, polled = 0, settled = 0;

  // ── Phase 0: poll + settle in-flight async runs (before any new work). ──────
  try {
    const { data: actives } = await service
      .from("program_schedules")
      .select("id, user_id, program_id, active_run_id, active_run_started_at, active_run_deadline")
      .not("active_run_id", "is", null)
      .order("active_run_started_at", { ascending: true })
      .limit(ASYNC_POLL_MAX);
    for (const a of (actives as any[]) || []) {
      const scheduleId = String(a.id), runId = String(a.active_run_id), programId = String(a.program_id);
      const startedMs = a.active_run_started_at ? new Date(a.active_run_started_at).getTime() : 0;
      const deadlineMs = a.active_run_deadline ? new Date(a.active_run_deadline).getTime() : startedMs + 3_600_000;
      const pastGrace = Date.now() > deadlineMs + DEADLINE_GRACE_MS;
      polled++;

      const reapLost = async (why: string) => {
        await service.from("program_runs").update({
          status: "lost", error: why.slice(0, 500),
        }).eq("id", runId).eq("status", "pending");
        const { data: won } = await service.rpc("settle_async_program_run", {
          p_schedule_id: scheduleId, p_run_id: runId, p_ok: false,
        });
        if (won === true) settled++;
      };

      const conn = await getRunnerConn(service, String(a.user_id));
      if (!conn) {
        // Unconfigured/invalid runner: the durable result (if any) is unreachable.
        if (pastGrace) await reapLost("the runner was unreachable past the run's deadline");
        continue;
      }
      let pr: { status: number; body: any };
      try {
        pr = await callRunner(conn, "GET", `/result?run_id=${runId}`, null, POLL_TIMEOUT_MS);
      } catch {
        if (pastGrace) await reapLost("the runner was unreachable past the run's deadline");
        continue;
      }
      const b = (pr.body || {}) as Record<string, unknown>;
      const ok2xx = pr.status >= 200 && pr.status < 300;
      if (ok2xx && b.done === true && b.result && typeof b.result === "object") {
        // A false return means the run-row write failed and the marker was left
        // in place on purpose — a later tick re-polls and settles.
        if (await recordAsyncOutcome(service, scheduleId, programId, runId, b.result as Record<string, unknown>)) settled++;
      } else if (ok2xx && b.unknown === true) {
        // The runner has no record. Give a fresh dispatch a settling window
        // (an overlapping tick may be mid-dispatch), then call it lost.
        if (Date.now() - startedMs > UNKNOWN_MIN_AGE_MS) {
          await reapLost("the runner has no record of this run (restarted before it finished, or its result expired)");
        }
      } else if (ok2xx && b.running === true) {
        if (pastGrace) await reapLost("the run exceeded its deadline and the runner never produced a result");
        // else: still executing — nothing to do this tick.
      } else if (pastGrace) {
        // A non-2xx status (proxy 502, gateway 401 after a key rotation, clock
        // skew) or an unrecognized body — the runner is answering but not with a
        // collectable result. Left alone this would jam active_run_id forever and
        // starve the poll window; reap it once past the deadline. (Loss is typed,
        // never silent — design law #4.)
        await reapLost("the runner answered but never produced a collectable result before the deadline");
      }
    }
  } catch { /* poll phase is best-effort; the deadline reap self-heals */ }

  // Sweep run rows stranded 'pending' with no marker pointing at them (edge
  // death between insert and any terminal write; historical delete cascades).
  // Typed 'lost' beats silent 'pending' forever. Best-effort, service-role RPC;
  // absent on a pre-migration DB (swallowed).
  try { await service.rpc("sweep_orphan_cron_runs"); } catch { /* pre-migration or transient */ }

  // ── Phase 1: claim + dispatch due schedules. ────────────────────────────────
  let claimed: Array<{ schedule_id: string; user_id: string; program_id: string; tz: string; lease_token: string }> = [];
  try {
    const { data, error } = await service.rpc("claim_due_schedules", { p_limit: MAX_PER_TICK });
    if (error) { await service.rpc("mark_cron_tick", { p_ok: false, p_note: `claim: ${error.message}` }); return json({ ok: false, error: error.message }); }
    claimed = (data as any[]) || [];
  } catch (e) {
    await service.rpc("mark_cron_tick", { p_ok: false, p_note: `claim threw: ${(e as Error).message}` });
    return json({ ok: false, error: (e as Error).message });
  }

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
      // Dual-mode read (first-read-is-the-probe, the house pattern): edge
      // functions deploy before the migration is applied, so max_runtime_s may
      // not exist yet. Selecting it unconditionally would 42703 the whole read,
      // null `sched`, and release EVERY schedule every tick — a silent, total
      // scheduler stall while the health badge stays green. Fall back to the
      // base column (sync dispatch, fully valid on the old schema).
      let sched: { pinned_sha256?: string; max_runtime_s?: number | null } | null = null;
      {
        const withLong = await service
          .from("program_schedules").select("pinned_sha256, max_runtime_s").eq("id", scheduleId).maybeSingle();
        if (!withLong.error) {
          sched = withLong.data as any;
        } else {
          const base = await service
            .from("program_schedules").select("pinned_sha256").eq("id", scheduleId).maybeSingle();
          sched = base.data as any; // max_runtime_s stays undefined → sync path
        }
      }
      if (!pin || !sched || pin !== (sched as any).pinned_sha256) {
        await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
      }
      const maxRuntimeS = Number((sched as any).max_runtime_s) || 0;
      const asyncRun = maxRuntimeS * 1000 > CRON_SYNC_MAX_MS;

      const conn = await getRunnerConn(service, userId);
      if (!conn) { await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue; }

      // Rate limit against the shared per-user budget (run + cron; verify
      // excluded). Pure DEFERRALS (skipped / sandbox_unavailable) are excluded
      // too: they record that a run did NOT happen, and counting them lets
      // sustained busy-contention manufacture phantom "runs" that trip the daily
      // cap and then rate-release every schedule.
      const nowMs = Date.now();
      const DEFERRAL_STATUSES = '("skipped","sandbox_unavailable")';
      const [{ count: perMin }, { count: perDay }] = await Promise.all([
        service.from("program_runs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("mode", ["run", "cron"]).not("status", "in", DEFERRAL_STATUSES).gte("created_at", new Date(nowMs - 60_000).toISOString()),
        service.from("program_runs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("mode", ["run", "cron"]).not("status", "in", DEFERRAL_STATUSES).gte("created_at", new Date(nowMs - 86_400_000).toISOString()),
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
      const wantsPersist = manifest.persist === true;
      let stateKey: string | null = null, stateEpoch = 1;
      if (wantsPersist) {
        stateKey = (program as any).root_id || programId;
        // FAIL CLOSED (see program-run): never dispatch a persist run at a guessed
        // epoch of 1. On an unresolved epoch, error the run and release the lease
        // so a later tick can retry once the state row is readable.
        const { data: st, error: stErr } = await service.from("program_state").select("epoch").eq("root_id", stateKey).maybeSingle();
        if (stErr || !st || !Number.isInteger((st as any).epoch) || (st as any).epoch < 1) {
          await service.from("program_runs").update({ status: "error", error: "Could not resolve the program's persistent-state epoch." }).eq("id", runId);
          await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
        }
        stateEpoch = (st as any).epoch;
      }

      const baseJob = {
        mode: "run",
        language: program.language,
        code: program.code,
        manifest: {
          network: manifest.network === "allowlist" ? "allowlist" : "none",
          allowed_hosts: Array.isArray(manifest.allowed_hosts) ? manifest.allowed_hosts : [],
          secrets: Array.isArray(manifest.secrets) ? manifest.secrets : [],
          memory: manifest.memory, cpus: manifest.cpus, pids: manifest.pids,
          persist: wantsPersist,
          timeout_ms: asyncRun ? maxRuntimeS * 1000 : Math.min(CRON_SYNC_MAX_MS, Number(manifest.timeout_ms) || 15000),
        },
        state_key: stateKey, state_epoch: stateEpoch,
        args: {},
      };

      if (asyncRun) {
        // Don't OPEN an async dispatch (begin marker → accept can take ~30s)
        // this late in the tick: if the edge runtime is killed in the
        // begin→accept window the marker is set but no job was ever sent, and
        // that infrastructure loss would later be reaped as a counted failure.
        // Releasing here (a later tick redispatches cleanly) keeps it a deferral.
        if (Date.now() - tickStart > TICK_BUDGET_MS - CRON_SYNC_MAX_MS - ASYNC_ACCEPT_TIMEOUT_MS) {
          await service.from("program_runs").update({ status: "skipped", error: "deferred: not enough tick budget to open a long run safely" }).eq("id", runId);
          await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
        }
        // ── async dispatch: marker BEFORE the wire call, so an accepted job can
        // never be untracked. A failed/deferred dispatch aborts the marker.
        const deadline = new Date(Date.now() + maxRuntimeS * 1000 + 60_000).toISOString();
        const { data: begun } = await service.rpc("begin_async_program_run", {
          p_schedule_id: scheduleId, p_token: token, p_run_id: runId, p_deadline: deadline,
        });
        if (begun !== true) {
          await service.from("program_runs").update({ status: "skipped", error: "lost the dispatch race to a newer claim" }).eq("id", runId);
          skipped++; continue;
        }
        let ar: { status: number; body: any };
        try {
          ar = await callRunner(conn, "POST", "/run", { ...baseJob, async: true, run_id: runId }, ASYNC_ACCEPT_TIMEOUT_MS);
        } catch (e) {
          // Two-generals: the request may have been DELIVERED (runner launched
          // the job) even though the response was lost. Do NOT blindly abort —
          // that would record an executing run as never-run and let the slot
          // redispatch. Probe /result once: only a definitive "unknown" proves
          // the runner never got it (→ abort, a clean deferral). Anything else
          // (reachable/running/done, or unreachable) leaves the marker so the
          // poll phase settles the truth (done → outcome; unknown after 3 min →
          // lost; past deadline → reaped).
          let neverArrived = false;
          try {
            const probe = await callRunner(conn, "GET", `/result?run_id=${runId}`, null, POLL_TIMEOUT_MS);
            const pb = (probe.body || {}) as Record<string, unknown>;
            neverArrived = probe.status >= 200 && probe.status < 300 && pb.unknown === true;
          } catch { neverArrived = false; }
          if (neverArrived) {
            await service.from("program_runs").update({ status: "skipped", error: "deferred: the runner did not accept the async dispatch" }).eq("id", runId);
            await service.rpc("abort_async_program_run", { p_schedule_id: scheduleId, p_run_id: runId }); released++; continue;
          }
          // Ambiguous — leave it pending under the marker for the poll phase.
          await service.from("program_runs").update({ status: "pending", error: `async dispatch response lost; awaiting poll: ${(e as Error).message}`.slice(0, 500) }).eq("id", runId);
          dispatched++; continue;
        }
        const ab = (ar.body || {}) as Record<string, unknown>;
        if (ar.status === 429 || ab.status === "busy") {
          await service.from("program_runs").update({ status: "skipped", error: "runner busy — deferred to a later slot" }).eq("id", runId);
          await service.rpc("abort_async_program_run", { p_schedule_id: scheduleId, p_run_id: runId }); released++; continue;
        }
        if (ab.status === "accepted") {
          dispatched++; continue; // a later tick polls /result and settles
        }
        // A typed rejection (bad language, egress unavailable, marker write
        // failure…) is a real failure of this slot: record + CAS-settle.
        await service.from("program_runs").update({
          status: STATUS_MAP[String(ab.status || "")] || "error",
          error: String(ab.error || "the runner rejected the async dispatch").slice(0, 500),
        }).eq("id", runId);
        await service.rpc("settle_async_program_run", { p_schedule_id: scheduleId, p_run_id: runId, p_ok: false });
        failed++; continue;
      }

      // ── sync dispatch (the pre-existing path, plus busy-deferral).
      // The transport timeout must EXCEED the job's own wall-clock cap, or a run
      // that legitimately uses its full budget answers after the deadline and is
      // misrecorded as "did not respond" (the runner soft-kills at timeout+2s
      // then does docker inspect/cleanup). program-run uses the same 15s margin.
      let r: { status: number; body: any };
      try {
        r = await callRunner(conn, "POST", "/run", { ...baseJob, no_wait: true }, CRON_SYNC_MAX_MS + 15_000);
      } catch (e) {
        // A runner that is DOWN is infrastructure contention, not a program
        // failure: release the lease (deferral, no fail streak), matching the
        // async lane and this file's header. A sustained outage then defers
        // rather than auto-pausing the program with a "consecutive failures"
        // reason that blames the code for the box being offline.
        await service.from("program_runs").update({ status: "sandbox_unavailable", error: `Runner did not respond: ${(e as Error).message}`.slice(0, 500) }).eq("id", runId);
        await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
      }

      const rb = (r.body || {}) as Record<string, unknown>;
      // A busy runner is contention, not a program failure: defer without
      // touching the fail streak. (Pre-fix, this settled as a failure.)
      if (r.status === 429 || rb.status === "busy") {
        await service.from("program_runs").update({ status: "skipped", error: "runner busy — deferred to a later slot" }).eq("id", runId);
        await service.rpc("release_schedule_lease", { p_schedule_id: scheduleId, p_token: token }); released++; continue;
      }
      const runnerStatus = String(rb.status || (r.status >= 200 && r.status < 300 ? "ok" : "error"));
      const dbStatus = STATUS_MAP[runnerStatus] || "error";
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

  await service.rpc("mark_cron_tick", { p_ok: true, p_note: `claimed=${claimed.length} dispatched=${dispatched} skipped=${skipped} released=${released} failed=${failed} polled=${polled} settled=${settled}` });
  return json({ ok: true, claimed: claimed.length, dispatched, skipped, released, failed, polled, settled });
});
