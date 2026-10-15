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
  addToLedger,
  continuationMessage,
  decideNext,
  FINISH_TASK_NAME,
  finishTaskOutcome,
  initialAutoLoopState,
  isChangeEvent,
  parseTaskStatus,
  soundsFinished,
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

// Replies DeepSeek wrote in the user's loop on 2026-10-15 (chat_messages).
const REAL_FINISHED_NO_STATUS = "I have completed the new double-sided sales flyer using Ogilvy’s editorial layout, pairing the hero photograph, selling caption, and pain-point reversal bullets on Page 1 with the three service tiers and \"No-Surprise Las Vegas Promise\" on Page 2. Both finished pages were inspected, verified inside safe margins, and exported as high-resolution PNGs to your memory wiki as permanent visual neurons.";
const REAL_MORE_TO_DO = "Visual inspection of Page 2 confirms the single-column layout cleanly presents all three service tiers. Both sides now embody Ogilvy's editorial architecture. On the next turn, I will finalize the project by exporting the finished high-resolution flyer pages, saving the template, and updating your project assets in the workspace.";
const REAL_CHECKED_DONE = "Both pages of the flyer have been exported as PNGs and saved directly into your memory as new visual neurons.\n\nSTATUS: DONE — verified template `yardcleanad1` saved and confirmed PNG memory neurons linked to the flyer anchor card.";

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
    expect(decideNext(s0, turn("Did part 1.\nSTATUS: CONTINUE", 5))).toMatchObject({ action: "continue" });
  });

  it("accepts a DONE after tool work at once — no forced extra check run", () => {
    expect(decideNext(s0, turn(REAL_CHECKED_DONE, 8))).toEqual({ action: "stop", reason: "done" });
  });

  it("finish_task stops the loop whatever the text says", () => {
    expect(decideNext(s0, { ...turn("Working…\nSTATUS: CONTINUE", 6), finish: "done" })).toEqual({ action: "stop", reason: "done" });
    expect(decideNext(s0, { ...turn("Which photo?", 2), finish: "needs_user" })).toEqual({ action: "stop", reason: "needs_user" });
  });

  it("reads a finished reply that left off its status line as done", () => {
    expect(decideNext(s0, turn(REAL_FINISHED_NO_STATUS, 8))).toEqual({ action: "stop", reason: "done" });
    expect(decideNext(s0, turn(REAL_MORE_TO_DO, 8))).toMatchObject({ action: "continue" });
  });

  it("keeps going when a missing status follows tool work, stops when nothing happened", () => {
    const d = decideNext(s0, turn("Working…", 3));
    expect(d).toMatchObject({ action: "continue" });
    expect((d as { state: AutoLoopState }).state.unreported).toBe(true);
    expect(decideNext(s0, turn("Sure, here you go."))).toMatchObject({ reason: "no_status" });
  });

  it("stops at the continuation limit", () => {
    const full: AutoLoopState = { ...s0, continuations: 3 };
    expect(decideNext(full, turn("STATUS: CONTINUE", 2))).toMatchObject({ reason: "limit" });
  });

  it("stops after consecutive continuation runs that changed nothing — looking around counts as nothing", () => {
    let s: AutoLoopState = { ...s0, max: 10, continuations: 1 };
    const lookOnly = { ...turn("Checked again.\nSTATUS: CONTINUE", 2), changes: [] };
    for (let i = 0; i < AUTO_CONTINUE_STALL_LIMIT - 1; i++) {
      const d = decideNext(s, lookOnly);
      expect(d.action).toBe("continue");
      s = (d as { state: AutoLoopState }).state;
    }
    expect(decideNext(s, lookOnly)).toMatchObject({ reason: "stalled" });
  });

  it("carries what each run made into the ledger", () => {
    const d = decideNext(s0, { ...turn("STATUS: CONTINUE", 3), changes: ["Put the body on the DesignCraft back", "Put the body on the DesignCraft back", "Put the headline on the DesignCraft back"] });
    expect((d as { state: AutoLoopState }).state.ledger).toEqual([
      "run 0: Put the body on the DesignCraft back (×2)",
      "run 0: Put the headline on the DesignCraft back",
    ]);
  });
});

describe("soundsFinished", () => {
  it("hears a finish claim only when nothing is said to remain", () => {
    expect(soundsFinished(REAL_FINISHED_NO_STATUS)).toBe(true);
    expect(soundsFinished("The flyer is now complete.")).toBe(true);
    expect(soundsFinished(REAL_MORE_TO_DO)).toBe(false);
    expect(soundsFinished("Page 1 is finished; page 2 is not done yet.")).toBe(false);
    expect(soundsFinished("I placed the headline.")).toBe(false);
  });
});

describe("finish_task", () => {
  it("reports the status and what was checked", () => {
    const o = finishTaskOutcome(JSON.stringify({ status: "done", checked: "previewed both pages" }));
    expect(o.finish).toBe("done");
    expect(o.event).toEqual({ name: FINISH_TASK_NAME, summary: "Finished the task (checked: previewed both pages)", ok: true });
    expect(finishTaskOutcome(JSON.stringify({ status: "needs_user", question: "Which photo?" })).event.summary).toBe("Stopped to ask you: Which photo?");
    expect(finishTaskOutcome("not json").finish).toBe("done");
  });

  it("is not counted as work, and neither is looking", () => {
    expect(isChangeEvent(finishTaskOutcome("{}").event)).toBe(false);
    for (const summary of ["Inspected the DesignCraft document", "Looked at DesignCraft", "Searched DesignCraft commands for \"x\"", "Showed image: \"a\"", "Checked the creative apps"]) {
      expect(isChangeEvent({ name: "craft", summary, ok: true })).toBe(false);
    }
    expect(isChangeEvent({ name: "craft", summary: "Put the body on the DesignCraft back", ok: true })).toBe(true);
    expect(isChangeEvent({ name: "craft", summary: "Put the body on the DesignCraft back", ok: false })).toBe(false);
  });
});

describe("continuationMessage", () => {
  const st = { continuations: 2, max: 8, unreported: false, ledger: [] as string[] };
  it("restates the original request so the goal survives summarisation", () => {
    const m = continuationMessage("Align both pages\nthen preview", st);
    expect(m).toContain("↻ Auto-continue 2/8.");
    expect(m).toContain("> Align both pages\n> then preview");
  });
  it("truncates a very long goal", () => {
    expect(continuationMessage("x".repeat(2000), st).length).toBeLessThan(1100);
  });
  it("lists what earlier runs made, to keep and build on", () => {
    const m = continuationMessage("Make a flyer", { ...st, ledger: addToLedger([], 1, ["Put the headline on the DesignCraft back"]) });
    expect(m).toMatch(/keep it and build on it[^\n]*don't delete it or start over/);
    expect(m).toContain("- run 1: Put the headline on the DesignCraft back");
  });
  it("asks for finish_task when the last reply said nothing about being finished", () => {
    expect(continuationMessage("x", { ...st, unreported: true })).toContain("call finish_task now");
    expect(continuationMessage("x", st)).not.toContain("finish_task");
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
