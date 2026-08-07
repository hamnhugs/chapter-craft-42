import React, { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  analyzeToolCode,
  approveTool,
  auditRunSettle,
  auditRunStart,
  foundryAvailable,
  latestApprovalSha,
  latestToolRun,
  listTools,
  stubCapabilityHandler,
  toolFingerprint,
  type AgentToolRow,
  type ToolRunRow,
} from "@/lib/toolFoundry";
import {
  descriptionMatchesManifest,
  manifestFor,
  runConformance,
  type ConformanceCheck,
  type ConformanceReport,
} from "@/lib/toolConformance";
import { runToolSandboxed } from "@/lib/toolSandbox";

/**
 * Settings → Tool Foundry — the canonical management surface for the AI's
 * self-built tools. Both master switches are OPT-IN (explicit true, inverted
 * from the app's default-allow tool convention): shipping this feature must
 * not silently grant existing users' models the ability to author and run
 * code. Disable is the kill switch — run_tool reads it at execution time.
 *
 * Three things this surface owes the user beyond the switches:
 *
 *  1. A RUN BUTTON. Their tool, their data — asking the assistant to press
 *     play on the user's behalf was never a good reason to hide the control.
 *     Every run here goes through the same integrity gate run_tool uses:
 *     fingerprint vs the approvals pin, capabilities re-derived from the
 *     stored code, and the description re-verified against its manifest hash.
 *  2. AN HONEST VERDICT. "Tests passed" is the claim that lies — a tool that
 *     passes its author's own cases still scores zero on held-out inputs
 *     96.8% of the time. Check re-runs all three conformance layers against
 *     the stored code and prints the real counts, partial passes included.
 *  3. A WAY OUT OF LEGACY. Tools approved before the description was hashed
 *     into the manifest carry no pin. They are not silently trusted and not
 *     stranded either: one tap creates an identical version whose manifest
 *     carries the description hash, and approves it.
 *
 * Mobile rule observed throughout: nothing here calls .focus() — on Android
 * any programmatic focus opens the keyboard over the content.
 */

export interface ToolFoundrySettingsProps {
  /**
   * Live capability handler for user-initiated runs — the same function the
   * chat executor passes to run_tool. When it is absent, runs of tools that
   * declare capabilities execute against FIXTURES and the panel says so
   * plainly; tools that declare none run for real either way.
   */
  onCapability?: (cap: string, args: unknown) => Promise<unknown>;
}

type Trust = "pinned" | "unpinned_legacy" | "description_changed" | "unknown";

interface RunView {
  ok: boolean;
  live: boolean;
  ms?: number;
  value?: unknown;
  error?: string;
  capabilityCalls?: Array<{ cap: string; ok: boolean; bytes: number }>;
}

const jsonPretty = (v: unknown) => {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return String(v);
  }
};

const CheckRows: React.FC<{ title: string; checks: ConformanceCheck[] }> = ({ title, checks }) => {
  if (!checks || checks.length === 0) return null;
  return (
    <div className="mt-2 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{title}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex items-start gap-1.5 min-w-0">
            <span
              className={`material-symbols-outlined text-[13px] leading-4 mt-0.5 shrink-0 ${c.pass ? "text-on-surface-variant" : "text-destructive"}`}
              aria-hidden="true"
            >
              {c.pass ? "check_small" : "priority_high"}
            </span>
            <span className="min-w-0 text-[11px] text-on-surface-variant break-words">
              <span className="text-foreground">{c.name}</span> — {c.note}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const ToolFoundrySettings: React.FC<ToolFoundrySettingsProps> = ({ onCapability }) => {
  const { chatToolPermissions, setChatToolPermission, autoApproveToolUpdates, setAutoApproveToolUpdates } = useChatSettings();
  const [migrated, setMigrated] = useState<boolean | null>(null);
  const [tools, setTools] = useState<AgentToolRow[]>([]);
  /** Which sub-panel is open for which tool. One at a time keeps the list
   *  readable on a phone. */
  const [panel, setPanel] = useState<{ id: string; tab: "code" | "run" | "checks" } | null>(null);
  /** Fingerprint of each tool as it was when this list rendered — the thing
   *  the user is actually reviewing. Compared again at approval time. */
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [trust, setTrust] = useState<Record<string, Trust>>({});
  const [lastFailures, setLastFailures] = useState<Record<string, ToolRunRow | null>>({});
  const [argsText, setArgsText] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  const [reports, setReports] = useState<Record<string, ConformanceReport>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const forgeOn = chatToolPermissions["forge_tool"] === true;
  const runOn = chatToolPermissions["run_tool"] === true;

  const refresh = useCallback(async () => {
    const ok = await foundryAvailable();
    setMigrated(ok);
    if (!ok) return;
    try {
      const rows = await listTools();
      setTools(rows);

      const fps: Record<string, string> = {};
      await Promise.all(rows.filter((r) => r.status === "draft").map(async (r) => {
        try { fps[r.id] = await toolFingerprint(r.id); } catch { /* leaves it unpinned */ }
      }));
      setFingerprints(fps);

      const t: Record<string, Trust> = {};
      await Promise.all(rows.map(async (r) => {
        try {
          const res = await descriptionMatchesManifest(r.manifest, r.description || "");
          t[r.id] = res.ok ? "pinned" : res.legacy ? "unpinned_legacy" : "description_changed";
        } catch {
          t[r.id] = "unknown";
        }
      }));
      setTrust(t);

      // Only ask about tools that have actually failed — one query each, and
      // this list is short by construction.
      const fails: Record<string, ToolRunRow | null> = {};
      await Promise.all(rows.filter((r) => (r.fail_count || 0) > 0).map(async (r) => {
        try { fails[r.id] = await latestToolRun(r.id, { failedOnly: true }); } catch { fails[r.id] = null; }
      }));
      setLastFailures(fails);
    } catch { /* transient */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const drafts = tools.filter((t) => t.status === "draft" && !t.superseded_by);
  const active = tools.filter((t) => t.status === "approved" && !t.superseded_by);
  // Only USER-disabled tools belong here; approve_tool marks superseded
  // versions 'disabled' too, and those are history, not a management surface.
  const disabled = tools.filter((t) => t.disabled_by_user === true);
  const legacyApproved = active.filter((t) => trust[t.id] === "unpinned_legacy");
  const tampered = active.filter((t) => trust[t.id] === "description_changed");
  // Those two get their own, louder groups above — don't list them twice.
  const activeClean = active.filter((t) => trust[t.id] !== "unpinned_legacy" && trust[t.id] !== "description_changed");

  const nextVersionFor = (name: string) =>
    Math.max(0, ...tools.filter((x) => x.name === name).map((x) => Number(x.version) || 1)) + 1;

  /** The code must still be exactly what the manifest claims. Shared by the
   *  run path and by both approval paths — a row that fails this never
   *  executes and never gets re-approved. */
  const capabilityCheck = (t: AgentToolRow): { ok: boolean; capabilities: string[]; message: string } => {
    const gate = analyzeToolCode(t.code);
    const declared = ((t.manifest?.capabilities as string[] | undefined) || []).slice().sort();
    if (!gate.ok) {
      return { ok: false, capabilities: [], message: `Its stored code no longer passes the safety gate (${gate.errors[0] || "unknown"}).` };
    }
    if (JSON.stringify(gate.capabilities) !== JSON.stringify(declared)) {
      return {
        ok: false,
        capabilities: [],
        message: `Its stored code asks for ${gate.capabilities.join(", ") || "nothing"} but it was approved for ${declared.join(", ") || "nothing"}.`,
      };
    }
    return { ok: true, capabilities: gate.capabilities, message: "" };
  };

  const approve = async (t: AgentToolRow) => {
    setBusy(t.id);
    try {
      // Compare the fingerprint captured when this list rendered (i.e. what
      // the user actually reviewed) against the current one. Fetching it and
      // passing it straight back would make the RPC's mismatch check a
      // tautology — it can only reject content that changed since review.
      const fp = await toolFingerprint(t.id);
      const reviewed = fingerprints[t.id];
      if (reviewed && reviewed !== fp) {
        toast.error("This tool changed since the list loaded — reloading so you can review the new version.");
        void refresh();
        return;
      }
      // The fingerprint does NOT cover the description, so a wording change
      // between render and approval is invisible to the check above. Compare
      // it explicitly before pinning it, then approve the pinned row.
      const { data: fresh, error: freshErr } = await (supabase.from("agent_tools" as any) as any)
        .select("description, status")
        .eq("id", t.id)
        .maybeSingle();
      if (freshErr) throw freshErr;
      if (!fresh) {
        toast.error("That draft no longer exists.");
        void refresh();
        return;
      }
      if (String((fresh as any).description || "") !== (t.description || "")) {
        toast.error("This tool's description changed since the list loaded — reloading so you can read the new wording.");
        void refresh();
        return;
      }

      let approvalFp = fp;
      const pinned = await descriptionMatchesManifest(t.manifest, t.description || "");
      let pinnedNow = pinned.ok;
      if (!pinned.ok) {
        const caps = capabilityCheck(t);
        if (!caps.ok) {
          toast.error(`Can't approve "${t.name}". ${caps.message}`);
          return;
        }
        const manifest = await manifestFor(caps.capabilities, t.description || "");
        const { data: patched, error } = await (supabase.from("agent_tools" as any) as any)
          .update({ manifest })
          .eq("id", t.id)
          .eq("status", "draft")
          .select("manifest");
        // A row that has EVER been approved has its manifest frozen by the
        // database guard, so a tool the user disabled and re-enabled cannot be
        // pinned in place. That must not block the approval, and it must not
        // surface as a raw Postgres string: approve it unpinned and say so —
        // the "Needs one re-approval" path below is exactly for this.
        if (error) {
          console.debug("[foundry] description pin skipped:", error.message);
          pinnedNow = false;
        } else {
        // An UPDATE that matches no row is not an error in PostgREST. Without
        // this, a row that slipped out of 'draft' would be approved with an
        // unpinned manifest while the toast claimed otherwise.
          pinnedNow = Array.isArray(patched) && patched.length > 0
            && (await descriptionMatchesManifest((patched[0] as any)?.manifest, t.description || "")).ok;
        }
        approvalFp = await toolFingerprint(t.id);
      }
      await approveTool(t.id, approvalFp);
      toast.success(pinnedNow
        ? `"${t.name}" approved — its wording is now part of what you approved.`
        : `"${t.name}" approved. Its wording could not be pinned; it will show under "Needs one re-approval".`);
      void refresh();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Legacy path. An approved row's manifest is frozen by the DB trigger, so
   * the pin cannot be added in place. Create an identical version — same code,
   * same wording, same tests — whose manifest carries the description hash,
   * and approve that. approve_tool() supersedes the old one in the same
   * transaction, so the user ends with exactly one approved tool as before.
   */
  const pinAndReapprove = async (t: AgentToolRow) => {
    setBusy(t.id);
    try {
      const caps = capabilityCheck(t);
      if (!caps.ok) {
        toast.error(`Can't re-approve "${t.name}". ${caps.message} Ask the AI to forge a fresh version instead.`);
        return;
      }
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) { toast.error("You're signed out."); return; }

      const newId = crypto.randomUUID();
      const manifest = await manifestFor(caps.capabilities, t.description || "");
      const { error: insErr } = await (supabase.from("agent_tools" as any) as any).insert({
        id: newId,
        user_id: uid,
        root_id: t.root_id || t.id,
        name: t.name,
        description: t.description,
        code: t.code,
        manifest,
        tests: t.tests,
        status: "draft",
        version: nextVersionFor(t.name),
        entry_id: t.entry_id,
      });
      if (insErr) throw insErr;
      const fp = await toolFingerprint(newId);
      await approveTool(newId, fp);
      toast.success(`"${t.name}" re-approved with its description locked in.`);
      void refresh();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (t: AgentToolRow, status: "disabled" | "draft") => {
    try {
      // disabled_by_user records the INTENT, distinct from the 'disabled'
      // status approve_tool() uses for superseded versions.
      const patch: Record<string, unknown> = { status, disabled_by_user: status === "disabled" };
      const { error } = await (supabase.from("agent_tools" as any) as any).update(patch).eq("id", t.id);
      if (error) throw error;
      toast.success(status === "disabled" ? `"${t.name}" disabled` : `"${t.name}" re-enabled (needs approval to run)`);
      void refresh();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    }
  };

  const remove = async (t: AgentToolRow) => {
    if (!window.confirm(`Delete tool "${t.name}" (v${t.version}) permanently?`)) return;
    try {
      const { error } = await (supabase.from("agent_tools" as any) as any).delete().eq("id", t.id);
      if (error) throw error;
      toast.success(`"${t.name}" deleted`);
      void refresh();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    }
  };

  const runTool = async (t: AgentToolRow) => {
    const raw = (argsText[t.id] ?? "").trim();
    let parsed: unknown = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        setRuns((r) => ({
          ...r,
          [t.id]: { ok: false, live: false, error: `That isn't valid JSON — ${String((e as Error)?.message || e)}. Arguments go in as a JSON object, e.g. {"limit": 5}. Leave the box empty to run with none.` },
        }));
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRuns((r) => ({
          ...r,
          [t.id]: { ok: false, live: false, error: `Arguments must be a JSON object like {"limit": 5} — a ${Array.isArray(parsed) ? "list" : typeof parsed} won't reach run(args, caps).` },
        }));
        return;
      }
    }

    setBusy(t.id);
    try {
      const [fp, pin] = await Promise.all([toolFingerprint(t.id), latestApprovalSha(t.id)]);
      if (!pin || fp !== pin) {
        setRuns((r) => ({ ...r, [t.id]: { ok: false, live: false, error: "This tool no longer matches what you approved, so it won't run. Ask the AI to forge a fresh version." } }));
        return;
      }
      const caps = capabilityCheck(t);
      if (!caps.ok) {
        setRuns((r) => ({ ...r, [t.id]: { ok: false, live: false, error: `Refusing to run. ${caps.message}` } }));
        return;
      }
      const pinned = await descriptionMatchesManifest(t.manifest, t.description || "");
      if (!pinned.ok && !pinned.legacy) {
        setRuns((r) => ({ ...r, [t.id]: { ok: false, live: false, error: "This tool's description no longer matches the one you approved. It won't run until it's re-approved." } }));
        return;
      }

      const pure = caps.capabilities.length === 0;
      const live = pure || !!onCapability;
      const handler = onCapability ?? stubCapabilityHandler();
      // Only real runs belong in the append-only audit; a fixture run is not
      // a run of the user's data and must not look like one.
      const auditId = live && !pure ? await auditRunStart(t.id, pin) : null;
      const res = await runToolSandboxed({
        code: t.code,
        args: parsed,
        capabilities: caps.capabilities,
        onCapability: handler,
        timeoutMs: 10_000,
      });
      if (auditId) {
        await auditRunSettle(auditId, {
          status: res.ok ? "ok" : res.killed ? "killed" : "error",
          ms: res.ms,
          capabilityCalls: res.capabilityCalls,
          error: res.error,
        });
      }
      setRuns((r) => ({
        ...r,
        [t.id]: {
          ok: res.ok,
          live,
          ms: res.ms,
          value: res.value,
          error: res.error,
          capabilityCalls: res.capabilityCalls.map((c) => ({ cap: c.cap, ok: c.ok, bytes: c.bytes })),
        },
      }));
    } catch (e) {
      setRuns((r) => ({ ...r, [t.id]: { ok: false, live: false, error: String((e as Error)?.message || e) } }));
    } finally {
      setBusy(null);
    }
  };

  const checkTool = async (t: AgentToolRow) => {
    setBusy(t.id);
    try {
      const caps = capabilityCheck(t);
      if (!caps.ok) {
        toast.error(caps.message);
        return;
      }
      const report = await runConformance({
        code: t.code,
        capabilities: caps.capabilities,
        tests: (t.tests || []) as Array<{ args: unknown; expect?: string }>,
        runSandboxed: runToolSandboxed,
      });
      setReports((r) => ({ ...r, [t.id]: report }));
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string, tab: "code" | "run" | "checks") =>
    setPanel((p) => (p && p.id === id && p.tab === tab ? null : { id, tab }));

  // Rendered as a plain function, not a nested component: a component defined
  // inside the render body gets a new identity every render, which remounts
  // every open panel (and the args textarea) on each keystroke.
  const renderRow = (t: AgentToolRow, actions: React.ReactNode, opts: { runnable?: boolean } = {}) => {
    const open = panel?.id === t.id ? panel.tab : null;
    const report = reports[t.id];
    const run = runs[t.id];
    const failure = lastFailures[t.id];
    const caps = (t.manifest?.capabilities || []) as string[];
    const isBusy = busy === t.id;
    return (
      <li key={t.id} className="rounded-lg bg-surface-container-high/50 border border-outline-variant/15 px-3 py-2 min-w-0">
        <div className="flex items-start gap-2 min-w-0">
          <span className="material-symbols-outlined text-base text-on-surface-variant mt-0.5">construction</span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground truncate">
              {t.name} <span className="font-normal text-on-surface-variant">v{t.version}</span>
            </p>
            <p className="text-[11px] text-on-surface-variant break-words">{t.description}</p>
          </div>
          <div className="shrink-0">{actions}</div>
        </div>

        <div className="flex items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-on-surface-variant flex-wrap">
          <span>{t.run_count} run{t.run_count === 1 ? "" : "s"}</span>
          {t.fail_count > 0 && <span className="text-destructive">{t.fail_count} recent fail{t.fail_count === 1 ? "" : "s"}</span>}
          <span className="break-words">caps: {caps.join(", ") || "pure compute"}</span>
          {trust[t.id] === "unpinned_legacy" && <span className="text-amber-500">description not pinned</span>}
          {trust[t.id] === "description_changed" && <span className="text-destructive">description changed since approval</span>}
          <button onClick={() => toggle(t.id, "code")} className="text-primary hover:underline">{open === "code" ? "hide code" : "code"}</button>
          {opts.runnable && (
            <button onClick={() => toggle(t.id, "run")} className="text-primary hover:underline">{open === "run" ? "hide run" : "run"}</button>
          )}
          <button onClick={() => toggle(t.id, "checks")} className="text-primary hover:underline">{open === "checks" ? "hide checks" : "checks"}</button>
        </div>

        {failure && (
          <p className="mt-1 text-[10px] text-on-surface-variant break-words">
            <span className="text-destructive font-semibold">Last failure</span>{" "}
            {new Date(failure.created_at).toLocaleString()} — {String(failure.error || failure.status).slice(0, 200)}
          </p>
        )}

        {open === "code" && (
          <pre className="text-[10px] bg-surface-container-low rounded p-2 mt-1 overflow-x-auto max-h-48 overflow-y-auto"><code>{t.code}</code></pre>
        )}

        {open === "run" && (
          <div className="mt-2 flex flex-col gap-2 min-w-0">
            <label className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant" htmlFor={`args-${t.id}`}>
              Arguments (JSON)
            </label>
            <textarea
              id={`args-${t.id}`}
              value={argsText[t.id] ?? ""}
              onChange={(e) => setArgsText((a) => ({ ...a, [t.id]: e.target.value }))}
              placeholder='{"limit": 5}'
              rows={2}
              spellCheck={false}
              className="w-full max-w-full rounded-lg bg-surface-container-low border border-outline-variant/20 px-2 py-1.5 text-[11px] font-mono text-foreground resize-y"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void runTool(t)}
                disabled={isBusy}
                className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[11px] font-bold disabled:opacity-50"
              >
                {isBusy ? "Running…" : "Run"}
              </button>
              <span className="text-[10px] text-on-surface-variant">
                {caps.length === 0
                  ? "Real run — this tool reads nothing."
                  : onCapability
                    ? "Runs against your real content, read-only."
                    : "Runs against stand-in fixtures, not your real content."}
              </span>
            </div>
            {run && (
              <div className="rounded-lg bg-surface-container-low p-2 min-w-0">
                <p className={`text-[10px] font-bold uppercase tracking-widest ${run.ok ? "text-on-surface-variant" : "text-destructive"}`}>
                  {run.ok ? "Result" : "Failed"}
                  {typeof run.ms === "number" ? ` · ${run.ms}ms` : ""}
                  {run.ok && caps.length > 0 ? (run.live ? " · live data" : " · fixture data") : ""}
                </p>
                {run.ok ? (
                  <pre className="mt-1 text-[10px] text-foreground overflow-x-auto max-h-64 overflow-y-auto"><code>{jsonPretty(run.value)}</code></pre>
                ) : (
                  <p className="mt-1 text-[11px] text-on-surface-variant break-words">{run.error}</p>
                )}
                {run.capabilityCalls && run.capabilityCalls.length > 0 && (
                  <p className="mt-1 text-[10px] text-on-surface-variant break-words">
                    Read: {run.capabilityCalls.map((c) => `${c.cap}${c.ok ? "" : " (failed)"}`).join(", ")}
                  </p>
                )}
                {run.ok && run.capabilityCalls && run.capabilityCalls.length === 0 && caps.length > 0 && (
                  <p className="mt-1 text-[10px] text-on-surface-variant">Read nothing on this run.</p>
                )}
              </div>
            )}
          </div>
        )}

        {open === "checks" && (
          <div className="mt-2 min-w-0">
            {!report ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => void checkTool(t)}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded-lg bg-surface-container-highest text-foreground text-[11px] font-bold disabled:opacity-50"
                >
                  {isBusy ? "Checking…" : "Check this tool"}
                </button>
                <span className="text-[10px] text-on-surface-variant">
                  Re-runs its own tests, plus fixtures it has never seen, plus properties. Nothing is saved and no real content is read.
                </span>
              </div>
            ) : (
              <div className="rounded-lg bg-surface-container-low p-2 min-w-0">
                <p className={`text-[11px] ${report.passed ? "text-foreground" : "text-destructive"}`}>{report.summary}</p>
                <CheckRows title="Its own tests" checks={report.authorTests} />
                <CheckRows title="Held-out fixtures (never shown to the AI)" checks={report.heldOut} />
                <CheckRows title="Properties" checks={report.properties} />
                <button
                  onClick={() => setReports((r) => { const next = { ...r }; delete next[t.id]; return next; })}
                  className="mt-2 text-[10px] font-bold uppercase tracking-widest text-primary hover:underline"
                >
                  Run again
                </button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {migrated === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-on-surface-variant">
          <p className="font-semibold text-foreground mb-1">One-time setup needed</p>
          <p>The Tool Foundry database migration hasn't been applied. Paste this into Lovable's chat:</p>
          <p className="mt-1 font-mono text-[11px] bg-surface-container-low rounded p-2 select-all break-words">
            Please run the repo migration supabase/migrations/20260730120000_memory_lens_tool_foundry.sql exactly as written, without modifications. It is idempotent.
          </p>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 flex items-center gap-2">
          <span className="material-symbols-outlined text-amber-500">pending_actions</span>
          <p className="text-xs text-foreground min-w-0">
            <span className="font-semibold">{drafts.length} tool{drafts.length === 1 ? "" : "s"} waiting for you.</span>{" "}
            <span className="text-on-surface-variant">Nothing runs until you approve it.</span>
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Forge new tools</p>
          <p className="text-xs text-on-surface-variant">Let the AI write new tools for itself. Every new tool waits for your approval before it can ever run.</p>
        </div>
        <Switch checked={forgeOn} onCheckedChange={(v) => setChatToolPermission("forge_tool", v)} aria-label="Allow forging tools" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Run approved tools</p>
          <p className="text-xs text-on-surface-variant">Master switch (read at run time — flipping it off stops everything immediately). Tools run sandboxed: no internet, read-only access.</p>
        </div>
        <Switch checked={runOn} onCheckedChange={(v) => setChatToolPermission("run_tool", v)} aria-label="Allow running tools" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Auto-approve safe updates</p>
          <p className="text-xs text-on-surface-variant">Updates that gain no new powers (same capabilities, tests pass) apply without asking. New tools and anything gaining powers always ask.</p>
        </div>
        <Switch checked={autoApproveToolUpdates} onCheckedChange={setAutoApproveToolUpdates} aria-label="Auto-approve safe tool updates" />
      </div>

      {tampered.length > 0 && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-xs font-bold uppercase tracking-widest text-destructive mb-1">Description changed after approval</p>
          <p className="text-[11px] text-on-surface-variant mb-2">
            The wording the AI reads before deciding to use these tools is no longer the wording you approved. They will not run. Disable or delete them, and ask for a fresh version.
          </p>
          <ul className="flex flex-col gap-2">
            {tampered.map((t) => renderRow(t, (
              <button onClick={() => setStatus(t, "disabled")} className="text-[10px] font-bold uppercase tracking-widest text-destructive hover:underline">Disable</button>
            )))}
          </ul>
        </div>
      )}

      {legacyApproved.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-500 mb-1">Needs one re-approval ({legacyApproved.length})</p>
          <p className="text-[11px] text-on-surface-variant mb-2">
            These were approved before a tool's description became part of its approval. The description is what the AI reads when it decides to use a tool, so it should be locked to your approval like the code is. One tap makes an identical version with the wording hashed in, and approves it.
          </p>
          <ul className="flex flex-col gap-2">
            {legacyApproved.map((t) => renderRow(t, (
              <button
                onClick={() => void pinAndReapprove(t)}
                disabled={busy === t.id}
                className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline disabled:opacity-50"
              >
                {busy === t.id ? "Working…" : "Re-approve"}
              </button>
            ), { runnable: true }))}
          </ul>
        </div>
      )}

      {drafts.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-500 mb-2">Awaiting your approval ({drafts.length})</p>
          <ul className="flex flex-col gap-2">
            {drafts.map((t) => renderRow(t, (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void approve(t)}
                  disabled={busy === t.id}
                  className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline disabled:opacity-50"
                >
                  {busy === t.id ? "…" : "Approve"}
                </button>
                <button onClick={() => void remove(t)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Discard</button>
              </div>
            )))}
          </ul>
        </div>
      )}

      {activeClean.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant mb-2">Approved tools ({activeClean.length})</p>
          <ul className="flex flex-col gap-2">
            {activeClean.map((t) => renderRow(t, (
              <div className="flex items-center gap-2">
                <button onClick={() => void setStatus(t, "disabled")} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Disable</button>
                <button onClick={() => void remove(t)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Delete</button>
              </div>
            ), { runnable: true }))}
          </ul>
        </div>
      )}

      {disabled.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant mb-2">Disabled ({disabled.length})</p>
          <ul className="flex flex-col gap-2">
            {disabled.map((t) => renderRow(t, (
              <div className="flex items-center gap-2">
                <button onClick={() => void setStatus(t, "draft")} className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline">Re-enable</button>
                <button onClick={() => void remove(t)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Delete</button>
              </div>
            )))}
          </ul>
        </div>
      )}

      {migrated && tools.length === 0 && (
        <p className="text-xs text-on-surface-variant italic">
          No tools yet. With forging enabled, try: “make yourself a tool that counts words per chapter.” Tools live as entries in the Toolshed neuron (BRAIN tab).
        </p>
      )}
    </div>
  );
};

export default ToolFoundrySettings;
