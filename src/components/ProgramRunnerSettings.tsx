import React, { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  programsAvailable, listPrograms, disableProgram,
  listSchedules, setProgramSchedule, pauseProgramSchedule, deleteProgramSchedule, cronHealth, latestCronOutcomes,
  type AgentProgramRow, type ProgramScheduleRow, type CronHealth, type ProgramRunRow,
} from "@/lib/programFoundry";

/**
 * Settings → Program Foundry — the management surface for the AI's VPS programs.
 *
 * A program is arbitrary bash/python/node that runs a real shell on the user's
 * OWN connected VPS, so both switches are OPT-IN (explicit true, inverted from
 * the app's default-allow convention) AND nothing is usable until a runner is
 * connected. The connection's signing key is WRITE-ONLY: it is delta-written
 * (sent only when the user types a new one) and read back only by the edge
 * functions under RLS, so an unrelated settings save can never wipe it.
 *
 * The user's real safety gate is approving the exact source and its declared
 * execution profile on the chat approval card; this surface is for connecting
 * the runner, flipping the switches, and disabling a program's name for good.
 */

const MIGRATION_FILE = "supabase/migrations/20260824000000_program_foundry.sql";

// ── scheduling (cron) ────────────────────────────────────────────────────────
const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();

// value encoding: "" = off, "i<seconds>" = interval, "d<minute>" = daily-at-minute
const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Off (no schedule)", value: "" },
  { label: "Every 15 minutes", value: "i900" },
  { label: "Every 30 minutes", value: "i1800" },
  { label: "Hourly", value: "i3600" },
  { label: "Every 6 hours", value: "i21600" },
  { label: "Daily at 9:00 AM", value: "d540" },
  { label: "Daily at 6:00 PM", value: "d1080" },
];

function scheduleToPreset(s?: ProgramScheduleRow): string {
  if (!s) return "";
  if (s.every_seconds != null) return `i${s.every_seconds}`;
  if (s.daily_at_minute != null) return `d${s.daily_at_minute}`;
  return "";
}
function presetToArgs(v: string): { everySeconds?: number; dailyAtMinute?: number; tz?: string } | null {
  if (v.startsWith("i")) return { everySeconds: Number(v.slice(1)) };
  if (v.startsWith("d")) return { dailyAtMinute: Number(v.slice(1)), tz: BROWSER_TZ };
  return null;
}

// Long-run allowance: 0 = standard sync run (≤60s). Anything longer is
// dispatched async and polled by the scheduler until its result lands.
const RUNTIME_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "Standard (≤60s)", seconds: 0 },
  { label: "Up to 5 min", seconds: 300 },
  { label: "Up to 15 min", seconds: 900 },
  { label: "Up to 30 min", seconds: 1800 },
  { label: "Up to 1 hour", seconds: 3600 },
];

// A scheduled run's outcome, in plain words. 'ok' is the quiet case; everything
// else names what happened so a schedule is never just an anonymous fail count.
const CRON_OUTCOME_LABEL = (r: ProgramRunRow): string => {
  const at = new Date(r.created_at).toLocaleString();
  switch (r.status) {
    case "ok": return `succeeded (${at})`;
    case "timeout": return `timed out (${at})`;
    case "oom": return `ran out of memory (${at})`;
    case "egress_blocked": return `egress blocked (${at})`;
    case "lost": return `lost — runner restarted mid-run (${at})`;
    case "skipped": return `skipped — runner busy (${at})`;
    case "sandbox_unavailable": return `runner unreachable (${at})`;
    case "pending": return `in progress (${at})`;
    default: return `failed (${at})`;
  }
};

/** Per-program recurrence control. Only shown for an APPROVED program on a
 *  connected runner. Runs happen server-side (program-cron); this only creates
 *  the schedule via owner-scoped RPCs. */
const ScheduleControl: React.FC<{ program: AgentProgramRow; schedule?: ProgramScheduleRow; longRuns: boolean; lastCron?: ProgramRunRow; onChanged: () => void }> = ({ program, schedule, longRuns, lastCron, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const apply = useCallback(async (v: string, runtimeS?: number) => {
    setBusy(true);
    try {
      if (!v) {
        if (schedule) { await deleteProgramSchedule(program.id); toast.success("Schedule removed"); }
      } else {
        const a = presetToArgs(v);
        if (a) {
          const maxRuntimeS = runtimeS !== undefined ? (runtimeS || null) : (schedule?.max_runtime_s ?? null);
          const { next_run_at } = await setProgramSchedule(program.id, { ...a, maxRuntimeS });
          toast.success(next_run_at ? `Scheduled — next run ${new Date(next_run_at).toLocaleString()}` : "Scheduled");
        }
      }
      onChanged();
    } catch (e) {
      toast.error(`Could not update schedule: ${String((e as Error)?.message || e).slice(0, 160)}`);
    } finally { setBusy(false); }
  }, [program.id, schedule, onChanged]);
  const toggle = useCallback(async () => {
    if (!schedule) return;
    setBusy(true);
    try { await pauseProgramSchedule(program.id, !schedule.enabled); onChanged(); }
    catch (e) { toast.error(`Could not update: ${String((e as Error)?.message || e).slice(0, 160)}`); }
    finally { setBusy(false); }
  }, [program.id, schedule, onChanged]);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-on-surface-variant" aria-hidden>⏱</span>
      <select value={scheduleToPreset(schedule)} onChange={(e) => apply(e.target.value)} disabled={busy}
        aria-label={`Schedule for ${program.name}`}
        className="rounded border border-outline/50 bg-surface px-2 py-1 text-[11px] disabled:opacity-50">
        {SCHEDULE_PRESETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {schedule && longRuns && (
        <select
          value={String(schedule.max_runtime_s ?? 0)}
          onChange={(e) => apply(scheduleToPreset(schedule), Number(e.target.value))}
          // Disabled while paused: changing the allowance goes through
          // set_program_schedule, whose upsert re-enables the schedule and
          // resets the fail streak — a paused schedule must not silently re-arm
          // from this dropdown next to the Resume button.
          disabled={busy || !schedule.enabled}
          aria-label={`Runtime allowance for ${program.name}`}
          className="rounded border border-outline/50 bg-surface px-2 py-1 text-[11px] disabled:opacity-50">
          {RUNTIME_PRESETS
            // An interval must exceed the allowance by the 5-min headroom the RPC
            // requires (else it rejects, and a 100%-duty schedule would starve
            // others). Daily schedules (every_seconds null) accept any allowance.
            .filter((o) => o.seconds === 0 || schedule.every_seconds == null || o.seconds + 300 <= schedule.every_seconds)
            .map((o) => <option key={o.seconds} value={String(o.seconds)}>{o.label}</option>)}
        </select>
      )}
      {schedule && (
        <>
          <span className="text-[11px] text-on-surface-variant">
            {schedule.active_run_id
              ? (schedule.active_run_started_at ? `in flight since ${new Date(schedule.active_run_started_at).toLocaleTimeString()}` : "in flight…")
              : schedule.enabled
                ? `next ${new Date(schedule.next_run_at).toLocaleString()}`
                : (schedule.paused_reason || "paused")}
            {schedule.fail_count > 0 && schedule.enabled ? ` · ${schedule.fail_count} recent fail${schedule.fail_count > 1 ? "s" : ""}` : ""}
          </span>
          {lastCron && !schedule.active_run_id && (
            <span className="text-[11px] text-on-surface-variant" title={lastCron.error || undefined}>
              · last run {CRON_OUTCOME_LABEL(lastCron)}
            </span>
          )}
          <button onClick={toggle} disabled={busy}
            className="rounded border border-outline/50 px-2 py-0.5 text-[11px] disabled:opacity-50">
            {schedule.enabled ? "Pause" : "Resume"}
          </button>
        </>
      )}
    </div>
  );
};

const ProgramRunnerSettings: React.FC = () => {
  const {
    chatToolPermissions, setChatToolPermission,
    programRunnerUrl, programRunnerKeyId, programRunnerLast4, programRunnerConfigured, saveProgramRunner,
  } = useChatSettings();

  const forgeOn = chatToolPermissions["forge_program"] === true;
  const runOn = chatToolPermissions["run_program"] === true;

  const [migrated, setMigrated] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; programsAvailable().then((ok) => { if (alive) setMigrated(ok); }); return () => { alive = false; }; }, [forgeOn, runOn]);

  const [url, setUrl] = useState(programRunnerUrl || "");
  const [keyId, setKeyId] = useState(programRunnerKeyId || "");
  const [signingKey, setSigningKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => { setUrl(programRunnerUrl || ""); setKeyId(programRunnerKeyId || ""); }, [programRunnerUrl, programRunnerKeyId]);

  const [programs, setPrograms] = useState<AgentProgramRow[]>([]);
  const [schedules, setSchedules] = useState<Map<string, ProgramScheduleRow>>(new Map());
  const [cronOk, setCronOk] = useState<CronHealth | null>(null);
  const [schedulesReady, setSchedulesReady] = useState<boolean | null>(null);
  const [longRuns, setLongRuns] = useState(false);
  const [cronRuns, setCronRuns] = useState<Map<string, ProgramRunRow>>(new Map());
  const refresh = useCallback(async () => {
    if (!(await programsAvailable())) return;
    try { setPrograms((await listPrograms()).filter((p) => !p.superseded_by)); } catch { /* ignore */ }
    // Schedules live in the later cron migration; if it isn't applied yet, hide
    // the scheduling UI instead of erroring (schedulesReady=false).
    try {
      const { rows, longRuns: lr } = await listSchedules();
      setSchedules(new Map(rows.map((s) => [s.program_id, s])));
      setLongRuns(lr);
      setCronRuns(await latestCronOutcomes(rows.map((s) => s.program_id)));
      setCronOk(await cronHealth());
      setSchedulesReady(true);
    } catch { setSchedulesReady(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const onSave = useCallback(async () => {
    setSaving(true);
    // Only send the signing key when the user typed one — otherwise the stored
    // (write-only) key is preserved. Saving a fresh connection requires it.
    if (url && !programRunnerConfigured && !signingKey) { toast.error("Enter the signing key from your runner config"); setSaving(false); return; }
    const ok = await saveProgramRunner({ url, keyId, signingKey: signingKey || undefined });
    if (ok) setSigningKey("");
    setSaving(false);
  }, [url, keyId, signingKey, programRunnerConfigured, saveProgramRunner]);

  const onDisconnect = useCallback(async () => {
    setSaving(true);
    await saveProgramRunner({ url: "", keyId: "" });
    setUrl(""); setKeyId(""); setSigningKey("");
    setSaving(false);
  }, [saveProgramRunner]);

  const onTest = useCallback(async () => {
    setTesting(true);
    try {
      const res: any = await (supabase as any).functions.invoke("program-run", { body: { action: "health" } });
      const body = res?.data ?? null;
      if (res?.error && !body) { toast.error("Runner did not respond — check the URL and that the runner is running."); return; }
      if (body?.ok && body?.sandbox_ok) toast.success("Runner reachable and the gVisor sandbox is healthy.");
      else if (body?.ok && body?.sandbox_ok === false) toast.error("Runner reachable, but its gVisor sandbox self-test FAILED — it cannot run programs safely yet.");
      else toast.error(body?.error ? `Runner error: ${String(body.error).slice(0, 160)}` : "Runner did not confirm health.");
    } catch (e) {
      toast.error(`Test failed: ${String((e as Error)?.message || e).slice(0, 160)}`);
    } finally {
      setTesting(false);
    }
  }, []);

  const onDisableName = useCallback(async (name: string) => {
    if (!confirm(`Disable "${name}" permanently? It can never be re-approved under this name, even if re-forged. (You can still delete it.)`)) return;
    try { await disableProgram(name); toast.success(`"${name}" disabled`); void refresh(); }
    catch (e) { toast.error(`Could not disable: ${String((e as Error)?.message || e).slice(0, 160)}`); }
  }, [refresh]);

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {migrated === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-on-surface">
          <p className="font-semibold">One-time database setup needed.</p>
          <p className="mt-1">Paste this into Lovable's chat (tell it to sync and publish only, do not write code):</p>
          <code className="mt-2 block whitespace-pre-wrap break-words rounded bg-black/20 p-2 text-[11px]">
            Please run the repo migration {MIGRATION_FILE} exactly as written, without modifications. It is idempotent. Sync and publish only — do not write any code.
          </code>
        </div>
      )}

      {/* ── Master switches ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface">Forge new programs</p>
          <p className="text-xs text-on-surface-variant">Let the AI write bash/python/node programs for your VPS. Nothing runs without your per-program approval.</p>
        </div>
        <Switch checked={forgeOn} onCheckedChange={(v) => setChatToolPermission("forge_program", v)} aria-label="Allow forging programs" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface">Run approved programs</p>
          <p className="text-xs text-on-surface-variant">Let the AI execute programs you've approved on your connected runner.</p>
        </div>
        <Switch checked={runOn} onCheckedChange={(v) => setChatToolPermission("run_program", v)} aria-label="Allow running programs" />
      </div>

      {/* ── Runner connection ── */}
      <div className="rounded-lg border border-outline/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-on-surface">VPS runner</p>
          <span className={`text-[11px] font-medium ${programRunnerConfigured ? "text-emerald-500" : "text-on-surface-variant"}`}>
            {programRunnerConfigured ? "connected" : "not connected"}
          </span>
        </div>
        <p className="text-xs text-on-surface-variant">
          Deploy the runner from <code>vps-runner/</code> onto your Hostinger box (Docker + gVisor), then paste its HTTPS URL and one signing key pair here. Program secrets are configured on the VPS itself — their values never enter this app.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-on-surface-variant">Runner URL (https only)</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://runner.example.com"
            className="rounded border border-outline/50 bg-surface px-2 py-1.5 text-sm" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-on-surface-variant">Key id</span>
          <input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="e.g. chapter-craft-1"
            className="rounded border border-outline/50 bg-surface px-2 py-1.5 text-sm" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-on-surface-variant">
            Signing key (write-only{programRunnerLast4 ? ` — saved ••••${programRunnerLast4}` : ""})
          </span>
          <input value={signingKey} onChange={(e) => setSigningKey(e.target.value)} type="password"
            placeholder={programRunnerConfigured ? "leave blank to keep the saved key" : "paste the HMAC signing secret"}
            className="rounded border border-outline/50 bg-surface px-2 py-1.5 text-sm" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button onClick={onSave} disabled={saving || !url}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-50">
            {saving ? "Saving…" : "Save connection"}
          </button>
          <button onClick={onTest} disabled={testing || !programRunnerConfigured}
            className="rounded border border-outline/50 px-3 py-1.5 text-sm disabled:opacity-50">
            {testing ? "Testing…" : "Test connection"}
          </button>
          {programRunnerConfigured && (
            <button onClick={onDisconnect} disabled={saving}
              className="rounded border border-red-500/50 px-3 py-1.5 text-sm text-red-500 disabled:opacity-50">
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* ── Programs list ── */}
      {programs.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Your programs</p>
          {schedulesReady === true && (
            <p className="text-[10px] text-on-surface-variant">
              Scheduler {cronOk?.last_tick_at
                ? `· last ran ${new Date(cronOk.last_tick_at).toLocaleTimeString()}`
                : "· not running yet — finish the cron deploy (pg_cron heartbeat)"}
            </p>
          )}
          {schedulesReady === false && programRunnerConfigured && (
            <p className="text-[10px] text-amber-500">Scheduling needs the cron update — deploy <code>20260825090000_operator_tier.sql</code> via Lovable.</p>
          )}
          {programs.map((p) => (
            <div key={p.id} className="rounded border border-outline/30 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-on-surface">{p.name} <span className="text-xs text-on-surface-variant">v{p.version} · {p.status} · {p.language}</span></p>
                  <p className="truncate text-xs text-on-surface-variant">{(p.manifest as any)?.network === "allowlist" ? "network: allowlist" : "no network"}{Array.isArray((p.manifest as any)?.secrets) && (p.manifest as any).secrets.length > 0 ? ` · secrets: ${(p.manifest as any).secrets.join(", ")}` : ""}</p>
                </div>
                {p.status !== "disabled" && (
                  <button onClick={() => onDisableName(p.name)} className="shrink-0 rounded border border-red-500/40 px-2 py-1 text-[11px] text-red-500">Disable</button>
                )}
              </div>
              {p.status === "approved" && programRunnerConfigured && schedulesReady === true && (
                <ScheduleControl program={p} schedule={schedules.get(p.id)} longRuns={longRuns} lastCron={cronRuns.get(p.id)} onChanged={refresh} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ProgramRunnerSettings;
