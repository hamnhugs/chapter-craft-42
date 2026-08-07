// Tool availability — one place that decides which tools reach the model,
// and the ONLY place that says why one didn't.
//
// WHY THIS FILE EXISTS. Four independent gates could pull a tool out of the
// roster: the turn's model can't call functions at all (or turns them off on
// image turns), the Tool Foundry is opt-in and off by default, Lean Mode
// removes the paid generators, and a per-tool permission was switched off.
// Exactly one of them — Lean Mode — ever explained itself. The other three
// were silent to BOTH the user and the model, which produced the report this
// file exists to answer: "the AI can't use the forge tool and I don't know
// why." The switch existed; nothing on screen pointed at it.
//
// TWO LAYERS, ON PURPOSE, AND THEY MUST NOT BE MERGED.
//   · Removal is for the MODEL. A capability it cannot see is one it cannot
//     pretend to use; a tool that is merely described as unavailable gets
//     fabricated instead. So a withheld tool is genuinely absent from the
//     roster — this file only names what was taken and why.
//   · Explanation is for the HUMAN. A typed code, one plain sentence, and the
//     exact control that lifts it, rendered as a status surface the user can
//     consult (ToolStatusPanel) rather than a banner repeated every turn —
//     attention to a repeated warning collapses after two or three showings.
//
// The reasons here NEVER go into the system prompt. Permission and safety
// language in a system prompt measurably suppresses legitimate tool use on
// entirely benign requests, which is the same failure this file is fixing.
// They go to the user's screen, and — as closed enum codes plus app-authored
// sentences — into a tool result when a gated call is replayed from history.
// A provider's own error text is never replayed into model context: error
// strings carry implicit authority and are a first-class injection vector.
//
// COPY RULES for every string below. Present tense, the user's side of the
// screen, and the real name of the real control ("Turn on “Forge new tools”
// in Settings → Tool Foundry"). Never "not permitted", "not allowed",
// "blocked", or "for safety": that vocabulary reads as blame, and it is the
// exact register that suppresses tool use when a model sees it. The unit test
// asserts this structurally against a word list — it is not a style note.

import type { LeanMode } from "@/lib/leanMode";
import { blockedTools, capabilityName } from "@/lib/leanMode";
import { TOOL_PERMISSION, PERMISSION_GROUPS } from "@/lib/toolPermissions";

export type ToolGateCode =
  | "available"
  | "off_permission"
  | "off_lean_mode"
  | "off_foundry_optin"
  | "off_foundry_unavailable"
  | "off_model_no_tools"
  | "off_model_image_turn";

export interface ToolGate {
  tool: string;
  code: ToolGateCode;
  /** One plain sentence, app-authored, no provider strings, no safety vocabulary. */
  reason: string;
  /** The exact control that lifts it, in the user's words. */
  fix: string;
  fixTarget: "settings_permissions" | "settings_foundry" | "settings_lean" | "settings_model" | "none";
}

export interface ToolGateInput {
  toolNames: string[];
  leanMode: LeanMode;
  permissions: Record<string, boolean>;
  forgeOptIn: boolean;
  runOptIn: boolean;
  foundryReady: boolean;
  /** false when the turn's model cannot call functions at all. */
  providerSupportsTools: boolean;
  /** true when this turn carries images AND the model disables tools on image turns. */
  imageTurnDisablesTools: boolean;
}

/** The two Tool Foundry tools. Opt-in with INVERTED semantics (an explicit
 *  `true` grants; everything else withholds), which is why they are absent
 *  from TOOL_PERMISSION's default-allow map and gated by their own rules. */
export const FORGE_TOOL = "forge_tool";
export const RUN_TOOL = "run_tool";
/** Reading a tool's source and dry-running a candidate ARE the repair loop, so
 *  they ride with forging: being able to read code you have no way to rewrite
 *  helps nobody. `list_tools` is the one plain survey and is useful the moment
 *  either switch is on. This grouping must stay identical to the inline gate in
 *  chatTools.ts's Foundry dispatch — same rule, two consumers. */
export const FOUNDRY_REPAIR_TOOLS = ["read_tool", "test_tool"] as const;
export const FOUNDRY_SURVEY_TOOL = "list_tools";
const NEEDS_FORGE = new Set<string>([FORGE_TOOL, ...FOUNDRY_REPAIR_TOOLS]);
const FOUNDRY_TOOLS = new Set<string>([...NEEDS_FORGE, RUN_TOOL, FOUNDRY_SURVEY_TOOL]);
/** Is this tool governed by the Tool Foundry's opt-in switches at all? */
export function isFoundryTool(tool: string): boolean {
  return FOUNDRY_TOOLS.has(tool);
}

/** permission id → the label the settings screen actually renders. Naming the
 *  control the user will hunt for beats paraphrasing it. */
const PERMISSION_LABEL: Record<string, string> = {};
for (const group of PERMISSION_GROUPS) {
  for (const item of group.items) PERMISSION_LABEL[item.id] = item.label;
}

const upperFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** How a tool is named to the user: the settings toggle's own label when there
 *  is one, otherwise the Lean Mode capability name. Naming the control the
 *  user will hunt for beats paraphrasing it. */
export function toolDisplayLabel(tool: string): string {
  const permId = TOOL_PERMISSION[tool];
  const label = permId ? PERMISSION_LABEL[permId] : undefined;
  return label || upperFirst(capabilityName(tool));
}

/** The permission id a tool is governed by, if any — what an inline toggle in
 *  the status panel has to write back. */
export function permissionIdFor(tool: string): string | undefined {
  return TOOL_PERMISSION[tool];
}

const permissionLabelFor = toolDisplayLabel;

interface GateRule {
  code: ToolGateCode;
  fixTarget: ToolGate["fixTarget"];
  /** Does this rule withhold `tool` on this turn? */
  applies: (tool: string, input: ToolGateInput) => boolean;
  reason: (tool: string) => string;
  fix: (tool: string) => string;
  /** Copy for the grouped UI row, where one line covers several tools. */
  groupReason: string;
  groupFix: string;
}

// ── PRECEDENCE ──────────────────────────────────────────────────────────────
// Ordered list of predicates, first match wins. The order is policy, not an
// accident of nesting, and it is also the panel's display order:
//
//  1. off_model_no_tools      — nothing is sent at all, so it outranks every
//  2. off_model_image_turn      per-tool switch. Reporting "web search is off
//                               in your permissions" while the request carried
//                               no `tools` field whatsoever would send the user
//                               to fix a control that changes nothing.
//  3. off_foundry_optin       — the switch the user can see and set. It comes
//                               before availability because foundryReady is
//                               only ever probed once an opt-in is true; with
//                               both switches off it is false by construction,
//                               and blaming an unapplied migration then would
//                               be a lie for every default install.
//  4. off_foundry_unavailable — opt-in is on but the one-time setup is missing.
//  5. off_lean_mode           — a deliberate budget choice, one control.
//  6. off_permission          — the narrowest gate, checked last.
//
// Only rules 3 and 4 ever look at a specific tool name; the rest are driven by
// data (blockedTools, TOOL_PERMISSION) so a new tool is covered on the day it
// is registered rather than the day someone remembers to add it here.
const RULES: GateRule[] = [
  {
    code: "off_model_no_tools",
    fixTarget: "settings_model",
    applies: (_tool, input) => !input.providerSupportsTools,
    reason: () => "The model set for this chat doesn't do tool calls, so no tools go out with your messages.",
    fix: () => "Pick a tool-capable model under Settings → AI Models & Keys.",
    groupReason: "The model set for this chat doesn't do tool calls, so no tools go out with your messages.",
    groupFix: "Pick a tool-capable model under Settings → AI Models & Keys.",
  },
  {
    code: "off_model_image_turn",
    fixTarget: "settings_model",
    applies: (_tool, input) => input.imageTurnDisablesTools,
    reason: () =>
      "This model drops its tools on any message that carries a picture, so this one goes out without them.",
    fix: () => "Send the picture on its own and ask in a second message, or pick another model under Settings → AI Models & Keys.",
    groupReason:
      "This model drops its tools on any message that carries a picture, so this one goes out without them.",
    groupFix: "Send the picture on its own and ask in a second message, or pick another model under Settings → AI Models & Keys.",
  },
  {
    code: "off_foundry_optin",
    fixTarget: "settings_foundry",
    applies: (tool, input) =>
      (NEEDS_FORGE.has(tool) && !input.forgeOptIn) ||
      (tool === RUN_TOOL && !input.runOptIn) ||
      (tool === FOUNDRY_SURVEY_TOOL && !input.forgeOptIn && !input.runOptIn),
    reason: (tool) =>
      tool === FORGE_TOOL
        ? "Forging new tools is switched off, so the AI can't write code for itself."
        : tool === RUN_TOOL
          ? "Running forged tools is switched off, so the AI can't use the tools it has already built."
          : tool === FOUNDRY_SURVEY_TOOL
            ? "The Tool Foundry is switched off, so the AI can't see what tools it has built."
            : "Forging new tools is switched off, so the AI can't read or test its own code to repair it.",
    fix: (tool) =>
      tool === RUN_TOOL
        ? "Turn on “Run approved tools” in Settings → Tool Foundry."
        : tool === FOUNDRY_SURVEY_TOOL
          ? "Turn on either switch in Settings → Tool Foundry."
          : "Turn on “Forge new tools” in Settings → Tool Foundry.",
    groupReason: "The Tool Foundry switches are off, so the AI can't write or run code for itself.",
    groupFix: "Turn on “Forge new tools” and “Run approved tools” in Settings → Tool Foundry.",
  },
  {
    code: "off_foundry_unavailable",
    fixTarget: "settings_foundry",
    // test_tool is exempt: it is a pure sandbox scratchpad that touches no
    // Foundry table, and executeFoundryTool already routes it around the
    // migration probe for exactly this case. Withholding it here made that
    // exemption dead code and told a user to run a database migration before
    // the assistant could check a snippet that needs no database.
    applies: (tool, input) => FOUNDRY_TOOLS.has(tool) && tool !== "test_tool" && !input.foundryReady,
    reason: () => "The Tool Foundry is switched on, but its one-time database setup hasn't run on this account yet.",
    fix: () => "Open Settings → Tool Foundry and paste the setup line it shows you into Lovable, then reload.",
    groupReason: "The Tool Foundry is switched on, but its one-time database setup hasn't run on this account yet.",
    groupFix: "Open Settings → Tool Foundry and paste the setup line it shows you into Lovable, then reload.",
  },
  {
    code: "off_lean_mode",
    fixTarget: "settings_lean",
    applies: (tool, input) => blockedTools(input.leanMode).includes(tool),
    reason: (tool) => `${upperFirst(capabilityName(tool))} is off while Lean Mode is on.`,
    fix: () => "Choose “Full” under Spending in Settings → AI Models & Keys.",
    groupReason: "Lean Mode is on, which keeps the tools that cost money out of the AI's hands.",
    groupFix: "Choose “Full” under Spending in Settings → AI Models & Keys.",
  },
  {
    code: "off_permission",
    fixTarget: "settings_permissions",
    applies: (tool, input) => {
      const permId = TOOL_PERMISSION[tool];
      return !!permId && input.permissions[permId] === false;
    },
    reason: (tool) => `“${permissionLabelFor(tool)}” is switched off in your AI permissions.`,
    fix: (tool) => `Turn “${permissionLabelFor(tool)}” back on in Settings → AI Permissions.`,
    groupReason: "These are switched off in your AI permissions.",
    groupFix: "Turn the ones you want back on in Settings → AI Permissions.",
  },
];

const AVAILABLE: Omit<ToolGate, "tool"> = {
  code: "available",
  reason: "On — this goes out with your messages.",
  fix: "Nothing to change; it's already on.",
  fixTarget: "none",
};

/** Every tool's status for ONE turn, in the order the names were given (Map
 *  preserves insertion order, so the roster keeps its registration order). */
export function computeToolGates(input: ToolGateInput): Map<string, ToolGate> {
  const gates = new Map<string, ToolGate>();
  for (const tool of input.toolNames) {
    const rule = RULES.find((r) => r.applies(tool, input));
    gates.set(
      tool,
      rule
        ? { tool, code: rule.code, reason: rule.reason(tool), fix: rule.fix(tool), fixTarget: rule.fixTarget }
        : { tool, ...AVAILABLE },
    );
  }
  return gates;
}

/** The roster actually handed to the model. */
export function availableToolNames(gates: Map<string, ToolGate>): string[] {
  const out: string[] = [];
  for (const [tool, gate] of gates) if (gate.code === "available") out.push(tool);
  return out;
}

export function withheldGates(gates: Map<string, ToolGate>): ToolGate[] {
  return Array.from(gates.values()).filter((g) => g.code !== "available");
}

/** What the model is told, per code. Deliberately separate from the
 *  user-facing `reason`: that one is written to a person looking at their own
 *  settings ("your AI permissions"), which reads as nonsense addressed to the
 *  model. Both are app-authored constants — no provider text ever lands here. */
const MODEL_FACT: Record<ToolGateCode, string> = {
  available: "This tool is in your list for this turn.",
  off_permission: "The user has switched this tool off in their AI permissions.",
  off_lean_mode: "The user has Lean Mode on, which keeps the paid generators out of your list.",
  off_foundry_optin: "The user has the Tool Foundry switch off, so the foundry tools are not in your list.",
  off_foundry_unavailable: "The Tool Foundry's one-time database setup has not run on this account yet.",
  off_model_no_tools: "The model answering this turn cannot call tools, so none were sent with the request.",
  off_model_image_turn:
    "This turn carries a picture and the model answering it drops tools on picture turns, so none were sent with the request.",
};

/** The terminal refusal an executor returns when a call is replayed from
 *  history for a gated tool — the backstop for the roster omission, which is
 *  the primary enforcement. Terminal on purpose: the documented default is for
 *  models to retry a failed call two or three times, and a retry loop against
 *  a switch only the user can flip burns tokens to arrive back here.
 *
 *  Call this only with a WITHHELD gate; an "available" gate has nothing to
 *  refuse and would produce a contradictory result. */
export function gateRefusal(gate: ToolGate): { error: string; code: ToolGateCode; retriable: false; fix: string } {
  return {
    error:
      `${MODEL_FACT[gate.code]} '${gate.tool}' was not in your tool list for this turn, so this call came from ` +
      `earlier in the conversation. This is final: do not retry it and do not substitute a different tool. Say so ` +
      `in one sentence, tell the user what turns it back on (${gate.fix}), then give the best answer you can ` +
      `without it.`,
    code: gate.code,
    retriable: false,
    fix: gate.fix,
  };
}

/** Groups withheld gates by code for the UI, in RULES order (most severe
 *  first). A group of exactly one tool keeps that tool's specific wording —
 *  "Forging new tools is switched off" beats "the Tool Foundry switches are
 *  off" when only one of the two is actually off. */
export function groupWithheld(gates: Map<string, ToolGate>): Array<{
  code: ToolGateCode;
  reason: string;
  fix: string;
  fixTarget: ToolGate["fixTarget"];
  tools: string[];
}> {
  const byCode = new Map<ToolGateCode, ToolGate[]>();
  for (const gate of withheldGates(gates)) {
    const list = byCode.get(gate.code);
    if (list) list.push(gate);
    else byCode.set(gate.code, [gate]);
  }
  const out: Array<{ code: ToolGateCode; reason: string; fix: string; fixTarget: ToolGate["fixTarget"]; tools: string[] }> = [];
  for (const rule of RULES) {
    const group = byCode.get(rule.code);
    if (!group) continue;
    const single = group.length === 1 ? group[0] : null;
    out.push({
      code: rule.code,
      reason: single ? single.reason : rule.groupReason,
      fix: single ? single.fix : rule.groupFix,
      fixTarget: rule.fixTarget,
      tools: group.map((g) => g.tool),
    });
  }
  return out;
}

/** Every string this module can put in front of a person or a model. The
 *  copy-vocabulary test walks this so a new rule cannot slip past it. */
export function allGateCopy(): string[] {
  const out: string[] = [AVAILABLE.reason, AVAILABLE.fix, ...Object.values(MODEL_FACT)];
  const probes = [FORGE_TOOL, RUN_TOOL, "generate_video", "generate_image", "web_search", "delete_chapter", "some_new_tool"];
  for (const rule of RULES) {
    out.push(rule.groupReason, rule.groupFix);
    for (const tool of probes) out.push(rule.reason(tool), rule.fix(tool));
  }
  return out;
}
