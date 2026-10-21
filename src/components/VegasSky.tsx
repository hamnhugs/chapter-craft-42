import React, { useEffect, useMemo, useState } from "react";
import {
  CLEAR, cachedWeather, fetchWeather, overrideClock, skyClock, skyPaint,
  type SkyClock, type Weather,
} from "@/lib/vegasSky";
import "@/styles/vegas-sky.css";

/**
 * Bookworm Studio's app bar: the sky over Las Vegas right now, and the Strip
 * on its horizon.
 *
 * It is the G915 keyboard's Vegas theme (g915-lights/themes/vegas.py) moved
 * onto the screen: the colour follows the real time of day in Vegas, the sun
 * or the moon rides an arc across the bar, stars come out on clear nights,
 * cloud cover greys it all down, and along the bottom the Strip's neon
 * marquee chases the way the keyboard's bottom row does.
 *
 * It is decoration. aria-hidden, pointer-events none, and painted at z -1
 * inside the header's own stacking context (sticky + z-50), so it sits on the
 * header's background and under every control. The sky is laid over the
 * theme's night ink at low strength (SKY_STRENGTH in lib/vegasSky.ts) so the
 * gold and white header text keeps 4.5:1 at every hour — the test suite
 * checks that across day, dusk and night in clear, cloudy and rainy weather.
 *
 * Cost: one recompute a minute. Twinkle, window lights and the marquee are
 * CSS animations, frozen under prefers-reduced-motion. No canvas, no rAF.
 */

// The art is one SVG on a wide viewBox, sliced from the bottom-centre: a
// phone sees the landmarks in the middle, a desktop sees the whole valley.
// The ground is y = 120; the view starts at y = 30 so the city fills the
// lower half of a ~46-56px bar instead of a sliver of it.
const VB_X = -1000;
const VB_W = 6400;
const VB_Y = 30;
const VB_H = 90;
const GROUND = 120;
const NEON = ["#ff3d9a", "#2ee6ff", "#ffc94d", "#9b5cff", "#3dffa0"];

/** Small deterministic PRNG so the skyline is the same on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Tower { x: number; w: number; h: number }
interface Light { x: number; y: number; c: string; d: number }

function buildCity() {
  const r = rng(7);
  // Low background blocks across the whole valley. Tall ones only near the
  // Strip in the middle, so whatever sits at the bar's ends (the wordmark,
  // the buttons) has nothing behind it but rooftops.
  const blocks: Tower[] = [];
  for (let x = VB_X; x < VB_X + VB_W; ) {
    const w = 14 + r() * 26;
    const dist = Math.abs(x - 2250) / 2200;
    const h = 5 + r() * (dist < 0.25 ? 26 : dist < 0.5 ? 14 : 8);
    blocks.push({ x, w, h });
    x += w + r() * 6;
  }

  // Casino towers on the Strip, between the landmarks.
  const towers: Tower[] = [
    { x: 1830, w: 22, h: 34 }, { x: 1858, w: 14, h: 26 },
    { x: 2064, w: 18, h: 50 }, { x: 2086, w: 12, h: 40 },
    { x: 2118, w: 24, h: 44 },
    { x: 2232, w: 16, h: 38 },
    { x: 2336, w: 26, h: 52 }, { x: 2366, w: 14, h: 36 },
    { x: 2410, w: 20, h: 46 }, { x: 2436, w: 12, h: 30 },
    { x: 2600, w: 22, h: 34 }, { x: 2630, w: 16, h: 26 },
    { x: 1700, w: 18, h: 24 }, { x: 2720, w: 20, h: 22 },
  ];

  // Window lights: sparse columns on the casino towers, in Strip neon. Each
  // gets a delay from its x so the twinkle reads as a slow chase down the Strip.
  const lights: Light[] = [];
  const lr = rng(42);
  for (const t of towers) {
    for (let cx = t.x + 3; cx < t.x + t.w - 3; cx += 6) {
      for (let cy = GROUND - t.h + 5; cy < GROUND - 4; cy += 6) {
        if (lr() < 0.3) {
          lights.push({ x: cx, y: cy, c: NEON[Math.floor(lr() * NEON.length)], d: ((cx - 1700) / 1000) * 6 + lr() * 1.5 });
        }
      }
    }
  }

  const stars = Array.from({ length: 100 }, () => ({
    x: VB_X + r() * VB_W, y: VB_Y + 3 + r() * 46, s: 0.9 + r() * 1.4, d: r() * 6,
  }));

  // Far mountains: the Spring Mountains to the west stand taller than the
  // Frenchman range to the east, as they do from the Strip.
  const mr = rng(3);
  let ridge = `M${VB_X} ${GROUND}`;
  for (let x = VB_X; x <= VB_X + VB_W; x += 45) {
    const west = x < 2000 ? 1 : 0.55;
    const y = GROUND - (12 + 22 * west * (0.5 + 0.5 * Math.sin(x / 230 + 1.3)) + mr() * 7 * west);
    ridge += ` L${x} ${y.toFixed(1)}`;
  }
  ridge += ` L${VB_X + VB_W} ${GROUND} Z`;

  return { blocks, towers, lights, stars, ridge };
}

/** The landmarks, as one path (drawn twice: once raised for rim light, once in ink). */
const LANDMARKS = [
  // Luxor pyramid
  "M1950 120 L2000 74 L2050 120 Z",
  // Eiffel Tower (Paris) — splayed legs with the arch cut out, a platform, a spire
  "M2166 120 Q2183 98 2186 80 L2188 64 L2189 56 L2191 56 L2192 64 L2194 80 Q2197 98 2214 120 L2204 120 Q2190 102 2176 120 Z",
  "M2176 96 L2204 96 L2203 99 L2177 99 Z",
  // Hotel-tower Y (Wynn-ish curved slab)
  "M2264 120 L2264 70 Q2276 64 2290 66 L2290 120 Z",
  // The STRAT — tapered shaft, pod, needle
  "M2550 120 L2554 70 L2556 70 L2560 120 Z",
  "M2545 70 L2565 70 L2563 62 L2547 62 Z",
  "M2548 62 L2562 62 L2559 57 L2551 57 Z",
  "M2554.4 57 L2555.6 57 L2555.2 40 L2554.8 40 Z",
  // Welcome to Fabulous Las Vegas — posts
  "M1897 120 L1898 106 L1899 120 Z",
  "M1905 120 L1906 106 L1907 120 Z",
].join(" ");

function readOverride(): SkyClock | number | null {
  if (typeof window === "undefined") return null;
  try {
    return overrideClock(new URLSearchParams(window.location.search).get("vegasSky"));
  } catch {
    return null;
  }
}

function readWeatherOverride(): Weather | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("vegasWeather");
  if (v === "cloudy") return { cloud: 85, code: 3 };
  if (v === "rain") return { cloud: 90, code: 61 };
  if (v === "clear") return CLEAR;
  return null;
}

const VegasSky: React.FC = () => {
  const override = useMemo(readOverride, []);
  const weatherOverride = useMemo(readWeatherOverride, []);
  const city = useMemo(buildCity, []);
  const [now, setNow] = useState(() => Date.now());
  const [weather, setWeather] = useState<Weather>(() => weatherOverride ?? cachedWeather()?.w ?? CLEAR);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Weather is a bonus: refresh at most every 15 minutes, keep the last
  // reading (or a clear sky) when the fetch fails or the CSP refuses it.
  useEffect(() => {
    if (weatherOverride) return;
    const cached = cachedWeather(now);
    if (cached?.fresh) return;
    const ctl = new AbortController();
    fetchWeather(ctl.signal).then((w) => { if (w) setWeather(w); });
    return () => ctl.abort();
    // Re-checked on each minute tick; cachedWeather makes most ticks a no-op.
  }, [now, weatherOverride]);

  const clock: SkyClock = useMemo(() => {
    if (override && typeof override === "object") return override;
    return skyClock(typeof override === "number" ? override : now);
  }, [override, now]);

  const p = useMemo(() => skyPaint(clock, weather), [clock, weather]);
  const phase = p.isDay ? (Math.min(clock.frac, 1 - clock.frac) < 0.12 ? "golden" : "day") : p.night > 0.5 ? "night" : "twilight";

  const style = {
    "--vs-top": p.top,
    "--vs-mid": p.mid,
    "--vs-horizon": p.horizon,
    "--vs-glow": p.glow,
    "--vs-body-x": `${(4 + p.bodyX * 92).toFixed(2)}%`,
    "--vs-body-y": `${(12 + p.bodyY * 52).toFixed(2)}%`,
    "--vs-body": (p.body * (p.isDay ? 0.65 : 0.85)).toFixed(3),
    "--vs-night": p.night.toFixed(3),
    "--vs-rim": p.rim,
    "--vs-cloud": (p.cloud / 100).toFixed(3),
  } as React.CSSProperties;

  const clouds = Math.round((p.cloud / 100) * 5);

  return (
    <div className="vs-sky" data-phase={phase} data-rain={p.rain || undefined} style={style} aria-hidden="true">
      <div className="vs-gradient" />
      {/* The Strip lights its own sky from below after dark. */}
      <div className="vs-cityglow" />
      <div className={p.isDay ? "vs-sun" : "vs-moon"} />
      {Array.from({ length: clouds }, (_, i) => (
        <div key={i} className="vs-cloud" style={{ "--i": i } as React.CSSProperties} />
      ))}
      {p.rain && <div className="vs-rain" />}
      <svg className="vs-city" viewBox={`${VB_X} ${VB_Y} ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="vs-beam" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#f4f0ff" stopOpacity="0.85" />
            <stop offset="0.6" stopColor="#c9f6ff" stopOpacity="0.25" />
            <stop offset="1" stopColor="#c9f6ff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="vs-sphere" cx="0.4" cy="0.35" r="0.7">
            <stop offset="0" className="vs-sphere-a" />
            <stop offset="1" className="vs-sphere-b" />
          </radialGradient>
          <linearGradient id="vs-marquee" x1="0" y1="0" x2="160" y2="0" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
            {NEON.map((c, i) => <stop key={c} offset={i / NEON.length} stopColor={c} />)}
            <stop offset="1" stopColor={NEON[0]} />
          </linearGradient>
        </defs>

        <g className="vs-stars">
          {city.stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.s} style={{ animationDelay: `${s.d.toFixed(2)}s` }} />
          ))}
        </g>

        {/* Luxor's sky beam — night only */}
        <rect className="vs-beam" x="1998.8" y={VB_Y} width="2.4" height={76 - VB_Y} fill="url(#vs-beam)" />

        <path className="vs-ridge" d={city.ridge} />
        <g className="vs-blocks">
          {city.blocks.map((b, i) => <rect key={i} x={b.x} y={GROUND - b.h} width={b.w} height={b.h} />)}
        </g>

        {/* Rim light: the same shapes raised a hair, in the horizon's colour. */}
        <g className="vs-rim" transform="translate(0 -1.6)">
          <path d={LANDMARKS} />
          {city.towers.map((t, i) => <rect key={i} x={t.x} y={GROUND - t.h} width={t.w} height={t.h} />)}
          <circle cx="2318" cy="104" r="17" />
        </g>
        <g className="vs-front">
          <path d={LANDMARKS} />
          {city.towers.map((t, i) => <rect key={i} x={t.x} y={GROUND - t.h} width={t.w} height={t.h} />)}
        </g>

        {/* The Sphere */}
        <circle className="vs-sphere" cx="2318" cy="104" r="17" fill="url(#vs-sphere)" />

        {/* Welcome sign: a little neon diamond on its posts */}
        <path className="vs-welcome" d="M1902 92 L1916 100 L1902 108 L1888 100 Z" />

        {/* Pod + Luxor apex lights */}
        <circle className="vs-beacon" cx="2555" cy="40" r="1.6" />
        <circle className="vs-apex" cx="2000" cy="75" r="1.8" />

        <g className="vs-lights">
          {city.lights.map((l, i) => (
            <rect key={i} x={l.x} y={l.y} width="3.2" height="3.2" fill={l.c} style={{ animationDelay: `${l.d.toFixed(2)}s` }} />
          ))}
        </g>

        {/* The Strip's marquee — the keyboard's bottom-row chase */}
        <line className="vs-marquee" x1={VB_X} y1={GROUND - 1.2} x2={VB_X + VB_W} y2={GROUND - 1.2} stroke="url(#vs-marquee)" />
      </svg>
    </div>
  );
};

export default VegasSky;
