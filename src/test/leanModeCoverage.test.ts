import { describe, it, expect } from "vitest";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";
import { blockedTools, capabilityName } from "@/lib/leanMode";

// Lean Mode is enforced by REMOVING tools from the model's roster, which works
// — but only for tools someone remembered to add to the block list. Nothing
// checked that, so a new generation tool would silently keep spending in the
// tier that promises it won't. These tests are that check.
//
// The rule is deliberately about the NAME: anything called generate_* or
// edit_image bills the user's key, and the naming convention is the only
// signal available at test time. If a future tool spends money under a
// different name, it needs adding here as well as to the block list — but the
// common case is covered automatically.

const SPENDS = /^(generate_|edit_image$)/;

/** Tools that look like generators but cost nothing, with the reason. Keeping
 *  this list explicit means a genuinely free tool has to be argued for once
 *  rather than quietly slipping past the check. */
const FREE_BY_DESIGN = new Set<string>([
  // Rendered on the user's own GPU, no API call.
  "render_splat_views",
]);

describe("Lean Mode covers everything that spends", () => {
  const names = CHAT_TOOL_DEFINITIONS.map((t: any) => t.function.name as string);
  const chatOnly = blockedTools("chat_only");

  it("finds the tool registry", () => {
    expect(names.length).toBeGreaterThan(30);
  });

  it("blocks every generation tool in chat_only", () => {
    const spenders = names.filter((n) => SPENDS.test(n) && !FREE_BY_DESIGN.has(n));
    expect(spenders.length).toBeGreaterThan(0);
    for (const tool of spenders) {
      expect(chatOnly, `${tool} bills the user's key but is not blocked in chat_only`).toContain(tool);
    }
  });

  it("blocks the dollar-a-shot tools in the middle tier too", () => {
    for (const tool of ["generate_video", "generate_splat"]) {
      expect(blockedTools("lean")).toContain(tool);
    }
  });

  it("names every blocked tool in human language", () => {
    for (const tool of chatOnly) {
      expect(capabilityName(tool)).not.toBe(tool);
    }
  });

  it("blocks nothing that does not exist", () => {
    for (const tool of chatOnly) {
      expect(names, `${tool} is blocked but is not a real tool`).toContain(tool);
    }
  });

  // The free local sheets are the whole point of the tier — if these ever get
  // blocked, chat_only stops being able to do anything visual at all.
  it("leaves the free local drawing tools available in every tier", () => {
    for (const tool of ["create_blueprint_sheet", "create_stage_plan", "create_artifact", "render_blocks"]) {
      expect(names).toContain(tool);
      expect(blockedTools("chat_only")).not.toContain(tool);
      expect(blockedTools("lean")).not.toContain(tool);
    }
  });
});
