import React, { useState } from "react";
import { toast } from "sonner";
import { approveTool, toolFingerprint } from "@/lib/toolFoundry";
import { supabase } from "@/integrations/supabase/client";
import type { ToolProposal } from "@/lib/chatTools";

/**
 * Tool Foundry approval card — the Devin-style ratification gate.
 *
 * The capability list shown here is DERIVED from the code by the static
 * analyzer (never the model's claim), and Approve re-fetches the server-side
 * fingerprint at click time: if the code changed since this card rendered,
 * approve_tool() rejects the mismatch. The Approve button calls the RPC from
 * UI code — the model has no tool that can press it.
 */
const ToolApprovalCard: React.FC<{ proposal: ToolProposal }> = ({ proposal }) => {
  const [state, setState] = useState<"pending" | "approving" | "approved" | "rejected">(
    proposal.autoApproved ? "approved" : "pending",
  );
  const [showCode, setShowCode] = useState(false);

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
      toast.success(`Tool "${proposal.name}" approved — the AI can now run it.`);
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

  return (
    <div className="rounded-xl border border-primary-container/40 bg-surface-container-high/50 p-3 mt-1 flex flex-col gap-2">
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
        <span className="font-semibold text-foreground">Tests: </span>
        {proposal.testResults.every((t) => t.pass) ? `${proposal.testResults.length} passed on fixture data` : "failures (should not happen — refuse)"}
      </div>
      <button onClick={() => setShowCode((v) => !v)} className="text-[11px] text-primary text-left hover:underline">
        {showCode ? "Hide code" : "View code"}
      </button>
      {showCode && (
        <pre className="text-[11px] bg-surface-container-low rounded-lg p-2 overflow-x-auto max-h-64 overflow-y-auto"><code>{proposal.code}</code></pre>
      )}
      {state === "pending" && (
        <div className="flex items-center gap-2">
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
