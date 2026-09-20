import React, { useCallback, useEffect, useRef } from "react";

/**
 * The drifting layer behind the showcase.
 *
 * Everything it draws is read from CSS custom properties the seasonal theme
 * layer already publishes — `--season-mote`, `--season-drift`, `--season-light`,
 * `--season-tempo` — so it never decides a colour or a direction itself. Switch
 * themes and the motes restain; switch the season off and it renders nothing.
 * There is no seasonal art in this file, which is the point: art would have to
 * be authored four times and would only ever match one theme.
 *
 * The motion is one line of physics. `--season-drift` is the negated rate of
 * change of daylight, so motes rise while the days are lengthening and fall
 * while they shorten, and hang almost still at the solstices when the year
 * itself pauses. Spring and autumn look like spring and autumn without either
 * word appearing anywhere.
 *
 * WCAG 2.2.2 and 2.3.3: the caller owns a real pause control, and under
 * prefers-reduced-motion this paints one still frame and never starts a loop.
 */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

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

const SeasonAmbience: React.FC<{
  /** False freezes the field without unmounting it, for the pause control. */
  running?: boolean;
  className?: string;
}> = ({ running = true, className = "" }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef<Mote[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
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

    const drift = readVar("--season-drift", 0);
    const light = readVar("--season-light", 0);
    const tempo = readVar("--season-tempo", 1);
    const mote = readColor("--season-mote", "0 0% 60%");

    // Summer motes are soft and plentiful; winter's are small and sparse.
    const softness = (light + 1) / 2;
    const now = performance.now() / 1000;

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
      draw(0); // one still frame, so a paused or reduced field is still a field
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
