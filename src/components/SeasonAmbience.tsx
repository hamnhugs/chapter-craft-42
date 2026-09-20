import React, { useCallback, useEffect, useRef } from "react";

/**
 * The light show behind the Showcase.
 *
 * Three layers, none of which is authored per season: raking light shafts, an
 * aurora curtain, and a drift of motes. Everything they need is read from the
 * CSS custom properties the seasonal theme layer publishes — `--season-glow`,
 * `--season-mote`, `--season-elevation`, `--season-aurora`, `--season-drift`,
 * `--season-tempo`, `--season-polarity`. Switch theme and the whole show
 * restains; switch the season off and it renders nothing. There is no seasonal
 * art in this file, which is the point: art would have to be drawn four times
 * and would only ever suit one theme.
 *
 * What makes it read as a season rather than as a screensaver is that each
 * layer is driven by something real:
 *
 *  - The shafts rake along the sun's actual elevation, about 22 degrees at
 *    midwinter and 68 at midsummer. Low sideways light is most of why a winter
 *    afternoon looks like a winter afternoon.
 *  - The curtain is an aurora, so it rises as the daylight falls and is simply
 *    gone in high summer. That is `-light`, nothing more.
 *  - The motes drift along the *rate of change* of daylight, so they rise
 *    while the days are lengthening and fall while they shorten, and hang
 *    almost still at the solstices when the year itself pauses. Nobody
 *    authored "leaves fall in autumn".
 *
 * Polarity matters and is the one thing that cannot be finessed: light added
 * to black reads as light, and light added to Fruit Stripe's paper white reads
 * as nothing at all. On a dark canvas the show composites additively in the
 * theme's glow colour; on a light one it composites normally in the mote
 * colour, which the theme layer guarantees is darker than the page — so it
 * arrives as coloured haze rather than as an invisible wash.
 *
 * Cost: the two light layers are drawn into an offscreen buffer no wider than
 * 320px and scaled up. They are nothing but smooth gradients, so the upscale
 * is invisible, and it keeps a full-viewport light show at a few thousand
 * pixels of actual fill per frame. Only the motes, which are small and want to
 * be sharp, are drawn at real resolution.
 *
 * WCAG 2.2.2 and 2.3.3: the caller owns a real pause control, and under
 * prefers-reduced-motion this paints one still frame and never starts a loop.
 */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/** Widest the gradient buffer ever gets. Beyond this it is pure waste. */
const FIELD_MAX_W = 320;
/** Overlapping curtains. Three is enough to stop the waves ever repeating. */
const CURTAINS = 3;
/** Points sampled along a curtain's edge. */
const CURTAIN_STEPS = 40;
const SHAFTS = 3;

function readReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
}

interface Mote {
  x: number; y: number;      // 0..1, resolution-independent
  r: number;                 // radius in CSS px at 1x
  phase: number;             // sway offset
  sway: number;              // sway amplitude
  speed: number;             // vertical rate multiplier
}

/** Deterministic PRNG so a given field is stable across re-renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildField(count: number, seed: number): Mote[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    x: rnd(),
    y: rnd(),
    r: 0.7 + rnd() * 2.1,
    phase: rnd() * Math.PI * 2,
    sway: 0.2 + rnd() * 0.8,
    speed: 0.55 + rnd() * 0.9,
  }));
}

const readVar = (name: string, fallback: number): number => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const readColor = (name: string, fallback: string): string => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
};

interface FieldParams {
  elevation: number;  // degrees above the horizon
  aurora: number;     // 0..1
  bloom: number;      // 0..1, the bright end of the year
  tempo: number;
  color: string;      // bare HSL triplet
  t: number;          // seconds
}

/**
 * Both gradient layers, into the small offscreen buffer. Drawn in plain
 * source-over at low alpha; the *caller* decides how the finished buffer meets
 * the page, because that is what depends on the theme being light or dark.
 */
function drawLightField(ctx: CanvasRenderingContext2D, w: number, h: number, p: FieldParams): void {
  ctx.clearRect(0, 0, w, h);
  const fill = `hsl(${p.color})`;

  // ---- raking shafts, along the sun's elevation ----
  //
  // Laid out in the *rotated* frame and spread across the diagonal, not across
  // the canvas height. Spacing them by height looked right at midwinter's 22
  // degrees, where the shafts run nearly horizontal and cross everything, and
  // quietly emptied the frame at midsummer's 68, where they run steeply and
  // most of them fell outside it. Summer is not supposed to be the season with
  // less light in it.
  const span = Math.hypot(w, h) * 1.4;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((p.elevation * Math.PI) / 180);
  for (let i = 0; i < SHAFTS; i++) {
    const phase = p.t * 0.06 * p.tempo + i * 2.1;
    const centre = (i / SHAFTS - 0.5) * span + Math.sin(phase) * span * 0.12;
    const half = span * 0.055 * (0.7 + 0.5 * Math.sin(phase * 0.7 + i));
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
  // Anchored where the light is coming *from*, so it sits where the shafts
  // enter rather than in an arbitrary corner.
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
  // Drawn as overlapping smooth paths rather than a row of vertical strips.
  // Strips were the obvious way to get a wavy edge and they banded badly: each
  // one carries a single alpha across its width, and the 4x upscale turned
  // that into hard vertical stripes. Three clipped paths at different phases
  // give the same shimmer with no seam in it, and cost less.
  if (p.aurora > 0.02) {
    for (let k = 0; k < CURTAINS; k++) {
      const phase = p.t * (0.22 + k * 0.09) * p.tempo + k * 2.4;
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

const SeasonAmbience: React.FC<{
  /** False freezes the show without unmounting it, for the pause control. */
  running?: boolean;
  className?: string;
}> = ({ running = true, className = "" }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef<Mote[]>([]);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const clockRef = useRef<number>(0);
  const reducedRef = useRef<boolean>(readReduced());

  const draw = useCallback((dtSeconds: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Two ways a 2D context can be refused: null (jsdom, and any browser
    // without canvas) or a throw (anti-fingerprinting extensions that block
    // canvas readout). Ambience is the last thing that should be allowed to
    // take the view down with it, so both are treated as "draw nothing".
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext("2d"); } catch { return; }
    if (!ctx) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    // Cap the backing store at 2x: past that the motes cost real time on a
    // phone and look identical.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    clockRef.current += dtSeconds;
    const t = clockRef.current;

    const drift = readVar("--season-drift", 0);
    const light = readVar("--season-light", 0);
    const tempo = readVar("--season-tempo", 1);
    const elevation = readVar("--season-elevation", 45);
    const aurora = readVar("--season-aurora", 0);
    const onDark = readVar("--season-polarity", 1) > 0.5;
    const glow = readColor("--season-glow", "0 0% 60%");
    const mote = readColor("--season-mote", "0 0% 60%");

    // ---- the two gradient layers, via the small buffer ----
    let off = offscreenRef.current;
    if (!off) { off = document.createElement("canvas"); offscreenRef.current = off; }
    const ow = Math.max(32, Math.min(FIELD_MAX_W, Math.round(w / 4)));
    const oh = Math.max(32, Math.round((ow * h) / Math.max(w, 1)));
    if (off.width !== ow || off.height !== oh) { off.width = ow; off.height = oh; }
    let octx: CanvasRenderingContext2D | null = null;
    try { octx = off.getContext("2d"); } catch { octx = null; }

    if (octx) {
      // On paper the show has to darken to be seen at all, and the mote colour
      // is the one the theme layer guarantees sits away from the background.
      drawLightField(octx, ow, oh, {
        elevation, aurora, bloom: Math.max(0, light), tempo, t,
        color: onDark ? glow : mote,
      });
      ctx.save();
      ctx.globalCompositeOperation = onDark ? "lighter" : "source-over";
      ctx.globalAlpha = onDark ? 0.8 : 0.42;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, w, h);
      ctx.restore();
    }

    // ---- motes, at real resolution ----
    const softness = (light + 1) / 2;
    const now = t;

    for (const m of fieldRef.current) {
      m.y += drift * m.speed * tempo * 0.035 * dtSeconds;
      // Wrap rather than respawn, so a paused field is a still field and not a
      // field that jumps when it resumes.
      if (m.y > 1.05) m.y -= 1.1;
      if (m.y < -0.05) m.y += 1.1;

      const sway = Math.sin(now * 0.35 * tempo + m.phase) * m.sway * (0.006 + softness * 0.012);
      const px = (m.x + sway) * w;
      const py = m.y * h;
      const r = m.r * (0.8 + softness * 0.6);

      // Opacity fades at the edges so nothing pops in or out at a boundary.
      const edge = Math.min(1, Math.min(m.y, 1 - m.y) * 6);
      ctx.globalAlpha = Math.max(0, 0.10 + softness * 0.16) * edge;
      ctx.fillStyle = `hsl(${mote})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, []);

  // Build the field once per mount, sized by the season's brightness.
  useEffect(() => {
    const light = readVar("--season-light", 0);
    const count = Math.round(26 + ((light + 1) / 2) * 26);
    fieldRef.current = buildField(count, 0x5EA50);
    draw(0);
  }, [draw]);

  useEffect(() => {
    const shouldRun = running && !reducedRef.current;
    if (!shouldRun) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      draw(0); // one still frame, so a paused or reduced show is still a show
      return;
    }
    lastRef.current = performance.now();
    const loop = (t: number) => {
      // Clamped so a backgrounded tab does not resume with one enormous step.
      const dt = Math.min((t - lastRef.current) / 1000, 0.1);
      lastRef.current = t;
      draw(dt);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [running, draw]);

  // prefers-reduced-motion is watched, not merely read at mount: the media
  // query only governs CSS on its own, and this loop is JS.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mq: MediaQueryList;
    try { mq = window.matchMedia(REDUCE_QUERY); } catch { return; }
    const onChange = () => {
      reducedRef.current = mq.matches;
      if (mq.matches && rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        draw(0);
      }
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 w-full h-full ${className}`}
    />
  );
};

export default SeasonAmbience;
