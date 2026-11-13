import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/context/ThemeContext";
import { auroraState, overrideDate, type AuroraState } from "./auroraSky";
import "@/styles/themes/aurora-art.css";

/**
 * Aurora's app bar: the northern lights over a spruce treeline, tonight.
 *
 * Three curtains of rays hang across the bar — oxygen green in front, a teal
 * fold and a distant violet one behind — and drift on their own slow clocks.
 * How bright they are is read off the device clock by ./auroraSky.ts: dark
 * after nautical twilight, swelling toward local magnetic midnight, brighter
 * near the equinoxes, and on a per-night Kp so tonight is not last night.
 * Strong nights grow a red crown and a violet hem, the way real storms do.
 * By day only a faint pastel shimmer remains, behind the daylight.
 *
 * Decoration only: aria-hidden, pointer-events none, painted at z -1 inside
 * the header's stacking context, under every control. The curtains are capped
 * in alpha so header text holds 4.5:1 at full storm (src/test/auroraSky.test.ts).
 *
 * Cost: one recompute a minute. Each curtain is one static SVG that the
 * compositor slides and breathes (transform/opacity only — no repaint), and
 * every animation is frozen under prefers-reduced-motion. No canvas, no rAF,
 * no network.
 */

const VB_W = 2000; // each curtain is twice the bar wide, so it can drift
const VB_H = 100;

/** Deterministic PRNG so the curtains have the same folds on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Ray { x: number; y: number; w: number; h: number; o: number }

/**
 * One curtain: a run of vertical rays whose lower edges trace a slow fold.
 * The lower edge is the bright, sharp one (as in the sky); the rays fade
 * upward through the gradient in aurora-art.css.
 */
function buildCurtain(seed: number, base: number, amp: number, len: [number, number]): Ray[] {
  const r = rng(seed);
  const p1 = r() * Math.PI * 2;
  const p2 = r() * Math.PI * 2;
  const p3 = r() * Math.PI * 2;
  const rays: Ray[] = [];
  for (let x = 0; x < VB_W; ) {
    const w = 5 + r() * 6;
    const t = x / VB_W;
    const edge =
      base +
      amp * Math.sin(t * Math.PI * 4 + p1) +
      amp * 0.45 * Math.sin(t * Math.PI * 11 + p2);
    // Brightness swells and fades along the curtain, like the folds catching light.
    const fold = 0.5 + 0.5 * Math.sin(t * Math.PI * 6 + p3);
    const h = len[0] + (len[1] - len[0]) * (0.4 + 0.6 * fold) * (0.75 + 0.25 * r());
    rays.push({ x, y: edge - h, w: w + 1.5, h, o: 0.12 + 0.88 * fold * (0.3 + 0.7 * r()) });
    x += w;
  }
  return rays;
}

/** Spruce treeline along the bottom edge — sparse in the middle, denser at the ends. */
function buildTreeline(): string {
  const r = rng(11);
  let d = `M0 ${VB_H}`;
  for (let x = 0; x < 1000; ) {
    const t = x / 1000;
    const edgeness = Math.abs(t - 0.5) * 2; // 0 centre … 1 ends
    const w = 5 + r() * 7;
    const h = r() < 0.2 + edgeness * 0.6 ? 4 + r() * (3 + edgeness * 5) : 1 + r() * 1.5;
    d += ` L${x.toFixed(1)} ${VB_H - 1} L${(x + w / 2).toFixed(1)} ${(VB_H - 1 - h).toFixed(1)} L${(x + w).toFixed(1)} ${VB_H - 1}`;
    x += w * (0.7 + r() * 0.5);
  }
  return `${d} L1000 ${VB_H} Z`;
}

const CURTAINS = [
  // Lower edges sit in the bar's bottom band, under the text; the rays rise
  // through the text band, fading as they go (see TEXT_BAND in auroraSky.ts).
  { key: "a", seed: 3, base: 87, amp: 4, len: [60, 100] as [number, number] },
  { key: "b", seed: 17, base: 84, amp: 5, len: [50, 85] as [number, number] },
  { key: "c", seed: 29, base: 82, amp: 5, len: [40, 70] as [number, number] },
];

function readOverrides(): { at: Date | null; kp?: number } {
  if (typeof location === "undefined") return { at: null };
  const q = new URLSearchParams(location.search);
  const kp = Number(q.get("auroraKp"));
  return { at: overrideDate(q.get("auroraSky")), kp: kp >= 1 && kp <= 9 ? kp : undefined };
}

const AuroraArt: React.FC = () => {
  const curtains = useMemo(
    () => CURTAINS.map((c) => ({ ...c, rays: buildCurtain(c.seed, c.base, c.amp, c.len) })),
    [],
  );
  const treeline = useMemo(buildTreeline, []);

  // The season already knows which half of the world we're in — winter
  // nights are long in July down south, and so is the aurora australis.
  const hemisphere = useTheme().season.hemisphere;
  const [state, setState] = useState<AuroraState>(() => {
    const o = readOverrides();
    return auroraState(o.at ?? new Date(), hemisphere, o.kp);
  });

  useEffect(() => {
    const o = readOverrides();
    if (o.at) return; // a pinned preview time never advances
    const tick = () => setState(auroraState(new Date(), hemisphere, o.kp));
    tick();
    const id = window.setInterval(tick, 60_000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hemisphere]);

  const style = {
    "--au-strength": state.strength.toFixed(3),
    "--au-night": state.night.toFixed(3),
    "--au-crown": state.crown.toFixed(3),
    "--au-hem": state.hem.toFixed(3),
    "--au-twilight": state.twilight.toFixed(3),
    // Busier nights drift faster. Kp only changes at noon, so the duration
    // change never jumps a curtain mid-evening.
    "--au-tempo": (1 + (state.kp - 1) / 7).toFixed(3),
  } as React.CSSProperties;

  return (
    <div className="au-sky" data-phase={state.phase} data-kp={state.kp} style={style} aria-hidden="true">
      <div className="au-gradient" />
      <div className="au-stars" />
      <div className="au-stars au-stars--b" />
      <div className="au-lights">
      <div className="au-glow" />
      {curtains.map((c) => (
        <svg
          key={c.key}
          className={`au-curtain au-curtain--${c.key}`}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={`au-ray-${c.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="au-stop-crown" />
              <stop offset="0.38" className="au-stop-fade" />
              <stop offset="0.8" className="au-stop-core" />
              <stop offset="0.95" className="au-stop-edge" />
              <stop offset="1" className="au-stop-hem" />
            </linearGradient>
          </defs>
          <g fill={`url(#au-ray-${c.key})`}>
            {c.rays.map((r, i) => (
              <rect key={i} x={r.x.toFixed(1)} y={r.y.toFixed(1)} width={r.w.toFixed(1)} height={r.h.toFixed(1)} opacity={r.o.toFixed(2)} />
            ))}
          </g>
        </svg>
      ))}
      </div>
      <svg className="au-treeline" viewBox={`0 0 1000 ${VB_H}`} preserveAspectRatio="none">
        <path d={treeline} />
      </svg>
    </div>
  );
};

export default AuroraArt;
