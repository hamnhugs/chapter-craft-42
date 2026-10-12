// WhisperRecognition — the subset of the Web Speech `SpeechRecognition` API
// that useHandsFree and useDictation drive, answered by whisper.cpp running
// on this machine (reached through the same-origin /local/stt proxy).
//
// WHY. Chromium's SpeechRecognition streams the microphone to Google, and on
// Linux builds without Google's API keys it frequently does not work at all.
// whisper.cpp base.en transcribed a 6 s request perfectly in 0.6 s here, on
// the INTEGRATED GPU, leaving the discrete card's VRAM to the chat model
// (docs/local-ai/results). Mimicking the browser API keeps the two hooks'
// tested state machines untouched: they still get onstart → onresult →
// onend, one utterance per session (or a stream of them when continuous).
//
// Endpointing is energy-based: an adaptive noise floor from the first
// ~300 ms, speech when RMS clears it by SPEECH_RATIO, end of utterance after
// END_SILENCE_MS of quiet. That is the same "browser endpoints the turn"
// contract the hooks were written for, with the timing under our control.

const SAMPLE_RATE = 16000;
const SPEECH_RATIO = 3.0;
const MIN_FLOOR = 0.004;
const END_SILENCE_MS = 900;
const NO_SPEECH_MS = 8000;
const MAX_UTTERANCE_MS = 30000;
const STT_URL = "/local/stt/inference";

type Handler = ((e: any) => void) | null;

/** True when this page is served by the local edition's dev/preview server,
 *  which is the only place the /local/stt proxy exists. */
export function localSttAvailable(): boolean {
  if (typeof window === "undefined" || !navigator?.mediaDevices?.getUserMedia) return false;
  if (import.meta.env?.VITE_LOCAL_STT === "0") return false;
  return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);
}

export function encodeWav(samples: Float32Array, rate = SAMPLE_RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Linear-interpolation resample to 16 kHz mono. */
export function resample(input: Float32Array, fromRate: number, toRate = SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

/** whisper emits bracketed non-speech tags for silence and noise. */
export function cleanTranscript(t: string): string {
  return t.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)[^\]]*\]|\((?:silence|music|noise)[^)]*\)/gi, "").replace(/\s+/g, " ").trim();
}

export async function transcribe(wav: Blob, lang = "en", signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", wav, "speech.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", lang.split("-")[0] || "en");
  const r = await fetch(STT_URL, { method: "POST", body: form, signal });
  if (!r.ok) throw new Error(`whisper ${r.status}`);
  const j = await r.json();
  return cleanTranscript(String(j?.text || ""));
}

export class WhisperRecognition {
  continuous = false;
  interimResults = false;
  lang = "en-US";
  processLocally = true;
  onstart: Handler = null;
  onresult: Handler = null;
  onerror: Handler = null;
  onend: Handler = null;

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private results: Array<{ 0: { transcript: string }; isFinal: boolean; length: 1 }> = [];
  private stopped = false;
  private ended = false;
  private pending: Promise<void> = Promise.resolve();
  private abortCtl = new AbortController();

  start(): void {
    void this.run().catch((e) => {
      this.fire("onerror", { error: (e as DOMException)?.name === "NotAllowedError" ? "not-allowed" : "audio-capture", message: String(e) });
      this.finish();
    });
  }

  /** Stop listening; a captured utterance is still transcribed. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.flushSegment();
    void this.pending.then(() => this.finish());
  }

  /** Stop without delivering anything further. */
  abort(): void {
    this.stopped = true;
    this.abortCtl.abort();
    this.finish();
  }

  private fire(name: "onstart" | "onresult" | "onerror" | "onend", e: any): void {
    try { this[name]?.(e); } catch (err) { console.error(err); }
  }

  private async run(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.stopped) { this.finish(); return; }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but universally available and needs no
    // separately served worklet file; 4096-frame blocks ≈ 85-93 ms.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    const rate = this.ctx.sampleRate;
    const started = performance.now();
    let floor = 0, floorN = 0;
    let speaking = false, speechAt = 0, lastLoud = 0;

    this.node.onaudioprocess = (ev) => {
      if (this.stopped) return;
      const block = new Float32Array(ev.inputBuffer.getChannelData(0));
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      const rms = Math.sqrt(sum / block.length);
      const now = performance.now();
      if (now - started < 300) { floor = (floor * floorN + rms) / ++floorN; return; }
      const threshold = Math.max(MIN_FLOOR, floor * SPEECH_RATIO);
      const loud = rms > threshold;
      if (!speaking) {
        // Keep a short pre-roll so the first syllable isn't clipped.
        this.chunks.push(block);
        if (this.chunks.length > 4) this.chunks.shift();
        if (!loud) floor = floor * 0.95 + rms * 0.05;
        if (loud) { speaking = true; speechAt = now; lastLoud = now; }
        else if (!this.results.length && now - started > NO_SPEECH_MS && !this.continuous) {
          this.fire("onerror", { error: "no-speech" });
          this.stop();
        }
        return;
      }
      this.chunks.push(block);
      if (loud) lastLoud = now;
      if (now - lastLoud > END_SILENCE_MS || now - speechAt > MAX_UTTERANCE_MS) {
        speaking = false;
        this.flushSegment(rate);
        if (!this.continuous) this.stop();
      }
    };
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.fire("onstart", {});
  }

  private flushSegment(rate = this.ctx?.sampleRate || 48000): void {
    if (this.chunks.length < 3) { this.chunks = []; return; }
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { pcm.set(c, o); o += c.length; }
    this.chunks = [];
    const wav = encodeWav(resample(pcm, rate));
    this.pending = this.pending.then(async () => {
      try {
        const text = await transcribe(wav, this.lang, this.abortCtl.signal);
        if (!text || this.abortCtl.signal.aborted) return;
        this.results.push({ 0: { transcript: (this.results.length ? " " : "") + text }, isFinal: true, length: 1 });
        this.fire("onresult", { resultIndex: this.results.length - 1, results: this.results });
      } catch (e) {
        if (!this.abortCtl.signal.aborted) this.fire("onerror", { error: "network", message: String(e) });
      }
    });
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    try { this.node?.disconnect(); } catch { /* closed */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.fire("onend", {});
  }
}
