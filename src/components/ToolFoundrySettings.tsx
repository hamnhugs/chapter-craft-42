import React, { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useChatSettings } from "@/hooks/useChatSettings";
import { foundryAvailable, listTools, toolFingerprint, approveTool, type AgentToolRow } from "@/lib/toolFoundry";

/**
 * Settings → Tool Foundry — the canonical management surface for the AI's
 * self-built tools. Both master switches are OPT-IN (explicit true, inverted
 * from the app's default-allow tool convention): shipping this feature must
 * not silently grant existing users' models the ability to author and run
 * code. Disable is the kill switch — run_tool reads it at execution time.
 */
const ToolFoundrySettings: React.FC = () => {
  const { chatToolPermissions, setChatToolPermission, autoApproveToolUpdates, setAutoApproveToolUpdates } = useChatSettings();
  const [migrated, setMigrated] = useState<boolean | null>(null);
  const [tools, setTools] = useState<AgentToolRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Fingerprint of each tool as it was when this list rendered — the thing
   *  the user is actually reviewing. Compared again at approval time. */
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});

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
    } catch { /* transient */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const drafts = tools.filter((t) => t.status === "draft");
  const active = tools.filter((t) => t.status === "approved" && !t.superseded_by);
  // Only USER-disabled tools belong here; approve_tool marks superseded
  // versions 'disabled' too, and those are history, not a management surface.
  const disabled = tools.filter((t) => t.disabled_by_user === true);

  const approve = async (t: AgentToolRow) => {
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
      await approveTool(t.id, fp);
      toast.success(`"${t.name}" approved`);
      void refresh();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
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

  const Row: React.FC<{ t: AgentToolRow; actions: React.ReactNode }> = ({ t, actions }) => (
    <li className="rounded-lg bg-surface-container-high/50 border border-outline-variant/15 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-base text-on-surface-variant">construction</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground truncate">{t.name} <span className="font-normal text-on-surface-variant">v{t.version}</span></p>
          <p className="text-[11px] text-on-surface-variant truncate">{t.description}</p>
        </div>
        {actions}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-on-surface-variant">
        <span>{t.run_count} run{t.run_count === 1 ? "" : "s"}</span>
        {t.fail_count > 0 && <span className="text-destructive">{t.fail_count} recent fail{t.fail_count === 1 ? "" : "s"}</span>}
        <span>caps: {(t.manifest?.capabilities || []).join(", ") || "pure compute"}</span>
        <button onClick={() => setExpanded(expanded === t.id ? null : t.id)} className="text-primary hover:underline">{expanded === t.id ? "hide code" : "code"}</button>
      </div>
      {expanded === t.id && (
        <pre className="text-[10px] bg-surface-container-low rounded p-2 mt-1 overflow-x-auto max-h-48 overflow-y-auto"><code>{t.code}</code></pre>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      {migrated === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-on-surface-variant">
          <p className="font-semibold text-foreground mb-1">One-time setup needed</p>
          <p>The Tool Foundry database migration hasn't been applied. Paste this into Lovable's chat:</p>
          <p className="mt-1 font-mono text-[11px] bg-surface-container-low rounded p-2 select-all">
            Please run the repo migration supabase/migrations/20260730120000_memory_lens_tool_foundry.sql exactly as written, without modifications. It is idempotent.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Forge new tools</p>
          <p className="text-xs text-on-surface-variant">Let the AI write new tools for itself. Every new tool waits for your approval before it can ever run.</p>
        </div>
        <Switch checked={forgeOn} onCheckedChange={(v) => setChatToolPermission("forge_tool", v)} aria-label="Allow forging tools" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Run approved tools</p>
          <p className="text-xs text-on-surface-variant">Master switch (read at run time — flipping it off stops everything immediately). Tools run sandboxed: no internet, read-only access.</p>
        </div>
        <Switch checked={runOn} onCheckedChange={(v) => setChatToolPermission("run_tool", v)} aria-label="Allow running tools" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Auto-approve safe updates</p>
          <p className="text-xs text-on-surface-variant">Updates that gain no new powers (same capabilities, tests pass) apply without asking. New tools and anything gaining powers always ask.</p>
        </div>
        <Switch checked={autoApproveToolUpdates} onCheckedChange={setAutoApproveToolUpdates} aria-label="Auto-approve safe tool updates" />
      </div>

      {drafts.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-500 mb-2">Awaiting your approval ({drafts.length})</p>
          <ul className="flex flex-col gap-2">
            {drafts.map((t) => (
              <Row key={t.id} t={t} actions={
                <div className="flex items-center gap-2">
                  <button onClick={() => approve(t)} className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline">Approve</button>
                  <button onClick={() => remove(t)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Discard</button>
                </div>
              } />
            ))}
          </ul>
        </div>
      )}

      {active.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant mb-2">Approved tools ({active.length})</p>
          <ul className="flex flex-col gap-2">
            {active.map((t) => (
              <Row key={t.id} t={t} actions={
                <div className="flex items-center gap-2">
                  <button onClick={() => setStatus(t, "disabled")} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Disable</button>
                  <button onClick={() => remove(t)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Delete</button>
                </div>
              } />
            ))}
          </ul>
        </div>
      )}

      {disabled.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant mb-2">Disabled ({disabled.length})</p>
          <ul className="flex flex-col gap-2">
            {disabled.map((t) => (
              <Row key={t.id} t={t} actions={
                <div className="flex items-center gap-2">
                  <button onClick={() => setStatus(t, "draft")} className="text-[10px] font-bold uppercase tracking-widest text-primary hover:underline">Re-enable</button>
                  <button onClick={() => remove(t)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-destructive">Delete</button>
                </div>
              } />
            ))}
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
