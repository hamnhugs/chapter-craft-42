import React, { useEffect, useRef, useState } from "react";
import {
  BETA_AT, CALM_PATH, HOT_PATH, TILE, WAVE_H, bump, decay, labShift,
  type LabShift, type Stimulus,
} from "./DextersLabSignal";
import "@/styles/themes/dexters-lab-art.css";

/**
 * Dexter's Laboratory's app bar: a brainwave monitor wired to the reader.
 *
 * A phosphor trace runs the width of the bar over an oscilloscope graticule.
 * It idles in slow alpha waves; typing, clicking and scrolling pump energy
 * into it, so the trace climbs, turns magenta and spikes into beta, then
 * settles back when you stop — the lab is watching you think. On a bench
 * beside it, flasks bubble and a console's lamps blink. The lab lighting
 * follows the local clock, and after 9pm it drops into secret-lab mode.
 *
 * Decoration only: aria-hidden, pointer-events none, painted at z -1 inside
 * the header's stacking context, under every control. The trace is masked
 * out behind the wordmark and the bar's buttons so their text keeps its
 * contrast. Cost: passive input listeners that write ONE custom property
 * (no React re-render), a decay timer that runs only while there is energy
 * to decay, and a clock check once a minute. Every moving part is CSS and
 * freezes under prefers-reduced-motion (the trace still answers activity,
 * it just stops scrolling).
 */
const DextersLabArt: React.FC = () => {
  const root = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState<LabShift>(() => labShift(new Date()));

  useEffect(() => {
    const id = window.setInterval(() => setShift(labShift(new Date())), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let energy = 0;
    let band = "alpha";
    let timer: number | null = null;
    let last = performance.now();

    const paint = () => {
      const el = root.current;
      if (!el) return;
      el.style.setProperty("--dl-energy", energy.toFixed(3));
      const next = energy >= BETA_AT ? "beta" : "alpha";
      if (next !== band) {
        band = next;
        el.dataset.band = band;
      }
    };
    const tick = () => {
      const now = performance.now();
      energy = decay(energy, now - last);
      last = now;
      paint();
      if (energy === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const on = (s: Stimulus) => () => {
      if (timer === null) {
        last = performance.now();
        timer = window.setInterval(tick, 200);
      }
      energy = bump(energy, s);
      paint();
    };
    const key = on("key");
    const pointer = on("pointer");
    const wheel = on("wheel");
    const opts = { passive: true } as const;
    window.addEventListener("keydown", key, opts);
    window.addEventListener("pointerdown", pointer, opts);
    window.addEventListener("wheel", wheel, opts);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", pointer);
      window.removeEventListener("wheel", wheel);
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);

  const vb = `0 0 ${TILE * 2} ${WAVE_H}`;
  return (
    <div ref={root} className="dl-art" data-dexters-lab-art data-shift={shift} data-band="alpha" aria-hidden="true">
      <div className="dl-glass" />
      <div className="dl-sweep" />

      <div className="dl-scope">
        <div className="dl-amp">
          <div className="dl-trace dl-trace-calm">
            <svg viewBox={vb} preserveAspectRatio="none"><path d={CALM_PATH} /></svg>
          </div>
          <div className="dl-trace dl-trace-hot">
            <svg viewBox={vb} preserveAspectRatio="none"><path d={HOT_PATH} /></svg>
          </div>
        </div>
      </div>

      <svg className="dl-bench" viewBox="0 0 176 56" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="dl-liq-cyan" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5ff3ff" />
            <stop offset="1" stopColor="#00a6c4" />
          </linearGradient>
          <linearGradient id="dl-liq-mag" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ff5cad" />
            <stop offset="1" stopColor="#a1005a" />
          </linearGradient>
          <linearGradient id="dl-liq-holo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e08bff" />
            <stop offset="0.5" stopColor="#5ff3ff" />
            <stop offset="1" stopColor="#f8d878" />
          </linearGradient>
          <radialGradient id="dl-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#00eefc" stopOpacity="0.45" />
            <stop offset="1" stopColor="#00eefc" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Bench glow, under everything */}
        <ellipse className="dl-benchglow" cx="72" cy="50" rx="78" ry="16" fill="url(#dl-glow)" />

        {/* Erlenmeyer flask — cyan */}
        <g className="dl-flask">
          <path className="dl-liquid" d="M14.5 40 L29.5 40 L35 53 L9 53 Z" fill="url(#dl-liq-cyan)" />
          <path className="dl-glassline" d="M18 14 L18 27 L7 53 L37 53 L26 27 L26 14 M16 14 L28 14" />
          <g className="dl-bubbles" style={{ "--dl-bx": "0px" } as React.CSSProperties}>
            <circle cx="20" cy="47" r="1.6" style={{ animationDelay: "0s" }} />
            <circle cx="24" cy="49" r="1.1" style={{ animationDelay: "-0.9s" }} />
            <circle cx="22" cy="45" r="1.3" style={{ animationDelay: "-1.7s" }} />
          </g>
        </g>

        {/* Round-bottom flask — magenta, on its ring stand */}
        <g className="dl-flask">
          <path className="dl-liquid" d="M48.3 37 A10.5 10.5 0 1 0 67.7 37 Z" fill="url(#dl-liq-mag)" />
          <path className="dl-glassline" d="M55 12 L55 29.4 A12 12 0 1 0 61 29.4 L61 12 M53 12 L63 12" />
          <path className="dl-stand" d="M46 53.5 L70 53.5 M50 53.5 L52 49 M66 53.5 L64 49" />
          <g className="dl-bubbles">
            <circle cx="56" cy="44" r="1.4" style={{ animationDelay: "-0.4s" }} />
            <circle cx="60" cy="46" r="1" style={{ animationDelay: "-1.3s" }} />
            <circle cx="58" cy="42" r="1.2" style={{ animationDelay: "-2.1s" }} />
          </g>
        </g>

        {/* Test-tube rack */}
        <g className="dl-tubes">
          <rect className="dl-liquid" x="80.6" y="36" width="4.8" height="13" rx="2.4" fill="#f8d878" />
          <rect className="dl-liquid" x="88.6" y="30" width="4.8" height="19" rx="2.4" fill="url(#dl-liq-holo)" />
          <rect className="dl-liquid" x="96.6" y="40" width="4.8" height="9" rx="2.4" fill="#5ff3ff" />
          <path className="dl-glassline" d="M80 22 L80 49 A3 3 0 0 0 86 49 L86 22 M88 18 L88 49 A3 3 0 0 0 94 49 L94 18 M96 24 L96 49 A3 3 0 0 0 102 49 L102 24" />
          <path className="dl-rack" d="M76 33 L106 33 M76 53.5 L106 53.5 M77 33 L77 53.5 M105 33 L105 53.5" />
        </g>

        {/* The console: a lamp bank and a band readout */}
        <g className="dl-console">
          <rect className="dl-panel" x="114" y="20" width="58" height="33.5" rx="2" />
          <rect className="dl-screen" x="118" y="24" width="50" height="12" rx="1" />
          <text className="dl-readout dl-readout-alpha" x="121" y="32.6">EEG α CALM</text>
          <text className="dl-readout dl-readout-beta" x="121" y="32.6">EEG β FOCUS</text>
          <g className="dl-lamps">
            <rect x="119" y="41" width="5" height="4" style={{ animationDelay: "0s" }} />
            <rect x="127" y="41" width="5" height="4" style={{ animationDelay: "-0.7s" }} />
            <rect x="135" y="41" width="5" height="4" style={{ animationDelay: "-1.9s" }} />
            <rect x="143" y="41" width="5" height="4" style={{ animationDelay: "-0.3s" }} />
            <rect x="151" y="41" width="5" height="4" style={{ animationDelay: "-2.6s" }} />
            <circle className="dl-secret" cx="163" cy="45.5" r="2.6" />
          </g>
          <path className="dl-dial" d="M119 49.5 L158 49.5" />
        </g>
      </svg>

      <div className="dl-rail" />
    </div>
  );
};

export default DextersLabArt;
