import { describe, it, expect } from "vitest";
import { buildProgramCard } from "@/lib/toolshed";

/**
 * A program card is a retrieval-shaped neuron with the source riding underneath
 * as an inert payload — the same contract as a tool card, plus the rules a VPS
 * program adds: the verdict is a SMOKE TEST (never "verified safe"), the card
 * leads with the tool-vs-program routing axis, and it flags a secrets+egress
 * exfil combination. The formatting rules that keep it whole through the prompt
 * sanitizer are the same: no markdown headings, no <<<…>>>, and a source fence
 * that out-lengths any backtick run the program itself contains.
 */

const base = {
  name: "sync_hermes_feed",
  description: "Pulls the latest Hermes feed and normalises it to JSON.",
  version: 2,
  language: "python",
  network: "allowlist" as const,
  allowedHosts: ["api.hermes.example"],
  secrets: ["HERMES_TOKEN"],
  code: "import os, json\nprint(json.dumps({'ok': True}))\n",
  verdict: "passed" as const,
  health: { runCount: 3, failCount: 0, lastRunAt: "2026-08-24T10:00:00Z" },
};

describe("buildProgramCard", () => {
  it("titles by name and leads with the findable fields in the ablated order", () => {
    const { title, content } = buildProgramCard(base);
    expect(title).toBe("Program: sync_hermes_feed");
    const iWhat = content.indexOf("What it does:");
    const iWhen = content.indexOf("When to reach for it:");
    const iSig = content.indexOf("Signature:");
    const iRuntime = content.indexOf("Runtime:");
    const iVerify = content.indexOf("Verification:");
    const iLimit = content.indexOf("Limitations:");
    const iSource = content.indexOf("source below:");
    // Ordered, and every findable field above the source payload.
    expect(iWhat).toBeGreaterThanOrEqual(0);
    expect(iWhat).toBeLessThan(iWhen);
    expect(iWhen).toBeLessThan(iSig);
    expect(iSig).toBeLessThan(iRuntime);
    expect(iRuntime).toBeLessThan(iVerify);
    expect(iVerify).toBeLessThan(iLimit);
    expect(iLimit).toBeLessThan(iSource);
  });

  it("carries the routing axis and the exact callable signature", () => {
    const { content } = buildProgramCard(base);
    expect(content).toContain("run_program(\"sync_hermes_feed\", args)");
    expect(content).toContain("a program, run on the user's own VPS, not a browser tool");
  });

  it("renders the verdict as a SMOKE TEST, never 'verified safe'", () => {
    const passed = buildProgramCard(base).content;
    expect(passed).toContain("smoke test passed");
    expect(passed).not.toContain("verified safe");
    const inconclusive = buildProgramCard({ ...base, verdict: "inconclusive" }).content;
    expect(inconclusive).toContain("inconclusive");
    const unverified = buildProgramCard({ ...base, verdict: null }).content;
    expect(unverified).toContain("not yet verified");
  });

  it("states the declared network and secrets, and flags the exfil combination", () => {
    const { content } = buildProgramCard(base);
    expect(content).toContain("api.hermes.example");
    expect(content).toContain("HERMES_TOKEN");
    // secrets + allowlist ⇒ exfil warning
    expect(content).toContain("could send a secret out");
    // network 'none' + no secrets ⇒ no warning
    const safe = buildProgramCard({ ...base, network: "none", allowedHosts: [], secrets: [] }).content;
    expect(safe).not.toContain("could send a secret out");
    expect(safe).toContain("no network");
    expect(safe).toContain("uses no secrets");
  });

  it("never emits a markdown heading or a fence-marker sequence in the card body", () => {
    const { content } = buildProgramCard(base);
    const card = content.split("──── source below")[0];
    expect(card.split("\n").some((l) => /^#{1,6}\s/.test(l))).toBe(false);
    expect(card).not.toContain("<<<");
  });

  it("out-lengths any backtick run in the source so a program that emits markdown can't break the payload", () => {
    const withTicks = buildProgramCard({ ...base, language: "bash", code: "echo '```````fenced'`" });
    // The opening fence must be longer than the 7-backtick run in the source.
    const fenceMatch = withTicks.content.match(/\n(`{4,})bash\n/);
    expect(fenceMatch, "a dynamic fence must wrap the source").toBeTruthy();
    expect(fenceMatch![1].length).toBeGreaterThan(7);
  });

  it("truncates an over-long source with a pointer, keeping the card above it intact", () => {
    const big = buildProgramCard({ ...base, code: "x".repeat(9000) });
    expect(big.content).toContain("truncated");
    expect(big.content).toContain("What it does:");
    expect(big.content).toContain("Settings → Program Foundry");
  });

  it("says 'not run yet' at forge time and reports a streak once it has run", () => {
    expect(buildProgramCard({ ...base, health: { runCount: 0 } }).content).toContain("not run yet");
    expect(buildProgramCard({ ...base, health: { runCount: 5, failCount: 2 } }).content).toContain("2 failures in a row");
  });
});
