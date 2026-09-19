import React, { useState } from "react";
import { toast } from "sonner";
import { approveTool, toolFingerprint } from "@/lib/toolFoundry";
import { useChatSettings } from "@/hooks/useChatSettings";
import { RUN_TOOL } from "@/lib/toolAvailability";
import { supabase } from "@/integrations/supabase/client";
import type { ToolProposal } from "@/lib/chatTools";
import type { ConformanceCheck, ConformanceReport } from "@/lib/toolConformance";

/**
 * Tool Foundry approval card — the Devin-style ratification gate.
 *
 * The capability list shown here is DERIVED from the code by the static
 * analyzer (never the model's claim), and Approve re-fetches the server-side
 * fingerprint at click time: if the code changed since this card rendered,
 * approve_tool() rejects the mismatch. The Approve button calls the RPC from
 * UI code — the model has no tool that can press it.
 *
 * The verification line is deliberately NOT a green tick. A tool that passes
 * its author's own tests is almost certainly wrong — 96.8% of self-authored
 * tools score zero on held-out inputs while their in-session verifier stays
 * green — so this renders the honest ConformanceReport summary, splits the
 * layers, and says plainly when a layer was never run.
 *
 * APPROVE GRANTS `run_tool`, AND IT HAS TO. approve_tool() only flips the
 * row's status; whether `run_tool` reaches the model at all is a SEPARATE,
 * inverted opt-in (`chatToolPermissions.run_tool === true`, off by default)
 * that toolAvailability strips from the roster when it is unset. So a card
 * whose button says "let the AI run this" and only called the RPC was making
 * a promise the app then broke in silence: the tool showed as Approved, the
 * verb the model needed to reach it was never in the request, and the model —
 * still shown the approved tool by name in its prompt — narrated running it.
 * Clicking a button that says "let the AI run this" IS consent to run it, so
 * the click grants both. Only `run_tool`, only on an explicit click, and
 * never `forge_tool`: writing new tools is a different decision with its own
 * switch, and inferring it from an approval would be the same broken promise
 * pointing the other way.
 */

/** Forge-time extras the executor may attach; optional so an older proposal
 *  (or a build where chatTools has not been wired yet) still renders. */
type ProposalExtras = {
  conformance?: ConformanceReport;
  descriptionPinned?: boolean;
};

const CheckList: React.FC<{ title: string; checks: ConformanceCheck[] }> = ({ title, checks }) => {
  if (checks.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{title}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex items-start gap-1.5">
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

const ToolApprovalCard: React.FC<{ proposal: ToolProposal }> = ({ proposal }) => {
  const [state, setState] = useState<"pending" | "approving" | "approved" | "rejected">(
    proposal.autoApproved ? "approved" : "pending",
  );
  const [showCode, setShowCode] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const { chatToolPermissions, setChatToolPermission, loaded: settingsLoaded } = useChatSettings();

  // Same inverted read the roster uses: anything other than an explicit `true`
  // means the verb never ships. Read it here so the card can only ever claim
  // what the request will actually carry.
  const runOn = chatToolPermissions?.[RUN_TOOL] === true;

  const extras = proposal as ToolProposal & ProposalExtras;
  const report = extras.conformance;

  const onApprove = async () => {
    setState("approving");
    try {
      // Re-fetch the fingerprint at click time: approve_tool recomputes and
      // compares server-side, so a mutated draft can't ride an old card.
      const fp = await toolFingerprint(proposal.tool_id);
      if (proposal.fingerprint && fp !== proposal.fingerprint) {
        throw new Error("The tool changed since this card was shown — review it again in Settings → Tool Foundry.");
      }
      await approveTool(proposal.tool_id, fp);
      setState("approved");

      // The approval has ALREADY succeeded on the server by this line. Nothing
      // below may roll it back or report failure, so the permission write gets
      // its own try — letting it fall into the outer catch would reset the card
      // to "pending" and tell the user an approval that is live in the database
      // didn't happen, which is a worse lie than the one being fixed.
      //
      // The `settingsLoaded` guard is not cosmetic: until the row arrives the
      // shared store still holds `defaults`, and setChatToolPermission triggers
      // a debounced FULL-ROW upsert built from that snapshot — writing it would
      // blank the user's keys and saved models to grant one switch. Unreachable
      // in practice (a proposal only exists after a chat turn, which needs a
      // loaded key), so the fallback is simply to name the switch instead.
      let granted = false;
      if (!runOn && settingsLoaded) {
        try {
          setChatToolPermission(RUN_TOOL, true);
          granted = true;
        } catch {
          granted = false;
        }
      }

      const approved = `Tool "${proposal.name}" approved`;
      if (granted) {
        // Say what else changed on the user's behalf — a switch that flips
        // itself and says nothing is how a control stops being trustworthy.
        toast.success(`${approved} — the AI can run it now. (“Run approved tools” is on in Settings → Tool Foundry.)`);
      } else if (runOn) {
        toast.success(`${approved} — the AI can run it now.`);
      } else {
        toast.success(`${approved}. Turn on “Run approved tools” in Settings → Tool Foundry and the AI can run it.`);
      }
    } catch (e) {
      setState("pending");
      toast.error(String((e as Error)?.message || e));
    }
  };

  const onReject = async () => {
    try {
      await (supabase.from("agent_tools" as any) as any).delete().eq("id", proposal.tool_id).eq("status", "draft");
      setState("rejected");
      toast.success(`Draft "${proposal.name}" discarded.`);
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    }
  };

  const capLabel = proposal.capabilities.length === 0
    ? "Pure computation — reads nothing, no data access"
    : proposal.capabilities.join(", ");

  // Never collapse a partial pass into a tick. With no report at all, say that
  // only the author's own cases ran — because that is the layer that lies.
  const authored = proposal.testResults || [];
  const authoredPassed = authored.filter((t) => t.pass).length;
  const verificationLine = report
    ? report.summary
    : `${authoredPassed}/${authored.length} of the AI's own test cases passed on fixture data — held-out conformance was not run for this draft.`;
  const verificationBad = report ? !report.passed : authoredPassed !== authored.length;

  return (
    <div className="rounded-xl border border-primary-container/40 bg-surface-container-high/50 p-3 mt-1 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-container">construction</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate">
            Tool: {proposal.name} <span className="text-on-surface-variant font-normal">v{proposal.version}</span>
          </p>
          <p className="text-xs text-on-surface-variant">{proposal.description}</p>
        </div>
        {state === "approved" && <span className="text-[10px] font-bold uppercase tracking-widest text-green-500">Approved</span>}
        {state === "rejected" && <span className="text-[10px] font-bold uppercase tracking-widest text-destructive">Discarded</span>}
      </div>
      <div className="text-xs text-on-surface-variant">
        <span className="font-semibold text-foreground">Can touch (verified from the code): </span>{capLabel}
      </div>
      <div className="text-xs text-on-surface-variant">
        <span className="font-semibold text-foreground">Checks: </span>
        <span className={verificationBad ? "text-destructive" : undefined}>{verificationLine}</span>
      </div>
      {extras.descriptionPinned === false && (
        <p className="text-[11px] text-on-surface-variant">
          Note: this draft's wording is not hashed into the approval, so approving it does not lock the description.
        </p>
      )}
      {/* Approved, but the verb that reaches it is still off. Reachable two
          ways, and the card must say so in BOTH: an auto-approved update lands
          here with no button to click, and a manual approve whose permission
          write didn't stick lands here too. Gated on `settingsLoaded` so the
          first paint — where the shared store still holds defaults — can't
          announce a switch the user actually has on. */}
      {state === "approved" && settingsLoaded && !runOn && (
        <p className="text-[11px] text-on-surface-variant">
          The AI needs “Run approved tools” turned on in Settings → Tool Foundry before it can run this.
        </p>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        {report && (
          <button onClick={() => setShowChecks((v) => !v)} className="text-[11px] text-primary text-left hover:underline">
            {showChecks ? "Hide checks" : "What was checked"}
          </button>
        )}
        <button onClick={() => setShowCode((v) => !v)} className="text-[11px] text-primary text-left hover:underline">
          {showCode ? "Hide code" : "View code"}
        </button>
      </div>
      {report && showChecks && (
        <div className="rounded-lg bg-surface-container-low p-2 min-w-0">
          <CheckList title="The AI's own tests" checks={report.authorTests} />
          <CheckList title="Held-out fixtures (the AI never saw these)" checks={report.heldOut} />
          <CheckList title="Properties" checks={report.properties} />
        </div>
      )}
      {showCode && (
        <pre className="text-[11px] bg-surface-container-low rounded-lg p-2 overflow-x-auto max-h-64 overflow-y-auto"><code>{proposal.code}</code></pre>
      )}
      {state === "pending" && (
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onApprove} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold">
            Approve — let the AI run this
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

export default ToolApprovalCard;
