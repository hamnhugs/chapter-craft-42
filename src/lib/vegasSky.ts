// The Las Vegas sky behind Bookworm Studio's app bar.
//
// A port of the G915 keyboard theme (~/Work/g915-lights/themes/vegas.py): the
// sky's colour follows the real time of day in Las Vegas, the sun or moon arcs
// across from left horizon to right, stars come out on clear nights, and cloud
// cover greys everything down. The keyboard gets sunrise/sunset from
// Open-Meteo; here they are computed (NOAA solar equations), so the sky is
// right with no network at all. Live weather is an optional extra on top.
//
// Everything in this file is pure except the weather fetch at the bottom.

export const VEGAS = { lat: 36.1699, lon: -115.1398, tz: "America/Los_Angeles" } as const;

export type RGB = [number, number, number];

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Vegas calendar date (y, m 1-12, d) at an instant. */
export function vegasDate(at: number): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VEGAS.tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * Sunrise and sunset (UTC ms) for a calendar date at a place, by the NOAA
 * spreadsheet equations with the standard -0.833° refraction-corrected
 * horizon. Accurate to about a minute at Vegas's latitude. The date is the
 * LOCAL calendar date; the result instants may fall on the next UTC day.
 */
export function sunTimes(
  y: number, m: number, d: number, lat: number = VEGAS.lat, lon: number = VEGAS.lon,
): { sunrise: number; sunset: number; noon: number } {
  const midnightUtc = Date.UTC(y, m - 1, d);
  // Evaluate the sun at approximate local solar noon for the date.
  const approxNoon = midnightUtc + (12 - lon / 15) * 3_600_000;
  const jd = approxNoon / 86_400_000 + 2440587.5;
  const T = (jd - 2451545) / 36525;

  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T)
    + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const meanObliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));

  const yv = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime = 4 * deg(
    yv * Math.sin(2 * rad(L0))
    - 2 * e * Math.sin(rad(M))
    + 4 * e * yv * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * yv * yv * Math.sin(4 * rad(L0))
    - 1.25 * e * e * Math.sin(2 * rad(M)),
  ); // minutes

  const cosHA = (Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))))
    - Math.tan(rad(lat)) * Math.tan(rad(decl));
  const ha = deg(Math.acos(Math.min(1, Math.max(-1, cosHA))));

  const noonMin = 720 - 4 * lon - eqTime; // minutes after UTC midnight
  const min = 60_000;
  return {
    noon: midnightUtc + noonMin * min,
    sunrise: midnightUtc + (noonMin - 4 * ha) * min,
    sunset: midnightUtc + (noonMin + 4 * ha) * min,
  };
}

export interface SkyClock {
  /** 0..1 through the current day (sunrise→sunset) or night (sunset→sunrise). */
  frac: number;
  isDay: boolean;
}

/** Where in the day or night Vegas is — vegas.py conditions(). */
export function skyClock(at: number): SkyClock {
  const { y, m, d } = vegasDate(at);
  const { sunrise: rs, sunset: ss } = sunTimes(y, m, d);
  if (at >= rs && at <= ss) return { frac: (at - rs) / (ss - rs), isDay: true };
  const nightLen = 86_400_000 - (ss - rs);
  const since = (((at - ss) % 86_400_000) + 86_400_000) % 86_400_000;
  return { frac: Math.min(1, since / nightLen), isDay: false };
}

export const mix = (a: RGB, b: RGB, t: number): RGB => {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

export interface Weather {
  /** 0..100 */
  cloud: number;
  /** WMO weather code */
  code: number;
  tempF?: number;
}

export const CLEAR: Weather = { cloud: 0, code: 0 };

/**
 * The raw sky colour at a height, 0 = top of the bar, 1 = the horizon.
 * Straight from vegas.py sky(): blue days, purple-to-orange dusks, near-black
 * nights with a glow on the horizon around twilight, greyed by cloud.
 */
export function skyColor(clock: SkyClock, w: Weather, horizon: number): RGB {
  const edge = Math.min(clock.frac, 1 - clock.frac);
  let c: RGB;
  if (clock.isDay) {
    const k = Math.min(1, edge / 0.12);
    c = mix(mix([90, 20, 120], [255, 90, 20], horizon), mix([0, 70, 255], [60, 160, 255], horizon), k);
  } else {
    const k = Math.min(1, edge / 0.08);
    c = mix(mix([60, 10, 80], [160, 40, 20], horizon), mix([2, 3, 22], [8, 6, 40], horizon), k);
  }
  let grey: RGB = clock.isDay ? [95, 100, 115] : [14, 14, 20];
  if (w.code >= 51) grey = [grey[0] * 0.6, grey[1] * 0.6, grey[2] * 0.6];
  return mix(c, grey, (w.cloud / 100) * 0.85);
}

/** The theme's night ink (#07061a). Every sky stop is laid over it. */
export const INK: RGB = [7, 6, 26];

/**
 * How much of the raw sky shows through the ink scrim. Low by design: the app
 * bar carries gold and white text and both must hold 4.5:1 on every stop.
 */
export const SKY_STRENGTH = { top: 0.3, horizon: 0.42 };

export interface SkyPaint {
  top: string;
  mid: string;
  horizon: string;
  /** Stars and the Luxor beam: 0 by day, 1 on a clear night. */
  night: number;
  /** Sun/moon visibility, dimmed by cloud. */
  body: number;
  isDay: boolean;
  /** Position of the sun/moon: x 0..1 across the bar, y 0..1 (0 = high). */
  bodyX: number;
  bodyY: number;
  /** Horizon glow colour around sunrise/sunset (rgba string, may be transparent). */
  glow: string;
  cloud: number;
  rain: boolean;
  /** Light catching the top edges of the skyline: the horizon's own colour. */
  rim: string;
}

const css = ([r, g, b]: RGB) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;

/** Everything the component paints, from a clock and the weather. */
export function skyPaint(clock: SkyClock, w: Weather = CLEAR): SkyPaint {
  const at = (h: number, s: number) => mix(INK, skyColor(clock, w, h), s);
  const edge = Math.min(clock.frac, 1 - clock.frac);
  // Twilight: strongest at the moment the sun crosses the horizon.
  const twilight = clock.isDay ? Math.max(0, 1 - edge / 0.12) : Math.max(0, 1 - edge / 0.08);
  const clear = 1 - w.cloud / 100;
  const night = clock.isDay ? 0 : Math.min(1, edge / 0.08) * clear;
  return {
    top: css(at(0, SKY_STRENGTH.top)),
    mid: css(at(0.55, (SKY_STRENGTH.top + SKY_STRENGTH.horizon) / 2)),
    horizon: css(at(1, SKY_STRENGTH.horizon)),
    night,
    body: 1 - (w.cloud / 100) * 0.8,
    isDay: clock.isDay,
    bodyX: clock.frac,
    bodyY: 1 - Math.sin(Math.PI * clock.frac),
    glow: twilight > 0 ? `rgb(255 110 40 / ${(0.32 * twilight * (0.4 + 0.6 * clear)).toFixed(3)})` : "transparent",
    cloud: w.cloud,
    rim: (() => {
      const h = mix(skyColor(clock, w, 1), [255, 255, 255], 0.15);
      return `rgb(${h.map(Math.round).join(" ")} / ${clock.isDay ? 0.55 : 0.4 + 0.3 * twilight})`;
    })(),
    rain: (w.code >= 51 && w.code <= 67) || (w.code >= 80 && w.code <= 82) || w.code >= 95,
  };
}

/** WCAG relative luminance / contrast, for the legibility guarantee. */
export function contrast(a: RGB, b: RGB): number {
  const lum = (c: RGB) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Screenshot/debug override: `?vegasSky=day|dusk|night|dawn|<ISO time>`.
 * Only ever changes what the decoration draws.
 */
export function overrideClock(param: string | null): SkyClock | number | null {
  if (!param) return null;
  const named: Record<string, SkyClock> = {
    day: { frac: 0.4, isDay: true },
    noon: { frac: 0.5, isDay: true },
    dawn: { frac: 0.03, isDay: true },
    dusk: { frac: 0.96, isDay: true },
    twilight: { frac: 0.02, isDay: false },
    night: { frac: 0.45, isDay: false },
  };
  if (named[param]) return named[param];
  const t = Date.parse(param);
  return Number.isFinite(t) ? t : null;
}

// ── Optional live weather ─────────────────────────────────────────────────

const WEATHER_KEY = "cc-vegas-weather:v1";
const WEATHER_TTL = 15 * 60_000;
const WEATHER_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${VEGAS.lat}&longitude=${VEGAS.lon}` +
  "&current=temperature_2m,is_day,weather_code,cloud_cover&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles";

export function cachedWeather(now = Date.now()): { w: Weather; fresh: boolean } | null {
  try {
    const raw = localStorage.getItem(WEATHER_KEY);
    if (!raw) return null;
    const { at, w } = JSON.parse(raw) as { at: number; w: Weather };
    if (typeof w?.cloud !== "number") return null;
    // An hours-old reading is still a better guess than "clear".
    if (now - at > 6 * 3_600_000) return null;
    return { w, fresh: now - at < WEATHER_TTL };
  } catch {
    return null;
  }
}

/** Fetch current Vegas weather; null on any failure (offline, CSP, API). */
export async function fetchWeather(signal?: AbortSignal): Promise<Weather | null> {
  try {
    const r = await fetch(WEATHER_URL, { signal });
    if (!r.ok) return null;
    const c = (await r.json())?.current;
    if (!c || typeof c.cloud_cover !== "number") return null;
    const w: Weather = { cloud: c.cloud_cover, code: c.weather_code ?? 0, tempF: c.temperature_2m };
    try { localStorage.setItem(WEATHER_KEY, JSON.stringify({ at: Date.now(), w })); } catch { /* private mode */ }
    return w;
  } catch {
    return null;
  }
}
