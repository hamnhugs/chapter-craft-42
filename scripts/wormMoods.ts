/** One settled frame per mood, side by side — the distinctness check.
 *  Each animator runs 2.5s so springs have arrived and breathing is mid-cycle. */
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

const MOODS: Mood[] = ["sleep", "idle", "watch", "listen", "think", "read", "speak", "cheer", "oops"];
const silhouette = process.argv[3] === "silhouette";
const cells = MOODS.map((mood) => {
  let seed = 999;
  const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const a = new WormAnimator({ rng, mood });
  let p = a.step(16.67);
  for (let i = 0; i < 150; i++) {
    if (mood === "speak") a.setVoice(Math.max(0, Math.sin(i * 0.47)) * 0.8);
    p = a.step(16.67);
  }
  // A blink would ruin the comparison; force lids open for this sheet only.
  const pose = poseWorm({ ...p, lidL: Math.min(p.lidL, mood === "sleep" || mood === "cheer" ? 1 : 0.6), lidR: Math.min(p.lidR, mood === "sleep" || mood === "cheer" ? 1 : 0.6) });
  const shapes = silhouette
    ? pose.shapes.filter((s) => s.key === "body" || s.key === "head" || s.key.startsWith("bead") || s.key.startsWith("antenna")).map((s) => ({ ...s, fill: s.fill ? ("pupil" as Ink) : undefined, stroke: s.stroke ? ("pupil" as Ink) : undefined }))
    : pose.shapes;
  return (
    `<rect width="${VIEW_W}" height="${VIEW_H}" fill="${silhouette ? "#EDEAE6" : "#14110F"}"/>` +
    shapes.map(svg).join("") +
    `<text x="4" y="11" fill="${silhouette ? "#999" : "#8a8580"}" font-size="8" font-family="monospace">${mood}</text>`
  );
});
const cols = 5;
const rows = Math.ceil(cells.length / cols);
const body = cells.map((c, i) => `<g transform="translate(${(i % cols) * VIEW_W} ${Math.floor(i / cols) * VIEW_H})">${c}</g>`).join("");
writeFileSync(`/tmp/worm/${process.argv[2] || "moods"}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * VIEW_W}" height="${rows * VIEW_H}" viewBox="0 0 ${cols * VIEW_W} ${rows * VIEW_H}">${body}</svg>`);
console.log("wrote", process.argv[2] || "moods");
