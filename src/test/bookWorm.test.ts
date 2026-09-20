import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  poseWorm,
  REST_PARAMS,
  SHAPE_COUNT,
  VIEW_H,
  VIEW_W,
  type WormParams,
} from "@/lib/sprite/wormGeometry";
import { WormAnimator, type Mood } from "@/lib/sprite/wormAnimator";
import { noteWordBoundary, syntheticVoice, hasWordBoundaries } from "@/lib/sprite/voiceTap";
import { resolveWormMood, CHEER_MS, OOPS_MS, SLEEP_MS, WATCH_MS, type MoodSignals } from "@/lib/sprite/wormMood";
import { resolvePocketCaption, plainText, CAPTION_MAX, type CaptionSignals } from "@/lib/sprite/pocketCaption";

/**
 * The BookWorm — the companion sprite in Counsel.
 *
 * WHAT THIS PROTECTS. Four of these are regressions for defects that actually
 * happened while building it, and they are the reason this file exists rather
 * than a smoke test:
 *
 *   1. THE SPRINGS EXPLODED. Semi-implicit Euler on a spring diverges once
 *      dt > 2 / (w * (z + sqrt(z^2+1))). For the gaze spring (k=2600) that
 *      threshold is 16.2ms and a 60fps frame is 16.67ms — so it was unstable on
 *      every single frame, and `lookX` reached 6e11 within a few seconds. It
 *      was invisible in a filmstrip because a pupil offset that large clamps.
 *      Caught only by asserting the animator comes to rest. Hence "settles".
 *
 *   2. IT NEVER STOPPED MOVING. WCAG 2.2 SC 2.2.2 (Level A) requires a
 *      mechanism to pause, stop or hide motion that starts automatically, runs
 *      past five seconds and sits beside other content. It is a
 *      NON-INTERFERENCE criterion: failing it fails the whole page, not just
 *      this corner. The worm's conformance rests on coming to a complete stop
 *      inside that window on its own. If a future mood table entry, oscillator
 *      or impulse breaks that, this suite fails loudly.
 *
 *   3. THE SHAPE LIST HAS TO BE FIXED-LENGTH. BookWorm.tsx builds its SVG once
 *      and then writes attributes onto element refs by index at 60fps. If
 *      poseWorm ever emits a different count, order or kind for some parameter
 *      combination, the component silently paints a circle's radius onto an
 *      ellipse and the face falls apart. The contract is asserted here because
 *      it cannot be asserted at the call site.
 *
 *   4. THE VOICE TAP CAN SILENCE THE APP. createMediaElementSource REROUTES an
 *      element: from that moment its audio reaches the speakers only through
 *      the graph you built. If the destination connect is moved after anything
 *      that can throw, a failure there makes Counsel permanently mute — far
 *      worse than a still mouth. The connect ORDER is load-bearing.
 *
 * Style follows counselComposer.test.ts: pure logic is exercised directly, and
 * the structural invariants of the component are source assertions, because the
 * component needs a DOM, an AudioContext and rAF to mount.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/\\])\/\/[^\n]*/gm, "$1");

const COMPONENT = stripComments(read("src/components/BookWorm.tsx"));
const TAP = stripComments(read("src/lib/sprite/voiceTap.ts"));
const READ_ALOUD = stripComments(read("src/hooks/useReadAloud.ts"));
const PANEL = stripComments(read("src/components/ChatPanel.tsx"));
const SHEET = stripComments(read("src/components/CounselToolsSheet.tsx"));
const POCKET = stripComments(read("src/components/PocketScreen.tsx"));
const SETTINGS = stripComments(read("src/components/SettingsPanel.tsx"));

const ALL_MOODS: Mood[] = ["sleep", "idle", "watch", "listen", "think", "read", "speak", "cheer", "oops"];

/** A fixed stream, so a failure means the animator changed, not the dice. */
const seeded = (s: number) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const run = (a: WormAnimator, seconds: number, each?: (p: WormParams, t: number) => void) => {
  let p = a.step(16.67);
  for (let i = 1; i < Math.round(seconds * 60); i++) {
    p = a.step(16.67);
    each?.(p, i / 60);
  }
  return p;
};

describe("the shape list is a fixed-length contract, not a suggestion", () => {
  // BookWorm.tsx addresses elements by index forever after mount.
  const wild: Partial<WormParams>[] = [
    {},
    { curl: 3.6, stretch: 1.6, girth: 1.2 },
    { lidL: 1, lidR: 1, mouthOpen: 1, glasses: 0, glint: 1 },
    { lidL: -0.4, lidR: 0.5, mouthSmile: -1, mouthWide: -1, browL: 0.8 },
    { baseAngle: 0, curl: -2, stretch: 0.55, mouthWide: 1, phase: 99 },
  ];

  it("always emits exactly SHAPE_COUNT shapes", () => {
    for (const w of wild) {
      expect(poseWorm({ ...REST_PARAMS, ...w }).shapes.length).toBe(SHAPE_COUNT);
    }
  });

  it("keeps keys and element kinds identical in the same order", () => {
    const base = poseWorm(REST_PARAMS).shapes;
    for (const w of wild) {
      const other = poseWorm({ ...REST_PARAMS, ...w }).shapes;
      expect(other.map((s) => s.key)).toEqual(base.map((s) => s.key));
      expect(other.map((s) => s.k)).toEqual(base.map((s) => s.k));
    }
  });

  it("gives every shape a unique key", () => {
    const keys = poseWorm(REST_PARAMS).shapes.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never emits NaN, even for parameters no mood produces", () => {
    for (const w of wild) {
      for (const s of poseWorm({ ...REST_PARAMS, ...w }).shapes) {
        const nums = Object.values(s).filter((v) => typeof v === "number") as number[];
        for (const n of nums) expect(Number.isFinite(n)).toBe(true);
        if (s.k === "path") expect(s.d).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });
});

describe("the body is a body", () => {
  it("anchors the tail and moves the head, not the other way round", () => {
    // The worm is rooted to a floor. If the tail drifts it reads as sliding.
    const a = poseWorm(REST_PARAMS);
    // Note the parameters: curl and stretch push the head in OPPOSITE
    // directions along the chord, and at (2.2, 1.3) they very nearly cancel —
    // the first version of this test asserted on that pair and measured a 2px
    // move. Leaning the whole body is the unambiguous case.
    const b = poseWorm({ ...REST_PARAMS, baseAngle: -Math.PI / 2 + 0.8, curl: 1.5 });
    expect(a.spine[0]).toEqual(b.spine[0]);
    expect(Math.hypot(a.head.p.x - b.head.p.x, a.head.p.y - b.head.p.y)).toBeGreaterThan(10);
  });

  it("conserves volume: a stretched worm is a thinner worm", () => {
    // Without this, stretch reads as the whole creature scaling up, which is
    // the commonest tell of fake squash-and-stretch.
    const tall = poseWorm({ ...REST_PARAMS, stretch: 1.4, curl: 0 });
    const squat = poseWorm({ ...REST_PARAMS, stretch: 0.7, curl: 0 });
    expect(tall.head.r).toBeLessThan(squat.head.r);
  });

  it("keeps the head attached to the neck at every curl", () => {
    // A gap between the two shapes reads as a severed head.
    for (const curl of [-2, -0.5, 0, 1.2, 2.4, 3.6]) {
      const p = poseWorm({ ...REST_PARAMS, curl });
      const neck = p.spine[p.spine.length - 1];
      const gap = Math.hypot(p.head.p.x - neck.x, p.head.p.y - neck.y);
      expect(gap).toBeLessThan(p.head.r);
    }
  });

  it("stays inside its own viewBox however far it coils", () => {
    // The coiled moods threw the head clean out of frame until `baseAngle`
    // became the tail-to-head CHORD rather than the tail's own tangent.
    for (const curl of [-1.2, 0, 1.5, 2.4, 3.4]) {
      for (const stretch of [0.8, 1, 1.3]) {
        const p = poseWorm({ ...REST_PARAMS, curl, stretch });
        expect(p.head.p.x).toBeGreaterThan(0);
        expect(p.head.p.x).toBeLessThan(VIEW_W);
        expect(p.head.p.y).toBeGreaterThan(0);
        expect(p.head.p.y).toBeLessThan(VIEH_OR_H());
      }
    }
    function VIEH_OR_H() {
      return VIEW_H;
    }
  });

  it("closes the eye into a lash line rather than a white sliver", () => {
    const open = poseWorm(REST_PARAMS).shapes;
    const shut = poseWorm({ ...REST_PARAMS, lidL: 1, lidR: 1 }).shapes;
    const at = (list: typeof open, key: string) => list.find((s) => s.key === key)!;
    expect(at(open, "lashL").op).toBeLessThan(0.05);
    expect(at(shut, "lashL").op).toBeGreaterThan(0.95);
    expect(at(shut, "eyeL").op).toBeLessThan(0.05);
  });

  it("draws the eye as ONE dark pill: taller when startled, shorter in a squint", () => {
    // The flat redraw. No white, no pupil, no catchlight — three shapes were
    // fighting over nine pixels. The pill is a round-capped stroke, so its
    // height is the length of the segment and its width is the stroke.
    const eye = (lid: number) => {
      const s = poseWorm({ ...REST_PARAMS, curl: 0, lidL: lid }).shapes.find((x) => x.key === "eyeL")!;
      if (s.k !== "path") throw new Error("the eye must stay a stroke");
      const [x1, y1, x2, y2] = s.d.match(/-?[\d.]+/g)!.map(Number);
      return { len: Math.hypot(x2 - x1, y2 - y1), sw: s.sw!, stroke: s.stroke, fill: s.fill };
    };
    expect(eye(0).stroke).toBe("pupil");
    expect(eye(0).fill).toBeUndefined();
    expect(eye(-0.4).len).toBeGreaterThan(eye(0).len);
    expect(eye(0.5).len).toBeLessThan(eye(0).len);
    // A startled eye is also a touch wider, or it reads as merely stretched.
    expect(eye(-0.4).sw).toBeGreaterThan(eye(0).sw);
  });

  it("has no eye-whites, catchlights, outlines or speculars left to draw", () => {
    const keys = poseWorm(REST_PARAMS).shapes.map((s) => s.key);
    for (const gone of ["pupilL", "specL", "headSpec", "headOutline", "bodyOutline", "ring2"]) {
      expect(keys).not.toContain(gone);
    }
    // And nothing that is filled is also outlined in a different ink.
    for (const s of poseWorm(REST_PARAMS).shapes) {
      if (s.fill && s.stroke) expect(s.stroke).toBe(s.fill);
    }
  });

  it("moves the whole eye to look, since there is no white to look across", () => {
    const x = (lookX: number) => {
      const s = poseWorm({ ...REST_PARAMS, curl: 0, lookX }).shapes.find((k) => k.key === "eyeL")!;
      return Number((s as { d: string }).d.match(/-?[\d.]+/)![0]);
    };
    expect(x(1)).toBeGreaterThan(x(0) + 1);
    expect(x(-1)).toBeLessThan(x(0) - 1);
  });

  it("lifts a raised brow instead of tilting it into a glare", () => {
    // Regression. The brow's sign was backwards from its own doc comment, so
    // `listen` — brows RAISED — rendered as a furious V. Thin strokes on a busy
    // face hid it; the flat face did not.
    const brow = (b: number) => {
      const s = poseWorm({ ...REST_PARAMS, curl: 0, browL: b, browR: b }).shapes.find((k) => k.key === "browL")!;
      const [x1, y1, x2, y2] = (s as { d: string }).d.match(/-?[\d.]+/g)!.map(Number);
      // browL is on the viewer's left with the head upright: x2 is the INNER end.
      return { innerMinusOuter: y2 - y1, midY: (y1 + y2) / 2, op: s.op! };
    };
    // A frown drops the inner end (y grows downward).
    expect(brow(0.5).innerMinusOuter).toBeGreaterThan(0.5);
    // A raise travels up the forehead...
    expect(brow(-0.5).midY).toBeLessThan(brow(0).midY - 1);
    // ...and a small one is not drawn at all.
    expect(brow(-0.22).op).toBe(0);
    expect(brow(0.2).op).toBeGreaterThan(0);
  });
});

describe("the body is a delay line for the voice", () => {
  const swells = (p: WormParams) => [p.swell0, p.swell1, p.swell2, p.swell3, p.swell4, p.swell5];

  it("a syllable reaches the neck first and the tail last, fading as it goes", () => {
    const a = new WormAnimator({ rng: seeded(21), mood: "speak" });
    run(a, 0.5);
    // One 80ms burst of voice, then silence.
    const peakAt = [0, 0, 0, 0, 0, 0];
    const peak = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60; i++) {
      a.setVoice(i < 5 ? 0.9 : 0);
      swells(a.step(16.67)).forEach((v, j) => {
        if (v > peak[j]) {
          peak[j] = v;
          peakAt[j] = i;
        }
      });
    }
    for (let j = 0; j < 5; j++) {
      expect(peakAt[j]).toBeGreaterThan(peakAt[j + 1]);
      expect(peak[j]).toBeLessThan(peak[j + 1]);
    }
    expect(peak[5]).toBeGreaterThan(0.3);
  });

  it("travels at the same speed whatever the display's refresh rate", () => {
    const tailPeakMs = (dt: number) => {
      const a = new WormAnimator({ rng: seeded(21), mood: "speak" });
      let t = 0;
      let best = 0;
      let bestT = 0;
      while (t < 900) {
        a.setVoice(t < 80 ? 0.9 : 0);
        const v = a.step(dt).swell0;
        t += dt;
        if (v > best) {
          best = v;
          bestT = t;
        }
      }
      return bestT;
    };
    expect(Math.abs(tailPeakMs(16.67) - tailPeakMs(8.33))).toBeLessThan(30);
    expect(Math.abs(tailPeakMs(16.67) - tailPeakMs(33.3))).toBeLessThan(45);
  });

  it("is silent outside speech, and drains to EXACTLY zero", () => {
    const idle = new WormAnimator({ rng: seeded(2), mood: "idle" });
    idle.setVoice(0.9);
    run(idle, 1, (p) => swells(p).forEach((v) => expect(v).toBe(0)));

    const a = new WormAnimator({ rng: seeded(2), mood: "speak" });
    run(a, 0.5, () => a.setVoice(0.8));
    a.setVoice(0);
    run(a, 1.2);
    swells(a.step(16.67)).forEach((v) => expect(v).toBe(0));
  });

  it("sends thinking pulses the other way — tail to head", () => {
    const a = new WormAnimator({ rng: seeded(4), mood: "think" });
    run(a, 1);
    const peakAt = [0, 0, 0, 0, 0, 0];
    const peak = [0, 0, 0, 0, 0, 0];
    // One full cycle is ~1.18s; watch from wherever bead 0 next peaks.
    const seen: number[][] = [];
    run(a, 1.5, (p) => seen.push(swells(p)));
    const start = seen.findIndex((f, i) => i > 0 && f[0] < seen[i - 1][0] && seen[i - 1][0] > 0.2);
    expect(start).toBeGreaterThan(-1);
    for (let i = start - 1; i < Math.min(seen.length, start + 55); i++) {
      seen[i].forEach((v, j) => {
        if (v > peak[j]) {
          peak[j] = v;
          peakAt[j] = i;
        }
      });
    }
    for (let j = 0; j < 5; j++) expect(peakAt[j + 1]).toBeGreaterThan(peakAt[j]);
  });

  it("gives a reduced-motion user none of it", () => {
    const a = new WormAnimator({ rng: seeded(4), mood: "speak", reduced: true });
    run(a, 1, (p) => {
      a.setVoice(0.9);
      swells(p).forEach((v) => expect(v).toBe(0));
    });
  });

  it("cannot be inflated by a clipped sample", () => {
    const r = (v: number) => {
      const s = poseWorm({ ...REST_PARAMS, swell3: v }).shapes.find((k) => k.key === "bead3")!;
      return (s as { r: number }).r;
    };
    expect(r(50)).toBe(r(1));
    expect(r(1)).toBeGreaterThan(r(0));
  });
});

describe("the glasses are a gesture, not furniture", () => {
  const worn = (mood: Mood) => {
    const a = new WormAnimator({ rng: seeded(6), mood });
    run(a, 3);
    return a.step(16.67).glasses;
  };

  it("wears them to read, and not otherwise", () => {
    expect(worn("read")).toBeCloseTo(1, 1);
    expect(worn("watch")).toBeCloseTo(1, 1);
    for (const m of ["idle", "listen", "think", "speak", "cheer", "oops", "sleep"] as Mood[]) {
      expect(worn(m)).toBeLessThan(0.05);
    }
  });

  it("pushes them on with an overshoot rather than fading them in", () => {
    const a = new WormAnimator({ rng: seeded(6), mood: "idle" });
    run(a, 1);
    a.setMood("read");
    let max = 0;
    run(a, 1.5, (p) => (max = Math.max(max, p.glasses)));
    expect(max).toBeGreaterThan(1.02);
    expect(max).toBeLessThan(1.25);
  });

  it("slides them down from the forehead", () => {
    const y = (g: number) => {
      const s = poseWorm({ ...REST_PARAMS, curl: 0, glasses: g }).shapes.find((k) => k.key === "frameL")!;
      return { cy: (s as { cy: number }).cy, op: s.op! };
    };
    expect(y(0.3).cy).toBeLessThan(y(1).cy - 3);
    expect(y(0).op).toBe(0);
    expect(y(1).op).toBe(1);
  });

  it("tints the lens UNDER the eye and frames it over, so the eyes stay the darkest ink", () => {
    const keys = poseWorm(REST_PARAMS).shapes.map((s) => s.key);
    expect(keys.indexOf("lensL")).toBeLessThan(keys.indexOf("eyeL"));
    expect(keys.indexOf("frameL")).toBeGreaterThan(keys.indexOf("eyeL"));
  });
});

describe("it comes to a complete stop — WCAG 2.2 SC 2.2.2", () => {
  // See note 2 at the top. This is the conformance story for the whole feature.
  it.each(ALL_MOODS)("settles within five seconds: %s", (mood) => {
    const a = new WormAnimator({ rng: seeded(11), mood });
    a.pop(1);
    a.glint();
    a.clause();
    a.pet();
    let settledAt = -1;
    for (let i = 0; i < 60 * 12; i++) {
      a.step(16.67);
      if (settledAt < 0 && a.isSettled()) settledAt = i / 60;
    }
    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThanOrEqual(5);
  });

  it("emits identical numbers frame after frame once settled", () => {
    // If a settled worm still varies, the host's loop can never stop.
    const a = new WormAnimator({ rng: seeded(3), mood: "idle" });
    run(a, 8);
    const p1 = a.step(16.67);
    const p2 = a.step(16.67);
    for (const k of Object.keys(p1) as (keyof WormParams)[]) {
      expect(Math.abs(p1[k] - p2[k])).toBeLessThan(1e-6);
    }
  });

  it("stops blinking once settled — a still drawing has still eyes", () => {
    const a = new WormAnimator({ rng: seeded(5), mood: "idle" });
    run(a, 7);
    let moved = 0;
    run(a, 6, (p) => {
      if (p.lidL > 0.02) moved++;
    });
    expect(moved).toBe(0);
  });

  it("wakes again on the next conversational beat", () => {
    const a = new WormAnimator({ rng: seeded(9), mood: "idle" });
    run(a, 8);
    expect(a.isSettled()).toBe(true);
    a.topicChange();
    a.step(16.67);
    expect(a.isSettled()).toBe(false);
  });

  it("goes still almost at once under reduced motion", () => {
    const a = new WormAnimator({ rng: seeded(2), mood: "idle", reduced: true });
    a.setMood("cheer");
    a.pop(1);
    let settledAt = -1;
    for (let i = 0; i < 60 * 6; i++) {
      a.step(16.67);
      if (settledAt < 0 && a.isSettled()) settledAt = i / 60;
    }
    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThan(3);
  });

  it("runs no oscillator at all under reduced motion", () => {
    const a = new WormAnimator({ rng: seeded(4), mood: "speak", reduced: true });
    a.setVoice(1, 1);
    let jaw = 0;
    let wave = 0;
    run(a, 4, (p) => {
      jaw = Math.max(jaw, p.mouthOpen);
      wave = Math.max(wave, Math.abs(p.wave));
    });
    expect(jaw).toBeLessThan(0.02);
    expect(wave).toBeLessThan(0.02);
  });
});

describe("the springs are numerically stable", () => {
  // Regression for note 1: the gaze spring diverged at exactly 60fps.
  it("never diverges at any plausible frame time", () => {
    for (const dt of [8, 16.67, 20, 33.3, 50, 120, 400]) {
      const a = new WormAnimator({ rng: seeded(13), mood: "idle" });
      for (let i = 0; i < 400; i++) {
        const p = a.step(dt);
        a.setMood(i % 40 === 0 ? "think" : i % 23 === 0 ? "cheer" : "idle");
        for (const k of Object.keys(p) as (keyof WormParams)[]) {
          expect(Number.isFinite(p[k])).toBe(true);
        }
        expect(Math.abs(p.lookX)).toBeLessThanOrEqual(1.01);
        expect(Math.abs(p.lookY)).toBeLessThanOrEqual(1.01);
        expect(p.stretch).toBeLessThan(2);
        expect(p.stretch).toBeGreaterThan(0.4);
      }
    }
  });

  it("survives a backgrounded tab handing it a huge dt", () => {
    const a = new WormAnimator({ rng: seeded(17), mood: "think" });
    a.step(30_000);
    const p = a.step(16.67);
    for (const k of Object.keys(p) as (keyof WormParams)[]) expect(Number.isFinite(p[k])).toBe(true);
  });
});

describe("the idle behaviour is the measured kind", () => {
  it("blinks least while reading and most while speaking", () => {
    // Bentivoglio et al. 1997: 17/min at rest, 26 in conversation, 4.5 reading.
    // Reproducing that ordering is what stops the face looking mechanical.
    const count = (mood: Mood) => {
      const a = new WormAnimator({ rng: seeded(29), mood });
      let blinks = 0;
      let wasShut = false;
      for (let i = 0; i < 60 * 60; i++) {
        // Keep the motion budget topped up, or it settles and stops blinking.
        if (i % 30 === 0) a.bump();
        const p = a.step(16.67);
        const shut = p.lidL > 0.8;
        if (shut && !wasShut) blinks++;
        wasShut = shut;
      }
      return blinks;
    };
    const reading = count("read");
    const idle = count("idle");
    const speaking = count("speak");
    expect(reading).toBeLessThan(idle);
    expect(idle).toBeLessThan(speaking);
    expect(reading).toBeGreaterThan(0);
  });

  it("does not blink on a metronome", () => {
    // Evenly-spaced blinking is the single clearest tell that a face is code.
    // Inter-blink intervals in people are log-normal (Bentivoglio; Cruz 2010),
    // not uniform and not Poisson.
    const a = new WormAnimator({ rng: seeded(31), mood: "idle" });
    const gaps: number[] = [];
    let lastAt = 0;
    let wasShut = false;
    for (let i = 0; i < 60 * 180; i++) {
      if (i % 30 === 0) a.bump();
      const p = a.step(16.67);
      const shut = p.lidL > 0.8;
      if (shut && !wasShut) {
        if (lastAt) gaps.push((i - lastAt) / 60);
        lastAt = i;
      }
      wasShut = shut;
    }
    expect(gaps.length).toBeGreaterThan(8);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
    // Right-skewed with a real tail: a metronome would have sd near zero.
    expect(sd / mean).toBeGreaterThan(0.25);
    expect(Math.max(...gaps)).toBeGreaterThan(mean);
  });

  it("blinks just after a clause, and later after a topic change", () => {
    // Hömke et al. put conversational blinks at a median +20ms from the clause
    // end; Nakano et al. put the first blink after a topic change at 400-600ms.
    // They are different rules and the worm uses both.
    const firstBlink = (fire: (a: WormAnimator) => void) => {
      const a = new WormAnimator({ rng: seeded(41), mood: "speak" });
      fire(a);
      for (let i = 0; i < 60 * 2; i++) {
        if (a.step(16.67).lidL > 0.5) return i / 60;
      }
      return Infinity;
    };
    const clauseAt = firstBlink((a) => a.clause());
    const topicAt = firstBlink((a) => a.topicChange());
    expect(clauseAt).toBeLessThan(0.2);
    expect(topicAt).toBeGreaterThan(0.35);
    expect(topicAt).toBeLessThan(0.85);
  });

  it("anticipates before it pops — the body compresses first", () => {
    // A spring cannot do this: its nature is to move toward its target. The
    // anticipation is an authored curve, which is why impulses exist.
    const a = new WormAnimator({ rng: seeded(43), mood: "idle" });
    const rest = a.step(16.67).stretch;
    a.pop(1);
    let low = Infinity;
    let high = -Infinity;
    let lowAt = 0;
    let highAt = 0;
    run(a, 0.8, (p, t) => {
      if (p.stretch < low) { low = p.stretch; lowAt = t; }
      if (p.stretch > high) { high = p.stretch; highAt = t; }
    });
    expect(low).toBeLessThan(rest - 0.03);
    expect(high).toBeGreaterThan(rest + 0.1);
    expect(lowAt).toBeLessThan(highAt);
  });

  it("changes the wave phase smoothly when the rate changes", () => {
    // Sampling sin(t * rate) instead of integrating looks identical until a
    // rate changes, at which point the phase jumps and the whole body snaps.
    const a = new WormAnimator({ rng: seeded(47), mood: "idle" });
    run(a, 2);
    let prev = a.step(16.67).phase;
    a.setMood("speak");
    let worst = 0;
    run(a, 2, (p) => {
      let d = p.phase - prev;
      if (d < -Math.PI) d += Math.PI * 2;
      worst = Math.max(worst, Math.abs(d));
      prev = p.phase;
    });
    expect(worst).toBeLessThan(0.6);
  });

  it("opens the lid more slowly than it closes it", () => {
    // Kwon et al. 2013: the opening phase runs 2-3x the closing phase. A
    // symmetric blink reads as a dropped frame.
    const a = new WormAnimator({ rng: seeded(53), mood: "idle" });
    a.blinkAfter(0.01);
    let closing = 0;
    let opening = 0;
    let prev = 0;
    run(a, 1.2, (p) => {
      if (p.lidL > prev + 1e-6) closing++;
      else if (p.lidL < prev - 1e-6 && p.lidL > 0.001) opening++;
      prev = p.lidL;
    });
    expect(closing).toBeGreaterThan(0);
    expect(opening).toBeGreaterThan(closing * 1.5);
  });

  it("gives its idle oscillators incommensurate periods, so it never loops", () => {
    // Live2D's trick: no two periods share a rational ratio, so the
    // superposition has no visible repeat. Free aliveness.
    const SRC = stripComments(read("src/lib/sprite/wormAnimator.ts"));
    expect(SRC).toContain("SWAY_A_SEC = 6.5345");
    expect(SRC).toContain("SWAY_B_SEC = 3.5345");
    expect(SRC).toMatch(/breathSec: 4\.2345/);
  });
});

describe("the mood ladder", () => {
  const base: MoodSignals = {
    speaking: false,
    listening: false,
    thinking: false,
    streamingText: false,
    failed: false,
    typing: false,
    sinceTypedMs: 1e9,
    sinceDoneMs: 1e9,
    idleMs: 0,
  };
  const m = (o: Partial<MoodSignals>) => resolveWormMood({ ...base, ...o }).mood;

  it("puts speech above everything — the mouth must match the audio", () => {
    expect(m({ speaking: true, listening: true, thinking: true, failed: true })).toBe("speak");
  });

  it("puts an open microphone above thinking", () => {
    expect(m({ listening: true, thinking: true })).toBe("listen");
  });

  it("separates waiting for a reply from reading one", () => {
    expect(m({ thinking: true })).toBe("think");
    expect(m({ thinking: true, streamingText: true })).toBe("read");
  });

  it("lets a failure cancel the celebration", () => {
    expect(m({ sinceDoneMs: 200 })).toBe("cheer");
    expect(m({ sinceDoneMs: 200, failed: true })).toBe("oops");
  });

  it("stops celebrating, and stops sulking, on schedule", () => {
    expect(m({ sinceDoneMs: CHEER_MS - 1 })).toBe("cheer");
    expect(m({ sinceDoneMs: CHEER_MS + 1 })).toBe("idle");
    expect(m({ sinceDoneMs: OOPS_MS + 1, failed: true })).toBe("idle");
  });

  it("keeps watching a moment past the last keystroke", () => {
    // Otherwise it flicks in and out between words.
    expect(m({ typing: true, sinceTypedMs: WATCH_MS - 1 })).toBe("watch");
    expect(m({ typing: true, sinceTypedMs: WATCH_MS + 1 })).toBe("idle");
  });

  it("sleeps only after a long silence", () => {
    expect(m({ idleMs: SLEEP_MS - 1 })).toBe("idle");
    expect(m({ idleMs: SLEEP_MS })).toBe("sleep");
  });

  it("reports when to look again instead of asking to be polled", () => {
    // A companion that needs a ticking interval just to notice it should look
    // sleepy costs more than it gives.
    expect(resolveWormMood({ ...base, sinceDoneMs: 500 }).recheckInMs).toBe(CHEER_MS - 500);
    expect(resolveWormMood({ ...base, speaking: true }).recheckInMs).toBe(Infinity);
  });
});

describe("the component is a decoration and behaves like one", () => {
  it("is hidden from assistive tech and never takes a tap", () => {
    // Every state it reflects is already in text elsewhere on the bar, so it
    // must cost a screen-reader user nothing — and it sits over the transcript.
    expect(COMPONENT).toContain('aria-hidden="true"');
    expect(COMPONENT).toContain('focusable="false"');
    expect(COMPONENT).toContain('pointerEvents: "none"');
    expect(PANEL).toContain("pointer-events-none select-none");
  });

  it("stops scheduling frames when the animator settles", () => {
    expect(COMPONENT).toMatch(/if \(a\.isSettled\(\)\) \{\s*raf\.current = null;\s*return;/);
  });

  it("stops when the tab is hidden or it scrolls out of view", () => {
    expect(COMPONENT).toContain('document.addEventListener("visibilitychange"');
    expect(COMPONENT).toContain("new IntersectionObserver");
  });

  it("listens for prefers-reduced-motion changing, not just its value at mount", () => {
    // The media query only affects CSS by itself; anything driven from JS has
    // to stop what is already in flight.
    expect(COMPONENT).toContain('mq.addEventListener?.("change"');
    expect(COMPONENT).toContain("setReduced(mq.matches)");
  });

  it("paints by writing attributes, never by re-rendering", () => {
    // 35 nodes through React at 60fps is real money on a mid-range Android.
    expect(COMPONENT).toContain("el.setAttribute");
    expect(COMPONENT).not.toContain("useState");
  });

  it("samples the voice inside the frame, not through React state", () => {
    expect(COMPONENT).toContain("voiceRef.current?.()");
  });

  it("ships a real control, because reduced-motion alone does not satisfy 2.2.2", () => {
    expect(SHEET).toContain('label="Companion"');
    expect(SHEET).toContain("wormEnabled");
    expect(PANEL).toContain("worm.setEnabled(!worm.enabled)");
  });
});

describe("the voice tap cannot silence the app", () => {
  it("connects the destination before it builds anything that can throw", () => {
    // createMediaElementSource REROUTES the element. If this order is inverted,
    // a failure anywhere after it leaves Counsel permanently mute.
    const src = TAP.indexOf("createMediaElementSource");
    const dest = TAP.indexOf("source.connect(ctx.destination)");
    const analyser = TAP.indexOf("createAnalyser");
    expect(src).toBeGreaterThan(-1);
    expect(dest).toBeGreaterThan(src);
    expect(analyser).toBeGreaterThan(dest);
  });

  it("never routes the same element twice", () => {
    // A second call on one element throws, and the element in useReadAloud is
    // created once and reused by every session for the life of the document.
    expect(TAP).toContain("new WeakSet<HTMLAudioElement>()");
    expect(TAP).toContain("routed.has(el)");
  });

  it("swallows every failure — a still mouth beats no audio", () => {
    expect(TAP).toMatch(/catch \{[\s\S]*?return false;/);
  });

  it("allocates its buffers once, not per frame", () => {
    const readFn = TAP.slice(TAP.indexOf("export function readVoice"));
    expect(readFn).not.toContain("new Uint8Array");
  });

  it("keeps the analysis lag low, against the stock defaults", () => {
    // smoothingTimeConstant 0.8 is a ~75ms EMA at 60fps; with the window that
    // is ~96ms of lag before a pixel moves. The asymmetry matters: a mouth may
    // be ~125ms late but only ~45ms early, and Android output latency already
    // pushes this tap toward early.
    expect(TAP).toContain("analyser.fftSize = 1024");
    expect(TAP).toContain("analyser.smoothingTimeConstant = 0.1");
  });

  it("is attached where the audio element is created, and nowhere else", () => {
    expect(READ_ALOUD).toContain("attachVoiceTap(audio)");
    expect(READ_ALOUD.split("attachVoiceTap(").length - 1).toBe(1);
    expect(READ_ALOUD).toContain("resumeVoiceTap()");
  });

  it("falls back to a synthetic envelope when the engine cannot be analysed", () => {
    // speechSynthesis output never enters the page's audio graph at all.
    const HOOK = stripComments(read("src/hooks/useBookWorm.ts"));
    expect(HOOK).toContain("readVoice() ?? syntheticVoice(");
  });
});

describe("it does not poll", () => {
  it("scans streamed text incrementally, not from the top on every delta", () => {
    // This effect runs on every token. Re-matching the whole accumulated reply
    // each time is O(n^2) on the main thread during the busiest part of a turn.
    const HOOK = stripComments(read("src/hooks/useBookWorm.ts"));
    expect(HOOK).toContain("sig.lastText.slice(scannedTo.current)");
    expect(HOOK).not.toContain("sig.lastText.match(");
  });

  it("schedules one timeout at the next possible change", () => {
    const HOOK = stripComments(read("src/hooks/useBookWorm.ts"));
    expect(HOOK).toContain("setTimeout(evaluate");
    expect(HOOK).not.toContain("setInterval");
  });

  it("remembers the user's choice, and survives storage being unavailable", () => {
    const HOOK = stripComments(read("src/hooks/useBookWorm.ts"));
    expect(HOOK).toContain('const STORAGE_KEY = "counsel_bookworm"');
    expect(HOOK).toMatch(/localStorage\.getItem\(STORAGE_KEY\)[\s\S]{0,80}catch/);
    expect(HOOK).toMatch(/localStorage\.setItem\(STORAGE_KEY[\s\S]{0,120}catch/);
  });
});


describe("tap to pet", () => {
  const smileAfter = (build: (a: WormAnimator) => void, seconds: number) => {
    const a = new WormAnimator({ rng: seeded(61), mood: "idle" });
    a.step(16.67);
    build(a);
    let peak = -Infinity;
    run(a, seconds, (p) => {
      peak = Math.max(peak, p.mouthSmile);
    });
    return peak;
  };

  it("is a reaction laid over the mood, not a mood of its own", () => {
    // Routing it through the mood ladder would mean a pet outranked whatever
    // the conversation was actually doing.
    const a = new WormAnimator({ rng: seeded(62), mood: "think" });
    a.step(16.67);
    a.pet();
    run(a, 0.4);
    expect(a.getMood()).toBe("think");
  });

  it("smiles and squints, then returns to composure", () => {
    const a = new WormAnimator({ rng: seeded(63), mood: "idle" });
    const rest = a.step(16.67);
    a.pet();
    let peakSmile = -Infinity;
    let peakLid = -Infinity;
    run(a, 0.5, (p) => {
      peakSmile = Math.max(peakSmile, p.mouthSmile);
      peakLid = Math.max(peakLid, p.lidL);
    });
    expect(peakSmile).toBeGreaterThan(rest.mouthSmile + 0.2);
    expect(peakLid).toBeGreaterThan(0.3);
    // ...and then lets go of it. A reaction that never resolves is a mood.
    const after = run(a, 3);
    expect(Math.abs(after.mouthSmile - rest.mouthSmile)).toBeLessThan(0.08)
  });

  it("reacts harder to being fussed over than to being greeted", () => {
    const once = smileAfter((a) => a.pet(), 1);
    const thrice = smileAfter((a) => {
      a.pet();
      for (let i = 0; i < 12; i++) a.step(16.67);
      a.pet();
      for (let i = 0; i < 12; i++) a.step(16.67);
      a.pet();
    }, 1);
    expect(thrice).toBeGreaterThan(once);
  });

  it("wakes a sleeping worm even under reduced motion", () => {
    // The reaction is suppressed, but bump() still runs — so the host's mood
    // ladder leaves "sleep". Being unable to rouse it would be a bug, not
    // restraint.
    const a = new WormAnimator({ rng: seeded(64), mood: "sleep", reduced: true });
    run(a, 6);
    expect(a.isSettled()).toBe(true);
    a.pet();
    a.step(16.67);
    expect(a.isSettled()).toBe(false);
  });

  it("moves nothing under reduced motion", () => {
    const a = new WormAnimator({ rng: seeded(65), mood: "idle", reduced: true });
    const before = a.step(16.67);
    a.pet();
    let peak = -Infinity;
    run(a, 1, (p) => {
      peak = Math.max(peak, p.mouthSmile);
    });
    expect(peak).toBeLessThanOrEqual(before.mouthSmile + 1e-6);
  });

  it("fires on pointer-UP past a movement threshold, never on pointer-down", () => {
    // The composer's prompt switcher already shipped this bug once: it opened
    // on the DOWN event and fired before the finger had travelled. The worm
    // sits where a thumb lands to start a scroll, so down-to-pet would fire on
    // every flick.
    expect(COMPONENT).toContain("onPointerUp");
    expect(COMPONENT).toContain("onPointerCancel");
    expect(COMPONENT).toMatch(/Math\.hypot\(e\.clientX - d\.x, e\.clientY - d\.y\) > 10/);
    const onDown = COMPONENT.slice(COMPONENT.indexOf("const onDown"), COMPONENT.indexOf("const onUp"));
    expect(onDown).not.toContain("pet()");
  });

  it("makes only the worm's own ink tappable", () => {
    // The svg stays pointer-events:none and exactly two fills opt back in, so
    // a tap beside the worm — or on its eyes — falls through to the transcript.
    expect(COMPONENT).toContain('pointerEvents: "none"');
    expect(COMPONENT).toContain('pointerEvents: "auto" as const');
    expect(COMPONENT).toMatch(/s\.key === "body" \|\| s\.key === "head" \|\| s\.key\.startsWith\("bead"\)/);
  });
});

describe("the browser voice drives the mouth from word events", () => {
  const T = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

  it("falls back to a free-running rhythm when no word event is recent", () => {
    // Stale by construction, so this holds whatever earlier tests did to the
    // module's state.
    const t0 = T();
    let moved = 0;
    for (let i = 0; i < 60; i++) {
      if (syntheticVoice(t0 + 10 + i / 60).level > 0.25) moved++;
    }
    expect(moved).toBeGreaterThan(5);
  });

  it("opens the mouth across a word and closes it in the gap after", () => {
    const t0 = T();
    noteWordBoundary(4);
    expect(hasWordBoundaries()).toBe(true);
    // charLength 4 -> ~214ms of word; sample the middle of it, then well past.
    expect(syntheticVoice(t0 + 0.107).level).toBeGreaterThan(0.5);
    expect(syntheticVoice(t0 + 0.6).level).toBeLessThan(0.1);
  });

  it("keeps a long word busy longer than a short one", () => {
    // "a" and "extraordinarily" should not produce the same shape, and
    // charLength is the only hint the boundary event gives.
    const short = T();
    noteWordBoundary(1);
    const shortLate = syntheticVoice(short + 0.3).level;
    const long = T();
    noteWordBoundary(14);
    const longLate = syntheticVoice(long + 0.3).level;
    expect(longLate).toBeGreaterThan(shortLate + 0.3);
  });

  it("is wired to the boundary event, and skips sentence boundaries", () => {
    // A sentence boundary would gape once per sentence instead of per word.
    expect(READ_ALOUD).toContain("u.onboundary = (e: SpeechSynthesisEvent)");
    expect(READ_ALOUD).toContain("noteWordBoundary(e.charLength)");
    expect(READ_ALOUD).toMatch(/if \(e\.name === "sentence"\) return;/);
  });
});


describe("it shows up on the pocket screen too", () => {
  // The hands-free guard is a near-black full-screen overlay that arms after
  // 12s untouched, for a phone sitting in a pocket with the mic live. Adding a
  // character to it is only defensible if it respects what that screen is for.

  it("never swallows the double tap that dismisses the guard", () => {
    // THE important one. That gesture is the only way out of this overlay, and
    // a worm that ate it would strand the user on a black screen. No `onPet`
    // means no shape opts into hit testing at all.
    // Anchored on the style prop, not on "<BookWorm" — that substring also
    // occurs inside `useRef<BookWormHandle>` further up the file, which is how
    // the first version of this assertion silently measured the wrong slice.
    const at = POCKET.indexOf("style={DIM_WORM}");
    expect(at).toBeGreaterThan(-1);
    const wrapper = POCKET.slice(POCKET.lastIndexOf("<div", at), at);
    expect(wrapper).toContain("pointer-events-none");
    const mount = POCKET.slice(at, POCKET.indexOf("/>", at));
    expect(mount).not.toContain("onPet");
  });

  it("uses OPAQUE ink, so the body cannot show through the head", () => {
    // These were rgba() at 0.15 alpha, which made the head tinted glass: the
    // body tube ran visibly straight through the face, because the head is a
    // separate ellipse drawn over it and a see-through fill occludes nothing.
    // The offline render harness never showed it — that harness composites
    // colours over black to build its SVG, so the thing being looked at was
    // opaque while the thing shipping was not.
    const block = POCKET.slice(POCKET.indexOf("const DIM_WORM"), POCKET.indexOf("const MOOD_FOR"));
    expect(block).not.toContain("rgba(");
    expect(block).toMatch(/"--worm-body" as string\]: "#[0-9A-Fa-f]{6}"/);
    expect(block).toContain('"transparent"'); // the shadow, which stays off
  });

  it("dims the creature rather than just shrinking it", () => {
    // Full-saturation green on an overlay whose whole point is that OLED pixels
    // are off would defeat the screen.
    expect(POCKET).toContain("const DIM_WORM");
    for (const v of ["--worm-body", "--worm-dark", "--worm-eye", "--worm-spec", "--worm-pupil"]) {
      expect(POCKET).toContain(v);
    }
  });

  it("keeps the dimmed values dark, whatever form they are written in", () => {
    // Opaque does not mean bright. Every channel of the body fill stays well
    // under mid-grey, or the overlay stops being an off screen.
    const m = POCKET.match(/"--worm-body" as string\]: "#([0-9A-Fa-f]{6})"/);
    const hex = m![1];
    for (let i = 0; i < 6; i += 2) expect(parseInt(hex.slice(i, i + 2), 16)).toBeLessThan(80);
  });

  it("cuts the face out of the body as unlit pixels, and lights the frames instead", () => {
    // The flat worm has no contour to brighten. The eyes and mouth are pure
    // black — on an OLED, holes in the light, legible for no power at all —
    // while the glasses go LIGHTER than the body, because they overhang the
    // head and a black frame over a black screen is no frame.
    const lum = (token: string) => {
      const m = POCKET.match(new RegExp(`"${token}" as string\\]: "#([0-9A-Fa-f]{6})"`));
      if (!m) throw new Error("no " + token);
      const h = m[1];
      return parseInt(h.slice(0, 2), 16) + parseInt(h.slice(2, 4), 16) + parseInt(h.slice(4, 6), 16);
    };
    expect(lum("--worm-pupil")).toBe(0);
    expect(lum("--worm-mouth")).toBe(0);
    expect(lum("--worm-dark")).toBeLessThan(lum("--worm-body"));
    expect(lum("--worm-frame")).toBeGreaterThan(lum("--worm-body"));
    expect(lum("--worm-spec")).toBeGreaterThan(lum("--worm-frame"));
  });

  it("drops the contact shadow — it is not standing on anything out there", () => {
    expect(POCKET).toMatch(/--worm-shadow[^\n]*transparent/);
  });

  it("keeps the status glyph, which is the only explicit listening signal", () => {
    // The worm is decorative and aria-hidden. "Is it listening to me?" is not a
    // question to answer in mime.
    expect(POCKET).toContain("material-symbols-outlined");
    expect(POCKET).toMatch(/state === "listening" \? "mic"/);
  });

  it("maps every hands-free state onto a mood", () => {
    expect(POCKET).toContain("const MOOD_FOR: Record<string, Mood>");
    for (const k of ["listening", "thinking", "speaking"]) expect(POCKET).toContain(k + ":");
    // `idle` is the fallback rather than a key, so an unknown state is safe.
    expect(POCKET).toContain('MOOD_FOR[state] ?? "idle"');
  });

  it("respects the companion being switched off", () => {
    expect(POCKET).toContain("{wormEnabled && (");
    expect(PANEL).toContain("wormEnabled={worm.enabled}");
  });

  it("stands the transcript worm down while the guard covers it", () => {
    // Otherwise two animators run, one of them behind an opaque overlay.
    expect(POCKET).toContain("onArmedChange?.(guarding)");
    expect(PANEL).toContain("onArmedChange={setPocketArmed}");
    expect(PANEL).toContain("{worm.enabled && !pocketArmed && (");
  });

  it("still blinks at spoken clause boundaries", () => {
    expect(POCKET).toContain("wormRef.current?.clause()");
    expect(PANEL).toMatch(/speakChunk=\{speakProgress\?\.index \?\? null\}/);
  });

  it("can be switched off in Settings, and defaults ON", () => {
    // The pocket screen shipped before it was a setting, so an absent key has
    // to read as enabled or every existing user silently loses the guard.
    expect(SETTINGS).toContain('const POCKET_SCREEN_KEY = "hands_free_pocket_screen"');
    expect(SETTINGS).toContain('localStorage.getItem(POCKET_SCREEN_KEY) !== "false"');
    expect(SETTINGS).toContain("localStorage.setItem(POCKET_SCREEN_KEY, String(pocketScreen))");
    expect(SETTINGS).toContain("<FieldLabel>Pocket screen (hands-free, phones)</FieldLabel>");
    expect(SETTINGS).toContain('ariaLabel="Enable the hands-free pocket screen"');
  });

  it("is gated on that setting where it mounts", () => {
    expect(PANEL).toContain('localStorage.getItem("hands_free_pocket_screen") !== "false"');
    expect(PANEL).toContain("active={handsFree.active && pocketScreenEnabled}");
  });

  it("gives the dark-ground colours their own variables", () => {
    // On black the defaults collapse: the catchlight vanishes into the eye, the
    // glasses and brows into the pupil they share a value with.
    expect(COMPONENT).toContain("var(--worm-spec, var(--worm-eye");
    expect(COMPONENT).toContain("var(--worm-brow, var(--worm-pupil");
    expect(COMPONENT).toContain("var(--worm-frame, var(--worm-pupil");
    expect(COMPONENT).toContain("var(--worm-shadow, #000000)");
  });
});


describe("the caption under the worm", () => {
  const base: CaptionSignals = {
    handsFreeActive: true,
    state: "idle",
    interim: "",
    assistantText: null,
    assistantId: null,
    lastUserText: "how many chapters are left",
    lastUserId: "u1",
  };
  const c = (o: Partial<CaptionSignals>) => resolvePocketCaption({ ...base, ...o });

  it("shows nothing when hands-free is off", () => {
    expect(c({ handsFreeActive: false, assistantText: "hello" })).toBeNull();
  });

  it("KEEPS the reply up after the voice stops", () => {
    // The regression this file exists for. The first version showed only the
    // sentence being spoken, so the answer vanished the instant the audio
    // ended — useless for the actual job, which is hearing something and then
    // reading it back without unlocking the phone.
    const spoken = c({ state: "speaking", assistantText: "Twelve chapters remain.", assistantId: "a1" });
    const after = c({ state: "idle", assistantText: "Twelve chapters remain.", assistantId: "a1" });
    expect(spoken).toEqual(after);
    expect(after).toMatchObject({ text: "Twelve chapters remain.", from: "assistant" });
  });

  it("shows the whole reply, not the fragment being spoken", () => {
    const long = "First sentence. Second sentence. Third sentence.";
    expect(c({ state: "speaking", assistantText: long, assistantId: "a1" })!.text).toBe(long);
  });

  it("keeps one stable id while the reply streams, so the fade does not strobe", () => {
    // The bubble keys its entrance animation on this. Keying on the text
    // replayed the fade on every streamed token.
    const a = c({ assistantText: "Twelve", assistantId: "a1" });
    const b = c({ assistantText: "Twelve chapters remain.", assistantId: "a1" });
    expect(a!.id).toBe(b!.id);
    expect(a!.text).not.toBe(b!.text);
  });

  it("yields to the live transcript the moment the user speaks", () => {
    expect(c({ state: "listening", interim: "how many chap", assistantText: "old answer", assistantId: "a1" }))
      .toMatchObject({ text: "how many chap", from: "user" });
  });

  it("shows the waiting question while the model works", () => {
    // Otherwise the screen is blank through the longest pause in the cycle.
    expect(c({ state: "thinking", assistantText: "old answer", assistantId: "a1" }))
      .toMatchObject({ text: "how many chapters are left", from: "user" });
  });

  it("falls back to the user's own line before any reply exists", () => {
    expect(c({ assistantText: null })).toMatchObject({ from: "user" });
    expect(c({ assistantText: null, lastUserText: null })).toBeNull();
  });

  it("renders markdown as something readable, keeping the paragraph breaks", () => {
    // Not stripMarkdownForTts, which flattens every newline to ". " — right for
    // a speech engine, destructive for something being read.
    expect(plainText("## Title\n\n**bold** and `code` and [link](http://x)")).toBe(
      "Title\n\nbold and code and link",
    );
    expect(plainText("- one\n- two")).toBe("• one\n• two");
    expect(plainText("a\n\nb")).toContain("\n\n");
  });

  it("caps the length so a pasted wall of text is not sitting in the DOM", () => {
    const long = c({ assistantText: "x".repeat(CAPTION_MAX + 500), assistantId: "a1" });
    expect(long!.text.length).toBe(CAPTION_MAX + 1);
    expect(long!.text.endsWith("…")).toBe(true);
  });

  it("is not clamped, and takes the whole middle of the screen", () => {
    // line-clamp-4 was cutting answers off mid-thought — reported twice, and
    // the reason the bubble is a full-height scroll box now rather than a
    // fixed-height one centred around a 132px worm.
    expect(POCKET).not.toContain("line-clamp");
    expect(POCKET).not.toContain("max-h-[52vh]");
    expect(POCKET).toContain("flex-1 min-h-0 overflow-y-auto");
    expect(POCKET).toContain("whitespace-pre-wrap");
  });

  it("is set big enough to actually read at arm's length", () => {
    expect(POCKET).toContain("text-[16px] leading-relaxed");
    expect(POCKET).toContain("max-w-[46ch]");
  });

  it("says when there is more below, because drag-scrolling is invisible", () => {
    expect(POCKET).toContain("{reading && more && (");
    expect(POCKET).toContain("keyboard_double_arrow_down");
    expect(POCKET).toContain("el.scrollHeight - el.scrollTop - el.clientHeight > STICK_SLOP");
  });

  it("switches to a reading layout, shrinking the worm to an avatar", () => {
    // Keeping the reading layout centred on a 132px worm spent half a phone on
    // decoration while the text scrolled in a letterbox.
    expect(POCKET).toContain("const reading = !!caption;");
    expect(POCKET).toContain("size={reading ? 84 : 132}");
    expect(POCKET).toMatch(/reading \? "justify-start" : "justify-center"/);
  });

  it("clears the notch and the home indicator", () => {
    // The overlay covers them, so its content has to clear them itself.
    expect(POCKET).toContain("env(safe-area-inset-top, 0px)");
    expect(POCKET).toContain("env(safe-area-inset-bottom, 0px)");
  });

  it("can be dragged to read a long answer", () => {
    // The overlay is touch-none and touch-action cannot be re-enabled by a
    // descendant, so native scrolling is unavailable in here; scrollTop is
    // moved by hand from pointermove instead.
    expect(POCKET).toContain("onPointerMove={onBubbleMove}");
    expect(POCKET).toContain("el.scrollTop = d.top - dy");
  });

  it("still lets a tap on the text count toward the double tap", () => {
    // A scrollable bubble must not become a dead zone where the only way out
    // of the guard stops working.
    expect(POCKET).toContain("const registerTap");
    expect(POCKET).toMatch(/onBubbleUp[\s\S]*?registerTap\(e\.isPrimary\)/);
    expect(POCKET).toContain("if (!d || d.moved > DRAG_SLOP) return;");
  });

  it("follows a streaming reply only while the view is already at the bottom", () => {
    expect(POCKET).toContain("el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP");
  });

  it("starts a new line at the top", () => {
    expect(POCKET).toMatch(/box\.current\.scrollTop = 0;[\s\S]*?\}, \[caption\?\.id\]\);/);
  });

  it("is aria-hidden, because the live region behind it already announces this", () => {
    const bubble = POCKET.slice(POCKET.indexOf("{caption && ("), POCKET.indexOf("material-symbols-outlined"));
    expect(bubble).toContain('aria-hidden="true"');
  });

  it("does not use the themed bubble classes, which carry a bright accent", () => {
    // dexters-lab paints a 3px fully-saturated cyan/magenta edge on those — the
    // one thing this screen exists not to have.
    expect(POCKET).not.toContain("message-bubble-ai");
    expect(POCKET).not.toContain("message-bubble-user");
    // ...but keeps the asymmetric corner, so it still reads as a chat bubble.
    expect(POCKET).toContain('borderRadius: "1.5rem 1.5rem 1.5rem 0.25rem"');
    expect(POCKET).toContain('borderRadius: "1.5rem 1.5rem 0.25rem 1.5rem"');
  });

  it("fades on change only for people who have not asked for less motion", () => {
    expect(POCKET).toContain("motion-safe:animate-fade-in");
    expect(POCKET).toContain("key={caption.id}");
  });
});

describe("the geometry stays cheap", () => {
  it("builds a pose fast enough to be free at 60fps", () => {
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) poseWorm({ ...REST_PARAMS, phase: i * 0.01, curl: (i % 30) / 10 });
    const perPose = (performance.now() - t0) / 2000;
    // A 60fps frame is 16.67ms. Generous bound: CI machines are noisy.
    expect(perPose).toBeLessThan(1);
  });

  it("rounds its path numbers, which land in the DOM every frame", () => {
    const d = (poseWorm(REST_PARAMS).shapes.find((s) => s.key === "body") as { d: string }).d;
    for (const n of d.match(/-?\d+\.\d+/g) || []) {
      expect(n.split(".")[1].length).toBeLessThanOrEqual(2);
    }
  });
});
