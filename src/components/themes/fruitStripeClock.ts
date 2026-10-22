/**
 * Fruit Stripe's "flavour of the hour" — the pure half of FruitStripeArt.
 *
 * The app bar is printed like a five-flavour gum wrapper. Which flavour leads
 * the wrapper follows the local clock, the way a day goes: lemon at breakfast,
 * lime through the bright middle of the day, tangerine in the long afternoon,
 * cherry for the evening, melon after dark. The lead flavour prints its stripe
 * double-width and colours the little atomic starburst, which walks across the
 * bar from morning (left) to the small hours (right).
 *
 * Pure and DOM-free so it can be tested: an hour in, a wrapper out.
 */

export type FlavorId = "lemon" | "lime" | "tangerine" | "cherry" | "melon";

export interface Flavor {
  id: FlavorId;
  name: string;
  /** Full-strength ink, for edges and the starburst. */
  ink: string;
  /** The printed pastel the wrapper stripe uses (≈30% on paper). */
  tint: string;
  /** Local hour this flavour takes over (0–23). */
  from: number;
}

/** In wrapper order, which is also the order of the day. */
export const FLAVORS: Flavor[] = [
  { id: "lemon",     name: "Lemon",     ink: "#F4C95D", tint: "#FBEBC2", from: 5 },
  { id: "lime",      name: "Lime",      ink: "#6BBF59", tint: "#D6EDD0", from: 10 },
  { id: "tangerine", name: "Tangerine", ink: "#F4844D", tint: "#FCDCCB", from: 14 },
  { id: "cherry",    name: "Cherry",    ink: "#E63946", tint: "#F8CDD0", from: 18 },
  { id: "melon",     name: "Melon",     ink: "#EE7B9E", tint: "#FADAE3", from: 22 },
];

/** The wrapper's day starts at 5am, when lemon comes on. */
const DAY_START = FLAVORS[0].from;

export interface WrapperState {
  lead: Flavor;
  /** 0..1 through the wrapper day (5am → 5am), drives the starburst. */
  progress: number;
  /** Flavours in print order, starting with the lead. */
  order: Flavor[];
  /** True between 22:00 and 05:00 — the press runs dimmer after hours. */
  night: boolean;
}

export function flavorAtHour(hour: number): Flavor {
  const h = ((hour % 24) + 24) % 24;
  // Walk back from the last flavour; melon wraps past midnight to 5am.
  for (let i = FLAVORS.length - 1; i >= 0; i--) {
    if (h >= FLAVORS[i].from) return FLAVORS[i];
  }
  return FLAVORS[FLAVORS.length - 1];
}

/** `hour` may be fractional (14.5 = 2:30pm). */
export function wrapperAt(hour: number): WrapperState {
  const h = ((hour % 24) + 24) % 24;
  const lead = flavorAtHour(h);
  const i = FLAVORS.indexOf(lead);
  const order = [...FLAVORS.slice(i), ...FLAVORS.slice(0, i)];
  const progress = (((h - DAY_START) % 24) + 24) % 24 / 24;
  return { lead, progress, order, night: h >= 22 || h < DAY_START };
}

/** Geometry of the printed stripes, in px along the gradient axis. */
export const STRIPE = { band: 13, gap: 11, angle: 118 } as const;

/**
 * The wrapper's repeating stripe: the lead flavour double-width, then the
 * rest, each separated by bare paper. Returns the CSS gradient and its
 * HORIZONTAL period (what the drift has to travel to loop seamlessly).
 */
export function wrapperStripes(order: Flavor[]): { background: string; period: number } {
  const stops: string[] = [];
  let at = 0;
  order.forEach((f, i) => {
    const w = i === 0 ? STRIPE.band * 2 : STRIPE.band;
    stops.push(`${f.tint} ${at}px ${at + w}px`);
    at += w;
    stops.push(`transparent ${at}px ${at + STRIPE.gap}px`);
    at += STRIPE.gap;
  });
  const rad = (STRIPE.angle * Math.PI) / 180;
  const period = at / Math.abs(Math.sin(rad));
  return {
    background: `repeating-linear-gradient(${STRIPE.angle}deg, ${stops.join(", ")})`,
    period: Math.round(period * 1000) / 1000,
  };
}

/** Local fractional hour now, or the preview override `?fsHour=HH[.h]`. */
export function currentHour(now: Date = new Date(), search = typeof location !== "undefined" ? location.search : ""): number {
  const o = new URLSearchParams(search).get("fsHour");
  if (o !== null && o !== "" && Number.isFinite(Number(o))) return Number(o);
  return now.getHours() + now.getMinutes() / 60;
}
