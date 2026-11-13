// Scriptorium theme — the horarium behind the whole theme. Pure functions, no
// network, no location: everything is read off the device clock.
//
// A monastery kept time by the sun, not by a clock. The day from sunrise to
// sunset was cut into twelve "temporal" hours, long in summer and short in
// winter, and the offices were sung at fixed ones: Prime at the first, Terce
// at the third, Sext at the sixth (noon), None at the ninth, Vespers as the
// lamps were lit, Compline at nightfall, Matins in the small hours and Lauds
// at first light. The scriptorium worked by that light, and so does this
// theme:
//
//  - WHICH FACE. The theme has two — vellum by daylight, the same room by
//    candle. The candle is lit a quarter of an hour after sunset and snuffed a
//    quarter of an hour before sunrise. It is a switch, never a blend: a page
//    half-way between ink-on-vellum and vellum-on-dark is grey on grey.
//  - THE GOLDEN HOUR. What does blend is the daylight itself: for the last
//    stretch before the candle and the first after it, the sun is low and the
//    light through the window goes amber (`golden`, 0..1).
//  - THE WINDOW. Sunlight falls across the page from a lancet window and
//    crosses it during the day (`sun`, 0 at sunrise … 1 at sunset).
//  - THE VINE. The app bar's border vine grows from midnight to midnight
//    (`dayFrac`) and sets a gilded bud at each office as it passes.
//  - THE MOON. Its real phase, from the synodic month.
//  - THE CANDLE. Lit at dusk, it burns down until dawn (`candle`, 1 → 0).
//
// Day length is the same mid-latitude model the Aurora theme uses, so the two
// agree about when the sun sets.
import { dayLength, dayOfYear, type Hemisphere } from "./auroraSky";

export type Face = "day" | "night";

export interface Office {
  id: "matins" | "lauds" | "prime" | "terce" | "sext" | "none" | "vespers" | "compline";
  name: string;
  /** What the office marks, for the tooltip-sized line in the theme menu. */
  gloss: string;
  /** Clock hour (0..24) at which it begins today. */
  at: number;
}

export interface HoursState {
  face: Face;
  /** 0 in full daylight or full night … 1 with the sun on the horizon. */
  golden: number;
  /** 0 at midnight … 1 at the next midnight: how far the vine has grown. */
  dayFrac: number;
  /** 0 at sunrise … 1 at sunset; outside 0..1 the sun is down. */
  sun: number;
  /** Height of the sun (by day) or moon (by night) on its arc, 0..1. */
  altitude: number;
  /** The office being kept now. */
  office: Office;
  /** All eight for today, in clock order, for the bar's hour marks. */
  offices: Office[];
  /** 0 new … 0.5 full … 1 new again. */
  moon: number;
  /** 1 when the candle is lit at dusk … 0 as it gutters at dawn; 1 by day. */
  candle: number;
  sunrise: number;
  sunset: number;
}

/** Local solar noon on the clock — half past twelve splits the DST difference. */
const SOLAR_NOON = 12.5;
/** The candle is lit this long after sunset and snuffed this long before sunrise. */
export const CANDLE_MARGIN = 0.25;
/** How long before (after) the candle the light is amber, in hours. */
export const GOLDEN_SPAN = 1.6;

export type RGB = [number, number, number];

/**
 * The room's light, as laid over the app by ScriptoriumAmbient — colour and
 * PEAK alpha of each layer, mirrored in styles/themes/scriptorium.css.
 *
 * These are not taste. The light lies over the text, so every one of them
 * takes contrast away from it, and each is set at the most it can be while
 * the theme's faintest ink (muted-foreground) still clears WCAG AA under it:
 * faded ink inside the brightest window pane at the amber end of the day,
 * and by night at the far edge of the candle's dark. src/test/scriptorium
 * .test.ts composites them and checks, and checks the CSS still agrees.
 */
export const LIGHT = {
  /** Sun through the window: its colour at noon, at the golden hour, and its alpha. */
  window: { rgb: [255, 238, 176] as RGB, golden: [255, 205, 120] as RGB, alpha: 0.13 },
  /** The shade everywhere the window's light is not. */
  shade: { rgb: [86, 58, 22] as RGB, alpha: 0.07 },
  /** The amber wash over the whole room at --scr-golden = 1 (its stronger end). */
  goldenWash: { rgb: [255, 150, 50] as RGB, alpha: 0.08 },
  /** The dark beyond the candle, at its deepest. */
  candleDark: { rgb: [8, 5, 2] as RGB, alpha: 0.3 },
  /** The candle's own glow, at its centre. */
  candleGlow: { rgb: [255, 196, 104] as RGB, alpha: 0.2 },
} as const;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const SYNODIC_MONTH = 29.530588853;
/** A known new moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);

/** 0 new … 0.5 full … 1 new again. */
export function moonPhase(at: Date): number {
  const days = (at.getTime() - NEW_MOON_EPOCH) / 86_400_000;
  return ((days / SYNODIC_MONTH) % 1 + 1) % 1;
}

/** Today's eight offices on the clock, from today's sunrise and sunset. */
export function officesFor(sunrise: number, sunset: number): Office[] {
  const hour = (sunset - sunrise) / 12; // one temporal hour of daylight
  return [
    { id: "matins", name: "Matins", gloss: "the night office", at: 0 },
    { id: "lauds", name: "Lauds", gloss: "first light", at: sunrise - 1 },
    { id: "prime", name: "Prime", gloss: "the first hour", at: sunrise },
    { id: "terce", name: "Terce", gloss: "the third hour", at: sunrise + 3 * hour },
    { id: "sext", name: "Sext", gloss: "the sixth hour — noon", at: sunrise + 6 * hour },
    { id: "none", name: "None", gloss: "the ninth hour", at: sunrise + 9 * hour },
    { id: "vespers", name: "Vespers", gloss: "the lighting of the lamps", at: sunset - 0.75 },
    { id: "compline", name: "Compline", gloss: "nightfall, the day's last office", at: sunset + 1.5 },
  ];
}

export function hoursAt(now: Date, hemisphere: Hemisphere = "north"): HoursState {
  const h = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const length = dayLength(dayOfYear(now), hemisphere);
  const sunrise = SOLAR_NOON - length / 2;
  const sunset = SOLAR_NOON + length / 2;
  const lit = sunset + CANDLE_MARGIN;
  const snuffed = sunrise - CANDLE_MARGIN;

  const face: Face = h >= snuffed && h < lit ? "day" : "night";

  // Amber at both ends of the day, measured from the moment the face changes
  // so the wash is at its deepest exactly when the candle takes over.
  const golden = face === "day"
    ? Math.max(1 - smoothstep(snuffed, snuffed + GOLDEN_SPAN, h), smoothstep(lit - GOLDEN_SPAN, lit, h))
    : 0;

  const sun = (h - sunrise) / (sunset - sunrise);
  // The moon's arc runs from sunset to sunrise across midnight.
  const nightLength = 24 - (sunset - sunrise);
  const intoNight = h >= sunset ? h - sunset : h + 24 - sunset;
  const moonArc = clamp(intoNight / nightLength);
  const altitude = Math.sin(Math.PI * (face === "day" ? clamp(sun) : moonArc));

  const offices = officesFor(sunrise, sunset);
  let office = offices[0];
  for (const o of offices) if (h >= o.at) office = o;

  const candleSpan = 24 - (lit - snuffed);
  const sinceLit = h >= lit ? h - lit : h + 24 - lit;
  const candle = face === "night" ? 1 - clamp(sinceLit / candleSpan) : 1;

  return {
    face, golden, dayFrac: h / 24, sun, altitude, office, offices,
    moon: moonPhase(now), candle, sunrise, sunset,
  };
}

/**
 * A pinned preview instant: `?hours=day|dusk|vespers|night|matins|HH:MM|<ISO>`.
 * Mirrors the Aurora theme's `?auroraSky=`; null means "use the real clock".
 */
export function overrideHours(param: string | null, now = new Date()): Date | null {
  if (!param) return null;
  const at = (hours: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setMinutes(Math.round(hours * 60));
    return d;
  };
  const length = dayLength(dayOfYear(now));
  const sunset = SOLAR_NOON + length / 2;
  if (param === "day") return at(11);
  if (param === "dusk") return at(sunset - 0.2);
  if (param === "vespers") return at(sunset - 0.6);
  if (param === "night") return at(21.5);
  if (param === "matins") return at(2.5);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(param);
  if (clock) return at(Number(clock[1]) + Number(clock[2]) / 60);
  const t = Date.parse(param);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The instant the theme should be drawn for: a pinned preview, or now. */
export function hoursNow(): Date {
  if (typeof location === "undefined") return new Date();
  // The app routes on the hash, so a preview parameter can sit on either side.
  const q = new URLSearchParams(location.search);
  const hashQuery = location.hash.includes("?") ? new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1)) : null;
  return overrideHours(q.get("hours") ?? hashQuery?.get("hours") ?? null) ?? new Date();
}
