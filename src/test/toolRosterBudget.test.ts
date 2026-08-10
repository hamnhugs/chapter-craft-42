import { describe, it, expect } from "vitest";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";

/**
 * A budget, not a limit — and deliberately a failing test rather than a lint.
 *
 * Tool-selection accuracy is measured to degrade once a roster passes roughly
 * 30-50 tools (Anthropic's tool-search documentation states the threshold
 * outright; RAG-MCP, arXiv:2505.03275, measures selection collapsing as a pool
 * grows past ~100). This app is already past that, which is a genuine second
 * cause of "the AI won't use its tools" — independent of every gate.
 *
 * Deleting tools is NOT the fix: the chance-corrected end-to-end measurement
 * (arXiv:2605.24660) found adaptive shortlisting LOST to a fixed roster,
 * 71.7% against 73.3%, because presentation rate fell faster than selection
 * accuracy rose. And the vendor answer — keeping every tool in the request
 * with deferred loading plus a searchable catalog — is not available on
 * OpenRouter, Gemini or NVIDIA's OpenAI-compatible surfaces.
 *
 * So the honest control is this: growth must be a decision somebody makes on
 * purpose. Adding a tool means editing the number below and accepting that
 * every other tool got slightly harder to select. The two levers that DO work
 * without a provider feature are consolidating sibling tools into one verb and
 * rewriting descriptions — both of which are cheaper to reach for when the
 * build makes the cost visible.
 *
 * Self-built Foundry tools deliberately do NOT count: they are reached through
 * run_tool and never enter the roster, which is why the library can grow
 * without making everything else worse.
 */
const ROSTER_BUDGET = 68; // +1: delete_tool (Foundry tool removal, confirm-gated)

describe("the tool roster stays within its stated budget", () => {
  it(`ships at most ${ROSTER_BUDGET} tools`, () => {
    expect(CHAT_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(ROSTER_BUDGET);
  });

  it("every tool has a name and a description the model can act on", () => {
    for (const def of CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>) {
      const fn = def?.function;
      expect(fn?.name, JSON.stringify(def).slice(0, 80)).toMatch(/^[a-z][a-z0-9_]*$/);
      // Short blurbs are the measured cheap lever on call rate; a stub is a
      // tool the model will not reach for.
      expect(String(fn?.description || "").length, fn?.name).toBeGreaterThan(40);
    }
  });

  it("no two tools share a name", () => {
    const names = (CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>).map((d) => d.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
