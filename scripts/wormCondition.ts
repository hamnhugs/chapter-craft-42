/**
 * Contact sheet for the worm's CONDITION: the same worm at a run of health
 * numbers, in a few moods, settled by the real animator.
 *
 *   npx vite-node scripts/wormCondition.ts -- <out.svg>
 */
import { writeFileSync } from "fs";
import { poseWorm, VIEW_W, VIEW_H, type Ink, type Shape } from "../src/lib/sprite/wormGeometry";
import { WormAnimator, scruffOf, type Mood } from "../src/lib/sprite/wormAnimator";

const mix = (a: string, b: string, t: number) => {
  const h = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(h(a, i) + (h(b, i) - h(a, i)) * t).toString(16).padStart(2, "0")).join("");
};

function hex(health: number): Record<Ink, string> {
  const g = scruffOf(health) * 0.46;
  return {
    body: mix("#4fd69c", "#8b8274", g), bodyAlt: mix("#2fb37f", "#6f675b", g), pupil: "#0d0b26", spec: "#f4f0ff",
    mouth: "#0d0b26", tongue: "#ff8fc2", brow: "#0d0b26", glass: "#f4f0ff", frame: "#0d0b26", shadow: "#000000",
    hat: "#5d5f73", hatAlt: "#474859", patch: "#c9a25a", spark: "#ffd166",
  };
}

function svgOf(s: Shape, HEX: Record<Ink, string>): string {
  const a: string[] = [s.fill ? `fill="${HEX[s.fill]}"` : 'fill="none"'];
  if (s.stroke) a.push(`stroke="${HEX[s.stroke]}"`);
  if (s.sw != null) a.push(`stroke-width="${s.sw}"`);
  if (s.op != null) a.push(`opacity="${s.op}"`);
  if (s.cap) a.push('stroke-linecap="round" stroke-linejoin="round"');
  const at = a.join(" ");
  if (s.k === "path") return `<path d="${s.d}" ${at}/>`;
  if (s.k === "circle") return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${at}/>`;
  return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${s.rot ? `transform="rotate(${s.rot} ${s.cx} ${s.cy})"` : ""} ${at}/>`;
}

const HEALTH = [100, 88, 75, 60, 45, 30, 12];
const MOODS: Mood[] = ["idle", "cheer", "oops", "sleep", "read"];
let body = "";
MOODS.forEach((mood, r) => {
  HEALTH.forEach((h, c) => {
    const a = new WormAnimator({ mood, health: h, rng: () => 0.5 });
    let p = a.step(16);
    for (let i = 0; i < 90; i++) p = a.step(16);
    body +=
      `<g transform="translate(${c * VIEW_W} ${r * VIEW_H})"><rect width="${VIEW_W}" height="${VIEW_H}" fill="#12102a"/>` +
      poseWorm(p).shapes.map((s) => svgOf(s, hex(h))).join("") +
      `<text x="4" y="11" fill="#9a96c0" font-size="7" font-family="monospace">${mood} ${h}</text></g>`;
  });
});
const W = HEALTH.length * VIEW_W;
const H = MOODS.length * VIEW_H;
writeFileSync(process.argv[process.argv.length - 1], `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}">${body}</svg>`);
