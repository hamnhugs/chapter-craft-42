// Generative UI sound for the library mind map — chimes, birdsong, wind, and
// distant thunder, all synthesized with the Web Audio API. Zero audio assets
// (a Tone.js-style library would cost ~76KB gzip for nothing we need here).
//
// Design follows earcon research (Brewster et al.): short (<400ms core),
// musical timbres, pitch in the 125Hz–5kHz band, quiet relative to content,
// randomized per trigger so repeats don't fatigue. Chime strikes use the
// modal frequency ratios of a struck metal tube (≈1 : 2.76 : 5.40 : 8.93 —
// inharmonic partials are what read as "metal") on a pentatonic scale, which
// is why wind chimes sound pleasant in any random order.
//
// One lazy AudioContext (autoplay policy: created/resumed inside user
// gestures), one master gain → compressor (protects against chord pile-ups),
// throttled triggers, and a voice cap. Every one-shot disconnects its nodes
// in `onended` — dangling connected subgraphs are the classic Web Audio leak.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let pinkBuf: AudioBuffer | null = null;
let brownBuf: AudioBuffer | null = null;

let voices = 0;
const MAX_VOICES = 8;
const lastFire: Record<string, number> = {};
let lastNoteIdx = -1;

// C major pentatonic across ~1.5 octaves.
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
// Struck-tube modal partials: ratio, relative gain, decay seconds.
const PARTIALS = [
  { r: 1.0, g: 1.0, d: 1.5 },
  { r: 2.76, g: 0.4, d: 0.9 },
  { r: 5.4, g: 0.18, d: 0.5 },
  { r: 8.93, g: 0.08, d: 0.28 },
];

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(comp);
    comp.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Throttle gate + voice cap. Returns the context or null to skip the sound. */
function gate(kind: string, minGapMs: number): AudioContext | null {
  const now = performance.now();
  if (now - (lastFire[kind] || 0) < minGapMs) return null;
  if (voices >= MAX_VOICES) return null;
  const c = ensureCtx();
  if (!c) return null;
  // Note: resume() is async, so during the very gesture that enables sound the
  // state may still read "suspended" — schedule anyway (it starts the moment
  // resume completes). If the context stays suspended (no gesture yet), the
  // voice cap bounds how much can queue up, so no burst on resume.
  lastFire[kind] = now;
  return c;
}

function trackVoice(node: { onended: ((this: any, ev: Event) => any) | null }, cleanup: () => void) {
  voices += 1;
  node.onended = () => {
    voices = Math.max(0, voices - 1);
    cleanup();
  };
}

function pickNote(): number {
  let idx = Math.floor(Math.random() * PENTATONIC.length);
  if (idx === lastNoteIdx) idx = (idx + 1) % PENTATONIC.length; // no immediate repeats
  lastNoteIdx = idx;
  return PENTATONIC[idx];
}

/** Pre-rendered looping noise buffers (no per-sample JS at runtime). */
function getNoise(c: AudioContext, kind: "pink" | "brown"): AudioBuffer {
  if (kind === "pink" && pinkBuf) return pinkBuf;
  if (kind === "brown" && brownBuf) return brownBuf;
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const out = buf.getChannelData(0);
  if (kind === "pink") {
    // Paul Kellet pink-noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    pinkBuf = buf;
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    }
    brownBuf = buf;
  }
  return buf;
}

/** One chime strike: 4 decaying inharmonic partials. */
function strike(c: AudioContext, baseHz: number, when: number, level: number, tail = 1) {
  for (const p of PARTIALS) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.frequency.value = baseHz * p.r * (1 + (Math.random() - 0.5) * 0.005);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(p.g * level, when + 0.004);
    g.gain.setTargetAtTime(0, when + 0.01, (p.d * tail) / 5);
    osc.connect(g);
    g.connect(master!);
    osc.start(when);
    osc.stop(when + p.d * tail + 0.3);
    trackVoice(osc, () => {
      try { osc.disconnect(); g.disconnect(); } catch { /* no-op */ }
    });
  }
}

/** One swept-sine bird chirp through a tracking bandpass. */
function chirpOnce(c: AudioContext, when: number, level: number) {
  const f0 = 1900 + Math.random() * 900;
  const f1 = f0 * (2.2 + Math.random() * 0.8);
  const dur = 0.08 + Math.random() * 0.07;
  const osc = c.createOscillator();
  const bp = c.createBiquadFilter();
  const g = c.createGain();
  bp.type = "bandpass";
  bp.Q.value = 6;
  osc.frequency.setValueAtTime(f0, when);
  osc.frequency.exponentialRampToValueAtTime(f1, when + dur);
  bp.frequency.setValueAtTime((f0 + f1) / 2, when);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level, when + 0.006);
  g.gain.setTargetAtTime(0, when + dur - 0.02, 0.015);
  osc.connect(bp);
  bp.connect(g);
  g.connect(master!);
  osc.start(when);
  osc.stop(when + dur + 0.1);
  trackVoice(osc, () => {
    try { osc.disconnect(); bp.disconnect(); g.disconnect(); } catch { /* no-op */ }
  });
}

/** Filtered-noise burst: wind gust (pink/bandpass) or thunder (brown/lowpass). */
function noiseBurst(
  c: AudioContext,
  kind: "pink" | "brown",
  filterType: BiquadFilterType,
  freq: number,
  level: number,
  attack: number,
  decay: number,
) {
  const src = c.createBufferSource();
  src.buffer = getNoise(c, kind);
  src.loop = true;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = c.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq * (0.85 + Math.random() * 0.3);
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 4);
  src.connect(f);
  f.connect(g);
  g.connect(master!);
  src.start(t);
  src.stop(t + attack + decay + 0.5);
  trackVoice(src, () => {
    try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* no-op */ }
  });
}

// --- Public one-shots (each silently no-ops when throttled/unsupported) -----

export const librarySounds = {
  /** Soft single chime — node hover. */
  hover() {
    const c = gate("hover", 90);
    if (!c) return;
    strike(c, pickNote(), c.currentTime, 0.05, 0.5);
  },
  /** Ascending two-note chime — opening a book. */
  open() {
    const c = gate("open", 150);
    if (!c) return;
    const base = pickNote();
    strike(c, base, c.currentTime, 0.1);
    strike(c, base * 1.5, c.currentTime + 0.09, 0.08);
  },
  /** Short bird phrase (2–3 chirps) — selecting a category/tag hub. */
  chirp() {
    const c = gate("chirp", 200);
    if (!c) return;
    const n = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      chirpOnce(c, c.currentTime + i * (0.09 + Math.random() * 0.05), 0.07);
    }
  },
  /** Soft wind gust — grabbing/rotating the graph. */
  gust() {
    const c = gate("gust", 700);
    if (!c) return;
    noiseBurst(c, "pink", "bandpass", 700, 0.05, 0.15, 0.8);
  },
  /** Quiet distant thunder roll — entering/leaving expanded mode. */
  thunder() {
    const c = gate("thunder", 2500);
    if (!c) return;
    noiseBurst(c, "brown", "lowpass", 95, 0.12, 0.18, 2.2);
  },
  /** Drop CPU to ~0 while sounds are toggled off. */
  suspend() {
    if (ctx && ctx.state === "running") void ctx.suspend();
  },
};
