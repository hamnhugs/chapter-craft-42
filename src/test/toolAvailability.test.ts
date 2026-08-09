import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeToolGates,
  availableToolNames,
  withheldGates,
  gateRefusal,
  groupWithheld,
  allGateCopy,
  FORGE_TOOL,
  RUN_TOOL,
  FOUNDRY_REPAIR_TOOLS,
  FOUNDRY_SURVEY_TOOL,
  isFoundryTool,
  type ToolGateCode,
  type ToolGateInput,
} from "@/lib/toolAvailability";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";
import { blockedTools } from "@/lib/leanMode";

// toolPermissions.ts is the precedent this file copies: one map, two
// consumers, and a test that fails the build when they drift. Here the map is
// the gate rule list, the consumers are the roster in ChatContext and the
// status panel, and the drift that matters most is a tool that stops being
// offered without anything on screen saying so.

const ALL_TOOLS: string[] = CHAT_TOOL_DEFINITIONS.map((t: any) => t.function.name as string);

const OPEN: ToolGateInput = {
  toolNames: ALL_TOOLS,
  leanMode: "full",
  permissions: {},
  forgeOptIn: true,
  runOptIn: true,
  foundryReady: true,
  providerSupportsTools: true,
  imageTurnDisablesTools: false,
};

const withInput = (patch: Partial<ToolGateInput>): ToolGateInput => ({ ...OPEN, ...patch });
const codeOf = (input: ToolGateInput, tool: string): ToolGateCode =>
  computeToolGates(input).get(tool)!.code;

const ALL_CODES: ToolGateCode[] = [
  "available",
  "off_permission",
  "off_lean_mode",
  "off_foundry_optin",
  "off_foundry_unavailable",
  "off_model_no_tools",
  "off_model_image_turn",
];

describe("the fully open configuration offers everything", () => {
  it("returns every registered tool", () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(30);
    const gates = computeToolGates(OPEN);
    expect(availableToolNames(gates)).toEqual(ALL_TOOLS);
    expect(withheldGates(gates)).toEqual([]);
    expect(groupWithheld(gates)).toEqual([]);
  });

  it("keeps the roster in registration order", () => {
    // The order is the wire order. A Map reordering the roster between turns
    // would churn every provider's prompt cache for nothing.
    const gates = computeToolGates(withInput({ leanMode: "lean" }));
    const kept = availableToolNames(gates);
    expect(kept).toEqual(ALL_TOOLS.filter((t) => kept.includes(t)));
  });
});

describe("precedence is policy, in order", () => {
  it("a model that cannot call tools withholds EVERYTHING", () => {
    const gates = computeToolGates(withInput({ providerSupportsTools: false }));
    expect(availableToolNames(gates)).toEqual([]);
    expect(withheldGates(gates)).toHaveLength(ALL_TOOLS.length);
    for (const g of withheldGates(gates)) expect(g.code).toBe("off_model_no_tools");
  });

  it("an image turn on a model that drops tools withholds EVERYTHING", () => {
    const gates = computeToolGates(withInput({ imageTurnDisablesTools: true }));
    expect(availableToolNames(gates)).toEqual([]);
    for (const g of withheldGates(gates)) expect(g.code).toBe("off_model_image_turn");
  });

  it("model-level gates outrank every per-tool switch", () => {
    // Reporting "web search is off in your permissions" while the request
    // carried no `tools` field at all would send the user to fix a control
    // that changes nothing about this turn.
    const stacked = withInput({
      providerSupportsTools: false,
      leanMode: "chat_only",
      permissions: { web_search: false },
      forgeOptIn: false,
      runOptIn: false,
      foundryReady: false,
    });
    expect(codeOf(stacked, "web_search")).toBe("off_model_no_tools");
    expect(codeOf(stacked, FORGE_TOOL)).toBe("off_model_no_tools");
  });

  it("no-tools outranks the image-turn gate when both fire", () => {
    const both = withInput({ providerSupportsTools: false, imageTurnDisablesTools: true });
    expect(codeOf(both, "web_search")).toBe("off_model_no_tools");
  });

  it("the foundry opt-in outranks the missing migration", () => {
    // foundryReady is only ever probed once an opt-in is true, so with both
    // switches off it is false by construction. Blaming an unapplied
    // migration there would be a lie for every default install.
    const off = withInput({ forgeOptIn: false, runOptIn: false, foundryReady: false });
    expect(codeOf(off, FORGE_TOOL)).toBe("off_foundry_optin");
    expect(codeOf(off, RUN_TOOL)).toBe("off_foundry_optin");
  });

  it("names the missing migration once the switch is genuinely on", () => {
    const on = withInput({ forgeOptIn: true, runOptIn: true, foundryReady: false });
    expect(codeOf(on, FORGE_TOOL)).toBe("off_foundry_unavailable");
    expect(codeOf(on, RUN_TOOL)).toBe("off_foundry_unavailable");
  });

  it("gates the two foundry tools independently", () => {
    // With one combined flag, enabling only "forge" still advertised run_tool
    // to the model, which then called it and got a refusal.
    const forgeOnly = withInput({ forgeOptIn: true, runOptIn: false });
    expect(codeOf(forgeOnly, FORGE_TOOL)).toBe("available");
    expect(codeOf(forgeOnly, RUN_TOOL)).toBe("off_foundry_optin");
  });

  it("lean mode outranks a permission on the same tool", () => {
    const both = withInput({ leanMode: "chat_only", permissions: { web_search: false } });
    expect(codeOf(both, "web_search")).toBe("off_lean_mode");
  });

  it("falls through to the permission gate when nothing above it fires", () => {
    expect(codeOf(withInput({ permissions: { web_search: false } }), "web_search")).toBe("off_permission");
  });
});

describe("the foundry gates touch the foundry tools and nothing else", () => {
  for (const patch of [
    { forgeOptIn: false, runOptIn: false } as Partial<ToolGateInput>,
    { foundryReady: false } as Partial<ToolGateInput>,
  ]) {
    it(`only the foundry tools move under ${JSON.stringify(patch)}`, () => {
      const gates = computeToolGates(withInput(patch));
      // test_tool is a pure sandbox scratchpad that touches no Foundry table,
      // so an unapplied migration must not withhold it — executeFoundryTool
      // already routes it around the migration probe, and the two layers have
      // to agree or that exemption is dead code.
      const migrationExempt = "foundryReady" in patch && !("forgeOptIn" in patch);
      for (const [tool, gate] of gates) {
        if (isFoundryTool(tool) && !(migrationExempt && tool === "test_tool")) {
          expect(gate.code, tool).not.toBe("available");
        } else {
          expect(gate.code, tool).toBe("available");
        }
      }
    });
  }

  it("an unapplied migration does not withhold test_tool", () => {
    const gates = computeToolGates(withInput({ foundryReady: false }));
    expect(gates.get("test_tool")!.code).toBe("available");
    expect(gates.get(FORGE_TOOL)!.code).toBe("off_foundry_unavailable");
  });

  it("registers every foundry tool — the gates would be dead code otherwise", () => {
    for (const tool of [FORGE_TOOL, RUN_TOOL, FOUNDRY_SURVEY_TOOL, ...FOUNDRY_REPAIR_TOOLS]) {
      expect(ALL_TOOLS, tool).toContain(tool);
      expect(isFoundryTool(tool), tool).toBe(true);
    }
  });

  // The grouping below is the SAME rule the executor applies inline in
  // chatTools.ts's Foundry dispatch. If the two ever drift, the model is
  // offered a verb the executor then refuses — which is precisely the silent
  // mismatch this whole ship exists to remove.
  it("reading and dry-running ride with forging, not with running", () => {
    const forgeOnly = computeToolGates(withInput({ forgeOptIn: true, runOptIn: false }));
    for (const tool of [FORGE_TOOL, ...FOUNDRY_REPAIR_TOOLS]) {
      expect(forgeOnly.get(tool)!.code, tool).toBe("available");
    }
    expect(forgeOnly.get(RUN_TOOL)!.code).toBe("off_foundry_optin");

    const runOnly = computeToolGates(withInput({ forgeOptIn: false, runOptIn: true }));
    expect(runOnly.get(RUN_TOOL)!.code).toBe("available");
    for (const tool of [FORGE_TOOL, ...FOUNDRY_REPAIR_TOOLS]) {
      expect(runOnly.get(tool)!.code, tool).toBe("off_foundry_optin");
    }
  });

  it("the survey verb needs only one switch — either one", () => {
    for (const patch of [{ forgeOptIn: true, runOptIn: false }, { forgeOptIn: false, runOptIn: true }]) {
      expect(computeToolGates(withInput(patch)).get(FOUNDRY_SURVEY_TOOL)!.code, JSON.stringify(patch)).toBe("available");
    }
    expect(
      computeToolGates(withInput({ forgeOptIn: false, runOptIn: false })).get(FOUNDRY_SURVEY_TOOL)!.code,
    ).toBe("off_foundry_optin");
  });
});

describe("the data-driven gates track their source maps", () => {
  it("lean mode withholds exactly blockedTools(mode)", () => {
    for (const mode of ["full", "lean", "chat_only"] as const) {
      const gates = computeToolGates(withInput({ leanMode: mode }));
      const withheld = withheldGates(gates).filter((g) => g.code === "off_lean_mode").map((g) => g.tool);
      expect(withheld.sort(), mode).toEqual(blockedTools(mode).filter((t) => ALL_TOOLS.includes(t)).sort());
    }
  });

  it("an explicit false blocks; anything else allows (default-allow semantics)", () => {
    expect(codeOf(withInput({ permissions: { delete_chapter: false } }), "delete_chapter")).toBe("off_permission");
    expect(codeOf(withInput({ permissions: { delete_chapter: true } }), "delete_chapter")).toBe("available");
    expect(codeOf(withInput({ permissions: {} }), "delete_chapter")).toBe("available");
  });

  it("every permission id can withhold the tools it governs", () => {
    const permIds = Array.from(new Set(Object.values(TOOL_PERMISSION)));
    for (const permId of permIds) {
      const governed = Object.keys(TOOL_PERMISSION).filter((t) => TOOL_PERMISSION[t] === permId && ALL_TOOLS.includes(t));
      const gates = computeToolGates(withInput({ permissions: { [permId]: false } }));
      for (const tool of governed) expect(gates.get(tool)!.code, `${permId} → ${tool}`).toBe("off_permission");
    }
  });
});

describe("every gate can be acted on", () => {
  it("every code carries a non-empty reason and fix", () => {
    // A code with no fix is a dead end — the user learns a tool is off and
    // nothing about where the switch lives, which is the original bug.
    const seen = new Map<ToolGateCode, { reason: string; fix: string }>();
    const scenarios: ToolGateInput[] = [
      OPEN,
      withInput({ providerSupportsTools: false }),
      withInput({ imageTurnDisablesTools: true }),
      withInput({ forgeOptIn: false, runOptIn: false }),
      withInput({ foundryReady: false }),
      withInput({ leanMode: "chat_only" }),
      withInput({ permissions: { web_search: false } }),
    ];
    for (const s of scenarios) {
      for (const gate of computeToolGates(s).values()) {
        seen.set(gate.code, { reason: gate.reason, fix: gate.fix });
      }
    }
    for (const code of ALL_CODES) {
      const copy = seen.get(code);
      expect(copy, `no scenario produced '${code}'`).toBeTruthy();
      expect(copy!.reason.trim().length, code).toBeGreaterThan(10);
      expect(copy!.fix.trim().length, code).toBeGreaterThan(10);
    }
  });

  it("every withheld gate points at a real control", () => {
    const gates = computeToolGates(
      withInput({ leanMode: "chat_only", permissions: { delete_chapter: false }, forgeOptIn: false, runOptIn: false }),
    );
    for (const gate of withheldGates(gates)) {
      expect(gate.fixTarget, gate.tool).not.toBe("none");
    }
    // The converse: nothing that IS available claims a control to go fix.
    for (const name of availableToolNames(gates)) {
      expect(gates.get(name)!.fixTarget, name).toBe("none");
    }
  });
});

describe("grouping is stable and complete", () => {
  it("covers every withheld tool exactly once, most severe first", () => {
    const gates = computeToolGates(
      withInput({ leanMode: "chat_only", permissions: { delete_chapter: false }, forgeOptIn: false, runOptIn: false }),
    );
    const groups = groupWithheld(gates);
    expect(groups.map((g) => g.code)).toEqual(["off_foundry_optin", "off_lean_mode", "off_permission"]);
    const listed = groups.flatMap((g) => g.tools);
    expect(listed.sort()).toEqual(withheldGates(gates).map((g) => g.tool).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("the chip's arithmetic always agrees with the panel's list", () => {
    // The failure this pins: a count saying "4 off" above a list of three.
    for (const s of [
      OPEN,
      withInput({ providerSupportsTools: false }),
      withInput({ imageTurnDisablesTools: true }),
      withInput({ leanMode: "lean", forgeOptIn: false, runOptIn: false, permissions: { web_search: false } }),
    ]) {
      const gates = computeToolGates(s);
      const offered = availableToolNames(gates).length;
      const withheld = groupWithheld(gates).reduce((n, g) => n + g.tools.length, 0);
      expect(offered + withheld).toBe(ALL_TOOLS.length);
      expect(withheld).toBe(withheldGates(gates).length);
    }
  });

  it("keeps the specific wording when a group holds one tool", () => {
    const gates = computeToolGates(withInput({ runOptIn: false }));
    const group = groupWithheld(gates).find((g) => g.code === "off_foundry_optin")!;
    expect(group.tools).toEqual([RUN_TOOL]);
    expect(group.reason).toBe(gates.get(RUN_TOOL)!.reason);
    expect(group.fix).toContain("Run approved tools");
  });

  it("falls back to group wording when several tools share a code", () => {
    const gates = computeToolGates(withInput({ forgeOptIn: false, runOptIn: false }));
    const group = groupWithheld(gates).find((g) => g.code === "off_foundry_optin")!;
    expect(group.tools.sort()).toEqual([FORGE_TOOL, RUN_TOOL, FOUNDRY_SURVEY_TOOL, ...FOUNDRY_REPAIR_TOOLS].sort());
    expect(group.reason).toContain("Tool Foundry");
  });
});

describe("the replayed-call refusal is terminal", () => {
  it("names the code, forbids the retry, and carries the fix", () => {
    const gate = computeToolGates(withInput({ forgeOptIn: false })).get(FORGE_TOOL)!;
    const r = gateRefusal(gate);
    expect(r.code).toBe("off_foundry_optin");
    expect(r.retriable).toBe(false);
    expect(r.error.toLowerCase()).toContain("do not retry");
    expect(r.error.toLowerCase()).toContain("do not substitute");
    expect(r.error).toContain(FORGE_TOOL);
    expect(r.fix).toBe(gate.fix);
    expect(r.error).toContain(gate.fix);
  });

  it("produces a distinct, non-empty refusal for every withheld code", () => {
    const cases: Array<[ToolGateCode, ToolGateInput, string]> = [
      ["off_model_no_tools", withInput({ providerSupportsTools: false }), "web_search"],
      ["off_model_image_turn", withInput({ imageTurnDisablesTools: true }), "web_search"],
      ["off_foundry_optin", withInput({ forgeOptIn: false }), FORGE_TOOL],
      ["off_foundry_unavailable", withInput({ foundryReady: false }), FORGE_TOOL],
      ["off_lean_mode", withInput({ leanMode: "chat_only" }), "generate_image"],
      ["off_permission", withInput({ permissions: { web_search: false } }), "web_search"],
    ];
    const errors = new Set<string>();
    for (const [code, input, tool] of cases) {
      const gate = computeToolGates(input).get(tool)!;
      expect(gate.code).toBe(code);
      const r = gateRefusal(gate);
      expect(r.error.length, code).toBeGreaterThan(60);
      errors.add(r.error);
    }
    expect(errors.size).toBe(cases.length);
  });
});

describe("copy invariant: no safety or blame vocabulary anywhere", () => {
  // Standard safety framing in a system prompt raised unfaithful refusals on
  // entirely benign requests from 0.25% to 3.95% — 15.6x. These strings reach
  // the model (via gateRefusal) and the user (via the panel); the register
  // that suppresses tool use is the same register that reads as blame. This
  // test is the structural pin for that, not a style preference.
  const FORBIDDEN = [
    "not permitted", "not allowed", "for safety", "unsafe", "blocked", "block ",
    "denied", "deny", "forbidden", "prohibited", "disallowed", "unauthorized",
    "restricted", "violation", "security", "harmful", "dangerous", "abuse",
    "you cannot", "you can't", "you may not", "you must not", "misuse",
  ];

  it("holds for every reason, fix and model-facing sentence", () => {
    for (const line of allGateCopy()) {
      const lower = line.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(lower.includes(word), `"${word}" appears in: ${line}`).toBe(false);
      }
    }
  });

  it("holds for the refusals the model actually receives", () => {
    const scenarios: ToolGateInput[] = [
      withInput({ providerSupportsTools: false }),
      withInput({ imageTurnDisablesTools: true }),
      withInput({ forgeOptIn: false, runOptIn: false }),
      withInput({ foundryReady: false }),
      withInput({ leanMode: "chat_only" }),
      withInput({ permissions: { web_search: false, delete_chapter: false } }),
    ];
    for (const s of scenarios) {
      for (const gate of withheldGates(computeToolGates(s))) {
        const lower = gateRefusal(gate).error.toLowerCase();
        for (const word of FORBIDDEN) {
          expect(lower.includes(word), `"${word}" in refusal for ${gate.tool}`).toBe(false);
        }
      }
    }
  });

  it("every gate sentence actually reads as a sentence", () => {
    for (const line of allGateCopy()) {
      expect(line.trim().length).toBeGreaterThan(10);
      expect(line.trim().endsWith("."), line).toBe(true);
    }
  });
});

describe("a tool whose executor needs someone else's switch leaves the roster with it", () => {
  // supersede_memory_entry has its own permission AND its executor refuses
  // 100% of calls when "Edit memory entries" is off (chatTools.ts, the
  // memory-write case). Before DEPENDS_ON the roster carried the verb and the
  // prompt actively instructed its use, so every attempt spent a round trip to
  // reach a hard refusal — the prompt, the roster and the executor disagreeing
  // about one tool. This is the pin for that agreement.
  const DEP_TOOL = "supersede_memory_entry";
  const DEP_ON = "update_memory_entry";

  it("withholds supersede when memory editing is off, even with its own switch on", () => {
    const input = withInput({ permissions: { [DEP_ON]: false, [DEP_TOOL]: true } });
    expect(codeOf(input, DEP_TOOL)).toBe("off_permission");
    expect(availableToolNames(computeToolGates(input))).not.toContain(DEP_TOOL);
  });

  it("offers it when both switches are on — the mirror, so this never over-filters", () => {
    expect(codeOf(withInput({ permissions: {} }), DEP_TOOL)).toBe("available");
    expect(codeOf(withInput({ permissions: { [DEP_ON]: true } }), DEP_TOOL)).toBe("available");
  });

  it("names the switch that actually fired, never one that is already on", () => {
    const viaDep = computeToolGates(withInput({ permissions: { [DEP_ON]: false } })).get(DEP_TOOL)!;
    expect(viaDep.fix).toContain("Edit memory entries");
    const viaOwn = computeToolGates(withInput({ permissions: { [DEP_TOOL]: false } })).get(DEP_TOOL)!;
    expect(viaOwn.fix).not.toContain("Edit memory entries");
  });

  it("only depends on a switch that really is total — default-allow still holds", () => {
    // An absent value is ON. Reading `undefined` as off here would withhold the
    // tool from every user who has never opened the permissions screen.
    expect(codeOf(withInput({ permissions: { unrelated: false } }), DEP_TOOL)).toBe("available");
  });
});

describe("copy invariant: the chips under a reply follow the same rule as the panel", () => {
  // event.summary renders as a chip beneath the assistant bubble, so it is
  // user-facing copy — but allGateCopy() cannot reach it, and it drifted:
  // six summaries read "blocked by user settings" / "Blocked by free plan".
  // Same register, same harm, different file, and nothing was watching.
  const SRC = readFileSync(resolve(process.cwd(), "src", "lib", "chatTools.ts"), "utf8");
  const BLAME = ["blocked", "denied", "forbidden", "prohibited", "not permitted", "not allowed", "unauthorized"];

  it("has no blame vocabulary in any event summary", () => {
    const offenders: string[] = [];
    // One simple pattern per quote style rather than one clever one. A summary
    // containing an escaped quote of its own kind would end the match early —
    // that costs coverage of the tail, never a false pass on the head, and a
    // matcher nobody can read is the thing that rots.
    const patterns = [/summary:\s*"([^"]*)"/g, /summary:\s*'([^']*)'/g, /summary:\s*`([^`]*)`/g];
    const matches = patterns.flatMap((re) => [...SRC.matchAll(re)]);
    for (const m of matches) {
      const text = m[1].toLowerCase();
      // ${...} holes are identifiers, not copy — strip before judging.
      const rendered = text.replace(/\$\{[^}]*\}/g, "");
      for (const word of BLAME) if (rendered.includes(word)) offenders.push(`${word} :: ${m[1]}`);
    }
    expect(offenders, `blame vocabulary in event.summary:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("actually reads the summaries (guard against a regex that matches nothing)", () => {
    const count = [...SRC.matchAll(/summary:\s*(["'`])/g)].length;
    expect(count).toBeGreaterThan(60);
  });
});
