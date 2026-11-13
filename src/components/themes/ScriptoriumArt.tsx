import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/context/ThemeContext";
import { hoursAt, hoursNow, type HoursState } from "./scriptoriumHours";
import "@/styles/themes/scriptorium.css";

/**
 * Scriptorium's app bar: the day, drawn as a border vine.
 *
 * A manuscript's margin grows a vine; this one grows with the clock. It
 * starts at the left edge at midnight and by the next midnight has crossed
 * the bar, scrolling over and under its line with a leaf at every
 * crossing and a tendril in every hollow, and has set a gilded bud at each of
 * the eight offices as it reached them. The rest of the day is already there
 * in leadpoint — a border is sketched whole before any of it is inked — with
 * the offices still ahead only pricked into the vellum. At its tip rides the sun, or after dark the
 * moon in tonight's real phase, as high as it stands in the sky. The times
 * come from ./scriptoriumHours.ts; what the vine carries — blossom, gold,
 * hips or bare ivy — comes from the season the app already keeps.
 *
 * Decoration only: aria-hidden, pointer-events none, painted at z -1 inside
 * the header's stacking context, under every control. The vine keeps to the
 * bar's bottom band, below the text.
 *
 * Cost: one recompute a minute and one on resize. Everything is a static SVG;
 * the only motion is the compositor turning the sun's rays, breathing the
 * stars and opening a ring from the current office's bud — each its own
 * layer, so an idle bar does no style work at all — and all of it is frozen
 * under prefers-reduced-motion. No canvas, no rAF, no network.
 */

/** Deterministic PRNG so the vine has the same leaves on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PERIOD = 52; // px per full wave of the stem
const AMP = 4;

type Fruit = "bezant" | "berry" | "bud" | "blossom";
type Turn = "winter" | "spring" | "summer" | "autumn";
interface Leaf { x: number; y: number; rot: number; len: number; tone: "" | "fresh" | "amber" | "russet" }
interface Curl { x: number; d: string; ex: number; ey: number; fruit: Fruit | null }

/**
 * What the vine carries at this time of year. It is the same vine — same
 * stem, same scroll — dressed for the season the rest of the app already
 * knows about: blossom in spring, gold and lapis in high summer, hips and
 * turning leaves in autumn, and in winter the bare ivy with a few berries
 * left on it.
 */
const SEASONS: Record<Turn, { fruit: (Fruit | null)[]; tones: Leaf["tone"][]; leafEvery: number }> = {
  spring: { fruit: ["blossom", "blossom", "bezant", "blossom"], tones: ["fresh", "", "fresh"], leafEvery: 1 },
  summer: { fruit: ["bezant", "berry", "bezant", "bud"], tones: [""], leafEvery: 1 },
  autumn: { fruit: ["berry", "bezant", "berry", "berry"], tones: ["amber", "", "russet", "amber"], leafEvery: 1 },
  winter: { fruit: ["berry", null, null, "berry"], tones: ["", "russet"], leafEvery: 2 },
};

/** The stem's height at x: a rinceau, rising and falling about the baseline. */
const stemY = (x: number, base: number) => base + AMP * Math.sin((2 * Math.PI * x) / PERIOD);

/**
 * The whole day's vine for a bar this wide; the clock decides how much shows.
 *
 * It is built the way a border is drawn: the stem swings over and under its
 * line, a leaf springs forward from every crossing, and into every hollow the
 * swing leaves a tendril curls, closed with a gold bezant, a vermilion berry
 * or a lapis bud. That scroll-and-fill rhythm is what makes it read as a
 * vine and not as a string of beads.
 */
function buildVine(width: number, base: number, turn: Turn): { leaves: Leaf[]; curls: Curl[] } {
  const r = rng(1123);
  const leaves: Leaf[] = [];
  const curls: Curl[] = [];
  const { fruit: fruits, tones, leafEvery } = SEASONS[turn];
  for (let n = 0; n * (PERIOD / 2) < width; n++) {
    // Crossing: the stem passes through its line here, heading down (even n)
    // or up (odd n). The leaf leans forward, to the outside of the bend.
    const cx = n * (PERIOD / 2);
    const heading = n % 2 === 0 ? 1 : -1;
    const leaf: Leaf = { x: cx, y: base, rot: -heading * (52 + r() * 16), len: 8 + r() * 3, tone: tones[n % tones.length] };
    if (n % leafEvery === 0) leaves.push(leaf);

    // Extremum: low (hollow above) after an even crossing, high after an odd.
    const ex = cx + PERIOD / 4;
    const ey = stemY(ex, base);
    const s = -heading; // which way the hollow opens: -1 up, +1 down
    const sx = ex - 9;
    curls.push({
      x: ex,
      d: `M${sx.toFixed(1)} ${stemY(sx, base).toFixed(1)} C${(ex - 7).toFixed(1)} ${(ey + s * 8.5).toFixed(1)} ${(ex + 5).toFixed(1)} ${(ey + s * 10.5).toFixed(1)} ${(ex + 5.5).toFixed(1)} ${(ey + s * 5.4).toFixed(1)} C${(ex + 5.8).toFixed(1)} ${(ey + s * 2).toFixed(1)} ${(ex + 0.4).toFixed(1)} ${(ey + s * 2.4).toFixed(1)} ${(ex + 1.2).toFixed(1)} ${(ey + s * 5.4).toFixed(1)}`,
      ex: ex + 1.2, ey: ey + s * 5.4,
      fruit: fruits[n % fruits.length],
    });
  }
  return { leaves, curls };
}

function stemPath(to: number, base: number): string {
  let d = `M-2 ${stemY(-2, base).toFixed(1)}`;
  for (let x = 1; x < to; x += 3) d += ` L${x} ${stemY(x, base).toFixed(1)}`;
  return `${d} L${to.toFixed(1)} ${stemY(to, base).toFixed(1)}`;
}

/** The lit part of the moon's disc, radius r about the origin, for a phase 0..1. */
function moonLit(phase: number, r: number): string {
  const waxing = phase < 0.5;
  // Width of the terminator ellipse: r at new and full, 0 at the quarters.
  const k = Math.cos(phase * 2 * Math.PI); // 1 new, -1 full
  const rx = Math.abs(k) * r;
  // Outer limb on the lit side, then the terminator back.
  const limb = waxing ? 1 : 0;
  const term = (k > 0) === waxing ? 0 : 1;
  return `M0 ${-r} A${r} ${r} 0 0 ${limb} 0 ${r} A${rx.toFixed(2)} ${r} 0 0 ${term} 0 ${-r} Z`;
}

const ScriptoriumArt: React.FC = () => {
  const { season, seasonal, face } = useTheme();
  // With seasonal drift switched off the vine stays in high summer.
  const turn: Turn = seasonal ? season.season : "summer";
  const hemisphere = season.hemisphere;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 48 });
  const [hours, setHours] = useState<HoursState>(() => hoursAt(hoursNow(), hemisphere));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const tick = () => setHours(hoursAt(hoursNow(), hemisphere));
    tick();
    const id = window.setInterval(tick, 60_000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hemisphere]);

  const { w, h } = size;
  const base = h - 11;
  const vine = useMemo(() => buildVine(w, base, turn), [w, base, turn]);
  const stars = useMemo(() => {
    const r = rng(77);
    return Array.from({ length: Math.round(w / 34) }, () => ({
      x: r() * w, y: 5 + r() * (h * 0.5), s: 0.6 + r() * 0.9,
    }));
  }, [w, h]);

  const sketch = useMemo(() => {
    const leaf = (l: Leaf) => {
      const rad = (l.rot * Math.PI) / 180;
      const tx = l.x + Math.cos(rad) * l.len;
      const ty = l.y + Math.sin(rad) * l.len;
      return `M${l.x.toFixed(1)} ${l.y.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)}`;
    };
    return [stemPath(w + 2, base), ...vine.curls.map((c) => c.d), ...vine.leaves.map(leaf)].join(" ");
  }, [vine, w, base]);

  const tip = hours.dayFrac * w;
  const tipY = stemY(tip, base);
  // The sun or moon rides above the growing tip, as high as it stands.
  const orbR = 7;
  const orbY = tipY - 9 - hours.altitude * Math.max(0, h * 0.36 - 9);
  // The pinned face may disagree with the clock; the bar shows the clock's
  // own sky either way — it is the horarium, not the lamp.
  const dayOrb = hours.face === "day";
  const nowX = (hours.office.at / 24) * w;

  return (
    <div ref={ref} className="scr-frieze" data-sky={hours.face} data-face={face ?? "day"} data-turn={turn} aria-hidden="true">
      {/* Stars pricked in gold, after dark. Two sheets breathing out of step:
          each is one composited opacity, where a star apiece would be thirty
          main-thread animations. */}
      {!dayOrb && [0, 1].map((sheet) => (
        <svg key={sheet} className={`scr-stars scr-stars--${sheet ? "b" : "a"}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {stars.filter((_, i) => i % 2 === sheet).map((s, i) => (
            <path
              key={i}
              transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) scale(${s.s.toFixed(2)})`}
              d="M0 -2.4 L0.55 -0.55 L2.4 0 L0.55 0.55 L0 2.4 L-0.55 0.55 L-2.4 0 L-0.55 -0.55 Z"
            />
          ))}
        </svg>
      ))}

      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {/* The drypoint ruling the vine grows along, and the offices pricked into it */}
        <line className="scr-ruling" x1="0" x2={w} y1={base + 5.5} y2={base + 5.5} />
        {hours.offices.map((o) => {
          const x = (o.at / 24) * w;
          const passed = x <= tip;
          return passed ? (
            <g key={o.id} className="scr-bud" transform={`translate(${x.toFixed(1)} ${(stemY(x, base) - 1).toFixed(1)})`}>
              <circle r="3.4" className="scr-bud-ring" />
              <circle r="2.1" className="scr-bud-gold" />
            </g>
          ) : (
            <circle key={o.id} className="scr-prick" cx={x.toFixed(1)} cy={base + 5.5} r="1.4" />
          );
        })}

        {/* The underdrawing: the whole day's vine in leadpoint, as a border is
            sketched before any of it is inked. The clock inks over it. */}
        <g className="scr-sketch">
          <path d={sketch} />
        </g>

        {/* Tendrils and leaves first, so the stem's line runs over their roots */}
        <g>
          {vine.curls.filter((c) => c.x < tip - 8).map((c, i) => {
            // The newest growth has not fruited yet.
            const ripe = tip - c.x > 40;
            return (
              <g key={i}>
                <path className="scr-stem scr-stem--tendril" d={c.d} />
                {ripe && c.fruit && <circle className={`scr-fruit scr-fruit--${c.fruit}`} cx={c.ex.toFixed(1)} cy={c.ey.toFixed(1)} r={c.fruit === "bezant" ? 2.3 : c.fruit === "blossom" ? 2.6 : 1.9} />}
                {ripe && c.fruit === "blossom" && <circle className="scr-fruit--eye" cx={c.ex.toFixed(1)} cy={c.ey.toFixed(1)} r="0.9" />}
              </g>
            );
          })}
          {vine.leaves.filter((l) => l.x < tip - 3).map((l, i) => {
            // …and is still unfurling.
            const young = Math.min(1, (tip - l.x) / 46);
            const len = l.len * (0.35 + 0.65 * young);
            const wide = len * 0.36;
            return (
              <g key={i} transform={`translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) rotate(${l.rot.toFixed(0)})`}>
                <path className={l.tone ? `scr-leaf scr-leaf--${l.tone}` : "scr-leaf"} d={`M0 0 C${(len * 0.25).toFixed(1)} ${(-wide).toFixed(1)} ${(len * 0.7).toFixed(1)} ${(-wide).toFixed(1)} ${len.toFixed(1)} 0 C${(len * 0.7).toFixed(1)} ${wide.toFixed(1)} ${(len * 0.25).toFixed(1)} ${wide.toFixed(1)} 0 0 Z`} />
                <path className="scr-vein" d={`M0.5 0 L${(len - 1.5).toFixed(1)} 0`} />
              </g>
            );
          })}
        </g>
        <path className="scr-stem" d={stemPath(tip, base)} />
        {/* The tip curls up to carry the sun or moon */}
        <path className="scr-stem scr-stem--tendril" d={`M${tip.toFixed(1)} ${tipY.toFixed(1)} q5 -1 ${(3).toFixed(1)} ${(orbY + orbR - tipY).toFixed(1)}`} />

        <g transform={`translate(${(tip + 3).toFixed(1)} ${orbY.toFixed(1)})`}>
          <circle className="scr-orb-halo" r={orbR * 3} />
          {dayOrb ? (
            <g className="scr-sun">
              <circle className="scr-sun-disc" r={orbR} />
              <circle className="scr-sun-ring" r={orbR - 2} />
            </g>
          ) : (
            <g className="scr-moon">
              <circle className="scr-moon-dark" r={orbR} />
              <path className="scr-moon-lit" d={moonLit(hours.moon, orbR)} />
              <circle className="scr-moon-rim" r={orbR} />
            </g>
          )}
        </g>
      </svg>

      {/* The two things that move, each its own composited layer so neither
          costs a style recalculation: the sun's rays turning, and a ring
          opening from the bud of the office being kept. */}
      {dayOrb && (
        <svg className="scr-sun-rays" width="34" height="34" viewBox="-17 -17 34 34" style={{ left: tip + 3 - 17, top: orbY - 17 }}>
          {Array.from({ length: 12 }, (_, i) => (
            <path key={i} transform={`rotate(${i * 30})`} d={i % 2 ? `M-1 ${-orbR - 1.5} L0 ${-orbR - 5} L1 ${-orbR - 1.5} Z` : `M-1.3 ${-orbR - 1.5} L0 ${-orbR - 7.5} L1.3 ${-orbR - 1.5} Z`} />
          ))}
        </svg>
      )}
      <i className="scr-now" style={{ left: nowX - 4, top: stemY(nowX, base) - 1 - 4 }} />
    </div>
  );
};

export default ScriptoriumArt;
