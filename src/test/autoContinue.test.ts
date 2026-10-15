import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_EVERY,
  AUTO_CONTINUE_MAX,
  AUTO_CONTINUE_MAX_LIMIT,
  clampCompactEvery,
  clampRuns,
  loopCompactionInstructions,
  shouldCompact,
  AUTO_CONTINUE_STALL_LIMIT,
  continuationMessage,
  decideNext,
  initialAutoLoopState,
  parseTaskStatus,
  stripTaskStatus,
  type AutoLoopState,
} from "@/lib/autoContinue";

const turn = (text: string, toolCalls = 0, aborted = false) => ({ text, toolCalls, aborted });

describe("parseTaskStatus", () => {
  it("reads the last-line status in any common markdown dress", () => {
    expect(parseTaskStatus("Done the thing.\nSTATUS: DONE")).toBe("done");
    expect(parseTaskStatus("x\n**STATUS: CONTINUE**")).toBe("continue");
    expect(parseTaskStatus("x\n`STATUS: NEEDS_USER` — need prices\n")).toBe("needs_user");
    expect(parseTaskStatus("x\nstatus: done")).toBe("done");
  });
  it("ignores a status that is not on the last line", () => {
    expect(parseTaskStatus("STATUS: DONE\nbut actually more text")).toBeNull();
    expect(parseTaskStatus("no status here")).toBeNull();
  });
  it("strips only the trailing status line", () => {
    expect(stripTaskStatus("Body text.\n\nSTATUS: CONTINUE")).toBe("Body text.");
    expect(stripTaskStatus("Body text.")).toBe("Body text.");
  });
});

describe("decideNext", () => {
  const s0 = initialAutoLoopState(3);

  it("stops on a plain answer marked done", () => {
    expect(decideNext(s0, turn("Hi!\nSTATUS: DONE"))).toEqual({ action: "stop", reason: "done" });
  });

  it("stops when the user is needed or pressed Stop", () => {
    expect(decideNext(s0, turn("Need prices.\nSTATUS: NEEDS_USER", 4))).toMatchObject({ reason: "needs_user" });
    expect(decideNext(s0, turn("STATUS: CONTINUE", 4, true))).toMatchObject({ reason: "aborted" });
  });

  it("continues while work remains", () => {
    const d = decideNext(s0, turn("Did part 1.\nSTATUS: CONTINUE", 5));
    expect(d).toMatchObject({ action: "continue", kind: "continue" });
  });

  it("spends exactly one verification turn on a DONE claim after tool work", () => {
    const d1 = decideNext(s0, turn("All aligned.\nSTATUS: DONE", 5));
    expect(d1).toMatchObject({ action: "continue", kind: "verify" });
    const s1 = (d1 as { state: AutoLoopState }).state;
    expect(decideNext(s1, turn("Checked with inspect_document.\nSTATUS: DONE", 1))).toMatchObject({ reason: "done" });
  });

  it("keeps going when a missing status follows tool work, stops when nothing happened", () => {
    expect(decideNext(s0, turn("Working…", 3))).toMatchObject({ action: "continue" });
    expect(decideNext(s0, turn("Sure, here you go."))).toMatchObject({ reason: "no_status" });
  });

  it("stops at the continuation limit", () => {
    const full: AutoLoopState = { ...s0, continuations: 3 };
    expect(decideNext(full, turn("STATUS: CONTINUE", 2))).toMatchObject({ reason: "limit" });
  });

  it("stops after consecutive tool-less continuation turns", () => {
    let s: AutoLoopState = { ...s0, max: 10, continuations: 1 };
    for (let i = 0; i < AUTO_CONTINUE_STALL_LIMIT - 1; i++) {
      const d = decideNext(s, turn("Thinking.\nSTATUS: CONTINUE"));
      expect(d.action).toBe("continue");
      s = (d as { state: AutoLoopState }).state;
    }
    expect(decideNext(s, turn("Thinking.\nSTATUS: CONTINUE"))).toMatchObject({ reason: "stalled" });
  });
});

describe("continuationMessage", () => {
  it("restates the original request so the goal survives summarisation", () => {
    const m = continuationMessage("Align both pages\nthen preview", "continue", 2, 8);
    expect(m).toContain("↻ Auto-continue 2/8.");
    expect(m).toContain("> Align both pages\n> then preview");
  });
  it("truncates a very long goal", () => {
    expect(continuationMessage("x".repeat(2000), "verify", 1, 8).length).toBeLessThan(1100);
  });
});

describe("user-set runs and compaction", () => {
  it("clamps run counts to 1..limit and falls back on junk", () => {
    expect(clampRuns("12")).toBe(12);
    expect(clampRuns(0)).toBe(1);
    expect(clampRuns(999)).toBe(AUTO_CONTINUE_MAX_LIMIT);
    expect(clampRuns(undefined)).toBe(AUTO_CONTINUE_MAX);
    expect(clampRuns("abc")).toBe(AUTO_CONTINUE_MAX);
  });

  it("clamps the compaction interval, 0 meaning off", () => {
    expect(clampCompactEvery("0")).toBe(0);
    expect(clampCompactEvery(-3)).toBe(0);
    expect(clampCompactEvery(undefined)).toBe(AUTO_COMPACT_EVERY);
  });

  it("compacts after every N completed runs, never before the first", () => {
    const hits = [0, 1, 2, 3, 4, 5, 6, 7].filter((n) => shouldCompact(n, 3));
    expect(hits).toEqual([3, 6]);
    expect(shouldCompact(4, 0)).toBe(false);
  });

  it("a user-set max is the loop's limit", () => {
    let s = initialAutoLoopState(clampRuns(2));
    const work = { text: "step\nSTATUS: CONTINUE", toolCalls: 1, aborted: false };
    for (const _ of [1, 2]) {
      const d = decideNext(s, work);
      expect(d.action).toBe("continue");
      if (d.action === "continue") s = d.state;
    }
    expect(decideNext(s, work)).toEqual({ action: "stop", reason: "limit" });
  });

  it("the compaction summary keeps the user's rules in their own verbatim section", () => {
    const p = loopCompactionInstructions();
    expect(p).toMatch(/USER RULES[^\n]*word for word/);
    for (const h of ["GOAL", "DONE", "STILL TO DO", "FACTS"]) expect(p).toContain(h);
  });
});
