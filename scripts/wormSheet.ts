/**
 * Contact-sheet harness for the BookWorm.
 *
 * Not shipped, not imported by the app — this is the drawing loop. It renders
 * poses straight from the same `poseWorm` the component uses, writes an SVG
 * grid, and rasterises it, so the thing being critiqued is byte-for-byte the
 * thing that ships rather than a mockup of it.
 *
 *   npx vite-node scripts/wormSheet.ts -- <name> [cols]
 */
import { writeFileSync } from "fs";
import { poseWorm, VIEW_W, VIEW_H, type Shape, type WormParams, type Ink } from "../src/lib/sprite/wormGeometry";
import { REST_PARAMS } from "../src/lib/sprite/wormGeometry";

const HEX: Record<Ink, string> = {
  body: "#DD7C58", bodyAlt: "#C9683F", pupil: "#2B1B15", spec: "#FFF6EE", mouth: "#2B1B15",
  tongue: "#F4A58C", brow: "#2B1B15", glass: "#FFF6EE", frame: "#2B1B15", shadow: "#000000",
};

function attrs(s: Shape): string {
  const a: string[] = [];
  if ("fill" in s && s.fill) a.push(`fill="${HEX[s.fill]}"`);
  else a.push('fill="none"');
  if ("stroke" in s && s.stroke) a.push(`stroke="${HEX[s.stroke]}"`);
  if ("sw" in s && s.sw != null) a.push(`stroke-width="${s.sw}"`);
  if ("op" in s && s.op != null) a.push(`opacity="${s.op}"`);
  if ("cap" in s && s.cap) a.push('stroke-linecap="round" stroke-linejoin="round"');
  return a.join(" ");
}

export function shapeToSvg(s: Shape): string {
  if (s.k === "path") return `<path d="${s.d}" ${attrs(s)}/>`;
  if (s.k === "circle") return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${attrs(s)}/>`;
  const rot = s.rot ? ` transform="rotate(${s.rot} ${s.cx} ${s.cy})"` : "";
  return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"${rot} ${attrs(s)}/>`;
}

export function cell(label: string, p: Partial<WormParams>): string {
  const pose = poseWorm({ ...REST_PARAMS, ...p });
  return (
    `<rect width="${VIEW_W}" height="${VIEW_H}" fill="#14110F"/>` +
    `<rect x="0" y="${VIEW_H - 4}" width="${VIEW_W}" height="4" fill="#241f1c"/>` +
    pose.shapes.map(shapeToSvg).join("") +
    `<text x="4" y="11" fill="#8a8580" font-size="7" font-family="monospace">${label}</text>`
  );
}

export function sheet(cells: { label: string; p: Partial<WormParams> }[], cols: number): string {
  const rows = Math.ceil(cells.length / cols);
  const W = cols * VIEW_W;
  const H = rows * VIEW_H;
  const body = cells
    .map((c, i) => {
      const x = (i % cols) * VIEW_W;
      const y = Math.floor(i / cols) * VIEW_H;
      return `<g transform="translate(${x} ${y})">${cell(c.label, c.p)}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// --- the sheet being looked at right now ---------------------------------
const P = Math.PI;
const cells: { label: string; p: Partial<WormParams> }[] = [
  { label: "rest", p: {} },
  { label: "straight", p: { curl: 0 } },
  { label: "curl 1.2", p: { curl: 1.2 } },
  { label: "curl 2.4", p: { curl: 2.4 } },
  { label: "curl 3.6", p: { curl: 3.6, stretch: 0.9 } },
  { label: "curl -0.8", p: { curl: -0.8 } },
  { label: "lean", p: { baseAngle: -P / 2 + 0.35, curl: 0.8 } },
  { label: "wave .5 ph0", p: { wave: 0.5, phase: 0 } },
  { label: "wave .5 ph2", p: { wave: 0.5, phase: 2 } },
  { label: "wave .5 ph4", p: { wave: 0.5, phase: 4 } },
  { label: "stretch 1.3", p: { stretch: 1.3 } },
  { label: "squash .75", p: { stretch: 0.75, curl: 0.9 } },
  { label: "girth 1.15", p: { girth: 1.15 } },
  { label: "blink", p: { lidL: 1, lidR: 1 } },
  { label: "wide", p: { lidL: -0.35, lidR: -0.35 } },
  { label: "wink", p: { lidR: 1 } },
  { label: "mouth .5", p: { mouthOpen: 0.5 } },
  { label: "mouth 1", p: { mouthOpen: 1 } },
  { label: "frown", p: { mouthSmile: -0.8, browL: 0.5, browR: 0.5, lidL: 0.35, lidR: 0.35 } },
  { label: "look L", p: { lookX: -1 } },
  { label: "look up", p: { lookY: 1, headTilt: -0.3 } },
  { label: "tilt", p: { headTilt: 0.6, antennaLag: 0.5 } },
  { label: "glasses", p: { glasses: 1 } },
  { label: "antenna lag", p: { antennaLag: 1.1, curl: 1.4 } },
  { label: "glint", p: { glasses: 1, glint: 1, lidL: 0.3, lidR: 0.3 } },
  { label: "asleep", p: { curl: 3.1, lidL: 1, lidR: 1, mouthSmile: 0.15, stretch: 0.88, baseAngle: -P / 2 + 0.45 } },
];

const name = process.argv[2] || "sheet";
const cols = Number(process.argv[3] || 6);
writeFileSync(`/tmp/worm/${name}.svg`, sheet(cells, cols));
console.log(`wrote /tmp/worm/${name}.svg (${cells.length} cells)`);
