import { REST_PARAMS, type WormParams } from "./wormGeometry";

/**
 * What the BookWorm is doing, and how it gets there.
 *
 * wormGeometry.ts turns numbers into a body. This turns the state of the
 * conversation into those numbers. The split is the point: geometry is pure
 * and time-free, and every clock, every random draw and every piece of
 * hysteresis in the feature lives here, behind one `step(dt)`.
 *
 * ---------------------------------------------------------------------------
 * THE CONSTRAINT THAT SHAPED THIS FILE
 *
 * WCAG 2.2 SC 2.2.2 (Pause, Stop, Hide, Level A) requires a mechanism to pause,
 * stop or hide any motion that starts automatically, lasts more than five
 * seconds, and sits in parallel with other content. A mascot beside a chat
 * transcript is the textbook case, the "essential" exemption does not reach it
 * (the same warmth is achievable with static art, which defeats the second
 * clause of the definition), and 2.2.2 is a NON-INTERFERENCE criterion — a
 * failure here fails the entire page, not just this corner of it. Honouring
 * prefers-reduced-motion is not a substitute; the W3C working group is explicit
 * that the media query alone does not satisfy 2.2.2.
 *
 * So the worm is not a loop. Every oscillation in it — breath, undulation,
 * sway, blinking, gaze — is multiplied by `alive`, which falls to exactly zero
 * 4.8 seconds after the last conversational event. What is left is a still
 * drawing that holds its pose until something actually happens.
 *
 * That constraint turned out to be a gift three times over:
 *
 *   - Abrams & Christ (2003) found that motion ONSET captures attention while
 *     continuous motion does not, and Simola (2011) found animated content
 *     beside a text column measurably damages reading. A companion that moves
 *     only at real conversational beats is both more conformant AND less
 *     costly to the reader than one that idles forever.
 *   - `isSettled()` lets the host stop its requestAnimationFrame loop outright.
 *     The cheapest frame is the one never scheduled, which matters most on the
 *     mid-range Android this ships to.
 *   - A character that is usually still makes its movements mean something.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES THE MOTION IS BUILT ON
 *
 * 1. NOTHING IS EVER SET, ONLY PULLED. Every parameter is a critically-damped
 *    spring chasing a target, so moods interrupt each other cleanly at any
 *    point: a reply landing mid-blink mid-coil just re-aims the springs.
 *    Keyframed transitions would need an explicit curve for all 81 ordered
 *    pairs of moods and would still pop when one arrived early.
 *
 * 2. OSCILLATION IS INTEGRATED, NOT SAMPLED. Phases advance by `rate * dt`
 *    rather than being read off a wall clock as `sin(t * rate)`. Sampling looks
 *    identical until a rate changes, at which point the phase jumps and the
 *    body snaps. Integrating costs one add and can never snap.
 *
 * 3. THE CLOCK AND THE DICE ARE INJECTED. `step` takes dt and the constructor
 *    takes an rng, so every behaviour here is reproducible in a test without a
 *    fake timer or a real frame.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS CAME FROM
 *
 * The idle behaviour is measured, not invented. Sources, for the next person:
 *
 *   Blink rate by condition — Bentivoglio et al. 1997, Mov Disord 12(6),
 *   n=150: 17/min at rest, 26/min in conversation, 4.5/min while reading. Hence
 *   `idle` 17, `speak` 26, `read` 5: this worm blinks LEAST while reading a
 *   streaming reply and MOST while speaking, which is backwards from the
 *   intuition and correct.
 *
 *   Inter-blink intervals are log-normal, not Poisson — Bentivoglio fitted it
 *   explicitly; Cruz et al. 2010 confirm symmetry under log transform. The
 *   graphics literature's habitual Poisson assumption is not supported by the
 *   ophthalmology data. Evenly-spaced blinking is the single most reliable way
 *   to make a face look mechanical.
 *
 *   Lid kinematics — Kwon et al. 2013, J R Soc Interface, 600fps: the opening
 *   phase runs 2-3x the closing phase. A symmetric blink reads as a glitch.
 *
 *   Blinks at clause boundaries — Hömke, Holler & Levinson 2017 (411 addressee
 *   blinks): blinks pin to clause ends at a median +20ms, and ~15% are "long"
 *   (>=410ms), twice as likely to co-occur with a nod. Those long blinks are
 *   perceived as communicative acknowledgement. `clause()` implements exactly
 *   that, which is why the worm appears to be agreeing with the sentence it
 *   just heard. Nakano et al. 2009 put the blink after a TOPIC change later,
 *   peaking 400-600ms, which is what `topicChange()` uses.
 *
 *   Breathing — Live2D's shipped CubismBreath sample and TalkingHead's
 *   per-mood constants: 0.24-0.31 Hz with inhale:hold:exhale near 1.2:0.5:1.0,
 *   amplitude encoding arousal. A pure sine is the thing that reads mechanical.
 *
 *   Non-looping idle — Live2D gives its five idle oscillators deliberately
 *   incommensurate periods (6.5345s, 3.5345s, 5.5345s...) so the superposition
 *   never visibly repeats. Free aliveness; copied below.
 *
 *   Microsaccades are deliberately NOT simulated. They are under one degree,
 *   which at this sprite size is comfortably sub-pixel, and the flicker rate
 *   needed to fake them sits above the ~2 Hz threshold where sway stops reading
 *   as sway and starts reading as jitter. An earlier pass had them; removing
 *   them made the eyes calmer and cost nothing.
 */

export type Mood =
  /** Nothing has happened in a long while. Coiled, lights off. */
  | "sleep"
  /** Awake, unoccupied. */
  | "idle"
  /** The user is typing. Cranes over the composer. */
  | "watch"
  /** The mic is open. Head cocked hard. */
  | "listen"
  /** A reply is being generated. Coiled back, looking up and away. */
  | "think"
  /** Assistant text is streaming in. Eyes track it like a page. */
  | "read"
  /** Text-to-speech is playing. The mouth is driven by the audio itself. */
  | "speak"
  /** A reply landed cleanly. */
  | "cheer"
  /** The turn failed. */
  | "oops";

interface MoodDef {
  baseAngle: number;
  curl: number;
  wave: number;
  waveHz: number;
  waveLen: number;
  stretch: number;
  headTilt: number;
  lid: number;
  brow: number;
  smile: number;
  /** Breath depth (arousal) and period in seconds (calm). */
  breathAmp: number;
  breathSec: number;
  /** Spontaneous blinks per minute. Zero disables scheduling. */
  blinkRate: number;
  gaze: "none" | "wander" | "front" | "up" | "down" | "scan";
}

const A = -Math.PI / 2;

/**
 * One line per mood.
 *
 * SILHOUETTE IS THE MESSAGE. At the size this ships (~64px, of which the face
 * is twenty) nobody reads an expression — they read a shape. An earlier pass
 * separated these moods mostly by lean and brow, and they were, correctly,
 * indistinguishable in a filmstrip. Each of these now owns a posture you could
 * identify as a black silhouette.
 *
 * The gaze directions are not decorative either. The worm is docked at the
 * BOTTOM of the transcript, so the composer is below it and arriving text is
 * above it: `watch` genuinely looks down at what you are typing, and `read`
 * genuinely looks up at the reply.
 *
 * This table is only this legible because `baseAngle` in the geometry is the
 * tail-to-head CHORD rather than the tail's own tangent — otherwise every curl
 * here would need a hand-computed lean to keep the head inside the frame.
 */
const MOODS: Record<Mood, MoodDef> = {
  /** A tight spiral, lights off. */
  sleep:  { baseAngle: A + 0.55, curl:  3.40, wave: 0.03, waveHz: 0.18, waveLen: 1.0, stretch: 0.82, headTilt:  0.15, lid:  1.00, brow:  0.00, smile:  0.15, breathAmp: 0.075, breathSec: 5.0345, blinkRate:  0, gaze: "none" },
  /** Upright, a lazy S. */
  idle:   { baseAngle: A + 0.00, curl:  0.45, wave: 0.06, waveHz: 0.50, waveLen: 1.0, stretch: 1.00, headTilt:  0.00, lid:  0.00, brow:  0.00, smile:  0.35, breathAmp: 0.038, breathSec: 4.2345, blinkRate: 17, gaze: "wander" },
  /** Craned over the composer, peering down at the typing. */
  watch:  { baseAngle: A + 0.52, curl:  1.30, wave: 0.05, waveHz: 0.60, waveLen: 1.0, stretch: 1.04, headTilt: -0.10, lid: -0.12, brow: -0.14, smile:  0.45, breathAmp: 0.034, breathSec: 3.7345, blinkRate: 14, gaze: "down" },
  /** Tall and still with the head cocked hard over — the whole-body posture of
   *  something straining to catch a sound. */
  listen: { baseAngle: A - 0.10, curl:  0.55, wave: 0.07, waveHz: 0.70, waveLen: 1.1, stretch: 1.12, headTilt:  0.52, lid: -0.28, brow: -0.22, smile:  0.30, breathAmp: 0.050, breathSec: 3.2345, blinkRate: 20, gaze: "front" },
  /** Coiled back into a question mark, eyes up and away. Nobody thinks hard
   *  while looking straight at you. */
  think:  { baseAngle: A - 0.38, curl:  2.15, wave: 0.15, waveHz: 0.55, waveLen: 0.8, stretch: 0.92, headTilt: -0.35, lid:  0.25, brow:  0.20, smile:  0.10, breathAmp: 0.055, breathSec: 3.2345, blinkRate:  8, gaze: "up" },
  /** Upright, head tipped back to take in the text arriving above it. */
  read:   { baseAngle: A - 0.14, curl:  0.50, wave: 0.05, waveHz: 0.45, waveLen: 1.0, stretch: 1.03, headTilt: -0.40, lid:  0.05, brow: -0.05, smile:  0.30, breathAmp: 0.030, breathSec: 4.2345, blinkRate:  5, gaze: "scan" },
  /** Leaning in and undulating, because it is talking TO you. */
  speak:  { baseAngle: A + 0.20, curl:  0.80, wave: 0.24, waveHz: 1.05, waveLen: 1.2, stretch: 1.05, headTilt:  0.05, lid:  0.00, brow: -0.08, smile:  0.50, breathAmp: 0.030, breathSec: 3.2345, blinkRate: 26, gaze: "front" },
  /** Arched BACKWARD. A forward curl at full stretch reads as lunging; the
   *  backward arch is the shape of every celebration ever drawn. */
  cheer:  { baseAngle: A - 0.12, curl: -0.62, wave: 0.30, waveHz: 1.60, waveLen: 1.4, stretch: 1.30, headTilt: -0.50, lid:  0.58, brow: -0.32, smile:  1.00, breathAmp: 0.070, breathSec: 2.4345, blinkRate: 20, gaze: "front" },
  /** Folded forward so the head hangs below the shoulder of the curve — a
   *  droop has to actually drop the head, not merely frown. Rate normal,
   *  amplitude low: that is what sadness does to breathing. */
  oops:   { baseAngle: A + 0.85, curl:  1.75, wave: 0.03, waveHz: 0.30, waveLen: 1.0, stretch: 0.88, headTilt:  0.30, lid:  0.45, brow: -0.48, smile: -0.50, breathAmp: 0.022, breathSec: 4.0345, blinkRate: 12, gaze: "down" },
};

/**
 * A critically-damped spring, integrated semi-implicitly.
 *
 * Critical damping (zeta = 1) is the default because it is the only damping
 * that reaches the target in the shortest time WITHOUT crossing it. Overshoot
 * on a posture parameter reads as a wobble, not as life; all the overshoot in
 * this character is deliberate and lives in the impulse envelopes below, where
 * it can be shaped rather than merely suffered.
 */
class Spring {
  v = 0;
  constructor(
    public x: number,
    private k: number,
    private zeta = 1,
  ) {}
  to(target: number, dt: number) {
    const c = 2 * this.zeta * Math.sqrt(this.k);
    // SUBSTEP, ALWAYS. Semi-implicit Euler on a spring diverges once
    // dt > 2 / (w * (z + sqrt(z^2 + 1))), which for the gaze spring (k=2600,
    // w=51) is 16.2ms — i.e. it was unstable at 60fps, on every single frame.
    // The settle test caught it as lookX reaching 6e11 before anything was ever
    // drawn. Substepping to a provably stable h costs at most three iterations
    // of four arithmetic ops and makes stiffness a free parameter again, which
    // matters because a saccade genuinely needs to arrive in three frames.
    const h = 1 / (Math.sqrt(this.k) * 2.5);
    const n = Math.max(1, Math.ceil(dt / h));
    const sub = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - c * this.v) * sub;
      this.x += this.v * sub;
    }
  }
  atRest(target: number): boolean {
    return Math.abs(this.v) < 3e-3 && Math.abs(this.x - target) < 3e-3;
  }
}

/** Posture is heavy, the face is light, gaze is near-ballistic. A saccade of
 *  5-15 degrees takes 30-45ms in life (duration = 2.2 * amplitude + 21 ms), so
 *  the gaze spring is stiff enough to arrive inside three frames. Easing the
 *  eyes into position over 200ms is the tell of every cheap avatar. */
const K_BODY = 34;
const K_FACE = 150;
const K_GAZE = 2600;
const K_JAW = 900;
const K_WIDE = 320;

/** Lid phases, in seconds. Kwon et al. put the opening phase at 2-3x the
 *  closing phase; a symmetric blink reads as a dropped frame. */
const BLINK_CLOSE = 0.06;
const BLINK_OPEN = 0.17;
/** A normal blink's closed dwell, and the "acknowledgement" blink's. Hömke
 *  puts the long-blink threshold at 410ms total and finds ~15% of conversational
 *  blinks are long — those are the ones people read as active agreement. */
const HOLD_SHORT = 0.055;
const HOLD_LONG = 0.3;

/** Motion stops dead at 4.8s, inside SC 2.2.2's five-second allowance, with
 *  the ramp starting at 3.0s so the worm winds down rather than switching off. */
const QUIET_FROM = 3.0;
const QUIET_TO = 4.8;

interface Impulse {
  t: number;
  dur: number;
  amp: number;
  curve: (u: number) => number;
}

/**
 * A pop, with real anticipation.
 *
 * The first 90ms go the WRONG WAY — the worm compresses before it extends.
 * That is the oldest trick in the book and it cannot be expressed as a spring
 * toward a target, because a spring's whole nature is to move toward the thing
 * it is chasing. It has to be an authored curve, which is the entire reason
 * impulses exist alongside springs here.
 */
const POP = (u: number): number => {
  const t = u * 0.7;
  if (t < 0.09) return -0.38 * Math.sin((t / 0.09) * Math.PI);
  const d = t - 0.09;
  return Math.exp(-d * 7) * Math.sin(d * 13) * 2.2;
};

/** Down, up, settle. Fired per spoken clause, and with every long blink. */
const NOD = (u: number): number => {
  const t = u * 0.55;
  return Math.exp(-t * 9) * Math.sin(t * 16) * 1.6;
};

/** A hard flash that decays. Front-loaded: a slow glint reads as a smear
 *  rather than a realisation. */
const FLASH = (u: number): number => Math.pow(1 - u, 2.2);

/**
 * One breath, as a fraction of full inhalation, over a normalised cycle.
 *
 * Live2D and TalkingHead both ship inhale:hold:exhale near 1.2:0.5:1.0 with a
 * rest beat before the next breath, and both are right: a sine wave in and out
 * is the single most mechanical-looking thing a chest can do. The asymmetry
 * and the pause at the bottom are what make it read as breathing at all.
 */
const BREATH = (u: number): number => {
  if (u < 0.286) return smoothstep(u / 0.286);
  if (u < 0.405) return 1;
  if (u < 0.643) return 1 - smoothstep((u - 0.405) / 0.238);
  return 0;
};

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function smoothstep(t: number) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export interface AnimatorOptions {
  /** Under prefers-reduced-motion the worm holds a still pose per mood and
   *  cross-fades between them: no oscillation, no impulses, no driven jaw. */
  reduced?: boolean;
  /** Injected so blink and gaze scheduling are reproducible in tests. */
  rng?: () => number;
  mood?: Mood;
}

export class WormAnimator {
  private rng: () => number;
  private reduced: boolean;
  private mood: Mood;

  private sBase: Spring;
  private sCurl: Spring;
  private sWave: Spring;
  private sWaveHz: Spring;
  private sWaveLen: Spring;
  private sStretch: Spring;
  private sTilt: Spring;
  private sLid: Spring;
  private sBrow: Spring;
  private sSmile: Spring;
  private sJaw: Spring;
  private sWide: Spring;
  private sLookX: Spring;
  private sLookY: Spring;
  private sBreathAmp: Spring;

  /**
   * Four oscillator phases with DELIBERATELY INCOMMENSURATE periods, lifted
   * straight from Live2D's CubismBreath sample (6.5345s, 3.5345s, ...). Because
   * no two share a rational ratio, their superposition never repeats — the
   * cheapest aliveness in the entire file, and the reason the idle does not
   * develop a visible tell after ten seconds of watching it.
   */
  private phWave = 0;
  private phBreath = 0;
  private phSwayA = 0;
  private phSwayB = 0;
  private static readonly SWAY_A_SEC = 6.5345;
  private static readonly SWAY_B_SEC = 3.5345;

  /** Motion budget, 1 down to 0. See the SC 2.2.2 note at the top. */
  private alive = 1;
  private sinceEvent = 0;

  private blinkIn = 2.5;
  private blinkT = -1;
  private blinkHold = HOLD_SHORT;
  private queued: { delay: number; hold: number }[] = [];

  private gazeIn = 1;
  private gazeX = 0;
  private gazeY = 0;
  private scanX = -0.8;

  private impulses: { stretch: Impulse[]; tilt: Impulse[]; glint: Impulse[] } = { stretch: [], tilt: [], glint: [] };

  private voice = 0;
  private voiceTarget = 0;
  private wideTarget = 0;
  /** Trails the head so the antennae can be driven by the difference. */
  private lag = 0;
  private restFrames = 0;

  constructor(opts: AnimatorOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.reduced = !!opts.reduced;
    this.mood = opts.mood ?? "idle";
    const m = MOODS[this.mood];
    this.sBase = new Spring(m.baseAngle, K_BODY);
    this.sCurl = new Spring(m.curl, K_BODY);
    // Zero from the very first frame when motion is off. Seeding these at the
    // mood's amplitude and letting the springs decay would show a
    // reduced-motion user roughly a second of undulation they asked not to see.
    this.sWave = new Spring(this.reduced ? 0 : m.wave, K_BODY);
    this.sWaveHz = new Spring(m.waveHz, K_BODY);
    this.sWaveLen = new Spring(m.waveLen, K_BODY);
    this.sStretch = new Spring(m.stretch, K_BODY);
    this.sTilt = new Spring(m.headTilt, K_FACE);
    this.sLid = new Spring(m.lid, K_FACE);
    this.sBrow = new Spring(m.brow, K_FACE);
    this.sSmile = new Spring(m.smile, K_FACE);
    this.sJaw = new Spring(0, K_JAW);
    this.sWide = new Spring(0, K_WIDE);
    this.sLookX = new Spring(0, K_GAZE);
    this.sLookY = new Spring(0, K_GAZE);
    this.sBreathAmp = new Spring(this.reduced ? 0 : m.breathAmp, K_BODY);
    this.scheduleBlink();
  }

  getMood(): Mood {
    return this.mood;
  }

  /** Any conversational event. Resets the motion budget and thereby restarts
   *  the host's frame loop. */
  bump() {
    this.sinceEvent = 0;
    this.restFrames = 0;
  }

  setMood(m: Mood) {
    this.bump();
    if (m === this.mood) return;
    const was = this.mood;
    this.mood = m;
    // Waking is a beat in itself: a creature that merely un-coils has not woken,
    // it has been re-posed.
    if (was === "sleep") {
      this.blinkAfter(0.12, HOLD_SHORT);
      this.pop(0.5);
    }
    // A reading pass starts at the left margin, like a page.
    if (m === "read") this.scanX = -0.8;
    this.scheduleBlink();
    this.gazeIn = 0;
  }

  setReduced(r: boolean) {
    this.reduced = r;
    if (r) {
      // Switched on mid-session: stop what is in flight rather than easing out
      // of it. Someone who has just asked for less motion should not have to
      // watch a graceful exit.
      this.sWave.x = 0;
      this.sWave.v = 0;
      this.sBreathAmp.x = 0;
      this.sBreathAmp.v = 0;
      this.impulses.stretch.length = 0;
      this.impulses.tilt.length = 0;
      this.impulses.glint.length = 0;
      this.queued.length = 0;
      this.blinkT = -1;
    }
    this.bump();
  }

  /**
   * Live loudness 0..1 and vowel spread -1..1 from the voice tap. `wide` is a
   * coarse high-to-low energy ratio, not a viseme classifier: at this sprite
   * size a wrong vowel for 80ms is invisible, while a late mouth is not.
   */
  setVoice(level: number, wide = 0) {
    this.voiceTarget = clamp(level, 0, 1);
    this.wideTarget = clamp(wide, -1, 1);
    if (level > 0.02) this.bump();
  }

  pop(strength = 1) {
    this.bump();
    if (this.reduced) return;
    this.impulses.stretch.push({ t: 0, dur: 0.7, amp: 0.3 * strength, curve: POP });
  }

  nod(strength = 1) {
    this.bump();
    if (this.reduced) return;
    this.impulses.tilt.push({ t: 0, dur: 0.55, amp: 0.22 * strength, curve: NOD });
  }

  glint() {
    this.bump();
    if (this.reduced) return;
    this.impulses.glint.push({ t: 0, dur: 0.45, amp: 1, curve: FLASH });
  }

  /**
   * A clause just ended — a sentence of streamed text, or a spoken chunk.
   *
   * Hömke et al. found conversational blinks pin to clause boundaries at a
   * median of +20ms, and that roughly 15% of them are long ones that listeners
   * read as active acknowledgement, twice as likely to be paired with a nod.
   * That is what this reproduces, and it is the single most uncanny thing the
   * worm does: it appears to be agreeing with the sentence it just heard.
   */
  clause() {
    this.bump();
    if (this.reduced) return;
    const long = this.rng() < 0.15;
    this.blinkAfter(0.02 + this.rng() * 0.03, long ? HOLD_LONG : HOLD_SHORT);
    if (long) this.nod(0.55);
  }

  /**
   * A new topic landed — a reply arrived, the user sent something.
   * Nakano et al. put the first blink after a scene break at a peak latency of
   * 400-600ms, which is a different rule from the clause one above and reads
   * as "taking it in" rather than "agreeing".
   */
  topicChange() {
    this.bump();
    if (this.reduced) return;
    this.blinkAfter(0.4 + this.rng() * 0.2, HOLD_SHORT);
  }

  blinkAfter(delay: number, hold = HOLD_SHORT) {
    this.queued.push({ delay, hold });
  }

  /** True once every spring has arrived, nothing is oscillating and the motion
   *  budget has run out. The host stops its rAF loop on this. */
  isSettled(): boolean {
    return this.restFrames > 4;
  }

  /**
   * Inter-blink intervals in people are right-skewed with a long tail, not
   * uniform and not exponential — Bentivoglio fitted a log-normal explicitly,
   * and the Poisson habit in the graphics literature is not supported by the
   * ophthalmology data. A uniform draw produces a metronome, which is the
   * clearest possible tell that a face is a program.
   */
  private scheduleBlink() {
    const rate = MOODS[this.mood].blinkRate;
    if (rate <= 0) {
      this.blinkIn = Infinity;
      return;
    }
    const mean = 60 / rate;
    const u1 = Math.max(1e-6, this.rng());
    const u2 = this.rng();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    // Floor-clamped at 0.4s for lid refractoriness.
    this.blinkIn = Math.max(0.4, clamp(mean * Math.exp(g * 0.6 - 0.18), mean * 0.3, mean * 3.2));
  }

  private newGazeTarget() {
    const g = MOODS[this.mood].gaze;
    const r = this.rng;
    switch (g) {
      case "none":
        this.gazeX = 0;
        this.gazeY = 0;
        break;
      case "front":
        // Never dead centre: a perfectly centred gaze is a thousand-yard stare.
        this.gazeX = (r() - 0.5) * 0.3;
        this.gazeY = (r() - 0.5) * 0.25;
        break;
      case "up":
        this.gazeX = (r() - 0.5) * 1.1;
        this.gazeY = 0.45 + r() * 0.45;
        break;
      case "down":
        this.gazeX = (r() - 0.5) * 0.7;
        this.gazeY = -0.35 - r() * 0.4;
        break;
      case "wander":
        // Mostly small drifts with the occasional real look away, which is what
        // an unoccupied gaze actually does.
        if (r() < 0.3) {
          this.gazeX = (r() - 0.5) * 1.8;
          this.gazeY = (r() - 0.5) * 1.2;
        } else {
          this.gazeX = (r() - 0.5) * 0.5;
          this.gazeY = (r() - 0.5) * 0.4;
        }
        break;
      case "scan": {
        // Reading: step rightward along a line in saccade-sized jumps, then
        // sweep back to the left margin and drop one. The return sweep is the
        // single most recognisable thing eyes do, and it is what makes a
        // streaming reply look READ rather than merely waited out.
        this.scanX += 0.34 + r() * 0.22;
        if (this.scanX > 0.85) {
          this.scanX = -0.8;
          this.gazeY = 0.18;
        } else {
          this.gazeY = 0.34 + (r() - 0.5) * 0.14;
        }
        this.gazeX = this.scanX;
        break;
      }
    }
  }

  private runImpulses(list: Impulse[], dt: number): number {
    let sum = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const im = list[i];
      im.t += dt;
      if (im.t >= im.dur) {
        list.splice(i, 1);
        continue;
      }
      sum += im.curve(im.t / im.dur) * im.amp;
    }
    return sum;
  }

  /**
   * Advance by `dtMs` and return the body's numbers.
   *
   * dt is clamped to 50ms. A backgrounded tab or a long GC hands rAF a gap of
   * hundreds of milliseconds, and integrating that in one step would launch a
   * spring past its target hard enough to look like a hardware fault. The few
   * milliseconds of catch-up this costs are invisible.
   */
  step(dtMs: number): WormParams {
    const dt = clamp(dtMs, 0, 50) / 1000;
    const m = MOODS[this.mood];

    // --- motion budget ----------------------------------------------------
    this.sinceEvent += dt;
    this.alive = this.reduced ? 0 : smoothstep((QUIET_TO - this.sinceEvent) / (QUIET_TO - QUIET_FROM));

    // --- voice: fast attack, slow release ---------------------------------
    // Symmetric smoothing turns speech into one sustained mumble; the asymmetry
    // is what makes separate syllables visible. 20ms / 90ms are the envelope
    // follower constants the lip-sync implementations converge on.
    const vk = this.voiceTarget > this.voice ? 1 - Math.exp(-dt / 0.02) : 1 - Math.exp(-dt / 0.09);
    this.voice += (this.voiceTarget - this.voice) * vk;

    const speakingNow = this.mood === "speak" && !this.reduced;

    // --- posture ----------------------------------------------------------
    this.sBase.to(m.baseAngle, dt);
    this.sCurl.to(m.curl, dt);
    this.sTilt.to(m.headTilt, dt);
    this.sWave.to(m.wave * this.alive, dt);
    this.sWaveHz.to(m.waveHz, dt);
    this.sWaveLen.to(m.waveLen, dt);
    this.sStretch.to(m.stretch, dt);
    this.sBreathAmp.to(m.breathAmp * this.alive, dt);

    // Integrated, never sampled — rule 2 at the top of the file. Frozen once
    // the budget is spent, so a settled worm returns byte-identical numbers
    // frame after frame and the host's diff has nothing to do.
    if (this.alive > 0.001 || speakingNow) {
      this.phWave += this.sWaveHz.x * dt;
      this.phBreath += dt / m.breathSec;
      this.phSwayA += dt / WormAnimator.SWAY_A_SEC;
      this.phSwayB += dt / WormAnimator.SWAY_B_SEC;
    }
    this.phWave %= 1;
    this.phBreath %= 1;
    this.phSwayA %= 1;
    this.phSwayB %= 1;

    // --- blinking ---------------------------------------------------------
    let blinkEnv = 0;
    if (!this.reduced) {
      for (let i = this.queued.length - 1; i >= 0; i--) {
        this.queued[i].delay -= dt;
        if (this.queued[i].delay <= 0 && this.blinkT < 0) {
          this.blinkT = 0;
          this.blinkHold = this.queued[i].hold;
          this.queued.splice(i, 1);
        }
      }
      // Spontaneous blinks only while there is a motion budget; a settled worm
      // is a still drawing, eyes included.
      if (this.alive > 0.15) {
        this.blinkIn -= dt;
        if (this.blinkIn <= 0 && this.blinkT < 0) {
          this.blinkT = 0;
          this.blinkHold = HOLD_SHORT;
          this.scheduleBlink();
          // Real blinks come in doublets often enough that always-single reads
          // as a tic.
          if (this.rng() < 0.15) this.blinkAfter(0.08 + this.rng() * 0.12, HOLD_SHORT);
        }
      }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const t = this.blinkT;
        const total = BLINK_CLOSE + this.blinkHold + BLINK_OPEN;
        if (t < BLINK_CLOSE) blinkEnv = t / BLINK_CLOSE;
        else if (t < BLINK_CLOSE + this.blinkHold) blinkEnv = 1;
        else if (t < total) blinkEnv = 1 - (t - BLINK_CLOSE - this.blinkHold) / BLINK_OPEN;
        else this.blinkT = -1;
        blinkEnv = clamp(blinkEnv, 0, 1);
      }
    }

    // --- gaze -------------------------------------------------------------
    if (this.alive > 0.15) {
      this.gazeIn -= dt;
      if (this.gazeIn <= 0) {
        this.newGazeTarget();
        // Fixations run 225-330ms in reading and 2-5s in free viewing; a
        // reading scan therefore steps along far faster than an idle look-around.
        this.gazeIn = m.gaze === "scan" ? 0.24 + this.rng() * 0.16 : 2 + this.rng() * 3;
      }
      this.sLookX.to(clamp(this.gazeX, -1, 1), dt);
      this.sLookY.to(clamp(this.gazeY, -1, 1), dt);
    } else {
      this.sLookX.to(0, dt);
      this.sLookY.to(0, dt);
    }

    // --- face -------------------------------------------------------------
    this.sBrow.to(m.brow, dt);
    this.sSmile.to(m.smile, dt);
    this.sLid.to(m.lid, dt);

    const speaking = speakingNow;
    // The jaw follows the voice directly, held slightly ajar rather than
    // snapping shut between syllables — a mouth that fully closes on every
    // trough chatters like a nutcracker.
    const jawTarget = speaking ? clamp(this.voice * 1.05 + 0.06, 0, 1) : 0;
    this.sJaw.to(jawTarget, dt);
    this.sWide.to(speaking ? this.wideTarget : 0, dt);

    // --- impulses ---------------------------------------------------------
    const impStretch = this.runImpulses(this.impulses.stretch, dt);
    const impTilt = this.runImpulses(this.impulses.tilt, dt);
    const glint = clamp(this.runImpulses(this.impulses.glint, dt), 0, 1);

    // --- assemble ---------------------------------------------------------
    // Breath is centred on its own mean so the resting girth is 1 whatever the
    // amplitude; otherwise a deeper breath would also make the worm fatter.
    const breathe = (BREATH(this.phBreath) - 0.38) * this.sBreathAmp.x;
    const swayA = Math.sin(this.phSwayA * Math.PI * 2) * 0.05 * this.alive;
    const swayB = Math.sin(this.phSwayB * Math.PI * 2) * 0.022 * this.alive;

    // A voiced syllable lifts the whole body slightly. This is most of why the
    // worm looks like it is PRODUCING the sound rather than miming over it.
    const voiceLift = speaking ? this.voice * 0.05 : 0;
    const stretch = this.sStretch.x + impStretch + breathe * 0.5 + voiceLift;

    // Antenna follow-through is derived, not authored: they trail whatever the
    // head just did. `lag` chases the head's angular state and the DIFFERENCE
    // between them is the trailing force, so the faster the head moves the
    // further back they whip — for free, and always in the right direction.
    const headState = this.sTilt.x + impTilt + this.sCurl.x * 0.25;
    this.lag += (headState - this.lag) * clamp(dt * 11, 0, 1);
    const antennaLag = clamp((headState - this.lag) * 2.6, -0.9, 0.9);

    const lid = this.sLid.x + (1 - this.sLid.x) * blinkEnv;

    // --- settle detection -------------------------------------------------
    const quiet =
      this.alive <= 0.001 &&
      this.blinkT < 0 &&
      this.queued.length === 0 &&
      this.impulses.stretch.length === 0 &&
      this.impulses.tilt.length === 0 &&
      this.impulses.glint.length === 0 &&
      this.voice < 0.01 &&
      this.sBase.atRest(m.baseAngle) &&
      this.sCurl.atRest(m.curl) &&
      this.sStretch.atRest(m.stretch) &&
      this.sTilt.atRest(m.headTilt) &&
      this.sLid.atRest(m.lid) &&
      this.sSmile.atRest(m.smile) &&
      this.sJaw.atRest(jawTarget) &&
      this.sLookX.atRest(0) &&
      this.sLookY.atRest(0);
    this.restFrames = quiet ? this.restFrames + 1 : 0;

    return {
      ...REST_PARAMS,
      baseAngle: this.sBase.x + swayA,
      curl: this.sCurl.x,
      wave: this.sWave.x,
      phase: this.phWave * Math.PI * 2,
      waveLen: this.sWaveLen.x,
      stretch: clamp(stretch, 0.6, 1.65),
      girth: clamp(1 + breathe + (speaking ? this.voice * 0.03 : 0), 0.8, 1.25),
      headTilt: this.sTilt.x + impTilt + swayB,
      lookX: this.sLookX.x,
      lookY: this.sLookY.x,
      lidL: lid,
      lidR: lid,
      browL: this.sBrow.x,
      browR: this.sBrow.x,
      mouthOpen: this.sJaw.x,
      mouthSmile: this.sSmile.x,
      mouthWide: this.sWide.x,
      antennaLag,
      glasses: 1,
      glint,
    };
  }
}
