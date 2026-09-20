import React, { useCallback, useEffect, useRef } from "react";
import { getTheme } from "@/lib/themes";
import { seasonalTheme } from "@/lib/seasonTheme";
import { oklchToHex } from "@/lib/oklch";
import { useTheme } from "@/context/ThemeContext";

/**
 * The seasonal backdrop behind the Showcase. A still image, painted once.
 *
 * It used to animate, and that was wrong twice over. The user didn't want the
 * motion, and the motion was also what made the Vault unusable: the draw loop
 * read its inputs back off the document with getComputedStyle, eight times a
 * frame at 60fps. Every one of those forces the browser to flush style for the
 * whole document, and the Vault can hold hundreds of book rows — several
 * hundred forced style recalculations a second, which locks the tab.
 *
 * Both problems have the same fix, so there is now no requestAnimationFrame,
 * no interval, no timer, and no DOM read anywhere in this file. The scalars
 * come from seasonalTheme() as numbers, and the canvas is repainted only when
 * the theme changes, the season changes, or the element is resized.
 *
 * What is drawn is unchanged, because the look was the part that worked:
 *
 *  - Shafts rake along the sun's real elevation, about 22 degrees at midwinter
 *    and 68 at midsummer. Low sideways light is most of why a winter afternoon
 *    looks like a winter afternoon.
 *  - An aurora curtain rises as the daylight falls, and is gone in high summer,
 *    because that is what aurorae do.
 *  - A bloom answers it at the bright end of the year.
 *
 * None of it is authored per season and nothing here branches on which season
 * it is; it is all a function of one angle. Polarity is the one thing that
 * cannot be finessed: light added to black reads as light, light added to
 * paper white reads as nothing, so on a light theme the field composites
 * normally in the mote colour instead of additively in the glow colour.
 */

/** Widest the gradient buffer ever gets. Beyond this it is pure waste. */
const FIELD_MAX_W = 320;
/** Overlapping curtains. Three is enough to stop the waves ever repeating. */
const CURTAINS = 3;
/** Points sampled along a curtain's edge. */
const CURTAIN_STEPS = 40;
const SHAFTS = 3;

interface FieldParams {
  elevation: number;  // degrees above the horizon
  aurora: number;     // 0..1
  bloom: number;      // 0..1
  color: string;      // any CSS colour
}

/**
 * Both gradient layers, into a small offscreen buffer. Drawn in plain
 * source-over at low alpha; the caller decides how the finished buffer meets
 * the page, because that is what depends on the theme being light or dark.
 */
function drawLightField(
  ctx: CanvasRenderingContext2D, w: number, h: number, p: FieldParams,
): void {
  ctx.clearRect(0, 0, w, h);
  const fill = p.color;

  // ---- raking shafts, along the sun's elevation ----
  //
  // Laid out in the *rotated* frame and spread across the diagonal, not across
  // the canvas height. Spacing them by height looked right at midwinter's 22
  // degrees, where the shafts run nearly horizontal and cross everything, and
  // quietly emptied the frame at midsummer's 68, where they run steeply and
  // most of them fell outside it.
  const span = Math.hypot(w, h) * 1.4;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((p.elevation * Math.PI) / 180);
  for (let i = 0; i < SHAFTS; i++) {
    const centre = (i / SHAFTS - 0.5) * span + Math.sin(i * 2.1) * span * 0.12;
    const half = span * 0.055 * (0.7 + 0.5 * Math.sin(i * 1.47));
    const g = ctx.createLinearGradient(0, centre - half, 0, centre + half);
    g.addColorStop(0, "transparent");
    g.addColorStop(0.5, fill);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.34;
    ctx.fillRect(-span / 2, centre - half, span, half * 2);
  }
  ctx.restore();

  // ---- high-summer bloom ----
  // The counterweight to the aurora: one is the dark end of the year, this is
  // the bright end, and between them no week is without a light of its own.
  if (p.bloom > 0.02) {
    const rad = (p.elevation * Math.PI) / 180;
    const cx = w * 0.5 - Math.cos(rad) * w * 0.55;
    const cy = h * 0.5 - Math.sin(rad) * h * 0.85;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) * 0.75);
    g.addColorStop(0, fill);
    g.addColorStop(0.45, fill);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.globalAlpha = p.bloom * 0.3;
    ctx.fillRect(0, 0, w, h);
  }

  // ---- aurora curtain, present only as the daylight goes ----
  //
  // Overlapping smooth paths rather than a row of vertical strips. Strips were
  // the obvious way to get a wavy edge and they banded badly: each one carries
  // a single alpha across its width, and the upscale turned that into hard
  // vertical stripes.
  if (p.aurora > 0.02) {
    for (let k = 0; k < CURTAINS; k++) {
      const phase = k * 2.4;
      const amp = h * (0.06 + k * 0.025);
      const height = h * (0.46 + k * 0.1);
      const top = h * (0.02 + k * 0.05);
      const edge = (x: number) =>
        top +
        Math.sin(x * 0.055 + phase) * amp +
        Math.sin(x * 0.019 - phase * 0.55) * amp * 1.4;

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i <= CURTAIN_STEPS; i++) {
        const x = (i / CURTAIN_STEPS) * w;
        const y = edge(x);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = CURTAIN_STEPS; i >= 0; i--) {
        const x = (i / CURTAIN_STEPS) * w;
        ctx.lineTo(x, edge(x) + height);
      }
      ctx.closePath();
      ctx.clip();

      const g = ctx.createLinearGradient(0, top - amp * 2, 0, top + height);
      g.addColorStop(0, "transparent");
      g.addColorStop(0.3, fill);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.globalAlpha = p.aurora * (0.3 - k * 0.06);
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

const SeasonAmbience: React.FC<{ className?: string }> = ({ className = "" }) => {
  const { themeId, season, seasonal } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Two ways a 2D context can be refused: null (jsdom, and any browser
    // without canvas) or a throw (anti-fingerprinting extensions that block
    // canvas readout). A backdrop is the last thing that should be allowed to
    // take the view down with it, so both mean "draw nothing".
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext("2d"); } catch { return; }
    if (!ctx) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    // Cap the backing store at 2x; past that it costs real time and looks the
    // same. The gradients themselves are drawn far smaller still.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!seasonal) return;

    const s = seasonalTheme(getTheme(themeId), season);

    // Drawn small and scaled up: these are nothing but smooth gradients, so
    // the upscale is invisible and the whole field costs a few thousand
    // pixels of fill instead of a few million.
    const off = document.createElement("canvas");
    const ow = Math.max(32, Math.min(FIELD_MAX_W, Math.round(w / 4)));
    off.width = ow;
    off.height = Math.max(32, Math.round((ow * h) / Math.max(w, 1)));
    let octx: CanvasRenderingContext2D | null = null;
    try { octx = off.getContext("2d"); } catch { octx = null; }
    if (!octx) return;

    drawLightField(octx, off.width, off.height, {
      elevation: s.elevation,
      aurora: s.aurora,
      bloom: s.bloom,
      // On paper the field has to darken to be seen at all, and the mote
      // colour is the one the theme layer guarantees sits away from the page.
      color: oklchToHex(s.onDark ? s.glow : s.mote),
    });

    ctx.save();
    ctx.globalCompositeOperation = s.onDark ? "lighter" : "source-over";
    ctx.globalAlpha = s.onDark ? 0.8 : 0.42;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, w, h);
    ctx.restore();
  }, [themeId, season, seasonal]);

  // Repaint on the only three things that can change what it looks like.
  useEffect(() => { paint(); }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [paint]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 w-full h-full ${className}`}
    />
  );
};

export default SeasonAmbience;
