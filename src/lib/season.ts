/**
 * Where the year is, as a continuous quantity.
 *
 * The naive way to do "seasonal UI" is four buckets keyed off the month. It
 * looks fine in a screenshot and wrong in use: the library is identical on
 * September 1st and November 29th, and then changes overnight while nobody is
 * watching. Seasons are not a step function and shouldn't be modelled as one.
 *
 * What actually drives a season is the Earth's axial tilt relative to the Sun,
 * which is a smooth sinusoid. So the model here is a single angle — `theta`,
 * the position in the tropical year measured from the December solstice — and
 * every seasonal quantity is a projection of it. The library therefore differs
 * slightly from yesterday and a lot from three months ago, which is what the
 * year actually does.
 *
 * Two projections carry all the meaning, and they are orthogonal:
 *
 *   light  = -cos(theta)   how much daylight there is       (dark ↔ bright)
 *   growth =  sin(theta)   whether days are getting longer  (waning ↔ waxing)
 *
 * `growth` is the interesting one and it is the reason this is a sinusoid and
 * not a lookup table. It is the *derivative* of daylight, so it is what
 * separates March from September — both sit at the same tilt, the same day
 * length, the same `light`, and feel nothing alike. It is +1 in spring and −1
 * in autumn, and downstream it does real work: it is literally the sign of the
 * ambient drift, so motes rise when the days are lengthening and fall when
 * they are shortening. Nobody has to hand-author "leaves fall in autumn".
 *
 * A third projection, `warmth`, is `light` delayed by four weeks, because the
 * hottest part of summer is not the solstice — the ground and oceans take
 * about a month to catch up (seasonal lag). Colour follows warmth rather than
 * light for the same reason people do.
 *
 * Pure and DOM-free; everything is a function of an instant plus a hemisphere.
 */

export type Hemisphere = "north" | "south";
export type SeasonName = "winter" | "spring" | "summer" | "autumn";

export interface SeasonState {
  /** Position in the tropical year, radians from the December solstice. */
  angle: number;
  /** Daylight: −1 at the winter solstice, +1 at the summer solstice. */
  light: number;
  /** Rate of change of daylight: +1 mid-spring, −1 mid-autumn. */
  growth: number;
  /** Daylight delayed by the seasonal lag — what temperature actually does. */
  warmth: number;
  /** The named arc, by the astronomical convention (solstice → equinox). */
  season: SeasonName;
  /** 0..1 through the current named season. */
  progress: number;
  /** The solstice or equinox this season is running toward. */
  nextTurn: { name: SeasonName; days: number };
  hemisphere: Hemisphere;
}

const DAY_MS = 86_400_000;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** J2000.0 — 2000 January 1, 12:00 TT. The epoch every term below is fitted to. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/**
 * Seasonal lag: peak heat trails peak sunlight by roughly four weeks over
 * land. This is why late July outranks the June solstice, and why a warm
 * palette should still be warm in early September.
 */
export const SEASON_LAG_DAYS = 28;

/** Mean tropical year, used only to convert the lag into an angle. */
export const TROPICAL_YEAR_DAYS = 365.2422;

const LAG_RADIANS = (SEASON_LAG_DAYS / TROPICAL_YEAR_DAYS) * TAU;

const norm = (a: number): number => ((a % TAU) + TAU) % TAU;

/**
 * Apparent ecliptic longitude of the Sun, in degrees, for an instant.
 *
 * This is the astronomical definition of where the year is: lambda is 0 at the
 * March equinox, 90 at the June solstice, 180 at September, 270 at December.
 * Low-precision series from the Astronomical Almanac — good to about 0.01
 * degrees, or a quarter hour, for a couple of centuries either side of J2000.
 *
 * The obvious cheaper model is "day of year over 365.2422", and it is wrong in
 * a way that shows. Earth's orbit is an ellipse, so by Kepler's second law the
 * planet moves fastest near perihelion in early January and slowest near
 * aphelion in early July. The astronomical seasons are consequently unequal —
 * northern winter runs about 89 days and summer about 93.6 — and assuming four
 * equal quarters puts the March equinox roughly two days late. That error
 * would be invisible in a gradient but the showcase header prints a countdown
 * in days, and a UI should not state a date it has not actually computed.
 */
export function solarLongitude(at: Date | number): number {
  const ms = typeof at === "number" ? at : at.getTime();
  const n = (ms - J2000_MS) / DAY_MS;

  // Mean longitude and mean anomaly are tracked separately, and precess at
  // very slightly different rates (0.9856474 vs 0.9856003 deg/day) because the
  // perihelion itself creeps forward. Folding that difference into a constant
  // longitude-of-perihelion term looks tidier and silently accrues about half
  // a degree — eleven hours — per quarter century.
  const L = 280.460 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * DEG;

  // Equation of the centre: the correction for the orbit being an ellipse.
  const lambda = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
  return ((lambda % 360) + 360) % 360;
}

/**
 * Position in the tropical year as radians from the December solstice, so that
 * `-cos` is daylight and `sin` is whether daylight is growing.
 *
 * Both fall straight out of the longitude: with theta = lambda - 270 degrees,
 * -cos(theta) is sin(lambda), which is the solar declination normalised to
 * +/-1 — literally how far north the Sun stands. And sin(theta) is cos(lambda),
 * its rate of change. The two projections this model runs on are not analogies
 * for the season; they are the season.
 */
export function solarYearAngle(at: Date | number): number {
  return norm((solarLongitude(at) - 270) * DEG);
}

/**
 * When the Sun next reaches `targetLongitude` (0/90/180/270 — an equinox or a
 * solstice), in days from `from`.
 *
 * Solved rather than extrapolated, because the whole point of using the real
 * longitude is that its rate is not constant (it swings between about 0.953
 * and 1.019 degrees per day). It is strictly increasing, though, so once a
 * bracket is found the crossing bisects cleanly.
 */
export function daysUntilLongitude(from: Date | number, targetLongitude: number): number {
  const startMs = typeof from === "number" ? from : from.getTime();
  const target = ((targetLongitude % 360) + 360) % 360;
  // Unwrap to a monotonically rising angle so the crossing is a simple root.
  const start = solarLongitude(startMs);
  const ahead = ((target - start) % 360 + 360) % 360;
  const rise = (ms: number) => {
    const d = ((solarLongitude(ms) - start) % 360 + 360) % 360;
    return d;
  };
  // A quarter turn never takes more than ~94 days; 100 is a safe upper bracket.
  let lo = 0, hi = 100 * DAY_MS;
  if (ahead < 1e-9) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (rise(startMs + mid) < ahead) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) / DAY_MS;
}

/**
 * Astronomical seasons, in December-solstice order. Each occupies one quadrant
 * of the year angle, which puts their boundaries exactly on the solstices and
 * equinoxes without any calendar dates being written down anywhere.
 */
const ARCS: SeasonName[] = ["winter", "spring", "summer", "autumn"];

export function seasonAt(at: Date | number, hemisphere: Hemisphere = "north"): SeasonState {
  const ms = typeof at === "number" ? at : at.getTime();
  const northAngle = solarYearAngle(ms);
  // South of the equator the same instant sits half a year away in season.
  const angle = hemisphere === "south" ? norm(northAngle + Math.PI) : northAngle;

  const quarter = angle / (Math.PI / 2);
  const idx = Math.floor(quarter) % 4;

  // The next boundary in *solar longitude*, which is hemisphere-independent:
  // both halves of the planet turn a season at the same instant, they just
  // call it by different names. Solved from the real longitude, so the
  // countdown the header prints is the countdown an almanac would print.
  const nextLongitude = 270 + (Math.floor(quarter) + 1) * 90 + (hemisphere === "south" ? 180 : 0);

  return {
    angle,
    light: -Math.cos(angle),
    growth: Math.sin(angle),
    warmth: -Math.cos(angle - LAG_RADIANS),
    season: ARCS[idx],
    // Progress through the named season. Unequal season lengths mean this is
    // not quite the angle's own fraction, but it is only used to shade, and
    // the angle is the honest measure of where the year is.
    progress: quarter - Math.floor(quarter),
    nextTurn: { name: ARCS[(idx + 1) % 4], days: daysUntilLongitude(ms, nextLongitude) },
    hemisphere,
  };
}

/** Sentence for the showcase header. Deliberately plain — the visuals carry it. */
export function describeSeason(s: SeasonState): string {
  const d = Math.round(s.nextTurn.days);
  const turning =
    d <= 0 ? `${s.nextTurn.name} begins today`
    : d === 1 ? `${s.nextTurn.name} begins tomorrow`
    : `${d} days until ${s.nextTurn.name}`;
  return `${s.season} · ${turning}`;
}

// ---------------------------------------------------------------------------
// Which half of the planet
// ---------------------------------------------------------------------------

/**
 * Infer the hemisphere without asking for a location.
 *
 * The primary signal is daylight saving, which is a direct readout of the
 * season: a zone that springs forward in July is northern, one that springs
 * forward in January is southern. It costs nothing and needs no permission.
 *
 * Roughly half the planet keeps no DST at all, so the fallback is a table of
 * southern IANA zones covering the larger no-DST southern populations —
 * Brazil (which abolished DST in 2019), South Africa, Argentina, Peru,
 * Indonesia, Queensland, most of southern Africa. It is a best-effort list,
 * not a geography engine, which is exactly why the setting that consumes this
 * can be overridden by hand.
 */
const SOUTHERN_ZONES = new Set([
  // Africa, south of the equator
  "Africa/Johannesburg", "Africa/Maputo", "Africa/Harare", "Africa/Lusaka",
  "Africa/Gaborone", "Africa/Windhoek", "Africa/Luanda", "Africa/Lubumbashi",
  "Africa/Blantyre", "Africa/Maseru", "Africa/Mbabane", "Africa/Dar_es_Salaam",
  "Africa/Kigali", "Africa/Bujumbura", "Africa/Antananarivo", "Africa/Mogadishu",
  // South America
  "America/Sao_Paulo", "America/Fortaleza", "America/Recife", "America/Bahia",
  "America/Belem", "America/Manaus", "America/Campo_Grande", "America/Cuiaba",
  "America/Porto_Velho", "America/Rio_Branco", "America/Araguaina",
  "America/Maceio", "America/Santarem", "America/Noronha",
  "America/Argentina/Buenos_Aires", "America/Argentina/Cordoba",
  "America/Argentina/Mendoza", "America/Argentina/Salta",
  "America/Argentina/Tucuman", "America/Argentina/Ushuaia",
  "America/Montevideo", "America/Asuncion", "America/La_Paz", "America/Lima",
  "America/Santiago", "America/Punta_Arenas", "America/Guayaquil",
  // Indian Ocean & South-East Asia
  "Indian/Mauritius", "Indian/Reunion", "Indian/Antananarivo",
  "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Dili",
  // Oceania
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Perth", "Australia/Adelaide", "Australia/Hobart",
  "Australia/Darwin", "Australia/Canberra", "Australia/Lord_Howe",
  "Pacific/Auckland", "Pacific/Chatham", "Pacific/Fiji", "Pacific/Norfolk",
  "Pacific/Noumea", "Pacific/Port_Moresby", "Pacific/Guadalcanal",
  "Pacific/Tongatapu", "Pacific/Apia", "Pacific/Pago_Pago",
]);

export interface HemisphereProbe {
  /** getTimezoneOffset() for a January date, in minutes. */
  januaryOffset: number;
  /** getTimezoneOffset() for a July date, in minutes. */
  julyOffset: number;
  /** IANA zone name, when the platform knows one. */
  timeZone?: string;
}

/** Pure half of the inference, so the table and the logic stay testable. */
export function hemisphereFromProbe(p: HemisphereProbe): Hemisphere {
  // getTimezoneOffset is minutes *behind* UTC, so it shrinks under DST.
  // Smaller in July than January => the clocks moved forward in July.
  if (p.januaryOffset > p.julyOffset) return "north";
  if (p.julyOffset > p.januaryOffset) return "south";
  if (p.timeZone && SOUTHERN_ZONES.has(p.timeZone)) return "south";
  // Most of the world's people live north of the equator; so does most of the
  // world's land. When there is genuinely no signal, that is the better guess.
  return "north";
}

export function detectHemisphere(now: Date = new Date()): Hemisphere {
  const y = now.getFullYear();
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch { /* no Intl, or no zone — the DST probe still works */ }
  return hemisphereFromProbe({
    januaryOffset: new Date(y, 0, 1).getTimezoneOffset(),
    julyOffset: new Date(y, 6, 1).getTimezoneOffset(),
    timeZone,
  });
}
