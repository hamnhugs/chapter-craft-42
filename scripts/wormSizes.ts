/** True-size check: every mood at the sizes that actually ship (52, 64, 84,
 *  132 px), on the darkest and the lightest ground the app has. A drawing that
 *  only works zoomed in does not work.
 *
 *    npx vite-node scripts/wormSizes.ts -- <name>
 */
import { writeFileSync } from "fs";
import { poseWorm, VIEW_W, VIEW_H } from "../src/lib/sprite/wormGeometry";
import { WormAnimator, type Mood } from "../src/lib/sprite/wormAnimator";
import { shapeToSvg } from "./wormSheet";

const MOODS: Mood[] = ["sleep", "idle", "watch", "listen", "think", "read", "speak", "cheer", "oops"];
const SIZES = [52, 64, 84, 132];
const GROUNDS = ["#0E0D12", "#F4EFE6"];

function settled(mood: Mood) {
  let seed = 999;
  const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const a = new WormAnimator({ rng, mood });
  let p = a.step(16.67);
  for (let i = 0; i < 150; i++) {
    if (mood === "speak") a.setVoice(Math.max(0, Math.sin(i * 0.47)) * 0.8);
    p = a.step(16.67);
  }
  const cap = mood === "sleep" || mood === "cheer" ? 1 : 0.6;
  return poseWorm({ ...p, lidL: Math.min(p.lidL, cap), lidR: Math.min(p.lidR, cap) }).shapes.map(shapeToSvg).join("");
}

const art = MOODS.map(settled);
const colW = 140;
let y = 0;
let out = "";
for (const g of GROUNDS) {
  for (const size of SIZES) {
    const h = (size * VIEW_H) / VIEW_W;
    out += `<rect x="0" y="${y}" width="${colW * MOODS.length}" height="${h + 12}" fill="${g}"/>`;
    art.forEach((a, i) => {
      out += `<g transform="translate(${i * colW + (colW - size) / 2} ${y + 6}) scale(${size / VIEW_W})">${a}</g>`;
    });
    y += h + 12;
  }
}
writeFileSync(
  `/tmp/worm/${process.argv[2] || "sizes"}.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${colW * MOODS.length}" height="${y}" viewBox="0 0 ${colW * MOODS.length} ${y}">${out}</svg>`,
);
console.log("wrote", process.argv[2] || "sizes");
