import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";
import { blockedTools } from "@/lib/leanMode";
import { FORGE_TOOL, RUN_TOOL, computeToolGates, availableToolNames } from "@/lib/toolAvailability";

/**
 * WHAT toolOnWire MEANS — the predicate every gated tool result rests on.
 *
 * It had ELEVEN hand-placed call sites and zero tests. Every one of them was
 * correct on the day it was written and unpinned the day after: revert any
 * gate, or invert one comparison inside the function, and nothing in the suite
 * notices. toolResultToolTruth.test.ts pins WHERE the gates are; this file
 * pins what they DECIDE.
 *
 * Both directions are failures, and they fail differently:
 *
 *   · TOO PERMISSIVE — the clause survives on a turn that does not carry the
 *     tool. That is the reported bug verbatim: the freshest thing in context
 *     names a verb the model has no function for, so it narrates having used
 *     it ("it keeps lying about being able to use them").
 *   · TOO STRICT — the clause is dropped on a turn that DOES carry the tool.
 *     Nothing looks wrong on screen; the assistant just quietly stops
 *     suggesting a capability the user is paying for. This is why the
 *     default-allow convention below is tested as hard as the blocking cases:
 *     reading "absent" as "off" would withhold guidance from every user who
 *     has never opened the permissions screen, which is most of them.
 */

const h = vi.hoisted(() => ({ foundryReady: true }));

// The Foundry's one-time database probe. toolOnWire consults it for the
// Foundry verbs, so it has to be controllable rather than real.
vi.mock("@/lib/toolFoundry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toolFoundry")>()),
  foundryAvailable: async () => h.foundryReady,
}));

// chatTools reaches Supabase at module scope for other code paths. Every call
// below passes `permissionsSnapshot`, which short-circuits readToolPermissions
// before any query — this stub only has to exist, not to answer.
vi.mock("@/integrations/supabase/client", () => {
  const chain: any = new Proxy(() => chain, {
    get: () => chain,
    apply: () => chain,
  });
  return { supabase: { from: () => chain, auth: { getUser: async () => ({ data: { user: null } }) } } };
});

const { toolOnWire } = await import("@/lib/chatTools");

type Deps = Parameters<typeof toolOnWire>[1];
const deps = (permissions: Record<string, boolean> = {}, leanMode?: "full" | "lean" | "chat_only"): Deps =>
  ({ permissionsSnapshot: permissions, ...(leanMode ? { leanMode } : {}) }) as Deps;

beforeEach(() => { h.foundryReady = true; });

describe("the default-allow convention: OFF only on an explicit false", () => {
  // toolPermissions.ts's stated semantics: "every permission defaults to
  // ALLOWED; only an explicit `false` in user_settings.chat_tool_permissions
  // blocks." A fresh account has {} there. Getting this backwards is invisible
  // in review and withholds a clause from every existing user.
  const GOVERNED_BY_PERMISSION = Object.keys(TOOL_PERMISSION);

  it("says yes for every permissioned tool when the snapshot is empty", async () => {
    for (const tool of GOVERNED_BY_PERMISSION) {
      expect(await toolOnWire(tool, deps({})), tool).toBe(true);
    }
    expect(GOVERNED_BY_PERMISSION.length).toBeGreaterThan(25);
  });

  it("says yes for an explicit true and for an undefined key", async () => {
    expect(await toolOnWire("generate_image", deps({ generate_image: true }))).toBe(true);
    expect(await toolOnWire("generate_image", deps({ some_other_thing: false }))).toBe(true);
  });

  it("says no only for an explicit false", async () => {
    expect(await toolOnWire("generate_image", deps({ generate_image: false }))).toBe(false);
  });

  it("keys on the PERMISSION id, not the tool name — grouped toggles move together", async () => {
    // accept_generation and reject_generation share "production_ledger"; the
    // toggle is one control and both verbs leave the roster together, which is
    // what makes generate_image's closing note able to gate on one and name
    // both.
    expect(TOOL_PERMISSION.accept_generation).toBe("production_ledger");
    expect(TOOL_PERMISSION.reject_generation).toBe("production_ledger");
    const off = deps({ production_ledger: false });
    expect(await toolOnWire("accept_generation", off)).toBe(false);
    expect(await toolOnWire("reject_generation", off)).toBe(false);
    // …and a false written under the TOOL name is not the switch. Reading it
    // as one would be a second, silent source of truth.
    const wrongKey = deps({ accept_generation: false });
    expect(await toolOnWire("accept_generation", wrongKey)).toBe(true);
  });

  it("says yes for a tool with no permission entry at all", async () => {
    // The free/read-only surface. These are the names a gated clause is
    // allowed to fall back to, so "yes, always" is load-bearing.
    for (const free of ["list_images", "show_image", "view_image", "list_books", "save_file", "list_master_assets"]) {
      expect(await toolOnWire(free, deps({})), free).toBe(true);
      expect(await toolOnWire(free, deps({ [free]: false })), free).toBe(true);
    }
  });

  it("says yes for a name nobody has registered", async () => {
    // Unknown fails OPEN, exactly as modelCapabilities does. A typo in a gate
    // must not silently delete the clause it guards.
    expect(await toolOnWire("some_tool_invented_next_year", deps({}))).toBe(true);
  });
});

describe("the Lean tier outranks the permission map", () => {
  it("withholds exactly the tools each tier blocks, and nothing else", async () => {
    for (const mode of ["full", "lean", "chat_only"] as const) {
      const blocked = blockedTools(mode);
      for (const tool of blocked) {
        expect(await toolOnWire(tool, deps({}, mode)), `${mode}/${tool}`).toBe(false);
      }
      // A tool the tier does NOT block stays on — a budget mode that hid the
      // user's own library would be punishing them for being broke.
      for (const kept of ["list_images", "show_video", "lock_master_asset", "create_artifact"]) {
        expect(await toolOnWire(kept, deps({}, mode)), `${mode}/${kept}`).toBe(true);
      }
    }
    expect(blockedTools("lean")).toContain("generate_video");
    expect(blockedTools("chat_only")).toContain("web_search");
  });

  it("blocks even when the permission is explicitly ON", async () => {
    expect(await toolOnWire("generate_video", deps({ generate_video: true }, "lean"))).toBe(false);
  });

  it("treats a missing leanMode as 'full'", async () => {
    // Most call paths pass deps without it; reading undefined as a blocking
    // tier would withhold every generator clause from every turn.
    expect(await toolOnWire("generate_video", deps({}))).toBe(true);
    expect(await toolOnWire("generate_splat", deps({}))).toBe(true);
  });
});

describe("the Foundry's INVERTED opt-in", () => {
  // The two Foundry switches are absent from TOOL_PERMISSION on purpose: they
  // are off unless an explicit `true` is present, which is the opposite of
  // every other permission in the app. Reading them with the default-allow
  // rule would put forge_tool and run_tool in every result on every account —
  // the exact original bug, in the results layer.

  it("withholds every Foundry verb on a default account", async () => {
    for (const tool of [FORGE_TOOL, RUN_TOOL, "list_tools", "read_tool", "test_tool"]) {
      expect(await toolOnWire(tool, deps({})), tool).toBe(false);
    }
  });

  it("is not fooled by a truthy-but-not-true value", async () => {
    // `perms[X] === true`, not `!!perms[X]`. A row read back as "true" (a
    // string) or 1 must not grant.
    const sneaky = { [FORGE_TOOL]: "true", [RUN_TOOL]: 1 } as unknown as Record<string, boolean>;
    expect(await toolOnWire(FORGE_TOOL, deps(sneaky))).toBe(false);
    expect(await toolOnWire(RUN_TOOL, deps(sneaky))).toBe(false);
  });

  it("grants forge, read and test on the forge switch alone", async () => {
    const forgeOnly = deps({ [FORGE_TOOL]: true });
    expect(await toolOnWire(FORGE_TOOL, forgeOnly)).toBe(true);
    expect(await toolOnWire("read_tool", forgeOnly)).toBe(true);
    expect(await toolOnWire("test_tool", forgeOnly)).toBe(true);
    // …and not running. The two switches are independent controls.
    expect(await toolOnWire(RUN_TOOL, forgeOnly)).toBe(false);
  });

  it("grants running on the run switch alone, and nothing else", async () => {
    const runOnly = deps({ [RUN_TOOL]: true });
    expect(await toolOnWire(RUN_TOOL, runOnly)).toBe(true);
    expect(await toolOnWire(FORGE_TOOL, runOnly)).toBe(false);
    expect(await toolOnWire("read_tool", runOnly)).toBe(false);
    expect(await toolOnWire("test_tool", runOnly)).toBe(false);
  });

  it("gives list_tools to EITHER switch — it is the one plain survey", async () => {
    expect(await toolOnWire("list_tools", deps({ [FORGE_TOOL]: true }))).toBe(true);
    expect(await toolOnWire("list_tools", deps({ [RUN_TOOL]: true }))).toBe(true);
    expect(await toolOnWire("list_tools", deps({}))).toBe(false);
  });

  it("also requires the one-time database setup — except for test_tool", async () => {
    // CHANGED, and it was a real divergence. computeToolGates exempts test_tool
    // from off_foundry_unavailable (it is a pure sandbox scratchpad that
    // touches no Foundry table, and executeFoundryTool routes it around the
    // probe), so on an account with forging on and the migration NOT applied
    // the roster CARRIES test_tool. toolOnWire said it did not — over-filtering,
    // the mirror harm, and the direction that hides because nothing looks
    // wrong on screen.
    h.foundryReady = false;
    const forgeOn = deps({ [FORGE_TOOL]: true, [RUN_TOOL]: true });
    expect(await toolOnWire(FORGE_TOOL, forgeOn)).toBe(false);
    expect(await toolOnWire(RUN_TOOL, forgeOn)).toBe(false);
    expect(await toolOnWire("read_tool", forgeOn)).toBe(false);
    expect(await toolOnWire("list_tools", forgeOn)).toBe(false);
    expect(await toolOnWire("test_tool", forgeOn)).toBe(true);
    // The opt-in still comes first: no switch, no scratchpad.
    expect(await toolOnWire("test_tool", deps({}))).toBe(false);
  });
});

describe("it agrees with computeToolGates, which is the roster the model actually gets", () => {
  // THE POINT OF THE WHOLE FUNCTION. toolOnWire is a second implementation of
  // rules that live in toolAvailability.ts. Two implementations of one rule
  // drift; this is the differential test that says when they have.
  //
  // It deliberately omits the two model-capability gates (off_model_no_tools,
  // off_model_image_turn): those withhold the ENTIRE roster, and a turn with no
  // roster produces no tool result for a stray name to appear in — so both
  // inputs are pinned to the "model can call tools" case below.
  const PROBE_TOOLS = [
    "generate_image", "edit_image", "generate_video", "generate_splat", "web_search",
    "create_artifact", "delete_image", "lock_master_asset", "accept_generation",
    "supersede_memory_entry", "list_images", "show_image", "save_file",
    FORGE_TOOL, RUN_TOOL, "list_tools", "read_tool", "test_tool",
  ];

  const SCENARIOS: Array<{
    name: string;
    permissions: Record<string, boolean>;
    leanMode: "full" | "lean" | "chat_only";
    foundryReady: boolean;
  }> = [
    { name: "fresh account", permissions: {}, leanMode: "full", foundryReady: true },
    { name: "lean tier", permissions: {}, leanMode: "lean", foundryReady: true },
    { name: "chat only", permissions: {}, leanMode: "chat_only", foundryReady: true },
    { name: "images off", permissions: { generate_image: false, edit_image: false }, leanMode: "full", foundryReady: true },
    { name: "ledger off", permissions: { production_ledger: false }, leanMode: "full", foundryReady: true },
    { name: "foundry both on", permissions: { [FORGE_TOOL]: true, [RUN_TOOL]: true }, leanMode: "full", foundryReady: true },
    { name: "foundry forge only", permissions: { [FORGE_TOOL]: true }, leanMode: "full", foundryReady: true },
    { name: "foundry run only", permissions: { [RUN_TOOL]: true }, leanMode: "full", foundryReady: true },
    { name: "foundry on, migration missing", permissions: { [FORGE_TOOL]: true, [RUN_TOOL]: true }, leanMode: "full", foundryReady: false },
    { name: "lean + forge on", permissions: { [FORGE_TOOL]: true }, leanMode: "lean", foundryReady: true },
  ];

  for (const s of SCENARIOS) {
    it(s.name, async () => {
      h.foundryReady = s.foundryReady;
      const roster = new Set(
        availableToolNames(
          computeToolGates({
            toolNames: PROBE_TOOLS,
            leanMode: s.leanMode,
            permissions: s.permissions,
            forgeOptIn: s.permissions[FORGE_TOOL] === true,
            runOptIn: s.permissions[RUN_TOOL] === true,
            foundryReady: s.foundryReady,
            providerSupportsTools: true,
            imageTurnDisablesTools: false,
          }),
        ),
      );
      const disagreements: string[] = [];
      for (const tool of PROBE_TOOLS) {
        const onWire = await toolOnWire(tool, deps(s.permissions, s.leanMode));
        if (onWire !== roster.has(tool)) {
          disagreements.push(
            `${tool}: computeToolGates says ${roster.has(tool) ? "OFFERED" : "withheld"}, ` +
            `toolOnWire says ${onWire ? "on the wire" : "off the wire"}`,
          );
        }
      }
      expect(disagreements.join("\n"), disagreements.join("\n")).toBe("");
    });
  }
});
