// Desolate Lab — the facility's telemetry, as pure functions so the header
// strip (DesolateLabArt.tsx) stays a dumb renderer and this stays testable.
//
// The fiction: Annex 07 has run unattended since the last crew member signed
// out. Its instruments still page through their channels, its lights still
// follow the clock outside, and the uplink lamp is the only colour left.

/** Last crew sign-out. Everything "unattended" counts up from here. */
export const SEALED_AT = Date.UTC(2022, 10, 3, 4, 17, 0); // 2022-11-03 04:17 UTC

export type Cycle = "dawn" | "day" | "evening" | "night";

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");

/** "1448D 07:12:55" — time since the annex was sealed. */
export function unattended(now: number): string {
  const s = Math.max(0, Math.floor((now - SEALED_AT) / 1000));
  const d = Math.floor(s / 86400);
  return `${pad(d, 4)}D ${pad((s % 86400) / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}

/** Local wall clock, 24h, the way a facility clock reads. */
export function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The building follows the day outside even with nobody in it. */
export function cycleOf(hour: number): Cycle {
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 18) return "day";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

/** Grid power by day, auxiliary at night — percentages a tired plant reports. */
export function power(cycle: Cycle): { source: "GRID" | "AUX"; pct: number } {
  switch (cycle) {
    case "day": return { source: "GRID", pct: 100 };
    case "evening": return { source: "GRID", pct: 71 };
    case "dawn": return { source: "AUX", pct: 48 };
    case "night": return { source: "AUX", pct: 34 };
  }
}

export interface Channel {
  key: string;
  label: string;
  value: string;
  /** True when this channel is reporting a fault — the only time text goes red. */
  alarm?: boolean;
}

/** The instrument channels the readout pages through, in order. */
export function channels(now: Date, online: boolean): Channel[] {
  const cycle = cycleOf(now.getHours());
  const p = power(cycle);
  return [
    { key: "unattended", label: "UNATTENDED", value: unattended(now.getTime()) },
    { key: "local", label: "LOCAL", value: `${clock(now)} ${cycle.toUpperCase()}` },
    { key: "power", label: `${p.source} PWR`, value: `${pad(p.pct, 3)}%` },
    { key: "uplink", label: "UPLINK", value: online ? "NOMINAL" : "LOST", alarm: !online },
  ];
}

/** Seconds each channel stays on the readout before it pages. */
export const PAGE_SECONDS = 6;

/** Which channel is up at a given moment — wall-clock driven, so it never drifts. */
export function channelIndex(now: number, count: number): number {
  return Math.floor(now / 1000 / PAGE_SECONDS) % count;
}

/** Deterministic PRNG (mulberry32) so the trace is the same on every load. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TRACE_W = 1200;
export const TRACE_H = 40;

/**
 * A scope trace across the bar: a quiet, slightly noisy baseline (a building
 * at rest) with two small sensor ticks and one real event — a single damped
 * spike near 62% across. Returns the SVG path and where the event is, so the
 * strip can mark it on the ruler.
 */
export function trace(seed = 7): { d: string; eventX: number } {
  const r = rng(seed);
  const mid = TRACE_H / 2;
  const eventX = Math.round(TRACE_W * 0.62);
  const ticks = [TRACE_W * 0.18, TRACE_W * 0.86];
  const pts: string[] = [];
  let drift = 0;
  for (let x = 0; x <= TRACE_W; x += 4) {
    drift = drift * 0.92 + (r() - 0.5) * 0.9;
    let y = mid + drift + Math.sin(x / 57) * 0.8;
    for (const t of ticks) {
      const dx = x - t;
      if (Math.abs(dx) < 12) y -= Math.cos((dx / 12) * (Math.PI / 2)) * 4;
    }
    const de = x - eventX;
    if (de >= 0 && de < 120) {
      // damped ringing after the event
      y -= Math.sin(de / 3.2) * 15 * Math.exp(-de / 22);
    }
    y = Math.min(TRACE_H - 2, Math.max(2, y));
    pts.push(`${x} ${y.toFixed(1)}`);
  }
  return { d: `M${pts.join(" L")}`, eventX };
}
