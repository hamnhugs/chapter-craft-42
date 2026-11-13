/**
 * The BookWorm's body, as arithmetic.
 *
 * WHY A SPINE AND NOT A SPRITE SHEET. A worm is a soft body: the whole appeal
 * is that it bends, coils, squashes and follows through. Frame-based animation
 * would need a cel for every combination of (mood x voice loudness x gaze x
 * blink), which is combinatorially hopeless, and every transition between them
 * would be a cut. So the body is generated: a spine of 16 nodes whose shape
 * falls out of a handful of numbers, wrapped in a variable-width outline.
 *
 * This module is PURE and TIME-FREE. `poseWorm(params)` takes fully-resolved
 * numbers and returns shapes. It never reads a clock, never holds state, never
 * touches the DOM — which is what lets the same call render in the browser, in
 * a vitest assertion, and in the offline contact-sheet harness this creature
 * was actually drawn with. Animation — springs, wave phase, blink scheduling —
 * lives in wormAnimator.ts, on the other side of that line.
 *
 * TWO CONTRACTS THE REST OF THE FEATURE LEANS ON:
 *
 * 1. The returned scene is a declarative list, not an SVG string, so React and
 *    the harness render from one source. A string here would have meant two
 *    renderers and guaranteed drift between the thing being critiqued and the
 *    thing that shipped.
 *
 * 2. That list is FIXED-LENGTH and STABLY-KEYED. Every shape is emitted on
 *    every call in the same order; features that come and go — pupils behind a
 *    blink, the tongue, the brows — fade on `op` rather than mounting and
 *    unmounting. This is what lets BookWorm.tsx build the SVG once and then
 *    patch attributes imperatively at 60fps, instead of running React's
 *    reconciler sixty times a second on a mid-range Android. It also turned
 *    the hardest transition in the face (open eye to shut eye) into a
 *    cross-fade, which looks better than the hard swap it replaced.
 */

/** High enough for a smooth curl, low enough to cost nothing. */
export const SPINE_NODES = 16;
/** The body is a string of beads. Six is the most that still reads as separate
 *  segments at 52px, and the fewest that still reads as a caterpillar. */
export const BEADS = 6;
/** Exactly what poseWorm always returns: shadow + body + beads + antennae*4
 *  + head + eyes*6 + glasses*7 + mouth + tongue. Asserted in the tests. */
export const SHAPE_COUNT = 1 + 1 + BEADS + 4 + 1 + 6 + 7 + 2;

/** The drawing is authored in this box and scaled by the caller. The tail sits
 *  at (CX, BASE_Y) so the worm is rooted to a floor rather than floating.
 *  The box is wider than an upright worm needs, because a full coil throws the
 *  head sideways and a clipped head is worse than dead space. */
export const VIEW_W = 120;
export const VIEW_H = 130;
export const CX = 57;
export const BASE_Y = 122;

/** Neck-to-tail length at rest, in view units. The head is not part of it. */
const BODY_LEN = 60;
/** Radius of the body tube at its fattest. */
const GIRTH = 11;
/** The head is a separate, deliberately oversized ball. Drawing it as the fat
 *  end of the tube — the first thing tried here — produced a pea pod: one
 *  continuous silhouette has no neck, so it has no head, so it has no
 *  character, only a vegetable with eyes. Cartoon construction is a big head on
 *  a small body, and it has to be a separate shape to read as one. */
const HEAD_R = 16.2;

export type Vec = { x: number; y: number };

/** Palette keys, not colours. The component resolves them to CSS custom
 *  properties; the harness resolves them to hex. Neither knows about the other. */
export type Ink =
  | "body"
  | "bodyAlt"
  | "pupil"
  | "spec"
  | "mouth"
  | "tongue"
  | "brow"
  | "glass"
  | "frame"
  | "shadow";

interface Base {
  /** Stable across every call, so the renderer can address shapes by index. */
  key: string;
  fill?: Ink;
  stroke?: Ink;
  sw?: number;
  op?: number;
  cap?: boolean;
}
export type Shape =
  | (Base & { k: "path"; d: string })
  | (Base & { k: "circle"; cx: number; cy: number; r: number })
  | (Base & { k: "ellipse"; cx: number; cy: number; rx: number; ry: number; rot?: number });

/**
 * Every number the body needs. All of them are continuous and safe to
 * interpolate, which is the whole contract: the animator only ever eases these,
 * so there is no pose the worm cannot pass smoothly through on the way to
 * another. Angles are radians, screen space, y-down.
 */
export interface WormParams {
  /** Which way the worm POINTS: the chord from tail to head. -PI/2 is straight
   *  up. Deliberately not the tail's own departure angle — see the note in
   *  poseWorm where the two are reconciled. */
  baseAngle: number;
  /** Total bend accumulated head-ward. Positive curls the head toward +x. */
  curl: number;
  /** Amplitude of the travelling undulation, radians at the head. */
  wave: number;
  /** Where that wave currently is. Integrated by the animator, never computed
   *  from a raw clock — that way a change of speed never snaps. */
  phase: number;
  /** Wavelength as a fraction of body length. ~1 is a single hump. */
  waveLen: number;
  /** Length scale. Squash and stretch conserve volume through `girth`. */
  stretch: number;
  /** Width scale on top of volume conservation. Breathing lives here. */
  girth: number;
  /** Extra rotation of the head past where the neck points. */
  headTilt: number;
  /** Pupil offset within the eye, -1..1 on each axis. */
  lookX: number;
  lookY: number;
  /** Lid closure, 0 open .. 1 shut. Below 0 widens past neutral (surprise). */
  lidL: number;
  lidR: number;
  /** Brow angle, radians. Positive is an inward frown, negative a raise. */
  browL: number;
  browR: number;
  /** Jaw. 0 shut, 1 wide. */
  mouthOpen: number;
  /** -1 frown .. 1 grin. */
  mouthSmile: number;
  /** -1 rounded (an "oo") .. 1 spread (an "ee"). During speech this is driven
   *  by the ratio of high- to low-frequency energy in the actual audio, which
   *  is a coarse but free stand-in for vowel shape. A jaw that only opens and
   *  shuts chews; a mouth that also changes width talks. */
  mouthWide: number;
  /** How far the antennae trail the head, radians. Pure follow-through. */
  antennaLag: number;
  /** 0..1 fade for the reading glasses. */
  glasses: number;
  /** 0..1 flash across the lenses — the oldest shorthand in animation for a
   *  thought landing, and it costs one stroke. */
  glint: number;
  /** Per-bead swell, tail (0) to neck (5), each roughly -1..1. Six scalars
   *  rather than an array so every param stays a plain interpolable number.
   *  The animator feeds these from a DELAY LINE of the live voice, so a spoken
   *  syllable visibly travels down the body after it leaves the mouth. */
  swell0: number;
  swell1: number;
  swell2: number;
  swell3: number;
  swell4: number;
  swell5: number;
}

export const REST_PARAMS: WormParams = {
  baseAngle: -Math.PI / 2,
  curl: 0.45,
  wave: 0.05,
  phase: 0,
  waveLen: 1,
  stretch: 1,
  girth: 1,
  headTilt: 0,
  lookX: 0,
  lookY: 0,
  lidL: 0,
  lidR: 0,
  browL: 0,
  browR: 0,
  mouthOpen: 0,
  mouthSmile: 0.35,
  mouthWide: 0,
  antennaLag: 0,
  glasses: 0,
  glint: 0,
  swell0: 0,
  swell1: 0,
  swell2: 0,
  swell3: 0,
  swell4: 0,
  swell5: 0,
};

export interface WormPose {
  shapes: Shape[];
  /** Head centre and frame, exposed so callers can hang things off the head
   *  without recomputing the spine. */
  head: { p: Vec; forward: Vec; normal: Vec; r: number; angle: number };
  spine: Vec[];
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Radius profile along the body tube. s=0 tail, s=1 neck.
 *  Authored as keyframes rather than a formula because this curve is pure
 *  taste and was tuned by looking at it: a rounded tail that does not read as
 *  a leaf tip, mass carried forward of centre, and a pinch at the neck so the
 *  head has something to sit on. */
const RADIUS_KEYS: [number, number][] = [
  [0, 0.36],
  [0.2, 0.86],
  [0.46, 1.0],
  [0.72, 0.88],
  [1, 0.6],
];

function radiusAt(s: number): number {
  for (let i = 0; i < RADIUS_KEYS.length - 1; i++) {
    const [s0, r0] = RADIUS_KEYS[i];
    const [s1, r1] = RADIUS_KEYS[i + 1];
    if (s <= s1) return r0 + (r1 - r0) * smoothstep((s - s0) / (s1 - s0));
  }
  return RADIUS_KEYS[RADIUS_KEYS.length - 1][1];
}

/** Two decimals. These strings hit the DOM every frame, and trailing float
 *  noise is bytes the parser re-reads for sub-pixel nothing. */
const f = (n: number): number => Math.round(n * 100) / 100;

/** Catmull-Rom through the offset points, as cubics. A raw polyline silhouette
 *  on a 16-node spine shows its facets at any size worth looking at. */
function crSegment(p0: Vec, p1: Vec, p2: Vec, p3: Vec): string {
  return (
    `C${f(p1.x + (p2.x - p0.x) / 6)},${f(p1.y + (p2.y - p0.y) / 6)} ` +
    `${f(p2.x - (p3.x - p1.x) / 6)},${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)},${f(p2.y)}`
  );
}

function polyline(pts: Vec[]): string {
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    d += crSegment(pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]);
  }
  return d;
}

/** A closed Catmull-Rom loop. The head is drawn with this rather than an
 *  <ellipse> because its outline is a superellipse, which no SVG primitive is. */
function loop(pts: Vec[]): string {
  const n = pts.length;
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    d += crSegment(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]);
  }
  return d + "Z";
}

/** Position on the spine at a fractional s, 0 tail .. 1 neck. */
function along(spine: Vec[], s: number): Vec {
  const t = clamp(s, 0, 1) * (spine.length - 1);
  const i = Math.min(spine.length - 2, Math.floor(t));
  const u = t - i;
  return { x: spine[i].x + (spine[i + 1].x - spine[i].x) * u, y: spine[i].y + (spine[i + 1].y - spine[i].y) * u };
}

/** Squareness of the head. 2 is an ellipse, infinity is a rectangle; 2.7 is
 *  the "squircle" every modern icon grid settled on, and it is what stops the
 *  head reading as a ball balanced on a stick. */
const HEAD_POWER = 2.7;
const HEAD_POINTS = 16;
/** cos/sin of the superellipse, computed once: only the radii and the frame
 *  change from frame to frame. */
const HEAD_UNIT: Vec[] = Array.from({ length: HEAD_POINTS }, (_, i) => {
  const a = (i / HEAD_POINTS) * Math.PI * 2;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const e = 2 / HEAD_POWER;
  return { x: Math.sign(c) * Math.pow(Math.abs(c), e), y: Math.sign(sn) * Math.pow(Math.abs(sn), e) };
});

export function poseWorm(p: WormParams): WormPose {
  const n = SPINE_NODES;
  const shapes: Shape[] = [];

  // --- SPINE -------------------------------------------------------------
  // Angles first, positions by integration. Working in angle space is what
  // makes the worm bend like a worm: a travelling wave added to the angles is
  // a slither, whereas the same wave added to positions is a wobble.
  //
  // `baseAngle` is the CHORD, not the tail tangent. A worm bent by `curl`
  // radians sweeps an arc whose chord runs at (start + curl/2), so driving the
  // tail tangent directly meant every coil swung the head clean out of frame
  // and each mood had to hand-correct its own lean. Subtracting half the curl
  // here makes "which way it points" and "how bent it is" independent, which is
  // the only reason the mood table in the animator is one line per mood.
  const stretch = clamp(p.stretch, 0.55, 1.7);
  const seg = (BODY_LEN * stretch) / (n - 1);
  const start = p.baseAngle - p.curl / 2;

  const spine: Vec[] = [{ x: CX, y: BASE_Y }];
  for (let i = 0; i < n - 1; i++) {
    const s = i / (n - 1);
    // Whip-weighted: the tail is anchored and barely moves, the head swings.
    // The envelope is what makes it read as one continuous body rather than a
    // segmented arm.
    const env = Math.pow(s, 1.4);
    const travelling = Math.sin(p.phase - (s * (2 * Math.PI)) / Math.max(0.2, p.waveLen));
    const a = start + p.curl * s + p.wave * travelling * env;
    spine.push({ x: spine[i].x + Math.cos(a) * seg, y: spine[i].y + Math.sin(a) * seg });
  }

  // Volume conservation: a stretched worm is a thinner worm. Without this the
  // stretch reads as the whole creature scaling up, which is the commonest
  // tell of fake squash-and-stretch.
  const volume = 1 / Math.sqrt(stretch);
  // The tube is the connective tissue UNDER the beads, not the silhouette: it
  // runs at CORE of their radius so it fills the valleys between them halfway.
  // Without it a hard curl opens daylight between beads on the outside of the
  // bend; at full radius it would erase the scallops that are the whole point.
  const CORE = 0.74;
  const radii = spine.map((_, i) => GIRTH * radiusAt(i / (n - 1)) * volume * p.girth * CORE);

  const sideA: Vec[] = [];
  const sideB: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(n - 1, i + 1)];
    const m = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    const nx = -(next.y - prev.y) / m;
    const ny = (next.x - prev.x) / m;
    sideA.push({ x: spine[i].x + nx * radii[i], y: spine[i].y + ny * radii[i] });
    sideB.push({ x: spine[i].x - nx * radii[i], y: spine[i].y - ny * radii[i] });
  }

  const rNeck = radii[n - 1];
  const rTail = radii[0];
  const body =
    `M${f(sideA[0].x)},${f(sideA[0].y)}` +
    polyline(sideA) +
    `A${f(rNeck)},${f(rNeck)} 0 0 1 ${f(sideB[n - 1].x)},${f(sideB[n - 1].y)}` +
    polyline([...sideB].reverse()) +
    `A${f(rTail)},${f(rTail)} 0 0 1 ${f(sideA[0].x)},${f(sideA[0].y)}Z`;

  // --- CONTACT SHADOW ----------------------------------------------------
  // A creature with no shadow floats. It also does the cheapest possible job
  // of selling vertical squash: as the worm rises its shadow tightens and
  // fades, which is the only cue that says it left the ground.
  shapes.push({
    k: "ellipse",
    key: "shadow",
    cx: CX,
    cy: BASE_Y + 5.5,
    rx: f(15 * volume),
    ry: f(2.6 * volume),
    fill: "shadow",
    op: f(0.2 * volume),
  });

  // --- BODY --------------------------------------------------------------
  // FLAT. No contour, no rim light, no specular: one colour, and the shape does
  // all the work. The previous worm carried a dark outline so it would survive
  // both a near-black and a near-white theme; a mid-luminance clay does the
  // same job with nothing drawn, because it sits about as far from paper as it
  // does from black. An outline is what made the old one read as clip-art.
  shapes.push({ k: "path", key: "body", d: body, fill: "body" });

  // The beads. They replace the segmentation rings, and they earn the same
  // three things the rings did — they say "larva", they carry the undulation
  // visibly down the body, they give the silhouette an internal scale — but
  // they do it in the SILHOUETTE rather than with ink laid over it, which is
  // the difference between a shape and a drawing of a shape.
  //
  // Drawn tail to neck, so each one overlaps the one behind it and the
  // alternating tone reads as overlapping discs, the way cut paper would.
  const swell = [p.swell0, p.swell1, p.swell2, p.swell3, p.swell4, p.swell5];
  for (let j = 0; j < BEADS; j++) {
    const s = 0.035 + (j / (BEADS - 1)) * 0.86;
    const c = along(spine, s);
    // Swell is clamped where it is consumed, because it arrives from live
    // audio and one clipped sample must not be able to inflate a bead.
    const r = GIRTH * radiusAt(s) * volume * p.girth * (1 + 0.2 * clamp(swell[j], -1, 1));
    shapes.push({ k: "circle", key: `bead${j}`, cx: f(c.x), cy: f(c.y), r: f(r), fill: j % 2 ? "bodyAlt" : "body" });
  }

  // --- HEAD FRAME --------------------------------------------------------
  const neckP = spine[n - 1];
  const prevP = spine[n - 2];
  const headAngle = Math.atan2(neckP.y - prevP.y, neckP.x - prevP.x) + p.headTilt;
  const forward: Vec = { x: Math.cos(headAngle), y: Math.sin(headAngle) };
  const normal: Vec = { x: -forward.y, y: forward.x };

  const hsq = Math.sqrt(volume);
  // Wider than tall. A round head is a ball; a slightly landscape squircle is
  // a face, because it leaves room to set the eyes far apart.
  const headRx = HEAD_R * 1.06 * hsq * p.girth;
  const headRy = ((HEAD_R * 0.94) / hsq) * (0.5 + 0.5 * p.girth);
  // The head overlaps the neck rather than balancing on it. Even a one-pixel
  // seam between the two shapes reads as a severed head.
  const hp: Vec = { x: neckP.x + forward.x * headRy * 0.62, y: neckP.y + forward.y * headRy * 0.62 };

  /** Head-local placement in FRACTIONS of head radius, so every facial feature
   *  squashes and stretches with the head instead of sliding off it. */
  const at = (fwd: number, lat: number): Vec => ({
    x: hp.x + forward.x * (fwd * headRy) + normal.x * (lat * headRx),
    y: hp.y + forward.y * (fwd * headRy) + normal.y * (lat * headRx),
  });

  // --- ANTENNAE ----------------------------------------------------------
  // Two strokes whose only job is follow-through. Driven by the head's own lag
  // so they whip late on every direction change: the cheapest possible read of
  // "this thing has mass". Short, fat and in the body's own second tone — a
  // thin dark feeler is an insect, a stubby one is a character.
  for (const side of [-1, 1] as const) {
    const id = side < 0 ? "L" : "R";
    const root = at(0.62, side * 0.4);
    const dir = headAngle + side * 0.5 + p.antennaLag;
    const len = headRy * 0.78;
    const mid: Vec = {
      x: root.x + Math.cos(dir - side * 0.3) * len * 0.58,
      y: root.y + Math.sin(dir - side * 0.3) * len * 0.58,
    };
    const tip: Vec = { x: root.x + Math.cos(dir) * len, y: root.y + Math.sin(dir) * len };
    shapes.push({
      k: "path",
      key: `antenna${id}`,
      d: `M${f(root.x)},${f(root.y)}Q${f(mid.x)},${f(mid.y)} ${f(tip.x)},${f(tip.y)}`,
      stroke: "bodyAlt",
      sw: 3,
      cap: true,
    });
    shapes.push({ k: "circle", key: `antennaTip${id}`, cx: f(tip.x), cy: f(tip.y), r: f(headRx * 0.17), fill: "bodyAlt" });
  }

  // --- HEAD --------------------------------------------------------------
  shapes.push({
    k: "path",
    key: "head",
    d: loop(HEAD_UNIT.map((u) => at(u.y, u.x))),
    fill: "body",
  });

  // --- EYES --------------------------------------------------------------
  // Everything below is in fractions of the head, so the face is invariant to
  // squash, stretch, breathing and head size.
  //
  // THE EYE IS ONE DARK PILL. No white, no iris, no catchlight. At the size
  // this ships the old eye was a 5px white disc with a 3px pupil and a 1px
  // highlight — three shapes fighting over nine pixels, and the first thing
  // that dated it. A solid pill holds its shape down to nothing, and it turns
  // out to lose no acting: gaze moves the whole pill, surprise makes it
  // taller, a squint makes it shorter, and a blink is it collapsing to a line.
  //
  // It is drawn as a round-capped STROKE, not a filled shape, so "pill" costs
  // two points and its width is one attribute.
  const EYE_W = 0.115;
  const EYE_H = 0.3;
  const EYE_LAT = 0.43;
  const EYE_FWD = 0.1;
  const LOOK = 0.13;

  // The lens tint goes down BEFORE the eyes and the frames go on after them. A
  // pale lens laid over a dark pill greys it out, and the eyes are the one
  // thing on this face that has to stay the darkest thing on it.
  const gRad = 0.335 * headRx;
  const worn = clamp(p.glasses, 0, 1);
  const gOp = smoothstep(worn * 2.2);
  const gFwd = EYE_FWD + (1 - p.glasses) * 0.62;
  for (const side of [-1, 1] as const) {
    const g = at(gFwd, side * EYE_LAT);
    shapes.push({ k: "circle", key: `lens${side < 0 ? "L" : "R"}`, cx: f(g.x), cy: f(g.y), r: f(gRad), fill: "glass", op: f(gOp * 0.24) });
  }

  for (const side of [-1, 1] as const) {
    const id = side < 0 ? "L" : "R";
    const openness = 1 - clamp(side < 0 ? p.lidL : p.lidR, -0.4, 1);
    // Gaze moves the eye itself. There is no white for a pupil to travel
    // across, and the whole-eye shift reads further away than a pupil ever did.
    // Reined in behind glasses, or a hard look drives the pill into the frame.
    const look = LOOK * (1 - 0.45 * worn);
    const e = at(EYE_FWD + p.lookY * look, side * EYE_LAT + p.lookX * look);

    // Open eye and shut eye are BOTH always emitted and cross-faded on this
    // one number, which keeps the shape list fixed-length and replaced a hard
    // swap mid-blink with a two-frame dissolve.
    const eyeOp = smoothstep((openness - 0.06) / 0.12);

    // A closing eye keeps its width and loses its height, because that is what
    // a lid does. The stroke's round caps mean it bottoms out as a dot, never
    // as a sliver.
    const half = Math.max(0, EYE_H * clamp(openness, 0, 1.4) - EYE_W) * headRy;
    shapes.push({
      k: "path",
      key: `eye${id}`,
      d: `M${f(e.x - forward.x * half)},${f(e.y - forward.y * half)}L${f(e.x + forward.x * half)},${f(e.y + forward.y * half)}`,
      stroke: "pupil",
      // A startled eye is also a touch wider; a pill that only grows taller
      // reads as stretched rather than as surprised.
      sw: f(EYE_W * 2 * headRx * (1 + 0.35 * Math.max(0, openness - 1))),
      cap: true,
      op: f(eyeOp),
    });

    // A shut eye is one curved stroke. The curve carries mood for free — it
    // arcs up into a happy ^^ squint when the mouth is smiling, and sags when
    // it is not.
    const arc = clamp(p.mouthSmile, -1, 1);
    const lw = EYE_W * 1.75 * headRx;
    const a1 = { x: e.x - normal.x * lw, y: e.y - normal.y * lw };
    const a2 = { x: e.x + normal.x * lw, y: e.y + normal.y * lw };
    const ac = { x: e.x + forward.x * EYE_H * headRy * arc * 0.95, y: e.y + forward.y * EYE_H * headRy * arc * 0.95 };
    shapes.push({
      k: "path",
      key: `lash${id}`,
      d: `M${f(a1.x)},${f(a1.y)}Q${f(ac.x)},${f(ac.y)} ${f(a2.x)},${f(a2.y)}`,
      stroke: "pupil",
      sw: 2.6,
      cap: true,
      op: f(1 - eyeOp),
    });

    // Brow. A short stroke whose only variable is angle — and angle alone
    // carries more emotion than the rest of the face put together. Hidden at
    // neutral, because a permanent horizontal dash above each eye reads as a
    // scowl on a face this simple.
    //
    // A frown TILTS, a raise LIFTS. Tilting a raised brow — what this did
    // first, and with the sign backwards at that — turns attention into fury:
    // `listen` spent its whole life glaring. Raised brows now mostly travel up
    // the forehead and keep only a little of the angle, which is the worried
    // slant `oops` wants and nothing more.
    const brow = side < 0 ? p.browL : p.browR;
    const bc = at(EYE_FWD + EYE_H * 1.7 + Math.max(0, -brow) * 0.32, side * EYE_LAT);
    const ba = headAngle + Math.PI / 2 - (brow > 0 ? brow : brow * 0.55) * side;
    const bl = EYE_W * 1.9 * headRx;
    shapes.push({
      k: "path",
      key: `brow${id}`,
      d: `M${f(bc.x - Math.cos(ba) * bl)},${f(bc.y - Math.sin(ba) * bl)}L${f(bc.x + Math.cos(ba) * bl)},${f(bc.y + Math.sin(ba) * bl)}`,
      stroke: "brow",
      sw: 2.2,
      cap: true,
      // Asymmetric threshold: a slight frown should show (it is `think`), a
      // slight raise should not — on a face with no eye-whites a small raise is
      // already carried by the eyes growing taller, and two extra dashes over
      // them is clutter. Only a real raise, `oops`, draws them.
      op: f(clamp((brow > 0 ? brow - 0.1 : -brow - 0.3) * 5, 0, 1)),
    });
  }

  // --- GLASSES -----------------------------------------------------------
  // It is a bookworm; the joke is worth forty bytes of path. But they are now
  // something it PUTS ON — the animator raises `glasses` for reading and drops
  // it otherwise. Worn permanently they were furniture hiding the eyes; put on
  // at the moment a reply starts arriving, they are a gesture.
  //
  // They arrive from the forehead and are pushed down onto the eyes — `glasses`
  // may overshoot 1, and the overshoot is the frames bottoming out on the nose.
  for (const side of [-1, 1] as const) {
    const id = side < 0 ? "L" : "R";
    const g = at(gFwd, side * EYE_LAT);
    shapes.push({ k: "circle", key: `frame${id}`, cx: f(g.x), cy: f(g.y), r: f(gRad), stroke: "frame", sw: 1.9, op: f(gOp) });
    const ga = headAngle - 0.7;
    const gLen = gRad * 0.6;
    const gx = g.x + Math.cos(ga + Math.PI / 2) * gRad * 0.34;
    const gy = g.y + Math.sin(ga + Math.PI / 2) * gRad * 0.34;
    shapes.push({
      k: "path",
      key: `glint${id}`,
      d: `M${f(gx - Math.cos(ga) * gLen)},${f(gy - Math.sin(ga) * gLen)}L${f(gx + Math.cos(ga) * gLen)},${f(gy + Math.sin(ga) * gLen)}`,
      stroke: "spec",
      sw: f(1.6 + 2 * p.glint),
      // Invisible at rest. A permanent glare streak is a highlight, and this
      // drawing has none; the flash is an event.
      op: f(gOp * 0.9 * p.glint),
      cap: true,
    });
  }
  const bl0 = at(gFwd, -EYE_LAT);
  const br0 = at(gFwd, EYE_LAT);
  shapes.push({
    k: "path",
    key: "bridge",
    d: `M${f(bl0.x + normal.x * gRad)},${f(bl0.y + normal.y * gRad)}L${f(br0.x - normal.x * gRad)},${f(br0.y - normal.y * gRad)}`,
    stroke: "frame",
    sw: 1.9,
    op: f(gOp),
    cap: true,
  });

  // --- MOUTH -------------------------------------------------------------
  // Two quadratic lips, so "shut and smiling" and "wide open mid-vowel" are
  // the same path with different numbers rather than two separate drawings.
  // Small, and set close under the eyes: on a flat face the distance between
  // the features is the expression, and a mouth down on the chin is a muzzle.
  const MOUTH_FWD = -0.4;
  const openJaw = clamp(p.mouthOpen, 0, 1);
  const smile = clamp(p.mouthSmile, -1, 1);
  const wide = clamp(p.mouthWide, -1, 1);
  const mw = clamp(0.16 + 0.1 * openJaw + 0.07 * Math.max(0, smile) + 0.07 * wide, 0.09, 0.38);
  // Rounding trades width for height at constant area, the way a real mouth
  // does — otherwise an "oo" just reads as a smaller "ah".
  const lower = openJaw * 0.5 * (1 - wide * 0.22) + smile * 0.3;
  const ml = at(MOUTH_FWD, -mw);
  const mr = at(MOUTH_FWD, mw);
  const cu = at(MOUTH_FWD - smile * 0.24 * (1 - openJaw) + openJaw * 0.08, 0);
  const cd = at(MOUTH_FWD - lower, 0);
  shapes.push({
    k: "path",
    key: "mouth",
    d: `M${f(ml.x)},${f(ml.y)}Q${f(cu.x)},${f(cu.y)} ${f(mr.x)},${f(mr.y)}Q${f(cd.x)},${f(cd.y)} ${f(ml.x)},${f(ml.y)}Z`,
    fill: "mouth",
    stroke: "mouth",
    sw: 2,
    cap: true,
  });

  // The lip is a quadratic, so the cavity only reaches half the control offset.
  // The tongue sits low in it — any higher and it hangs out the chin.
  const tc = at(MOUTH_FWD - lower * 0.36, 0);
  shapes.push({
    k: "ellipse",
    key: "tongue",
    cx: f(tc.x),
    cy: f(tc.y),
    rx: f(mw * 0.55 * headRx),
    ry: f(Math.max(0.01, lower * 0.17 * headRy)),
    rot: f((headAngle * 180) / Math.PI + 90),
    fill: "tongue",
    op: f(smoothstep((openJaw - 0.3) * 3)),
  });

  return { shapes, head: { p: hp, forward, normal, r: headRx, angle: headAngle }, spine };
}
