import { describe, it, expect } from "vitest";
import { createIdBatcher } from "@/lib/idBatcher";

function harness(delayMs = 2000, maxBatch = 3, maxWaitMs?: number) {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const flushed: string[][] = [];
  const b = createIdBatcher({
    delayMs, maxBatch, maxWaitMs,
    onFlush: (ids) => flushed.push(ids),
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
    now: () => t,
  });
  const advance = (ms: number) => {
    t += ms;
    for (const [id, tm] of [...timers]) if (tm.at <= t) { timers.delete(id); tm.fn(); }
  };
  return { b, flushed, advance };
}

describe("createIdBatcher", () => {
  it("coalesces a burst into one flush after the quiet period", () => {
    const { b, flushed, advance } = harness();
    b.add(["a"]);
    advance(1000);
    b.add(["b", "a", "", null, undefined]);
    advance(1999);
    expect(flushed).toEqual([]);
    advance(1);
    expect(flushed).toEqual([["a", "b"]]);
    expect(b.pending()).toEqual([]);
  });

  it("flushes immediately when the batch fills", () => {
    const { b, flushed } = harness(2000, 2);
    b.add(["a", "b", "c"]);
    expect(flushed).toEqual([["a", "b"], ["c"]]);
  });

  it("a steady trickle still flushes by maxWait", () => {
    const { b, flushed, advance } = harness(2000, 100, 5000);
    for (let i = 0; i < 6; i++) { b.add([`id${i}`]); advance(1500); }
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed[0]).toContain("id0");
  });

  it("ignores empty adds and manual flush of an empty queue", () => {
    const { b, flushed } = harness();
    b.add([]);
    b.flush();
    expect(flushed).toEqual([]);
  });
});
