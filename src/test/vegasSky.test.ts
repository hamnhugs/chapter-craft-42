import { describe, expect, it } from "vitest";
import {
  contrast, INK, mix, overrideClock, skyClock, skyColor, skyPaint, sunTimes, vegasDate,
  type RGB, type SkyClock,
} from "@/lib/vegasSky";

// Reference times from api.sunrise-sunset.org for 36.1699, -115.1398.
const MIN = 60_000;
const near = (actual: number, iso: string, minutes = 3) =>
  expect(Math.abs(actual - Date.parse(iso)) / MIN).toBeLessThan(minutes);

describe("sunTimes", () => {
  it("summer solstice 2026", () => {
    const t = sunTimes(2026, 6, 21);
    near(t.sunrise, "2026-06-21T12:23:43Z"); // 05:23 PDT
    near(t.sunset, "2026-06-22T03:01:11Z"); // 20:01 PDT
    near(t.noon, "2026-06-21T19:42:27Z");
  });
  it("winter solstice 2026", () => {
    const t = sunTimes(2026, 12, 21);
    near(t.sunrise, "2026-12-21T14:47:50Z"); // 06:47 PST
    near(t.sunset, "2026-12-22T00:29:43Z"); // 16:29 PST
  });
});

describe("vegasDate", () => {
  it("uses the Vegas calendar, not UTC", () => {
    // 03:00 UTC on the 22nd is still the evening of the 21st in Vegas.
    expect(vegasDate(Date.parse("2026-06-22T03:00:00Z"))).toEqual({ y: 2026, m: 6, d: 21 });
  });
});

describe("skyClock", () => {
  it("is day at Vegas noon and halfway through", () => {
    const c = skyClock(Date.parse("2026-06-21T19:42:00Z"));
    expect(c.isDay).toBe(true);
    expect(c.frac).toBeGreaterThan(0.45);
    expect(c.frac).toBeLessThan(0.55);
  });
  it("is night at Vegas midnight", () => {
    const c = skyClock(Date.parse("2026-12-21T08:00:00Z")); // 00:00 PST
    expect(c.isDay).toBe(false);
    expect(c.frac).toBeGreaterThan(0.3);
    expect(c.frac).toBeLessThan(0.7);
  });
  it("is early night just after sunset, late night just before sunrise", () => {
    expect(skyClock(Date.parse("2026-12-22T00:40:00Z")).frac).toBeLessThan(0.05);
    const pre = skyClock(Date.parse("2026-12-21T14:30:00Z"));
    expect(pre.isDay).toBe(false);
    expect(pre.frac).toBeGreaterThan(0.95);
  });
});

describe("skyColor (vegas.py sky())", () => {
  const noon: SkyClock = { frac: 0.5, isDay: true };
  it("clear noon is the keyboard's day blues", () => {
    expect(skyColor(noon, { cloud: 0, code: 0 }, 0)).toEqual([0, 70, 255]);
    expect(skyColor(noon, { cloud: 0, code: 0 }, 1)).toEqual([60, 160, 255]);
  });
  it("sunset is purple over orange", () => {
    const s: SkyClock = { frac: 1, isDay: true };
    expect(skyColor(s, { cloud: 0, code: 0 }, 0)).toEqual([90, 20, 120]);
    expect(skyColor(s, { cloud: 0, code: 0 }, 1)).toEqual([255, 90, 20]);
  });
  it("overcast greys the sky", () => {
    const c = skyColor(noon, { cloud: 100, code: 3 }, 0);
    expect(c).toEqual(mix([0, 70, 255], [95, 100, 115], 0.85));
  });
});

describe("skyPaint", () => {
  const clocks: SkyClock[] = [
    { frac: 0.5, isDay: true }, { frac: 0.02, isDay: true }, { frac: 0.98, isDay: true },
    { frac: 0.01, isDay: false }, { frac: 0.5, isDay: false },
  ];
  const parse = (s: string): RGB => s.match(/\d+/g)!.slice(0, 3).map(Number) as RGB;

  it("gold and white header text hold 4.5:1 on every stop, every hour, any weather", () => {
    const gold: RGB = [255, 201, 77];
    const white: RGB = [244, 240, 255];
    for (const c of clocks) {
      for (const w of [{ cloud: 0, code: 0 }, { cloud: 100, code: 3 }, { cloud: 80, code: 61 }]) {
        const p = skyPaint(c, w);
        for (const stop of [p.top, p.mid, p.horizon]) {
          expect(contrast(gold, parse(stop))).toBeGreaterThanOrEqual(4.5);
          expect(contrast(white, parse(stop))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
  it("stars only on clear nights", () => {
    expect(skyPaint({ frac: 0.5, isDay: true }).night).toBe(0);
    expect(skyPaint({ frac: 0.5, isDay: false }).night).toBe(1);
    expect(skyPaint({ frac: 0.5, isDay: false }, { cloud: 100, code: 3 }).night).toBe(0);
  });
  it("the body arcs: low at the edges, high at the middle", () => {
    expect(skyPaint({ frac: 0, isDay: true }).bodyY).toBeCloseTo(1);
    expect(skyPaint({ frac: 0.5, isDay: true }).bodyY).toBeCloseTo(0);
  });
  it("glows only around twilight", () => {
    expect(skyPaint({ frac: 0.5, isDay: true }).glow).toBe("transparent");
    expect(skyPaint({ frac: 0.99, isDay: true }).glow).not.toBe("transparent");
  });
  it("is laid over the theme ink", () => {
    expect(parse(skyPaint({ frac: 0.5, isDay: false }).top)[2]).toBeLessThan(40);
    expect(INK).toEqual([7, 6, 26]);
  });
});

describe("overrideClock", () => {
  it("accepts names and ISO times, ignores junk", () => {
    expect(overrideClock("dusk")).toEqual({ frac: 0.96, isDay: true });
    expect(overrideClock("2026-06-21T19:42:00Z")).toBe(Date.parse("2026-06-21T19:42:00Z"));
    expect(overrideClock("nonsense")).toBeNull();
    expect(overrideClock(null)).toBeNull();
  });
});
