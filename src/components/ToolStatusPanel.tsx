import React, { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  availableToolNames,
  groupWithheld,
  permissionIdFor,
  toolDisplayLabel,
  type ToolGate,
  type ToolGateCode,
} from "@/lib/toolAvailability";

/**
 * The receipt for the AI's tool roster: a quiet chip near the composer and,
 * behind one tap, the list of everything that was left out and the switch that
 * puts it back.
 *
 * WHY A STATUS SURFACE AND NOT A WARNING. Every gate that removes a tool used
 * to be silent, which is how "the AI can't use the forge tool and I don't know
 * why" happens: the switch exists, nothing points at it. The obvious fix — a
 * banner on every affected turn — is the wrong one. Attention to a repeated
 * warning collapses after two or three exposures, and blanket-approving
 * whatever a permission prompt says is the overwhelmingly common response. So
 * this is a persistent thing to CONSULT, not a thing that interrupts: the chip
 * always shows the count, never an alarm for a healthy configuration, and it
 * is stateless enough to be ignored for months and still be right when it is
 * finally tapped.
 *
 * THE COUNT AND THE LIST COME FROM ONE MAP. Chip and panel are one component
 * reading one `gates` prop, so "58 tools · 4 off" cannot disagree with a list
 * of three. The map itself is the same computeToolGates() the send path uses.
 *
 * ONE TAP, NOT A SCAVENGER HUNT. Where the fix is a switch this app owns —
 * either foundry switch, any per-tool permission, Lean Mode — the switch is
 * rendered right here. Only "pick a different model" sends the user to
 * Settings, because that is a choice this panel has no business making.
 */

/** Section label per code — the small uppercase eyebrow, matching the rest of
 *  the app's furniture. */
const GROUP_LABEL: Record<ToolGateCode, string> = {
  available: "On",
  off_permission: "AI Permissions",
  off_lean_mode: "Lean Mode",
  off_foundry_optin: "Tool Foundry",
  off_foundry_unavailable: "Tool Foundry",
  off_model_no_tools: "This model",
  off_model_image_turn: "This model",
};

const GROUP_ICON: Record<ToolGateCode, string> = {
  available: "check_circle",
  off_permission: "shield_person",
  off_lean_mode: "savings",
  off_foundry_optin: "construction",
  off_foundry_unavailable: "construction",
  off_model_no_tools: "smart_toy",
  off_model_image_turn: "image",
};

/** Chips shown before the list rolls up. Long enough to be a real list, short
 *  enough that the sentence above it still wins the eye. */
const TOOL_CHIP_LIMIT = 12;

const FOUNDRY_SWITCH_LABEL: Record<string, string> = {
  forge_tool: "Forge new tools",
  run_tool: "Run approved tools",
};

const ToolStatusPanel: React.FC<{
  /** The roster the next turn would carry. Chip and list both read this. */
  gates: Map<string, ToolGate>;
  /** Deep-link into a Settings section (the host owns the tab switch). */
  onOpenSettings: (section?: string) => void;
  /** What the most recent reply ACTUALLY went out with, when it is known.
   *  A provider that silently lacks function calling finishes exactly like a
   *  model that simply chose not to call anything, so this is recorded at send
   *  time rather than inferred — it is the only way "we never offered it" is
   *  distinguishable from "we offered it and it declined". Absent for restored
   *  history, which reads as unknown rather than as a false claim. */
  lastTurn?: { offered: number; withheld: number };
}> = ({ gates, onOpenSettings, lastTurn }) => {
  const [open, setOpen] = useState(false);
  const { leanMode, setLeanMode, chatToolPermissions, setChatToolPermission } = useChatSettings();

  const { offered, withheld, groups } = useMemo(() => {
    const on = availableToolNames(gates);
    const g = groupWithheld(gates);
    return { offered: on.length, withheld: g.reduce((n, x) => n + x.tools.length, 0), groups: g };
  }, [gates]);

  // Never an alarm for a normal configuration. A few tools deliberately off is
  // the ordinary state of a well-configured app, so that reads as "on" accent,
  // not as damage. Zero tools is different in kind — the assistant has no
  // hands at all, and that is exactly the state that produced the bug report.
  const tone =
    offered === 0 ? "text-destructive"
      : withheld > 0 ? "text-primary-container"
        : "text-on-surface-variant hover:text-primary";

  const label = withheld > 0 ? `${offered} tools · ${withheld} off` : `${offered} tools`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`AI tools: ${label}. Open the tool status panel.`}
        title={
          withheld > 0
            ? `${withheld} tool${withheld === 1 ? " is" : "s are"} switched off — tap to see which, and turn them back on`
            : "Every tool goes out with your messages — tap for the list"
        }
        className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${tone}`}
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>handyman</span>
        <span className="whitespace-nowrap">{label}</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          // Android rule: nothing in this app takes focus programmatically —
          // any programmatic focus pops the soft keyboard over the sheet.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="max-h-[85vh] overflow-y-auto overflow-x-hidden rounded-t-2xl bg-surface-container-low border-outline-variant/20 p-0"
        >
          <div className="px-4 pt-4 pb-2 border-b border-outline-variant/10">
            <SheetTitle className="flex items-center gap-2 text-sm font-headline font-bold text-foreground">
              <span className="material-symbols-outlined text-primary-container text-xl" aria-hidden>handyman</span>
              AI tools
            </SheetTitle>
            <SheetDescription className="text-xs text-on-surface-variant mt-1">
              {withheld === 0
                ? `All ${offered} tools go out with your next message.`
                : `${offered} of ${offered + withheld} tools go out with your next message. Here's what's missing and where the switch is.`}
            </SheetDescription>
            {lastTurn && (
              <p className="text-[11px] text-on-surface-variant mt-2">
                Your last reply went out with{" "}
                <span className="font-semibold text-foreground">
                  {lastTurn.offered} tool{lastTurn.offered === 1 ? "" : "s"}
                </span>
                {lastTurn.offered === 0
                  ? " — so the AI had nothing to call, whatever it said."
                  : lastTurn.withheld > 0
                    ? `, with ${lastTurn.withheld} left out.`
                    : "."}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 px-4 py-4">
            {groups.length === 0 && (
              <div className="rounded-lg bg-surface-container-high/50 border border-outline-variant/15 px-3 py-3 flex items-start gap-2">
                <span className="material-symbols-outlined text-base text-primary-container shrink-0" aria-hidden>check_circle</span>
                <p className="text-xs text-on-surface-variant">
                  Nothing is switched off. If the AI still says it can't do something, it's the model's choice
                  this turn, not a setting — try asking it again, more directly.
                </p>
              </div>
            )}

            {groups.map((group) => (
              <section
                key={group.code}
                className="rounded-lg bg-surface-container-high/50 border border-outline-variant/15 px-3 py-3 min-w-0"
              >
                <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-sm" aria-hidden>{GROUP_ICON[group.code]}</span>
                  {GROUP_LABEL[group.code]}
                </p>
                <p className="text-xs text-foreground mt-1.5">{group.reason}</p>

                {/* A model-level gate covers the entire roster; sixty-two mono
                    chips would bury the one sentence that matters. */}
                {group.tools.length === offered + withheld ? (
                  <p className="text-[11px] text-on-surface-variant mt-2">
                    Every tool ({group.tools.length}) — including the forge and the run tool.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {group.tools.slice(0, TOOL_CHIP_LIMIT).map((tool) => (
                      <span
                        key={tool}
                        className="font-mono text-[10px] text-on-surface-variant bg-surface-container-low rounded px-1.5 py-0.5 max-w-full truncate"
                        title={toolDisplayLabel(tool)}
                      >
                        {tool}
                      </span>
                    ))}
                    {group.tools.length > TOOL_CHIP_LIMIT && (
                      <span className="text-[10px] text-on-surface-variant px-1 py-0.5">
                        +{group.tools.length - TOOL_CHIP_LIMIT} more
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-3 flex flex-col gap-2">
                  {/* Tool Foundry: the two opt-in switches, right here. ONLY
                      those two — `group.tools` also carries list_tools,
                      read_tool and test_tool, which are governed BY the forge
                      switch and have no setting of their own. Rendering a row
                      for them wrote a permission key nothing reads, so the
                      toggle latched ON forever inside a panel that went on
                      saying the tool was off. They appear in the chip row
                      above, which is the honest place for them. */}
                  {group.code === "off_foundry_optin" && group.tools.filter((t) => t in FOUNDRY_SWITCH_LABEL).map((tool) => (
                    <div key={tool} className="flex items-center justify-between gap-3 min-w-0">
                      <p className="text-xs text-foreground min-w-0 truncate">
                        {FOUNDRY_SWITCH_LABEL[tool] || toolDisplayLabel(tool)}
                      </p>
                      <Switch
                        checked={chatToolPermissions?.[tool] === true}
                        onCheckedChange={(v) => setChatToolPermission(tool, v)}
                        aria-label={FOUNDRY_SWITCH_LABEL[tool] || toolDisplayLabel(tool)}
                      />
                    </div>
                  ))}

                  {/* Per-tool permissions: one switch per governed tool, so a
                      user who only wants web search back does not have to hunt
                      through nineteen toggles for it. */}
                  {group.code === "off_permission" && Array.from(
                    new Map(
                      group.tools
                        .map((tool) => [permissionIdFor(tool), toolDisplayLabel(tool)] as const)
                        .filter((pair): pair is readonly [string, string] => !!pair[0]),
                    ).entries(),
                  ).map(([permId, permLabel]) => (
                    <div key={permId} className="flex items-center justify-between gap-3 min-w-0">
                      <p className="text-xs text-foreground min-w-0 truncate">{permLabel}</p>
                      <Switch
                        checked={chatToolPermissions?.[permId] !== false}
                        onCheckedChange={(v) => setChatToolPermission(permId, v)}
                        aria-label={permLabel}
                      />
                    </div>
                  ))}

                  {/* Lean Mode is a self-binding budget choice, so the control
                      is an explicit "put spending back on", never a silent
                      flip hidden behind another action. */}
                  {group.code === "off_lean_mode" && (
                    <button
                      type="button"
                      onClick={() => { void setLeanMode("full"); }}
                      disabled={leanMode === "full"}
                      className="self-start rounded-lg bg-primary-container text-on-primary-container text-xs font-semibold px-3 py-1.5 hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
                    >
                      Turn spending back on
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpenSettings(
                        group.fixTarget === "settings_permissions" ? "permissions"
                          : group.fixTarget === "settings_foundry" ? "foundry"
                            : "models",
                      );
                    }}
                    // w-full, not self-start: these sentences are long, and a
                    // shrink-to-fit button would size to its max-content width
                    // and push the sheet sideways on a 360px phone.
                    className="w-full text-[11px] text-primary hover:underline text-left"
                  >
                    {group.fix}
                  </button>
                </div>
              </section>
            ))}

            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              A tool that's switched off is left out of the AI's list entirely, so it can't offer it, attempt it,
              or claim it used it. Turning one back on applies from your next message.
            </p>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};

// Memoized: the host re-renders once per streamed token, and none of these
// props move during a reply.
export default React.memo(ToolStatusPanel);
