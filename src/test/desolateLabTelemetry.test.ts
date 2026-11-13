import { describe, expect, it } from "vitest";
import {
  SEALED_AT, PAGE_SECONDS, TRACE_H, TRACE_W,
  channelIndex, channels, clock, cycleOf, power, trace, unattended,
} from "@/components/themes/desolateLabTelemetry";

describe("Desolate Lab telemetry", () => {
  it("counts time unattended from the seal date", () => {
    expect(unattended(SEALED_AT)).toBe("0000D 00:00:00");
    expect(unattended(SEALED_AT + (3 * 86400 + 2 * 3600 + 5 * 60 + 9) * 1000)).toBe("0003D 02:05:09");
    expect(unattended(SEALED_AT - 1000)).toBe("0000D 00:00:00");
  });

  it("reads a 24h local clock", () => {
    expect(clock(new Date(2026, 9, 21, 7, 4, 9))).toBe("07:04:09");
  });

  it("follows the day outside", () => {
    expect(cycleOf(3)).toBe("night");
    expect(cycleOf(6)).toBe("dawn");
    expect(cycleOf(12)).toBe("day");
    expect(cycleOf(19)).toBe("evening");
    expect(cycleOf(23)).toBe("night");
    expect(power("night").source).toBe("AUX");
    expect(power("day")).toEqual({ source: "GRID", pct: 100 });
  });

  it("only alarms when the uplink is actually lost", () => {
    const now = new Date(2026, 9, 21, 22, 0, 0);
    expect(channels(now, true).some((c) => c.alarm)).toBe(false);
    const lost = channels(now, false).find((c) => c.key === "uplink")!;
    expect(lost).toMatchObject({ value: "LOST", alarm: true });
  });

  it("pages through every channel on the wall clock", () => {
    const seen = new Set<number>();
    for (let s = 0; s < PAGE_SECONDS * 4; s++) seen.add(channelIndex(s * 1000, 4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(channelIndex(0, 4)).toBe(channelIndex((PAGE_SECONDS - 1) * 1000, 4));
  });

  it("draws the same in-bounds trace on every load", () => {
    const a = trace();
    expect(trace().d).toBe(a.d);
    expect(a.eventX).toBeGreaterThan(0);
    expect(a.eventX).toBeLessThan(TRACE_W);
    const ys = [...a.d.matchAll(/[ML](\d+) ([\d.]+)/g)].map((m) => Number(m[2]));
    expect(ys.length).toBeGreaterThan(100);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ys)).toBeLessThanOrEqual(TRACE_H - 2);
  });
});
