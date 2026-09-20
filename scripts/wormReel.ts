/**
 * The reel — one scripted conversation, rendered frame by frame.
 *
 * The sheets answer "can it hold a pose"; the filmstrip answers "does one beat
 * have weight". Neither shows the things that only exist over seconds: a
 * syllable travelling down the beads, the glasses being pushed on, thought
 * pulses climbing the body. This steps the real animator through a whole turn —
 * idle, the user types, it thinks, the reply streams, it speaks, it lands — in
 * both the daylight palette and the pocket screen's, side by side.
 *
 *   npx vite-node scripts/wormReel.ts
 *   cd /tmp/worm/reel && for f in *.svg; do rsvg-convert -z 2 $f -o ${f%.svg}.png; done
 *   ffmpeg -y -framerate 30 -i %04d.png -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse" ../reel.gif
 */
import { mkdirSync, writeFileSync } from "fs";
import { poseWorm, VIEW_W, VIEW_H, type Ink, type Shape } from "../src/lib/sprite/wormGeometry";
import { WormAnimator, type Mood } from "../src/lib/sprite/wormAnimator";

const DAY: Record<Ink, string> = {
  body: "#DD7C58", bodyAlt: "#C9683F", pupil: "#2B1B15", spec: "#FFF6EE", mouth: "#2B1B15",
  tongue: "#F4A58C", brow: "#2B1B15", glass: "#FFF6EE", frame: "#2B1B15", shadow: "#000000",
};
/** Mirrors DIM_WORM in PocketScreen.tsx. */
const POCKET: Record<Ink, string> = {
  body: "#3B2117", bodyAlt: "#2C1810", pupil: "#000000", spec: "#B08A7A", mouth: "#000000",
  tongue: "#5A3328", brow: "#000000", glass: "#6B4536", frame: "#7C5243", shadow: "#000000",
};

const draw = (hex: Record<Ink, string>, hideShadow: boolean) => (s: Shape): string => {
  if (hideShadow && s.key === "shadow") return "";
  const a: string[] = [s.fill ? `fill="${hex[s.fill]}"` : 'fill="none"'];
  if (s.stroke) a.push(`stroke="${hex[s.stroke]}"`);
  if (s.sw != null) a.push(`stroke-width="${s.sw}"`);
  if (s.op != null) a.push(`opacity="${s.op}"`);
  if (s.cap) a.push('stroke-linecap="round" stroke-linejoin="round"');
  const at = a.join(" ");
  if (s.k === "path") return `<path d="${s.d}" ${at}/>`;
  if (s.k === "circle") return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${at}/>`;
  const rot = s.rot ? ` transform="rotate(${s.rot} ${s.cx} ${s.cy})"` : "";
  return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"${rot} ${at}/>`;
};

const SCRIPT: { t: number; mood: Mood; pop?: number }[] = [
  { t: 0, mood: "idle" },
  { t: 1.2, mood: "watch" },
  { t: 3.0, mood: "think" },
  { t: 5.4, mood: "read" },
  { t: 7.2, mood: "speak" },
  { t: 11.0, mood: "cheer", pop: 1 },
  { t: 12.4, mood: "idle" },
];
const END = 14;
const FPS = 30;

/** A stand-in for speech: syllables at ~4.5 Hz in phrases with gaps, each with
 *  its own loudness. Not audio, but shaped like the envelope the tap produces. */
function speech(t: number): { level: number; wide: number } {
  const phrase = (t % 1.9) < 1.45 ? 1 : 0;
  const syl = Math.pow(Math.max(0, Math.sin(t * Math.PI * 4.5)), 1.6);
  const loud = 0.55 + 0.45 * Math.sin(t * 7.3 + 1) * Math.sin(t * 2.1);
  return { level: phrase * syl * loud, wide: Math.sin(t * 3.7) };
}

let seed = 4242;
const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const a = new WormAnimator({ rng, mood: "idle" });
mkdirSync("/tmp/worm/reel", { recursive: true });

let next = 0;
let frame = 0;
const sub = 1000 / 120;
for (let t = 0; t < END; t += 1 / FPS) {
  while (next < SCRIPT.length && SCRIPT[next].t <= t) {
    a.setMood(SCRIPT[next].mood);
    if (SCRIPT[next].pop) a.pop(SCRIPT[next].pop);
    next++;
  }
  let p = a.step(0);
  for (let k = 0; k < 4; k++) {
    if (a.getMood() === "speak") {
      const v = speech(t + (k * sub) / 1000);
      a.setVoice(v.level, v.wide);
    }
    p = a.step(sub);
  }
  const shapes = poseWorm(p).shapes;
  const W = VIEW_W * 2;
  writeFileSync(
    `/tmp/worm/reel/${String(frame++).padStart(4, "0")}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${VIEW_H}" viewBox="0 0 ${W} ${VIEW_H}">` +
      `<rect width="${VIEW_W}" height="${VIEW_H}" fill="#F4EFE6"/>` +
      shapes.map(draw(DAY, false)).join("") +
      `<g transform="translate(${VIEW_W} 0)"><rect width="${VIEW_W}" height="${VIEW_H}" fill="#000"/>` +
      shapes.map(draw(POCKET, true)).join("") +
      `</g><text x="4" y="10" fill="#9a8f84" font-size="7" font-family="monospace">${a.getMood()} ${t.toFixed(2)}s</text></svg>`,
  );
}
console.log(`wrote ${frame} frames to /tmp/worm/reel`);
