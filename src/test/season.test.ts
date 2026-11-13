/**
 * The seasonal model is the input to everything the Showcase and the seasonal
 * theme layer do, so its two claims have to hold:
 *
 *  1. It is astronomy, not a calendar lookup. The first version divided the
 *     year into four equal quarters, which put the March equinox two days
 *     late — Earth's orbit is an ellipse and the seasons are genuinely unequal
 *     lengths. That error was invisible in a gradient and wrong in the header,
 *     which prints a countdown in days. These tests check the model against
 *     published equinox and solstice instants.
 *
 *  2. `growth` is the thing that separates March from September. Both sit at
 *     the same tilt and the same day length; only the direction differs. It is
 *     the sign of the ambient drift, so if it were ever wrong the library
 *     would grow in autumn and shed in spring.
 */
import { describe, it, expect } from "vitest";
import {
  daysUntilLongitude, describeSeason, detectHemisphere, hemisphereFromProbe,
  seasonAt, solarLongitude, solarYearAngle,
} from "@/lib/season";

/** Published turning points (UTC). Source: US Naval Observatory tables. */
const TURNING_POINTS: [string, string, number][] = [
  ["2026 March equinox",    "2026-03-20T14:46:00Z",   0],
  ["2026 June solstice",    "2026-06-21T08:25:00Z",  90],
  ["2026 September equinox","2026-09-23T00:06:00Z", 180],
  ["2026 December solstice","2026-12-21T20:50:00Z", 270],
  ["2027 March equinox",    "2027-03-20T20:25:00Z",   0],
  ["2030 December solstice","2030-12-21T20:09:00Z", 270],
  ["2000 June solstice",    "2000-06-21T01:48:00Z",  90],
];

describe("solar longitude", () => {
  it("hits the published equinoxes and solstices within half a degree-hour", () => {
    for (const [name, iso, expected] of TURNING_POINTS) {
      const got = solarLongitude(new Date(iso));
      const errDegrees = ((got - expected + 540) % 360) - 180;
      const errMinutes = Math.abs(errDegrees / 0.9856) * 24 * 60;
      expect(errMinutes, `${name} off by ${errMinutes.toFixed(0)} minutes`).toBeLessThan(20);
    }
  });

  it("advances monotonically through a year", () => {
    let prev = solarLongitude(new Date("2026-01-01T00:00:00Z"));
    let wraps = 0;
    for (let d = 1; d < 365; d++) {
      const now = solarLongitude(new Date(Date.UTC(2026, 0, 1 + d)));
      if (now < prev) wraps++;
      prev = now;
    }
    expect(wraps).toBe(1); // exactly one pass through 360 -> 0
  });

  it("does not drift the way the equal-quarters model did", () => {
    // The rejected model placed the March equinox ~2 days late. Anything that
    // reintroduces a constant-rate assumption will fail this.
    const days = daysUntilLongitude(new Date("2026-03-18T12:00:00Z"), 0);
    expect(days).toBeGreaterThan(1.5);
    expect(days).toBeLessThan(2.6);
  });
});

describe("the two projections", () => {
  const at = (iso: string) => seasonAt(new Date(iso));

  it("puts maximum daylight at the June solstice and minimum at December", () => {
    expect(at("2026-06-21T08:25:00Z").light).toBeCloseTo(1, 2);
    expect(at("2026-12-21T20:50:00Z").light).toBeCloseTo(-1, 2);
  });

  it("separates March from September, which daylight alone cannot", () => {
    const march = at("2026-03-20T14:46:00Z");
    const september = at("2026-09-23T00:06:00Z");
    // Same tilt, same day length — indistinguishable by `light` alone.
    expect(Math.abs(march.light - september.light)).toBeLessThan(0.02);
    // Opposite direction, which is the whole point.
    expect(march.growth).toBeGreaterThan(0.99);
    expect(september.growth).toBeLessThan(-0.99);
  });

  it("holds the year almost still at the solstices", () => {
    expect(Math.abs(at("2026-06-21T08:25:00Z").growth)).toBeLessThan(0.02);
    expect(Math.abs(at("2026-12-21T20:50:00Z").growth)).toBeLessThan(0.02);
  });

  it("lags warmth behind daylight, so late July beats the solstice", () => {
    const solstice = at("2026-06-21T08:25:00Z");
    const lateJuly = at("2026-07-26T12:00:00Z");
    expect(lateJuly.warmth).toBeGreaterThan(solstice.warmth);
    // And the coldest point is late January, not the December solstice.
    expect(at("2026-01-28T12:00:00Z").warmth).toBeLessThan(at("2026-12-21T20:50:00Z").warmth);
  });

  it("keeps every projection inside [-1, 1] all year", () => {
    for (let d = 0; d < 366; d++) {
      const s = seasonAt(new Date(Date.UTC(2026, 0, 1 + d)));
      for (const v of [s.light, s.growth, s.warmth]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1.0000001);
      }
    }
  });
});

describe("named seasons", () => {
  it("names the arc between each turning point", () => {
    expect(seasonAt(new Date("2026-01-15T12:00:00Z")).season).toBe("winter");
    expect(seasonAt(new Date("2026-04-15T12:00:00Z")).season).toBe("spring");
    expect(seasonAt(new Date("2026-07-15T12:00:00Z")).season).toBe("summer");
    expect(seasonAt(new Date("2026-10-15T12:00:00Z")).season).toBe("autumn");
  });

  it("counts down to the real next turning point", () => {
    const s = seasonAt(new Date("2026-09-22T00:06:00Z"));
    expect(s.nextTurn.name).toBe("autumn");
    expect(s.nextTurn.days).toBeGreaterThan(0.9);
    expect(s.nextTurn.days).toBeLessThan(1.1);
    expect(describeSeason(s)).toContain("autumn begins tomorrow");
  });

  it("never reports a countdown longer than the longest season", () => {
    for (let d = 0; d < 366; d++) {
      const s = seasonAt(new Date(Date.UTC(2026, 0, 1 + d)));
      expect(s.nextTurn.days).toBeGreaterThanOrEqual(0);
      expect(s.nextTurn.days).toBeLessThan(94);
    }
  });
});

describe("hemisphere", () => {
  it("reads daylight saving as a direct season signal", () => {
    // London: standard in January (0), BST in July (-60).
    expect(hemisphereFromProbe({ januaryOffset: 0, julyOffset: -60 })).toBe("north");
    // Sydney: AEDT in January (-660), AEST in July (-600).
    expect(hemisphereFromProbe({ januaryOffset: -660, julyOffset: -600 })).toBe("south");
  });

  it("falls back to the zone table where there is no daylight saving", () => {
    expect(hemisphereFromProbe({ januaryOffset: 180, julyOffset: 180, timeZone: "America/Sao_Paulo" })).toBe("south");
    expect(hemisphereFromProbe({ januaryOffset: -120, julyOffset: -120, timeZone: "Africa/Johannesburg" })).toBe("south");
    expect(hemisphereFromProbe({ januaryOffset: -330, julyOffset: -330, timeZone: "Asia/Kolkata" })).toBe("north");
  });

  it("guesses north when there is genuinely no signal at all", () => {
    expect(hemisphereFromProbe({ januaryOffset: 0, julyOffset: 0 })).toBe("north");
  });

  it("detects something valid from the live environment", () => {
    expect(["north", "south"]).toContain(detectHemisphere());
  });

  it("puts the two halves of the planet half a year apart", () => {
    const iso = "2026-09-19T12:00:00Z";
    const n = seasonAt(new Date(iso), "north");
    const s = seasonAt(new Date(iso), "south");
    expect(n.season).toBe("summer");
    expect(s.season).toBe("winter");
    expect(n.light).toBeCloseTo(-s.light, 6);
    // And southern spring grows while northern autumn sheds.
    expect(n.growth).toBeLessThan(0);
    expect(s.growth).toBeGreaterThan(0);
  });

  it("turns the season at the same instant for both hemispheres", () => {
    // Sampled three hours either side of the published equinox rather than at
    // it: the model is good to about 11 minutes, so the instant itself is
    // inside its own error bar and asserting on it would be asserting on noise.
    const equinox = new Date("2026-09-23T00:06:00Z").getTime();
    const before = new Date(equinox - 3 * 3600_000);
    const after = new Date(equinox + 3 * 3600_000);
    expect(seasonAt(before, "north").season).toBe("summer");
    expect(seasonAt(after, "north").season).toBe("autumn");
    expect(seasonAt(before, "south").season).toBe("winter");
    expect(seasonAt(after, "south").season).toBe("spring");
  });
});

describe("solarYearAngle", () => {
  /** Distance between two angles on the circle, so 2pi-epsilon reads as ~0. */
  const arc = (a: number, b: number) =>
    Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

  it("is zero at the December solstice and pi at the June one", () => {
    expect(arc(solarYearAngle(new Date("2026-12-21T20:50:00Z")), 0)).toBeLessThan(0.005);
    expect(arc(solarYearAngle(new Date("2026-06-21T08:25:00Z")), Math.PI)).toBeLessThan(0.005);
  });
});
