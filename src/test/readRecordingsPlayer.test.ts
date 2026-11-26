import { beforeEach, describe, expect, it, vi } from "vitest";

const synth = vi.fn(async (text: string) => ({ audio: new TextEncoder().encode(text).buffer as ArrayBuffer, words: null }));
vi.mock("@/lib/inworldTts", () => ({
  synthesizeSpeechWithTimestamps: (...a: unknown[]) => synth(...(a as [string])),
  contextBefore: () => "",
}));

import { ReadAlongPlayer, type ReadAlongVoice } from "@/lib/readAlongPlayer";
import { clipKey, type PageRecorder, type RecordedClip } from "@/lib/readRecordings";
import { tokenizeWords } from "@/lib/readAlong";

/** An <audio> that "plays" and can be told it finished. */
class FakeAudio {
  static last: FakeAudio | null = null;
  src = ""; playbackRate = 1; preload = ""; currentTime = 0; duration = 1;
  onended: (() => void) | null = null; onerror: (() => void) | null = null; onloadedmetadata: (() => void) | null = null;
  constructor() { FakeAudio.last = this; }
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  removeAttribute() {}
}

function memoryRecorder() {
  const kept = new Map<string, RecordedClip>();
  const rec: PageRecorder = {
    key: clipKey,
    get: async (k) => kept.get(k) ?? null,
    put: async (k, c) => { kept.set(k, c); },
  };
  return { rec, kept };
}

const TEXT = "The first sentence is here. The second one follows it. And a third to finish the page.";
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function listenThrough(voice: ReadAlongVoice) {
  const sources: string[] = [];
  let ended = false;
  const player = new ReadAlongPlayer({ onWord: () => {}, onStatus: () => {}, onEnd: () => { ended = true; }, onSource: (s) => sources.push(s) });
  player.start(TEXT, tokenizeWords(TEXT), 0, voice, 1);
  for (let i = 0; i < 20 && !ended; i++) {
    await flush();
    FakeAudio.last?.onended?.();
  }
  player.destroy();
  return { sources, ended };
}

beforeEach(() => {
  synth.mockClear();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("a page read aloud is recorded, and the recording is what plays next time", () => {
  it("pays for each line once", async () => {
    const { rec, kept } = memoryRecorder();
    const voice: ReadAlongVoice = { engine: "inworld", inworldVoiceId: "Ashley", style: { model: "m" }, recordings: rec };
    const first = await listenThrough(voice);
    expect(first.ended).toBe(true);
    const paidFor = synth.mock.calls.length;
    expect(paidFor).toBeGreaterThan(0);
    expect(kept.size).toBe(paidFor);
    expect(first.sources.every((s) => s === "fresh")).toBe(true);

    const second = await listenThrough(voice);
    expect(second.ended).toBe(true);
    expect(synth.mock.calls.length).toBe(paidFor);
    expect(second.sources.length).toBe(first.sources.length);
    expect(second.sources.every((s) => s === "recorded")).toBe(true);
  });

  it("does not play one voice's recording for another voice", async () => {
    const { rec } = memoryRecorder();
    await listenThrough({ engine: "inworld", inworldVoiceId: "Ashley", recordings: rec });
    const paidFor = synth.mock.calls.length;
    const other = await listenThrough({ engine: "inworld", inworldVoiceId: "Dennis", recordings: rec });
    expect(other.sources.every((s) => s === "fresh")).toBe(true);
    expect(synth.mock.calls.length).toBe(paidFor * 2);
  });

  it("records again once the page's recording is cleared", async () => {
    const { rec, kept } = memoryRecorder();
    const voice: ReadAlongVoice = { engine: "inworld", inworldVoiceId: "Ashley", recordings: rec };
    await listenThrough(voice);
    const paidFor = synth.mock.calls.length;
    kept.clear();
    await listenThrough(voice);
    expect(synth.mock.calls.length).toBe(paidFor * 2);
  });
});

describe("a clip is named by what is said and how", () => {
  const base = { text: "Hello there.", voiceId: "Ashley", model: "m", delivery: "d", direction: "", scene: "" };
  it("is the same for the same line", async () => {
    expect(await clipKey(base)).toBe(await clipKey({ ...base }));
  });
  it("differs when the text, voice, model or direction differs", async () => {
    const k = await clipKey(base);
    for (const other of [{ text: "Hello there!" }, { voiceId: "Dennis" }, { model: "n" }, { direction: "speak softly" }]) {
      expect(await clipKey({ ...base, ...other })).not.toBe(k);
    }
  });
});
