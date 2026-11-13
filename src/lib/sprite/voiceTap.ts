/**
 * A read-only tap on the voice that is actually playing.
 *
 * This is the one piece of the BookWorm that could not be faked. Everything
 * else about the character is driven by React state the app already had; the
 * mouth is driven by the waveform coming out of the speakers, which means the
 * worm is not miming to a timer — it is reacting to the same sound you are
 * hearing, sample for sample.
 *
 * WHAT IT CAN AND CANNOT SEE. Counsel has two speech engines. The Inworld path
 * decodes MP3 into a single long-lived `<audio>` element fed from a same-origin
 * `blob:` URL, which is exactly the case Web Audio can analyse: not
 * CORS-tainted, so the samples are readable. The browser path uses
 * `speechSynthesis`, whose output never enters the page's audio graph at all —
 * on Chrome it is often produced by the OS outside the tab. There is no
 * spec-defined way to route it to an AnalyserNode and there is an open WICG
 * issue asking for one. So this module simply reports that it is not attached,
 * and the caller falls back to a synthetic envelope.
 *
 * THE DANGEROUS PART, AND WHY THE CONNECT ORDER BELOW IS NOT ARBITRARY.
 * `createMediaElementSource` REROUTES the element: from that moment its sound
 * reaches the speakers only through the graph you build. Get it wrong and the
 * app goes permanently silent — a far worse bug than a mascot with a still
 * mouth. So the destination is connected FIRST, before the analyser exists, and
 * the analyser is a dead-end tap hanging off the source. If anything after that
 * line throws, audio is already safe. It is also once-per-element for the
 * lifetime of the document (a second call throws InvalidStateError), which is
 * why this is a module singleton keyed by the element rather than a hook.
 *
 * TUNING, FROM THE LITERATURE. fftSize 1024 gives a 21ms analysis window and
 * 47Hz bins at 48kHz — fine enough to separate the two bands below, short
 * enough to sit inside a single phoneme. `smoothingTimeConstant` is dropped
 * from its 0.8 default to 0.1: the default is a per-read EMA worth ~75ms of lag
 * at 60fps, which together with the window would put the mouth ~96ms behind the
 * sound before a pixel is drawn. That matters asymmetrically — ITU-R BT.1359
 * puts the detection threshold at 125ms for a LATE mouth but only 45ms for an
 * EARLY one, and Android audio output latency (up to ~150ms on cheap hardware)
 * already pushes this tap toward early, because it reads the buffer before it
 * is heard. Hence: keep the analysis lag small, and never add anticipation.
 */

const GATE_RMS = 0.015;
const GATE_FRAMES = 2;

interface Tap {
  analyser: AnalyserNode;
  time: Uint8Array;
  freq: Uint8Array;
  lowFrom: number;
  lowTo: number;
  highFrom: number;
  highTo: number;
}

let ctx: AudioContext | null = null;
let tap: Tap | null = null;
/** Elements already routed. A second createMediaElementSource on the same
 *  element throws, and the element in useReadAloud outlives every session. */
const routed = new WeakSet<HTMLAudioElement>();
let silentFrames = 0;
let fftTick = 0;
let lastWide = 0;

export interface VoiceReading {
  /** 0..1 loudness, gated and perceptually curved. */
  level: number;
  /** -1 rounded .. 1 spread. A coarse high-to-low energy ratio, not a viseme
   *  classifier — at 64px a wrong vowel for 80ms is invisible, a late mouth is
   *  not, and F1/F2 for neighbouring vowels overlap enough that a three-band
   *  heuristic misclassifies constantly anyway. */
  wide: number;
}

export function isVoiceTapped(): boolean {
  return tap !== null;
}

/**
 * Route `el` through an analyser. Idempotent, and safe to call on every
 * playback. Returns true if a tap is live.
 */
export function attachVoiceTap(el: HTMLAudioElement): boolean {
  if (tap && routed.has(el)) return true;
  if (routed.has(el)) return false;
  try {
    const Ctor: typeof AudioContext | undefined =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    if (!ctx) ctx = new Ctor();

    const source = ctx.createMediaElementSource(el);
    routed.add(el);
    // FIRST, and on its own line: from here the element's audio reaches the
    // speakers only through this graph. Everything below is optional; this is not.
    source.connect(ctx.destination);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.1;
    source.connect(analyser);

    const rate = ctx.sampleRate || 48000;
    const binHz = rate / analyser.fftSize;
    tap = {
      analyser,
      // Allocated once, never per frame. Re-allocating these is the classic
      // way to hand the GC a sawtooth at 60fps.
      time: new Uint8Array(analyser.fftSize),
      freq: new Uint8Array(analyser.frequencyBinCount),
      lowFrom: Math.max(1, Math.floor(300 / binHz)),
      lowTo: Math.floor(1500 / binHz),
      highFrom: Math.floor(1500 / binHz),
      highTo: Math.floor(4000 / binHz),
    };
    return true;
  } catch {
    // Already-routed elements, blocked contexts, Safari quirks. The mouth
    // falls back to a synthetic envelope; the voice keeps playing.
    return false;
  }
}

/** Autoplay policy suspends a context created outside a gesture. Cheap to call
 *  on every play; a no-op when already running. */
export function resumeVoiceTap(): void {
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/**
 * Read the current loudness. Returns null when nothing is tapped, which is the
 * caller's signal to synthesise instead.
 */
export function readVoice(): VoiceReading | null {
  if (!tap) return null;
  const { analyser, time } = tap;
  analyser.getByteTimeDomainData(time);

  // RMS straight off the waveform. No FFT is needed for a jaw, and the FFT is
  // the only expensive thing here.
  let sum = 0;
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / time.length);

  // A gate with hysteresis. Without the two-frame hold the mouth flickers shut
  // in the micro-gaps between words, which reads as a stutter rather than speech.
  if (rms < GATE_RMS) {
    silentFrames++;
    if (silentFrames >= GATE_FRAMES) return { level: 0, wide: lastWide * 0.8 };
  } else {
    silentFrames = 0;
  }

  const level = Math.pow(Math.min(1, rms / 0.28), 0.6);

  // The spectrum every other frame. The mouth's WIDTH does not need 60Hz —
  // vowels last 80ms — and the FFT is the one cost worth halving on a phone.
  if (++fftTick % 2 === 0) {
    const { freq, lowFrom, lowTo, highFrom, highTo } = tap;
    analyser.getByteFrequencyData(freq);
    let lo = 0;
    let hi = 0;
    for (let i = lowFrom; i < lowTo; i++) lo += freq[i];
    for (let i = highFrom; i < highTo; i++) hi += freq[i];
    lo /= Math.max(1, lowTo - lowFrom);
    hi /= Math.max(1, highTo - highFrom);
    const total = lo + hi;
    // Front vowels carry more high energy ("ee"), back vowels less ("oo").
    lastWide = total > 8 ? Math.max(-1, Math.min(1, ((hi - lo) / total) * 2.2)) : lastWide * 0.9;
  }

  return { level, wide: lastWide };
}

/* ---------------------------------------------------------------------------
 * The fallback mouth, for when the waveform cannot be analysed.
 *
 * `speechSynthesis` output never enters the page's audio graph, so on that path
 * there is nothing to measure — but there IS something to listen for. The
 * `boundary` event fires as each word begins, and `useReadAloud` was throwing
 * those away into a heartbeat bump. Fed through here they pin the mouth to real
 * word onsets, which is most of what sync actually is: you notice a mouth that
 * opens at the wrong TIME long before you notice one making the wrong SHAPE.
 *
 * It is not available everywhere. Boundary events are reliable on desktop
 * Chrome and broken on Android Chrome (crbug 40715888), and network voices
 * generally emit none at all. So this degrades in one step: word-driven when
 * boundaries are arriving, free-running syllables when they are not, decided by
 * whether one showed up recently rather than by sniffing the browser.
 * ------------------------------------------------------------------------- */

/** Seconds, on the same clock the caller passes to `syntheticVoice`. */
const nowSeconds = (): number =>
  (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

let boundaryAt = -Infinity;
let boundaryDur = 0.2;
let sawBoundary = false;
/** Past this with no word event, assume the engine does not emit them. */
const BOUNDARY_STALE = 1.5;

/**
 * A word just started. `charLength` comes from the boundary event and is the
 * only hint available about how long the word will take to say, so it sets how
 * long the mouth stays busy — "a" and "extraordinarily" should not produce the
 * same shape.
 */
export function noteWordBoundary(charLength?: number): void {
  boundaryAt = nowSeconds();
  sawBoundary = true;
  const n = typeof charLength === "number" && charLength > 0 ? charLength : 4;
  boundaryDur = Math.min(0.42, Math.max(0.1, 0.07 + n * 0.036));
}

/** True once any word event has been seen this session. Diagnostics only. */
export function hasWordBoundaries(): boolean {
  return sawBoundary;
}

/** Two incommensurate components near 4.4Hz — roughly the syllable rate of
 *  running English — shaped to spend more time closed than open. */
function freeRunning(t: number): VoiceReading {
  const a = Math.sin(t * 4.4 * Math.PI * 2);
  const b = Math.sin(t * 2.7345 * Math.PI * 2 + 1.1);
  const env = Math.max(0, a * 0.62 + b * 0.38);
  return { level: Math.pow(env, 0.75), wide: b * 0.45 };
}

/**
 * `tSeconds` must be on the same clock as `noteWordBoundary` uses —
 * `performance.now() / 1000`. Mixing clocks here would put the mouth an
 * arbitrary constant away from the words, which is the one error this whole
 * mechanism exists to avoid.
 */
export function syntheticVoice(tSeconds: number): VoiceReading {
  const since = tSeconds - boundaryAt;
  if (!sawBoundary || since < 0 || since > BOUNDARY_STALE) return freeRunning(tSeconds);

  // Inside the word: a raised arc over its estimated duration, modulated by a
  // ~5.4Hz carrier so a long word visibly articulates instead of being one
  // sustained gape. After it: a fast decay, then silence until the next word —
  // which is the part that makes the gaps between words read as gaps.
  const u = since / boundaryDur;
  const shape = u <= 1 ? Math.sin(Math.PI * Math.pow(u, 0.8)) : Math.exp(-(since - boundaryDur) * 12);
  const syllable = 0.66 + 0.34 * Math.abs(Math.sin(since * Math.PI * 5.4));
  return {
    level: Math.max(0, Math.min(1, shape * syllable)),
    wide: Math.sin(tSeconds * 2.7345 * Math.PI * 2 + 1.1) * 0.45,
  };
}
