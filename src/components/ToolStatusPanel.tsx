import React, { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  availableToolNames,
  groupWithheld,
  permissionIdFor,
  toolDisplayLabel,
  RUN_TOOL,
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
 *
 * ONE STATE OUTRANKS ITS OWN ARITHMETIC. "66 tools · 1 off" is calm, true, and
 * useless when the one tool that is off is run_tool: that single switch governs
 * the entire library the user has already reviewed and approved, so the count
 * is at its most reassuring exactly when the loss is largest. A user spent a
 * day unable to read that off this chip. So when the host tells us the library
 * is not empty (`approvedToolCount`), the chip stops reporting the subtraction
 * and reports the consequence, and the row carrying that switch sorts to the
 * top of the sheet. Primary accent, never destructive — this is a switch that
 * is off, not damage. With no count passed the panel behaves exactly as before:
 * a library we have not been told about is one we must not describe.
 */

/** Section label per code — the small uppercase eyebrow, matching the rest of
 *  the app's furniture. */
const GROUP_LABEL: Record<ToolGateCode, string> = {
  available: "On",
  off_permission: "AI Permissions",
  off_lean_mode: "Lean Mode",
  off_foundry_optin: "Tool Foundry",
  off_foundry_unavailable: "Tool Foundry",
  off_program_optin: "Program Foundry",
  off_program_unavailable: "Program Foundry",
  off_model_no_tools: "This model",
  off_model_image_turn: "This model",
};

const GROUP_ICON: Record<ToolGateCode, string> = {
  available: "check_circle",
  off_permission: "shield_person",
  off_lean_mode: "savings",
  off_foundry_optin: "construction",
  off_foundry_unavailable: "construction",
  off_program_optin: "dns",
  off_program_unavailable: "dns",
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
  lastTurn?: {
    offered: number;
    withheld: number;
    /** Calls the last reply wrote into its own prose instead of sending as
     *  calls, which the app salvaged and ran. Worth a line because the
     *  alternative — the historical behaviour — was a paragraph describing an
     *  action that never happened, and a user who has read that paragraph
     *  deserves to know which turns needed rescuing. Absent on the ordinary
     *  turn, where the structured path carried everything. */
    recovered?: number;
    /** Calls the last reply wrote into its prose that were NOT run — anything
     *  outside the small read-only set the app will run off text, because text
     *  in a reply may have been quoted into it from a file or a search result
     *  rather than chosen by the AI.
     *
     *  RENAMED, along with the behaviour it described: nothing is returned to
     *  the AI any more. The app does not run the call and does not repeat what
     *  it said, which is why the line below no longer promises the AI will
     *  send it again. Counted apart from `recovered` because "we ran it" and
     *  "we did not run it" are opposite answers to the only question this
     *  panel exists to answer truthfully. */
    recoveredNotRun?: number;
    /** The turn's LAST request ran with no tools attached (toolless retry
     *  after the budget-exhausted forced round) — disclosed so "offered N"
     *  stays a true statement about the requests it describes. */
    toollessRetry?: boolean;
  };
  /** How many tools the user has approved in the Tool Foundry, when the host
   *  knows. Undefined means unknown — settings still loading, foundry setup not
   *  run, no library — and unknown must read exactly like this panel always
   *  did. A count is the only thing that turns "one tool is off" into "your
   *  whole library is idle", so without one we do not make that claim. */
  approvedToolCount?: number;
}> = ({ gates, onOpenSettings, lastTurn, approvedToolCount }) => {
  const [open, setOpen] = useState(false);
  const { leanMode, setLeanMode, chatToolPermissions, setChatToolPermission } = useChatSettings();

  const { offered, withheld, groups, stranded } = useMemo(() => {
    const on = availableToolNames(gates);
    const g = groupWithheld(gates);
    // Scoped to off_foundry_optin on purpose. That code means the "Run approved
    // tools" switch is off, which is the one case where flipping it here fixes
    // everything. run_tool can also be missing because the model does no tool
    // calls or because the foundry's one-time setup hasn't run — naming the
    // switch then would send the user to flip a control that changes nothing,
    // and those two already have their own groups with the right fix.
    const stranded = (approvedToolCount ?? 0) > 0 && gates.get(RUN_TOOL)?.code === "off_foundry_optin";
    const lead = stranded ? g.filter((x) => x.code === "off_foundry_optin") : [];
    const groups = lead.length ? [...lead, ...g.filter((x) => x.code !== "off_foundry_optin")] : g;
    return { offered: on.length, withheld: g.reduce((n, x) => n + x.tools.length, 0), groups, stranded };
  }, [gates, approvedToolCount]);

  // Never an alarm for a normal configuration. A few tools deliberately off is
  // the ordinary state of a well-configured app, so that reads as "on" accent,
  // not as damage. Zero tools is different in kind — the assistant has no
  // hands at all, and that is exactly the state that produced the bug report.
  // A stranded library is the third kind: not damage, but not ordinary either,
  // so it takes the primary accent and a filled pill — colour alone can't do
  // it, since "n off" already wears a colour in this same row of chips.
  const tone =
    offered === 0 ? "text-destructive"
      : stranded ? "text-primary"
        : withheld > 0 ? "text-primary-container"
          : "text-on-surface-variant hover:text-primary";

  // Named by the label Settings → Tool Foundry actually prints, so the control
  // the user goes looking for is the control they read about here.
  const strandedLine = stranded
    ? `The AI can't run the ${approvedToolCount === 1 ? "tool" : `${approvedToolCount} tools`} you've approved — turn on “Run approved tools”.`
    : "";

  const label = stranded
    ? `${offered} tools · can't run yours`
    : withheld > 0 ? `${offered} tools · ${withheld} off` : `${offered} tools`;

  /** The hoisted section — same renderer and the same inline switch as always,
   *  wearing the accent so the first thing in the sheet is the fix. */
  const isLead = (code: ToolGateCode) => stranded && code === "off_foundry_optin";

  /** The Foundry group's switch rows, run_tool first when the approved library
   *  is what's waiting on it. filter() copies, so sorting here reorders nothing
   *  the gate map owns. */
  const foundrySwitchRows = (tools: string[]) =>
    tools.filter((t) => t in FOUNDRY_SWITCH_LABEL)
      .sort((a, b) => (stranded ? (a === RUN_TOOL ? -1 : b === RUN_TOOL ? 1 : 0) : 0));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          stranded
            ? `AI tools: ${strandedLine} Open the tool status panel.`
            : `AI tools: ${label}. Open the tool status panel.`
        }
        title={
          stranded
            ? `${strandedLine} Tap to turn it on.`
            : withheld > 0
              ? `${withheld} tool${withheld === 1 ? " is" : "s are"} switched off — tap to see which, and turn them back on`
              : "Every tool goes out with your messages — tap for the list"
        }
        className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${tone}${stranded ? " rounded-full bg-primary/10 ring-1 ring-primary/30 px-2 py-0.5" : ""}`}
      >
        <span className="material-symbols-outlined text-sm" aria-hidden>{stranded ? "toggle_off" : "handyman"}</span>
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
            {/* Stranded replaces the count rather than sitting under it: the
                count is the sentence that read as fine all day. */}
            <SheetDescription className={`text-xs mt-1 ${stranded ? "text-foreground font-semibold" : "text-on-surface-variant"}`}>
              {stranded
                ? strandedLine
                : withheld === 0
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
                {!!lastTurn.recovered && lastTurn.recovered > 0 && (
                  <>
                    {" "}
                    {lastTurn.recovered === 1
                      ? "One call arrived written into the reply as text; it was picked up and run."
                      : `${lastTurn.recovered} calls arrived written into the reply as text; they were picked up and run.`}
                  </>
                )}
                {/* NO CLAIM ABOUT WHAT THE CALL WOULD HAVE DONE. This used to
                    read "One call that changes your work…", and the app never
                    checked that. recoveredNotRun means "outside the read-class
                    allow-list", which is not the same as destructive:
                    web_search is out because it is third-party and metered,
                    and show_image / show_video / show_splat / view_image /
                    recall_image_memories / test_tool / render_blocks each have
                    their own reason — none of them change the user's work. So
                    a skipped web search was being reported as a near miss on
                    the user's chapters, on the one surface whose entire job is
                    telling the truth about tool activity. The count and "it
                    did not run" are both facts the app holds; the severity was
                    not. */}
                {!!lastTurn.recoveredNotRun && lastTurn.recoveredNotRun > 0 && (
                  <>
                    {" "}
                    {lastTurn.recoveredNotRun === 1
                      ? "One call arrived written into the reply as text; it did not run."
                      : `${lastTurn.recoveredNotRun} calls arrived written into the reply as text; they did not run.`}
                  </>
                )}
                {lastTurn.toollessRetry && (
                  <>
                    {" "}
                    The reading budget ran out before an answer, so the final request carried no tools — the reply was written from what had already been read.
                  </>
                )}
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
                className={`rounded-lg border px-3 py-3 min-w-0 ${isLead(group.code) ? "bg-primary/10 border-primary/40" : "bg-surface-container-high/50 border-outline-variant/15"}`}
              >
                <p className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 ${isLead(group.code) ? "text-primary" : "text-on-surface-variant"}`}>
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
                  {group.code === "off_foundry_optin" && foundrySwitchRows(group.tools).map((tool) => (
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
                            : group.fixTarget === "settings_programs" ? "programs"
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
