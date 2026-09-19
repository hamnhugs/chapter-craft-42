import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";

// H4: voice quick-search fired a real Burplexity/Tavily call and injected its
// results into the turn while checking ONLY Lean Mode — the user's own "Web
// search" switch in Settings → AI Permissions was never read, so turning it off
// did nothing on this path.
//
// The gate sits inside handleSend, a long async closure over React state, a
// settings store and an upload pipeline; there is no seam to reach it through
// without a full render harness. So it is pinned at the source level, the same
// way chatContextWiring.test.ts pins ChatContext's send path. Each assertion
// below corresponds to a specific shipped bug or a specific near-miss.
const PANEL = readFileSync(resolve(process.cwd(), "src/components/ChatPanel.tsx"), "utf8");

const gateAt = PANEL.indexOf("if (voiceQuickSearch && burplexityApiToken");
/** The `if (...)` head only — the condition, not the body. */
const condition = PANEL.slice(gateAt, PANEL.indexOf(") {", gateAt));

describe("voice quick-search honours the web_search permission", () => {
  it("has exactly one auto-fire site for the background search", () => {
    expect(gateAt).toBeGreaterThan(-1);
    // A second call site is the bug class: a copy that keeps the old condition
    // re-opens the same leak while this test still passes on the first.
    expect(PANEL.match(/runBackgroundSearch\(text\)/g) || []).toHaveLength(1);
  });

  it("reads the live permission state, not just Lean Mode", () => {
    expect(condition).toContain("webSearchSwitchedOn");
    expect(condition).toContain('isToolBlocked(leanMode, "web_search")');
  });

  it("derives that flag DEFAULT-ALLOW: off only on an explicit false", () => {
    // The direction matters more than the check. `=== true` here would switch
    // voice quick-search off for every user who has never opened the
    // permissions screen, which is worse than the leak being fixed.
    // toolAvailability.ts:226 is the convention: `permissions[permId] === false`.
    expect(PANEL).toContain(
      "const webSearchSwitchedOn = chatToolPermissions?.[TOOL_PERMISSION.web_search] !== false;",
    );
    expect(PANEL).not.toContain("chatToolPermissions?.[TOOL_PERMISSION.web_search] === true");
  });

  it("looks the id up in TOOL_PERMISSION rather than hardcoding it", () => {
    // If web_search is ever folded into a grouped permission, this follows the
    // map instead of silently checking an id that no longer exists (and an
    // absent id reads as allowed under default-allow — a silent re-leak).
    expect(TOOL_PERMISSION.web_search).toBe("web_search");
    expect(PANEL).toContain('import { TOOL_PERMISSION } from "@/lib/toolPermissions";');
  });

  it("subscribes the component to the permission state", () => {
    // Read from useChatSettings, so a flip of the switch re-renders and the
    // next send sees the new value. A module-level or ref read would go stale.
    const destructure = PANEL.slice(PANEL.indexOf("} = useChatSettings();") - 900, PANEL.indexOf("} = useChatSettings();"));
    expect(destructure).toContain("chatToolPermissions");
  });

  it("skips silently — no toast, no error, nothing added to model context", () => {
    // Permission explanation lives in ToolStatusPanel. Safety/permission
    // register inside a prompt measurably suppresses legitimate tool use, and
    // a toast here would fire on ordinary messages that merely matched
    // SEARCH_INTENT_RE. The turn just continues without the search.
    const body = PANEL.slice(gateAt, PANEL.indexOf("}", PANEL.indexOf("runBackgroundSearch(text)", gateAt)));
    expect(body).not.toContain("toast.");
    expect(body).not.toMatch(/\belse\b/);
  });
});
