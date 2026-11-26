import { describe, it, expect, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({}) } }));

import { isStopHandsFreeCommand } from "@/lib/handsFreeStop";
import { CHAT_TOOL_DEFINITIONS, executeChatTool } from "@/lib/chatTools";

describe("spoken commands that end hands-free on the spot", () => {
  it.each([
    "stop hands free",
    "Stop hands-free mode.",
    "Please stop the hands free mode",
    "Hey, can you end hands-free mode now?",
    "okay turn off hands free",
    "turn hands-free off please",
    "exit voice mode",
    "end voice chat",
    "stop listening",
    "Stop listening to me, thanks.",
    "hands free off",
    "turn off the mic",
    "could you just stop handsfree for now",
    "I need to stop hands free",
    "pause hands-free",
    "stop hand free mode",
  ])("ends on %j", (said) => {
    expect(isStopHandsFreeCommand(said)).toBe(true);
  });

  it.each([
    "",
    "stop",
    "how do I stop hands free mode from timing out",
    "what does hands free mode do",
    "stop reading that chapter",
    "the author says we should stop listening to critics",
    "tell me about the chapter on voice",
    "turn off the lights in the story",
    "please",
    "I was listening to the mode of the piece",
  ])("leaves %j for the model", (said) => {
    expect(isStopHandsFreeCommand(said)).toBe(false);
  });
});

describe("end_hands_free", () => {
  const run = async (deps: Record<string, unknown> = {}) =>
    executeChatTool("end_hands_free", "{}", { permissionsSnapshot: {}, userId: "u1", ...deps } as any);

  it("is on the roster", () => {
    expect(CHAT_TOOL_DEFINITIONS.map((d: any) => d.function.name)).toContain("end_hands_free");
  });

  it("ends the session and leaves a sentence worth speaking", async () => {
    const endHandsFree = vi.fn();
    const { result, event } = await run({ endHandsFree });
    expect(endHandsFree).toHaveBeenCalledTimes(1);
    expect((result as any).ok).toBe(true);
    expect(event.ok).toBe(true);
    expect(event.summary).toMatch(/hands-free is off/i);
  });

  it("says there is nothing to stop in a typed chat", async () => {
    const { result, event } = await run();
    expect((result as any).already_off).toBe(true);
    expect(event.ok).toBe(true);
  });
});
