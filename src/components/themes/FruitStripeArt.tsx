import React, { useEffect, useMemo, useState } from "react";
import { currentHour, wrapperAt, wrapperStripes } from "./fruitStripeClock";
import "@/styles/themes/fruit-stripe-art.css";

/**
 * Fruit Stripe's app bar: a five-flavour gum wrapper, printed on paper.
 *
 * Pastel diagonal stripes run across the open middle of the bar the way they
 * run round a stick of gum, with a halftone screen over them like cheap
 * mid-century print. The wrapper is alive in two slow ways:
 *
 *  - It follows the clock. The flavour of the hour (lemon at breakfast, lime
 *    at midday, tangerine in the afternoon, cherry in the evening, melon after
 *    dark — fruitStripeClock.ts) prints double-width at the head of the
 *    pattern, and an atomic-age starburst in that flavour walks across the bar
 *    from morning on the left to the small hours on the right.
 *  - It drifts, very slowly, like a wrapper being drawn off the stick.
 *
 * Legibility: the stripes are pastel tints (ink on any of them ≥ 13:1, the
 * cherry-ink icons ≥ 3:1) and a mask fades them out behind the wordmark and
 * the buttons, so every control still sits on near-paper.
 *
 * Decoration only: aria-hidden, pointer-events none, z -1 inside the header's
 * isolated stacking context (same contract as VegasSky). Cost: one state
 * update a minute; the drift and the twinkle are CSS, frozen under
 * prefers-reduced-motion. No canvas, no rAF, no network.
 */
export default function FruitStripeArt() {
  const [hour, setHour] = useState(() => currentHour());

  useEffect(() => {
    const tick = () => setHour(currentHour());
    const id = window.setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const w = useMemo(() => wrapperAt(hour), [hour]);
  // The pattern only changes when the lead flavour does (five times a day).
  const stripes = useMemo(() => wrapperStripes(w.order), [w.lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const style = {
    "--fsa-lead": w.lead.ink,
    "--fsa-lead-tint": w.lead.tint,
    "--fsa-p": w.progress.toFixed(4),
    "--fsa-period": `${stripes.period}px`,
  } as React.CSSProperties;

  return (
    <div
      className="fsa"
      data-fruit-stripe-art
      data-flavor={w.lead.id}
      data-night={w.night ? "" : undefined}
      aria-hidden
      style={style}
    >
      <div className="fsa-window">
        <div className="fsa-stripes" style={{ backgroundImage: stripes.background }} />
        <div className="fsa-halftone" />
      </div>
      <svg className="fsa-star" viewBox="-12 -12 24 24" width="22" height="22">
        <g className="fsa-star-rays">
          {Array.from({ length: 8 }, (_, i) => (
            <line
              key={i}
              x1="0" y1={i % 2 ? -4.2 : -4.6}
              x2="0" y2={i % 2 ? -7.6 : -11.2}
              transform={`rotate(${i * 45})`}
            />
          ))}
        </g>
        <circle className="fsa-star-core" r="3.4" />
      </svg>
    </div>
  );
}
