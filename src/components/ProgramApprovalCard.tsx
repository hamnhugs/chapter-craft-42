import React, { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useChatSettings } from "@/hooks/useChatSettings";
import { RUN_PROGRAM } from "@/lib/toolAvailability";
import { programFingerprint, approveProgram, mirrorApprovedProgram } from "@/lib/programFoundry";
import type { ProgramProposal } from "@/lib/chatTools";

/**
 * Program Foundry approval card — the ratification gate for VPS programs.
 *
 * A program is arbitrary code that runs a real shell on the user's own server,
 * so the user's approval here is the LOAD-BEARING safety boundary — more so than
 * for a browser tool. The card shows the EXACT source and its declared execution
 * profile (language, network, secrets), and Approve re-fetches the server-side
 * fingerprint at click time so a mutated draft can't ride an old card. The model
 * has no tool that can press Approve.
 *
 * The verification line is a SMOKE TEST, never "verified safe". The verifier ran
 * the code once, hermetically (no secrets, no network), against the author's
 * examples — a quality signal, not a certification that the program is safe. The
 * real gate is the visible code + profile, which is why they are front and centre.
 *
 * Approve GRANTS run_program in the same click, for the same reason the Tool
 * Foundry's approval grants run_tool: approval and the ability to run were two
 * consents behind one button, and a card that says "let the AI run this" while
 * only flipping the row's status made a promise the roster then broke in silence.
 */

const NETWORK_LABEL = (p: ProgramProposal) =>
  p.manifest?.network === "allowlist"
    ? `network → ${(p.manifest.allowed_hosts || []).join(", ") || "an approved allowlist"}`
    : "no network access";

const verdictLabel = (v?: ProgramProposal["verifier"]) => {
  switch (v?.verdict) {
    case "passed": return { text: "Smoke test passed (one hermetic trace — a quality signal, not a safety guarantee)", bad: false };
    case "failed": return { text: "Smoke test FAILED against the author's examples", bad: true };
    case "inconclusive": return { text: "Smoke test inconclusive — behaviour could not be checked hermetically", bad: false };
    default: return { text: "Not verified — no runner was reachable to smoke-test it", bad: false };
  }
};

const ProgramApprovalCard: React.FC<{ proposal: ProgramProposal }> = ({ proposal }) => {
  const [state, setState] = useState<"pending" | "approving" | "approved" | "rejected">("pending");
  const [showCode, setShowCode] = useState(false);
  const { chatToolPermissions, setChatToolPermission, loaded: settingsLoaded } = useChatSettings();
  const runOn = chatToolPermissions?.[RUN_PROGRAM] === true;

  const secrets = proposal.manifest?.secrets || [];
  const exfilRisk = proposal.exfilRisk === true || (secrets.length > 0 && proposal.manifest?.network === "allowlist");
  const v = verdictLabel(proposal.verifier);

  const onApprove = async () => {
    setState("approving");
    try {
      const fp = await programFingerprint(proposal.program_id);
      if (proposal.fingerprint && fp !== proposal.fingerprint) {
        throw new Error("The program changed since this card was shown — review it again in Settings → Program Foundry.");
      }
      await approveProgram(proposal.program_id, fp);
      setState("approved");

      // Approval has succeeded on the server. Everything below is best-effort and
      // must never roll it back or report failure.
      // File the approved program as a Toolshed retrieval card (deferred to here
      // on purpose — an unapproved description must never re-enter model context).
      try {
        await mirrorApprovedProgram({
          name: proposal.name, description: proposal.description, version: proposal.version,
          language: proposal.language, manifest: proposal.manifest, code: proposal.code,
          verdict: proposal.verifier?.verdict ?? null,
        });
      } catch { /* the neuron mirror is best-effort */ }

      let granted = false;
      if (!runOn && settingsLoaded) {
        try { setChatToolPermission(RUN_PROGRAM, true); granted = true; } catch { granted = false; }
      }
      const approved = `Program "${proposal.name}" approved`;
      if (granted) toast.success(`${approved} — the AI can run it now. (“Run approved programs” is on in Settings → Program Foundry.)`);
      else if (runOn) toast.success(`${approved} — the AI can run it now.`);
      else toast.success(`${approved}. Turn on “Run approved programs” in Settings → Program Foundry and the AI can run it.`);
    } catch (e) {
      setState("pending");
      toast.error(String((e as Error)?.message || e));
    }
  };

  const onReject = async () => {
    try {
      await (supabase.from("agent_programs" as any) as any).delete().eq("id", proposal.program_id).eq("status", "draft");
      setState("rejected");
      toast.success(`Draft "${proposal.name}" discarded.`);
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    }
  };

  return (
    <div className="rounded-xl border border-primary-container/40 bg-surface-container-high/50 p-3 mt-1 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-container">dns</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate">
            Program: {proposal.name} <span className="text-on-surface-variant font-normal">v{proposal.version} · {proposal.language}</span>
          </p>
          <p className="text-xs text-on-surface-variant">{proposal.description}</p>
        </div>
        {state === "approved" && <span className="text-[10px] font-bold uppercase tracking-widest text-green-500">Approved</span>}
        {state === "rejected" && <span className="text-[10px] font-bold uppercase tracking-widest text-destructive">Discarded</span>}
      </div>

      <div className="text-xs text-on-surface-variant">
        <span className="font-semibold text-foreground">Runs on your VPS with: </span>
        {NETWORK_LABEL(proposal)}{secrets.length > 0 ? `; secrets: ${secrets.join(", ")}` : "; no secrets"}.
      </div>
      {exfilRisk && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-[11px] text-on-surface">
          ⚠ This program has BOTH secrets and network access. It could send a secret out to an allowed host. Approve only if you trust the exact code below.
        </div>
      )}
      <div className="text-xs text-on-surface-variant">
        <span className="font-semibold text-foreground">Checks: </span>
        <span className={v.bad ? "text-destructive" : undefined}>{v.text}</span>
      </div>

      <button onClick={() => setShowCode((x) => !x)} className="text-[11px] text-primary text-left hover:underline">
        {showCode ? "Hide code" : "View the exact code"}
      </button>
      {showCode && (
        <pre className="text-[11px] bg-surface-container-low rounded-lg p-2 overflow-x-auto max-h-72 overflow-y-auto"><code>{proposal.code}</code></pre>
      )}

      {state === "approved" && settingsLoaded && !runOn && (
        <p className="text-[11px] text-on-surface-variant">
          The AI needs “Run approved programs” turned on in Settings → Program Foundry before it can run this.
        </p>
      )}
      {state === "pending" && (
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onApprove} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold">
            Approve — let the AI run this on my VPS
          </button>
          <button onClick={onReject} className="px-3 py-1.5 rounded-lg bg-surface-container-highest text-on-surface-variant text-xs font-bold hover:text-destructive">
            Discard
          </button>
        </div>
      )}
      {state === "approving" && <p className="text-xs text-on-surface-variant">Verifying fingerprint…</p>}
    </div>
  );
};

export default ProgramApprovalCard;
