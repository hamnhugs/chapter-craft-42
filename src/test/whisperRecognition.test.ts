import { describe, it, expect } from "vitest";
import { cleanTranscript, encodeWav, resample } from "@/lib/whisperRecognition";

describe("whisperRecognition helpers", () => {
  it("encodes 16-bit mono PCM WAV with a correct header", async () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
    // jsdom Blobs lack arrayBuffer(); FileReader reads them.
    const ab = await new Promise<ArrayBuffer>((res) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.readAsArrayBuffer(wav); });
    const b = new DataView(ab);
    const tag = (o: number) => String.fromCharCode(b.getUint8(o), b.getUint8(o + 1), b.getUint8(o + 2), b.getUint8(o + 3));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(b.getUint16(22, true)).toBe(1);       // mono
    expect(b.getUint32(24, true)).toBe(16000);   // rate
    expect(b.getUint32(40, true)).toBe(8);       // 4 samples × 2 bytes
    expect(b.getInt16(46, true)).toBe(0x7fff);
    expect(b.getInt16(48, true)).toBe(-0x8000);
  });

  it("resamples 48 kHz to 16 kHz at one third the length", () => {
    const out = resample(new Float32Array(48000).fill(0.25), 48000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.25);
  });

  it("drops whisper's non-speech tags", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript(" Hello\n there. [MUSIC] ")).toBe("Hello there.");
  });
});
