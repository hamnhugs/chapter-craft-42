import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ToolProposal } from "@/lib/chatTools";
import { RUN_TOOL, FORGE_TOOL } from "@/lib/toolAvailability";

/**
 * ToolApprovalCard — does Approve grant what the button says it grants?
 *
 * The bug this pins: the card's only action was approveTool(), which flips a
 * row's status and nothing else. Whether `run_tool` ever reaches the model is
 * a SEPARATE inverted opt-in, off by default, and with it off the roster drops
 * the verb before the request leaves. So the user clicked "let the AI run
 * this", saw "Approved", and the AI could not run it — while still being shown
 * the tool by name in its prompt, which is the highest-fabrication shape there
 * is. Every assertion below is about that gap, not about styling.
 *
 * Rendering goes through react-dom/client + React.act directly rather than
 * @testing-library/react: RTL v16 is present but its required peer
 * @testing-library/dom is not installed, and this ship adds no dependencies.
 * (Same harness choice, same reason, as workspaceResizeHandle.test.ts.)
 */

// ── mocks ─────────────────────────────────────────────────────────────────
// vi.mock is hoisted above the imports, so the spies have to be too.

const h = vi.hoisted(() => ({
  approveTool: vi.fn(async (_id: string, _fp: string | null) => {}),
  toolFingerprint: vi.fn(async (_id: string) => "fp-current"),
  setChatToolPermission: vi.fn((_tool: string, _allowed: boolean) => {}),
  perms: {} as Record<string, boolean>,
  settingsLoaded: true,
  success: vi.fn((_m: string) => {}),
  error: vi.fn((_m: string) => {}),
}));

vi.mock("@/lib/toolFoundry", () => ({
  approveTool: h.approveTool,
  toolFingerprint: h.toolFingerprint,
}));

vi.mock("@/hooks/useChatSettings", () => ({
  useChatSettings: () => ({
    chatToolPermissions: h.perms,
    setChatToolPermission: h.setChatToolPermission,
    loaded: h.settingsLoaded,
  }),
}));

vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

// Only reached by Discard, which these tests never press — but the module is
// imported at load time, and the real client opens a Supabase connection.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ delete: () => ({ eq: () => ({ eq: async () => ({}) }) }) }) },
}));

import ToolApprovalCard from "@/components/ToolApprovalCard";

// ── harness ───────────────────────────────────────────────────────────────

type Mutable = Record<string, unknown>;
/** React 18.3 ships `React.act`; it returns a thenable for sync callbacks too. */
const act = React.act as unknown as (cb: () => void | Promise<void>) => Promise<void>;

let openRoots: Array<{ root: Root; host: HTMLElement }> = [];

const PROPOSAL: ToolProposal = {
  tool_id: "tool-1",
  name: "word_counter",
  description: "Counts words per chapter.",
  capabilities: [],
  version: 1,
  fingerprint: "fp-current",
  testResults: [{ pass: true, note: "counts an empty string as 0" }],
  code: "export default () => 0;",
};

async function mount(patch: Partial<ToolProposal> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  openRoots.push({ root, host });
  await act(() => {
    root.render(React.createElement(ToolApprovalCard, { proposal: { ...PROPOSAL, ...patch } }));
  });
  return host;
}

const buttonLabelled = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => (b.textContent || "").includes(text));

const clickApprove = async (host: HTMLElement) => {
  const btn = buttonLabelled(host, "Approve");
  expect(btn, "the Approve button should be on a pending card").toBeTruthy();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  document.body.innerHTML = "";
  openRoots = [];
  (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT = true;
  h.perms = {};
  h.settingsLoaded = true;
  h.approveTool.mockClear().mockResolvedValue(undefined);
  h.toolFingerprint.mockClear().mockResolvedValue("fp-current");
  h.setChatToolPermission.mockClear().mockImplementation(() => {});
  h.success.mockClear();
  h.error.mockClear();
});

afterEach(async () => {
  for (const { root } of openRoots.splice(0)) {
    try {
      await act(() => root.unmount());
    } catch {
      /* the test may already have unmounted it */
    }
  }
  delete (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT;
  document.body.innerHTML = "";
});

// ── the grant ─────────────────────────────────────────────────────────────

describe("Approve grants the permission the button promises", () => {
  it("turns run_tool on when it was off", async () => {
    const host = await mount();
    await clickApprove(host);

    expect(h.approveTool).toHaveBeenCalledWith("tool-1", "fp-current");
    // The whole point: approval alone leaves the verb out of the roster.
    expect(h.setChatToolPermission).toHaveBeenCalledWith(RUN_TOOL, true);
    expect(host.textContent).toContain("Approved");
  });

  it("says out loud that it flipped the switch", async () => {
    const host = await mount();
    await clickApprove(host);

    const msg = h.success.mock.calls.at(-1)![0];
    expect(msg).toContain("word_counter");
    expect(msg).toContain("Run approved tools");
    expect(msg).toContain("Tool Foundry");
    expect(h.error).not.toHaveBeenCalled();
  });

  it("does not re-write, or mention, a switch that was already on", async () => {
    h.perms = { [RUN_TOOL]: true };
    const host = await mount();
    await clickApprove(host);

    expect(h.approveTool).toHaveBeenCalledTimes(1);
    expect(h.setChatToolPermission).not.toHaveBeenCalled();
    // A user who already had it on is told nothing about a switch that did
    // not move — that sentence would be noise at best and confusing at worst.
    const msg = h.success.mock.calls.at(-1)![0];
    expect(msg).toContain("the AI can run it now");
    expect(msg).not.toContain("Run approved tools");
  });

  it("treats only an explicit true as on (the inverted opt-in)", async () => {
    // `run_tool: false` and a missing key are the SAME state to the roster.
    // A card that read this as merely "unset" would skip the grant and leave
    // the user exactly where the bug left them.
    h.perms = { [RUN_TOOL]: false };
    const host = await mount();
    await clickApprove(host);
    expect(h.setChatToolPermission).toHaveBeenCalledWith(RUN_TOOL, true);
  });

  it("never grants forge_tool", async () => {
    // Writing new tools is a separate decision with its own switch. Inferring
    // it from an approval would be the same broken promise, reversed.
    const host = await mount();
    await clickApprove(host);
    for (const [tool] of h.setChatToolPermission.mock.calls) {
      expect(tool).not.toBe(FORGE_TOOL);
    }
  });

  it("grants nothing without a click", async () => {
    await mount();
    expect(h.setChatToolPermission).not.toHaveBeenCalled();
    expect(h.approveTool).not.toHaveBeenCalled();
  });
});

// ── the two failure paths must not lie in opposite directions ─────────────

describe("a failed permission write never un-approves the tool", () => {
  it("keeps the approved state and names the switch instead", async () => {
    h.setChatToolPermission.mockImplementation(() => {
      throw new Error("settings store is offline");
    });
    const host = await mount();
    await clickApprove(host);

    // approve_tool already succeeded server-side. Reverting the card here
    // would tell the user an approval that is live in the database did not
    // happen — a worse lie than the one being fixed.
    expect(host.textContent).toContain("Approved");
    expect(buttonLabelled(host, "Approve")).toBeFalsy();
    expect(h.error).not.toHaveBeenCalled();
    const msg = h.success.mock.calls.at(-1)![0];
    expect(msg).toContain("approved");
    expect(msg).toContain("Run approved tools");
  });

  it("holds the write back until settings have actually loaded", async () => {
    // Until the row arrives the shared store still holds `defaults`, and the
    // permission setter triggers a debounced FULL-ROW upsert built from that
    // snapshot — writing it would blank the user's keys to grant one switch.
    h.settingsLoaded = false;
    const host = await mount();
    await clickApprove(host);

    expect(h.approveTool).toHaveBeenCalledTimes(1);
    expect(h.setChatToolPermission).not.toHaveBeenCalled();
    expect(h.success.mock.calls.at(-1)![0]).toContain("Run approved tools");
  });
});

describe("a failed approval grants nothing", () => {
  it("returns to pending and writes no permission", async () => {
    h.approveTool.mockRejectedValue(new Error("approve_tool rejected the fingerprint"));
    const host = await mount();
    await clickApprove(host);

    expect(h.setChatToolPermission).not.toHaveBeenCalled();
    expect(buttonLabelled(host, "Approve"), "the card should be pending again").toBeTruthy();
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.success).not.toHaveBeenCalled();
  });

  it("grants nothing when the code changed under the card", async () => {
    h.toolFingerprint.mockResolvedValue("fp-mutated");
    const host = await mount();
    await clickApprove(host);

    expect(h.approveTool).not.toHaveBeenCalled();
    expect(h.setChatToolPermission).not.toHaveBeenCalled();
    expect(buttonLabelled(host, "Approve")).toBeTruthy();
  });
});

// ── the auto-approved path has no button to click ─────────────────────────

const NEEDS_SWITCH = "Run approved tools";

describe("an approved card is honest about the switch it still needs", () => {
  it("says so when an auto-approved update arrives with run_tool off", async () => {
    const host = await mount({ autoApproved: true });
    expect(host.textContent).toContain("Approved");
    expect(host.textContent).toContain(NEEDS_SWITCH);
    expect(host.textContent).toContain("Tool Foundry");
    // No Approve button will ever be pressed here, so the card is the only
    // place this can be said.
    expect(buttonLabelled(host, "Approve")).toBeFalsy();
  });

  it("stays quiet when the switch is on", async () => {
    h.perms = { [RUN_TOOL]: true };
    const host = await mount({ autoApproved: true });
    expect(host.textContent).not.toContain(NEEDS_SWITCH);
  });

  it("stays quiet before settings load, rather than guessing", async () => {
    // First paint reads `defaults`, where every permission is absent. Claiming
    // a switch is off there would be a coin flip shown as a fact.
    h.settingsLoaded = false;
    const host = await mount({ autoApproved: true });
    expect(host.textContent).not.toContain(NEEDS_SWITCH);
  });

  it("disappears the moment the grant lands", async () => {
    const host = await mount();
    h.setChatToolPermission.mockImplementation((tool: string, allowed: boolean) => {
      h.perms = { ...h.perms, [tool]: allowed };
    });
    await clickApprove(host);
    // The manual path grants the switch in the same commit that flips the
    // card to Approved, so the notice must never flash on a card that just
    // turned the switch on itself.
    expect(host.textContent).toContain("Approved");
    expect(host.textContent).not.toContain(NEEDS_SWITCH);
  });

  it("still says so when the grant threw", async () => {
    h.setChatToolPermission.mockImplementation(() => {
      throw new Error("settings store is offline");
    });
    const host = await mount();
    await clickApprove(host);
    expect(host.textContent).toContain(NEEDS_SWITCH);
  });
});

// ── copy invariant ────────────────────────────────────────────────────────

describe("copy invariant: no safety or blame vocabulary", () => {
  // Same word list and same reason as toolAvailability.test.ts. Standard
  // safety framing raised unfaithful refusals 15.6x, and the register that
  // suppresses tool use is the register that reads as blame. The user just
  // said yes; nothing on this path should sound like a stop.
  const FORBIDDEN = [
    "not permitted", "not allowed", "for safety", "unsafe", "blocked", "block ",
    "denied", "deny", "forbidden", "prohibited", "disallowed", "unauthorized",
    "restricted", "violation", "security", "harmful", "dangerous", "abuse",
    "you cannot", "you can't", "you may not", "you must not", "misuse",
  ];

  const assertClean = (line: string, where: string) => {
    const lower = line.toLowerCase();
    for (const word of FORBIDDEN) {
      expect(lower.includes(word), `"${word}" appears in ${where}: ${line}`).toBe(false);
    }
  };

  it("holds for every toast this card can raise and every state it can render", async () => {
    const scenarios: Array<() => void> = [
      () => { /* run_tool off, clean grant */ },
      () => { h.perms = { [RUN_TOOL]: true }; },
      () => { h.settingsLoaded = false; },
      () => { h.setChatToolPermission.mockImplementation(() => { throw new Error("offline"); }); },
    ];
    for (const setup of scenarios) {
      h.perms = {};
      h.settingsLoaded = true;
      h.setChatToolPermission.mockClear().mockImplementation(() => {});
      h.success.mockClear();
      setup();

      const host = await mount();
      await clickApprove(host);
      for (const [msg] of h.success.mock.calls) assertClean(msg, "a toast");
      assertClean(host.textContent || "", "the card");
    }
  });

  it("holds for the auto-approved notice", async () => {
    const host = await mount({ autoApproved: true });
    assertClean(host.textContent || "", "the auto-approved card");
    expect(host.textContent).toContain(NEEDS_SWITCH);
  });
});
