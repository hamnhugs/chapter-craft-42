import { describe, it, expect } from "vitest";
import { TOOL_PERMISSION, BRANCH_PERMISSIONS, PERMISSION_GROUPS } from "@/lib/toolPermissions";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";

// The settings screen once shipped 19 toggles and claimed the executor
// enforced all of them — 9 actually had a gate, 10 did not, and 3 more
// permissions were enforced with no toggle to reach them. toolPermissions.ts
// makes the claim structural; this test is the part that fails the build when
// the UI list and the enforcement map drift apart again.

const toolNames = CHAT_TOOL_DEFINITIONS.map((t: any) => t.function.name as string);
const toggleIds = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.id));
const enforcedIds = new Set([
  ...Object.values(TOOL_PERMISSION),
  ...Object.keys(BRANCH_PERMISSIONS),
]);

describe("permission coverage", () => {
  it("finds both registries", () => {
    expect(toolNames.length).toBeGreaterThan(30);
    expect(toggleIds.length).toBeGreaterThan(10);
  });

  // (a) A toggle nothing enforces is a lie in the settings screen — the user
  // switches it off and the tool keeps running.
  it("every rendered toggle is enforced somewhere", () => {
    for (const id of toggleIds) {
      expect(
        enforcedIds.has(id),
        `settings toggle '${id}' is enforced by neither TOOL_PERMISSION nor BRANCH_PERMISSIONS`,
      ).toBe(true);
    }
  });

  // (b) The other direction: an enforced permission with no toggle can never
  // be granted or revoked — a phantom the user cannot reach.
  it("every enforced permission id has a settings toggle", () => {
    for (const id of new Set(Object.values(TOOL_PERMISSION))) {
      expect(toggleIds, `TOOL_PERMISSION value '${id}' has no PERMISSION_GROUPS item`).toContain(id);
    }
    for (const id of Object.keys(BRANCH_PERMISSIONS)) {
      expect(toggleIds, `branch permission '${id}' has no PERMISSION_GROUPS item`).toContain(id);
    }
  });

  // (c) A gate on a tool that does not exist is a typo waiting to un-gate the
  // real tool when someone renames it.
  it("every TOOL_PERMISSION key names a real tool", () => {
    for (const key of Object.keys(TOOL_PERMISSION)) {
      expect(toolNames, `TOOL_PERMISSION key '${key}' is not a registered chat tool`).toContain(key);
    }
  });

  // (d) The naming convention is the only signal available at test time:
  // anything called delete_* destroys user data and MUST be toggleable.
  it("every delete_* tool has a permission entry", () => {
    const destructive = toolNames.filter((n) => n.startsWith("delete_"));
    expect(destructive.length).toBeGreaterThan(0);
    for (const tool of destructive) {
      expect(
        TOOL_PERMISSION[tool],
        `'${tool}' is destructive but has no TOOL_PERMISSION entry — the user cannot turn it off`,
      ).toBeTruthy();
    }
  });

  // (e) forge_tool / run_tool are deliberately ABSENT: the Tool Foundry is
  // opt-in with inverted semantics (off by default, enabled by an explicit
  // foundry setting plus per-tool approval), so listing it here — where every
  // permission defaults to ALLOWED — would silently flip it on for everyone.
  it("keeps the foundry out of the default-allowed permission map", () => {
    expect(TOOL_PERMISSION.forge_tool).toBeUndefined();
    expect(TOOL_PERMISSION.run_tool).toBeUndefined();
  });
});
