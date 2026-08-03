import type { Scene } from "./scene";
import { shotCoverage } from "./scene";
import { frustumWedge, sensorById, lensCoverage } from "./camera";
import { clipPolygonToBox } from "./geometry";
import {
  INK, MUTED, RULE, FAINT, PAPER, ACCENT, NONPHOTO,
  esc, n, label, wrap, truncate,
} from "./svgText";

// Stage plan and sequence sheet.
//
// The floor plan is the document that catches the mistake a written shot list
// cannot: whether the camera you specified actually SEES the person you said it
// was on. Coverage is computed from the plan — lens, sensor, position, heading —
// and any subject outside the wedge is called out on the page. Nobody has to
// assert coverage; the drawing derives it.
//
// The wedge itself is real optics, α = 2·arctan(d / 2f) on the declared sensor,
// not a decorative triangle. That is the difference between a diagram and an
// illustration of a diagram.

export const PLAN_WIDTH = 1000;
const MARGIN = 32;
const TITLE_H = 74;
const SECTION_GAP = 24;
const PLAN_H = 460;

const WALL_STROKE: Record<string, { color: string; width: number; dash?: string }> = {
  wall: { color: INK, width: 3 },
  flat: { color: MUTED, width: 2.4 },
  opening: { color: RULE, width: 2, dash: "8 5" },
  window: { color: NONPHOTO, width: 2.4, dash: "2 3" },
};

const LIGHT_GLYPH: Record<string, string> = {
  key: "K", fill: "F", back: "B", practical: "P", ambient: "A",
};

const DEFS = [
  "<defs>",
  `<g id="pl-cam"><path d="M -7 5 L 7 5 L 7 -3 L 2 -3 L 0 -6 L -4 -6 L -6 -3 L -7 -3 z" fill="${PAPER}" stroke="${INK}" stroke-width="1.3"/></g>`,
  `<g id="pl-actor"><circle r="7" fill="${PAPER}" stroke="${INK}" stroke-width="1.4"/><path d="M 0 -7 L 0 -12" stroke="${INK}" stroke-width="1.4"/></g>`,
  `<g id="pl-light"><circle r="6.5" fill="#fdf6e3" stroke="${MUTED}" stroke-width="1.1"/></g>`,
  `<g id="pl-north"><path d="M 0 -14 L 5 6 L 0 1 L -5 6 z" fill="${INK}"/></g>`,
  "</defs>",
].join("");

export interface PlanSheetOptions {
  /** Draw the coverage wedges. Off makes a clean blocking-only plan. */
  showFrustums?: boolean;
  showLights?: boolean;
  showShots?: boolean;
  gridStep?: number;
}

export interface PlanSheetResult {
  svg: string;
  width: number;
  height: number;
  nodeCount: number;
  /** Shots whose camera does not cover a declared subject. Surfaced to the
   *  caller too, so it can be said out loud rather than only drawn. */
  coverageWarnings: string[];
  omitted: string[];
}

function planMapper(scene: Scene, panel: { x: number; y: number; w: number; h: number }) {
  const scale = Math.min(panel.w / Math.max(scene.extent.w, 1e-6), panel.h / Math.max(scene.extent.h, 1e-6)) * 0.92;
  const drawnW = scene.extent.w * scale;
  const drawnH = scene.extent.h * scale;
  const originX = panel.x + (panel.w - drawnW) / 2;
  const bottomY = panel.y + (panel.h + drawnH) / 2;
  // Plan north is +y; SVG y grows downward, so north maps to a smaller y.
  return {
    scale,
    to: (p: { x: number; y: number }) => ({ x: originX + p.x * scale, y: bottomY - p.y * scale }),
    box: { x: originX, y: bottomY - drawnH, w: drawnW, h: drawnH },
  };
}

export function renderPlanSheet(scene: Scene, opts: PlanSheetOptions = {}): PlanSheetResult {
  const showFrustums = opts.showFrustums ?? true;
  const showLights = opts.showLights ?? true;
  const showShots = opts.showShots ?? true;
  const omitted: string[] = [];

  const body: string[] = [];
  let nodes = 0;
  const push = (markup: string) => { body.push(markup); nodes++; };

  const panel = { x: MARGIN, y: MARGIN + TITLE_H + SECTION_GAP, w: PLAN_WIDTH - MARGIN * 2, h: PLAN_H };
  const map = planMapper(scene, panel);

  push(`<rect x="${n(panel.x)}" y="${n(panel.y)}" width="${n(panel.w)}" height="${n(panel.h)}" fill="${PAPER}" stroke="${RULE}" stroke-width="1"/>`);

  // ── grid ──
  const step = opts.gridStep ?? (scene.extent.w > 20 ? 5 : 1);
  if (step > 0 && scene.extent.w / step < 60 && scene.extent.h / step < 60) {
    for (let gx = 0; gx <= scene.extent.w + 1e-9; gx += step) {
      const a = map.to({ x: gx, y: 0 });
      const b = map.to({ x: gx, y: scene.extent.h });
      push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${FAINT}" stroke-width="0.6"/>`);
    }
    for (let gy = 0; gy <= scene.extent.h + 1e-9; gy += step) {
      const a = map.to({ x: 0, y: gy });
      const b = map.to({ x: scene.extent.w, y: gy });
      push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${FAINT}" stroke-width="0.6"/>`);
    }
  } else {
    omitted.push(`grid suppressed — a ${step}${scene.unit} step over ${scene.extent.w}×${scene.extent.h}${scene.unit} would be unreadable`);
  }

  // ── coverage wedges, under everything so they read as light ──
  if (showFrustums) {
    for (const cam of scene.cameras) {
      const wedge = frustumWedge(
        { id: cam.id, label: cam.label, at: cam.at, headingDeg: cam.headingDeg, focalMm: cam.focalMm, sensorId: cam.sensorId, squeeze: cam.squeeze, throwDistance: cam.throwDistance ?? Math.max(scene.extent.w, scene.extent.h) },
        12,
      );
      // A wedge routinely reaches past the set — a 35mm from a corner covers
      // more than the room. Clip it to the plan area NUMERICALLY rather than
      // with a clip-path: a clip-path would leave the out-of-bounds coordinates
      // sitting in the markup, which the sheet validator would rightly reject.
      const clipped = clipPolygonToBox(wedge.map(map.to), map.box);
      if (clipped.length < 3) continue;
      const pts = clipped.map((p) => `${n(p.x)},${n(p.y)}`).join(" ");
      push(`<polygon points="${pts}" fill="${NONPHOTO}" fill-opacity="0.13" stroke="${NONPHOTO}" stroke-width="0.9" stroke-dasharray="5 4"/>`);
    }
  }

  // ── set ──
  for (const wall of scene.walls) {
    const s = WALL_STROKE[wall.kind] || WALL_STROKE.wall;
    const a = map.to(wall.from);
    const b = map.to(wall.to);
    push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="square"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`);
  }

  for (const prop of scene.props) {
    const c = map.to(prop.at);
    const w = prop.w * map.scale;
    const d = prop.d * map.scale;
    const rot = prop.rotationDeg ? ` transform="rotate(${n(prop.rotationDeg)} ${n(c.x)} ${n(c.y)})"` : "";
    push(`<rect x="${n(c.x - w / 2)}" y="${n(c.y - d / 2)}" width="${n(w)}" height="${n(d)}" fill="${FAINT}" stroke="${MUTED}" stroke-width="1"${rot}/>`);
    push(label(truncate(prop.name, Math.max(w, 40), 9), c.x, c.y + 3, { size: 9, fill: MUTED, anchor: "middle", maxWidth: Math.max(w, 40) }));
  }

  if (showLights) {
    for (const light of scene.lights) {
      const c = map.to(light.at);
      push(`<use href="#pl-light" x="${n(c.x)}" y="${n(c.y)}"/>`);
      push(label(LIGHT_GLYPH[light.kind] || "L", c.x, c.y + 3.5, { size: 9, fill: MUTED, anchor: "middle", weight: 700, mono: true }));
    }
  }

  for (const mark of scene.blocking) {
    const c = map.to(mark.at);
    push(`<use href="#pl-actor" x="${n(c.x)}" y="${n(c.y)}"${mark.facingDeg ? ` transform="rotate(${n(mark.facingDeg)} ${n(c.x)} ${n(c.y)})"` : ""}/>`);
    push(label(truncate(mark.name, 90, 10), c.x, c.y + 20, { size: 10, anchor: "middle", maxWidth: 90 }));
  }

  for (const cam of scene.cameras) {
    const c = map.to(cam.at);
    push(`<use href="#pl-cam" x="${n(c.x)}" y="${n(c.y)}" transform="rotate(${n(cam.headingDeg)} ${n(c.x)} ${n(c.y)})"/>`);
    const cov = lensCoverage(sensorById(cam.sensorId), cam.focalMm, cam.squeeze);
    push(label(`${cam.label} · ${cam.focalMm}mm · ${cov.horizontalDeg.toFixed(0)}°`, c.x, c.y - 14, { size: 9, fill: ACCENT, anchor: "middle", maxWidth: 150, mono: true }));
  }

  // ── north arrow + scale bar ──
  const north = { x: panel.x + panel.w - 30, y: panel.y + 34 };
  push(`<use href="#pl-north" x="${n(north.x)}" y="${n(north.y)}"/>`);
  push(label("N", north.x, north.y + 20, { size: 10, anchor: "middle", weight: 700, mono: true }));

  const barUnits = Math.max(1, Math.round(scene.extent.w / 5));
  const barPx = barUnits * map.scale;
  const barY = panel.y + panel.h - 18;
  push(`<line x1="${n(panel.x + 18)}" y1="${n(barY)}" x2="${n(panel.x + 18 + barPx)}" y2="${n(barY)}" stroke="${INK}" stroke-width="2"/>`);
  push(`<line x1="${n(panel.x + 18)}" y1="${n(barY - 4)}" x2="${n(panel.x + 18)}" y2="${n(barY + 4)}" stroke="${INK}" stroke-width="1"/>`);
  push(`<line x1="${n(panel.x + 18 + barPx)}" y1="${n(barY - 4)}" x2="${n(panel.x + 18 + barPx)}" y2="${n(barY + 4)}" stroke="${INK}" stroke-width="1"/>`);
  push(label(`${barUnits}${scene.unit}`, panel.x + 24 + barPx, barY + 4, { size: 10, maxWidth: 60, mono: true }));

  let cursorY = panel.y + panel.h + SECTION_GAP + 8;

  // ── shot list ──
  //
  // Every column here is derived from the plan. `covers` is the one that earns
  // the document: it names subjects the specified lens genuinely misses.
  const coverage = shotCoverage(scene);
  const coverageWarnings: string[] = [];
  coverage.forEach((c, i) => {
    if (scene.shots[i]?.omitted) return; // a cut shot cannot miss anybody
    if (c.missing.length) {
      coverageWarnings.push(`${c.number}: ${c.cameraLabel} at ${c.focalMm}mm does not cover ${c.missing.join(", ")}`);
    }
  });

  if (showShots && scene.shots.length) {
    push(label("SHOTS", MARGIN, cursorY, { size: 10, fill: MUTED, weight: 700, mono: true }));
    cursorY += 16;

    const cols: Array<[string, number]> = [["#", 130], ["CAM", 90], ["LENS", 62], ["SIZE", 118], ["MOVE", 82], ["ACTION", 380]];
    let cx = MARGIN;
    for (const [head, w] of cols) {
      push(label(head, cx, cursorY, { size: 9, fill: MUTED, weight: 700, maxWidth: w - 8, mono: true }));
      cx += w;
    }
    cursorY += 5;
    push(`<line x1="${n(MARGIN)}" y1="${n(cursorY)}" x2="${n(PLAN_WIDTH - MARGIN)}" y2="${n(cursorY)}" stroke="${RULE}" stroke-width="1"/>`);
    cursorY += 14;

    scene.shots.forEach((shot, i) => {
      const cov = coverage[i];
      // A tombstone keeps its row and its number — the hole in the sequence is
      // information — but is struck through and coverage-silent: a cut shot
      // cannot miss anybody.
      if (shot.omitted) {
        const cells = [cov.number, "—", "—", "—", "—", "OMITTED"];
        cx = MARGIN;
        cells.forEach((text, k) => {
          const w = cols[k][1];
          push(label(truncate(text, w - 8, 10), cx, cursorY, { size: 10, fill: MUTED, maxWidth: w - 8, mono: k === 0 }));
          cx += w;
        });
        push(`<line x1="${n(MARGIN)}" y1="${n(cursorY - 3.5)}" x2="${n(MARGIN + 118)}" y2="${n(cursorY - 3.5)}" stroke="${MUTED}" stroke-width="0.8"/>`);
        cursorY += 16;
        return;
      }
      const cells = [
        cov.number,
        cov.cameraLabel,
        cov.focalMm ? `${cov.focalMm}mm` : "—",
        cov.size,
        shot.movement,
        shot.action || "—",
      ];
      cx = MARGIN;
      cells.forEach((text, k) => {
        const w = cols[k][1];
        push(label(truncate(text, w - 8, 10), cx, cursorY, { size: 10, maxWidth: w - 8, mono: k === 0 }));
        cx += w;
      });
      // The line that earns the whole document: this lens, from this mark, does
      // not see that person. A written shot list cannot know it.
      if (cov.missing.length) {
        push(label(`⚠ misses ${cov.missing.join(", ")}`, MARGIN + 130, cursorY + 12, { size: 9, fill: ACCENT, maxWidth: 500 }));
        cursorY += 12;
      }
      cursorY += 16;
    });
    cursorY += SECTION_GAP - 12;

    // ── timeline strip ──
    const timed = scene.shots.filter((s) => !s.omitted && (s.durationS ?? 0) > 0);
    if (timed.length) {
      const total = timed.reduce((sum, s) => sum + (s.durationS || 0), 0);
      push(label(`SEQUENCE · ${total.toFixed(1)}s`, MARGIN, cursorY, { size: 10, fill: MUTED, weight: 700, mono: true }));
      cursorY += 14;
      const stripW = PLAN_WIDTH - MARGIN * 2;
      let x = MARGIN;
      for (const shot of timed) {
        const w = ((shot.durationS || 0) / total) * stripW;
        push(`<rect x="${n(x)}" y="${n(cursorY)}" width="${n(Math.max(1, w - 2))}" height="26" fill="${FAINT}" stroke="${MUTED}" stroke-width="0.8"/>`);
        if (w > 44) {
          const numberTail = (shot.number || shot.id).split("_").pop() || "";
          push(label(numberTail, x + 5, cursorY + 17, { size: 9, maxWidth: w - 12, mono: true }));
        }
        x += w;
      }
      cursorY += 26 + SECTION_GAP;
    }
  }

  if (scene.notes.length) {
    push(label("NOTES", MARGIN, cursorY, { size: 10, fill: MUTED, weight: 700, mono: true }));
    cursorY += 15;
    for (const note of scene.notes) {
      for (const line of wrap(note, PLAN_WIDTH - MARGIN * 2 - 12, 11)) {
        push(label(line, MARGIN + 10, cursorY, { size: 11, maxWidth: PLAN_WIDTH - MARGIN * 2 - 12 }));
        cursorY += 15;
      }
    }
    cursorY += 10;
  }

  const height = Math.max(600, cursorY + MARGIN);

  const head: string[] = [];
  head.push(`<rect x="0" y="0" width="${n(PLAN_WIDTH)}" height="${n(height)}" fill="${PAPER}"/>`);
  head.push(`<rect x="${n(MARGIN / 2)}" y="${n(MARGIN / 2)}" width="${n(PLAN_WIDTH - MARGIN)}" height="${n(height - MARGIN)}" fill="none" stroke="${RULE}" stroke-width="1"/>`);
  head.push(label(truncate(scene.name, PLAN_WIDTH - MARGIN * 2 - 240, 22), MARGIN, MARGIN + 26, { size: 22, weight: 650, maxWidth: PLAN_WIDTH - MARGIN * 2 - 240 }));
  const meta = [
    scene.slug,
    `${scene.extent.w}×${scene.extent.h}${scene.unit}`,
    `${scene.cameras.length} setup${scene.cameras.length === 1 ? "" : "s"}`,
    `${scene.shots.length} shot${scene.shots.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join("  ·  ");
  head.push(label(meta, MARGIN, MARGIN + 44, { size: 10, fill: MUTED, maxWidth: PLAN_WIDTH - MARGIN * 2 - 240, mono: true }));
  head.push(`<line x1="${n(MARGIN)}" y1="${n(MARGIN + TITLE_H - 16)}" x2="${n(PLAN_WIDTH - MARGIN)}" y2="${n(MARGIN + TITLE_H - 16)}" stroke="${INK}" stroke-width="1.4"/>`);
  nodes += head.length;

  const desc = [
    `Overhead stage plan for ${scene.name}.`,
    `${scene.extent.w} by ${scene.extent.h} ${scene.unit === "m" ? "metres" : "feet"},`,
    `${scene.walls.length} set elements, ${scene.blocking.length} blocking positions,`,
    `${scene.cameras.length} camera setups with angle-of-view coverage drawn from real lens optics.`,
  ].join(" ");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(PLAN_WIDTH)} ${n(height)}" role="graphics-document" aria-labelledby="pl-title" preserveAspectRatio="xMidYMid meet">`,
    `<title id="pl-title">${esc(scene.name)} — stage plan</title>`,
    `<desc>${esc(desc)}</desc>`,
    DEFS,
    ...head,
    ...body,
    `</svg>`,
  ].join("");

  return { svg, width: PLAN_WIDTH, height, nodeCount: nodes, coverageWarnings, omitted };
}
