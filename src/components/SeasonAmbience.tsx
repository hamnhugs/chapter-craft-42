import React, { useMemo } from "react";
import { getTheme } from "@/lib/themes";
import { seasonalTheme } from "@/lib/seasonTheme";
import { oklchToHex } from "@/lib/oklch";
import { useTheme } from "@/context/ThemeContext";

/**
 * The season's light, behind the Showcase header. One glow. No canvas.
 *
 * This has now been three things. It shipped as an animated light show, which
 * locked the Vault: the draw loop read its inputs back with getComputedStyle
 * sixty times a second. It then became a still canvas of the same picture —
 * raking shafts, an aurora curtain, a bloom — and that fixed the hang and not
 * the look: three diagonal smears of colour ran straight through the book's
 * title and summary, so the one thing the view exists to show was the thing
 * being drawn on.
 *
 * What is left is what the picture was FOR. The header's bottom rule is the
 * year, with a marker at today (see YearBand in LibraryShowcase), and this is
 * the light at that marker: a single soft dome rising off the rule at exactly
 * `at`, and nowhere else. It is confined to the header, so nothing is ever
 * painted behind text that has to be read.
 *
 * The year still shapes it, as numbers from the theme layer and never as a
 * branch on a season's name:
 *
 *  - HEIGHT follows the sun's real noon elevation, about 22 degrees at
 *    midwinter and 68 at midsummer — a low flat glow in December, a tall one
 *    in June.
 *  - WIDTH runs the other way, because low light is long light.
 *  - STRENGTH leans on whichever end of the year is nearer, so the equinoxes
 *    are the quietest weeks and neither solstice is dark.
 *
 * Polarity cannot be finessed: light added to black reads as light, light
 * added to paper reads as nothing. On a dark theme the glow colour is screened
 * over the surface; on a light one the mote colour — the one the theme layer
 * guarantees sits away from the page — is multiplied into it.
 *
 * A CSS gradient rather than a canvas because that is all it is. No context to
 * be refused, no backing store to size, no ResizeObserver, no repaint: the
 * browser rasterises it once and the component is a memo and a div.
 */
const SeasonAmbience: React.FC<{
  /** Where along the width the light stands, 0..1 — the year marker. */
  at: number;
  className?: string;
}> = ({ at, className = "" }) => {
  const { themeId, season, seasonal } = useTheme();

  const style = useMemo<React.CSSProperties | null>(() => {
    if (!seasonal) return null;
    const s = seasonalTheme(getTheme(themeId), season);
    const color = oklchToHex(s.onDark ? s.glow : s.mote);
    // 22..68 degrees onto 0..1.
    const high = Math.min(1, Math.max(0, (s.elevation - 22) / 46));
    const rx = 46 - 18 * high;   // % of width: long when the sun is low
    const ry = 120 + 110 * high; // % of header height: tall when it is high
    const strength = 0.55 + 0.45 * Math.max(s.aurora, s.bloom);
    const peak = Math.round((s.onDark ? 0.34 : 0.2) * strength * 255).toString(16).padStart(2, "0");
    const mid = Math.round((s.onDark ? 0.1 : 0.06) * strength * 255).toString(16).padStart(2, "0");
    const x = (Math.min(1, Math.max(0, at)) * 100).toFixed(2);
    return {
      backgroundImage: `radial-gradient(ellipse ${rx.toFixed(1)}% ${ry.toFixed(0)}% at ${x}% 100%, ${color}${peak} 0%, ${color}${mid} 45%, transparent 100%)`,
      mixBlendMode: s.onDark ? "screen" : "multiply",
    };
  }, [themeId, season, seasonal, at]);

  if (!style) return null;
  return <div aria-hidden className={`pointer-events-none absolute inset-0 ${className}`} style={style} />;
};

export default SeasonAmbience;
