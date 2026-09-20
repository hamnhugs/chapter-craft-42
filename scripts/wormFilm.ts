/**
 * Filmstrip harness — the animator's contact sheet.
 *
 * A pose sheet shows whether the worm can hold a shape. It says nothing about
 * whether the motion between shapes has weight, anticipation or follow-through,
 * which is the part that is actually hard. This steps the real WormAnimator at
 * a fixed 60fps and lays consecutive frames out left to right, so timing can be
 * read off the page like an animator's exposure sheet.
 *
 *   npx vite-node scripts/wormFilm.ts -- <clip> [everyNthFrame]
 */
import { writeFileSync } from "fs";
import { poseWorm, VIEW_W, VIEW_H, type Ink, type Shape } from "../src/lib/sprite/wormGeometry";
import { WormAnimator, type Mood } from "../src/lib/sprite/wormAnimator";

const HEX: Record<Ink, string> = {
  body: "#DD7C58", bodyAlt: "#C9683F", pupil: "#2B1B15", spec: "#FFF6EE", mouth: "#2B1B15",
  tongue: "#F4A58C", brow: "#2B1B15", glass: "#FFF6EE", frame: "#2B1B15", shadow: "#000000",
};

const svg = (s: Shape): string => {
  const a: string[] = [s.fill ? `fill="${HEX[s.fill]}"` : 'fill="none"'];
  if (s.stroke) a.push(`stroke="${HEX[s.stroke]}"`);
  if (s.sw != null) a.push(`stroke-width="${s.sw}"`);
  if (s.op != null) a.push(`opacity="${s.op}"`);
  if (s.cap) a.push('stroke-linecap="round" stroke-linejoin="round"');
  const at = a.join(" ");
  if (s.k === "path") return `<path d="${s.d}" ${at}/>`;
  if (s.k === "circle") return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${at}/>`;
  const rot = s.rot ? ` transform="rotate(${s.rot} ${s.cx} ${s.cy})"` : "";
  return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"${rot} ${at}/>`;
};

/** A clip is a schedule: at time t (seconds), do something. */
type Beat = { t: number; mood?: Mood; pop?: number; nod?: number; glint?: boolean; clause?: boolean; topic?: boolean; pet?: boolean };
interface Clip { dur: number; beats: Beat[]; voice?: (t: number) => number; reduced?: boolean }

const CLIPS: Record<string, Clip> = {
  // Anticipation should be visible: frames 1-5 go DOWN before the rise.
  pop: { dur: 1.1, beats: [{ t: 0.1, pop: 1 }] },
  // The whole arc of a turn, as the user would actually experience it.
  turn: {
    dur: 9,
    beats: [
      { t: 0.4, mood: "watch" },
      { t: 1.8, mood: "think" },
      { t: 2.4, glint: true },
      { t: 4.0, mood: "read", topic: true },
      { t: 4.9, clause: true },
      { t: 5.6, clause: true },
      { t: 6.2, mood: "cheer", pop: 1 },
      { t: 7.2, mood: "idle" },
    ],
  },
  // Synthetic speech envelope: syllables at ~4.5Hz with a slow phrase contour,
  // which is roughly the rate of English running speech.
  speak: {
    dur: 3.2,
    beats: [
      { t: 0.1, mood: "speak" },
      { t: 1.1, clause: true },
      { t: 2.2, clause: true },
    ],
    voice: (t) => {
      if (t < 0.15) return 0;
      const syl = Math.max(0, Math.sin(t * 4.5 * Math.PI * 2));
      const phrase = 0.55 + 0.45 * Math.sin(t * 0.7);
      return Math.pow(syl, 0.6) * phrase;
    },
  },
  pet: { dur: 2.6, beats: [{ t: 0.05, mood: "read" }, { t: 0.45, pet: true }] },
  fuss: { dur: 3.2, beats: [{ t: 0.05, mood: "idle" }, { t: 0.4, pet: true }, { t: 0.75, pet: true }, { t: 1.1, pet: true }] },
  wake: { dur: 3.5, beats: [{ t: 0.05, mood: "sleep" }, { t: 1.5, mood: "idle" }] },
  fail: { dur: 3.5, beats: [{ t: 0.05, mood: "think" }, { t: 1.4, mood: "oops" }, { t: 3.0, mood: "idle" }] },
  listen: { dur: 3.5, beats: [{ t: 0.05, mood: "idle" }, { t: 0.8, mood: "listen" }] },
  reduced: { dur: 4, reduced: true, beats: [{ t: 0.3, mood: "think" }, { t: 1.6, mood: "speak" }, { t: 2.8, mood: "cheer", pop: 1 }] },
};

const name = process.argv[2] || "pop";
const every = Number(process.argv[3] || 3);
const clip = CLIPS[name];
if (!clip) throw new Error(`no clip "${name}" — have: ${Object.keys(CLIPS).join(", ")}`);

// A fixed seed, so a filmstrip is the same picture every time it is rendered
// and a change in it means a change in the animator, not a change in the dice.
let seed = 12345;
const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const anim = new WormAnimator({ rng, mood: clip.beats[0]?.mood ?? "idle", reduced: clip.reduced });
const DT = 1000 / 60;
const frames: string[] = [];
let t = 0;
let next = 0;
for (let i = 0; t < clip.dur; i++, t += DT / 1000) {
  while (next < clip.beats.length && clip.beats[next].t <= t) {
    const b = clip.beats[next++];
    if (b.mood) anim.setMood(b.mood);
    if (b.pop) anim.pop(b.pop);
    if (b.nod) anim.nod(b.nod);
    if (b.glint) anim.glint();
    if (b.clause) anim.clause();
    if (b.topic) anim.topicChange();
    if (b.pet) anim.pet();
  }
  if (clip.voice) anim.setVoice(clip.voice(t));
  const params = anim.step(DT);
  if (i % every !== 0) continue;
  const pose = poseWorm(params);
  frames.push(
    `<rect width="${VIEW_W}" height="${VIEW_H}" fill="#14110F"/>` +
      pose.shapes.map(svg).join("") +
      `<text x="3" y="10" fill="#6f6a66" font-size="7" font-family="monospace">${t.toFixed(2)}</text>`,
  );
}

const cols = Math.min(10, frames.length);
const rows = Math.ceil(frames.length / cols);
const body = frames
  .map((c, i) => `<g transform="translate(${(i % cols) * VIEW_W} ${Math.floor(i / cols) * VIEW_H})">${c}</g>`)
  .join("");
const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * VIEW_W}" height="${rows * VIEW_H}" viewBox="0 0 ${cols * VIEW_W} ${rows * VIEW_H}">${body}</svg>`;
writeFileSync(`/tmp/worm/film-${name}.svg`, out);
console.log(`film-${name}: ${frames.length} frames (every ${every}) over ${clip.dur}s`);
