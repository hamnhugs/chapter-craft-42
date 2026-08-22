import { beforeAll, describe, expect, it, vi } from "vitest";
import { computeBackTarget, computeForwardTarget } from "@/lib/ttsSeek";
import {
  addTtsChunkAt,
  beginTtsCapture,
  completeTtsCapture,
  discardTtsCapture,
  downloadTtsAudio,
} from "@/lib/ttsAudioCache";

// Seek math for chunked TTS. Chunks are sentence groups; durations become
// known (seconds) once a chunk has played, and stay null until then.

describe("computeBackTarget", () => {
  it("seeks within the current chunk when far enough in", () => {
    expect(computeBackTarget({ index: 2, t: 15 }, [null, null, 20], 10))
      .toEqual({ index: 2, t: 5 });
  });

  it("lands exactly on the chunk start when the jump consumes the offset", () => {
    expect(computeBackTarget({ index: 2, t: 10 }, [8, 8, 20], 10))
      .toEqual({ index: 2, t: 0 });
  });

  it("walks into the previous chunk using its known duration", () => {
    // 3s into chunk 2, 10s back → 7s before chunk 2 = 12−7 = 5s into chunk 1.
    expect(computeBackTarget({ index: 2, t: 3 }, [10, 12, 20], 10))
      .toEqual({ index: 1, t: 5 });
  });

  it("walks across several short chunks", () => {
    // 1s into chunk 3; 10s back crosses chunk 2 (4s) and chunk 1 (4s),
    // leaving 1s inside chunk 0 (6s long) → 5s into chunk 0.
    expect(computeBackTarget({ index: 3, t: 1 }, [6, 4, 4, 9], 10))
      .toEqual({ index: 0, t: 5 });
  });

  it("snaps to the sentence start when a duration is unknown", () => {
    expect(computeBackTarget({ index: 2, t: 3 }, [10, null, 20], 10))
      .toEqual({ index: 1, t: 0 });
  });

  it("clamps at the very beginning", () => {
    expect(computeBackTarget({ index: 0, t: 4 }, [30], 10)).toEqual({ index: 0, t: 0 });
    expect(computeBackTarget({ index: 1, t: 2 }, [3, 10], 10)).toEqual({ index: 0, t: 0 });
  });

  it("treats a zero/invalid recorded duration as unknown", () => {
    expect(computeBackTarget({ index: 2, t: 1 }, [10, 0, 20], 10))
      .toEqual({ index: 1, t: 0 });
    expect(computeBackTarget({ index: 2, t: 1 }, [10, Number.NaN, 20], 10))
      .toEqual({ index: 1, t: 0 });
  });
});

describe("computeForwardTarget", () => {
  it("seeks within the current chunk when it is long enough", () => {
    expect(computeForwardTarget({ index: 0, t: 2 }, [20], 1, 10))
      .toEqual({ index: 0, t: 12 });
  });

  it("spills into the next chunk using known durations", () => {
    // 8s into a 12s chunk, +10s → 6s into chunk 1 (which is 9s long).
    expect(computeForwardTarget({ index: 0, t: 8 }, [12, 9], 2, 10))
      .toEqual({ index: 1, t: 6 });
  });

  it("lands at the next sentence start when the next duration is unknown", () => {
    expect(computeForwardTarget({ index: 0, t: 8 }, [12, null], 2, 10))
      .toEqual({ index: 1, t: 0 });
  });

  it("moves to the next sentence when the current duration is unknown", () => {
    expect(computeForwardTarget({ index: 1, t: 0 }, [10, null, null], 3, 10))
      .toEqual({ index: 2, t: 0 });
  });

  it("returns end past the last chunk", () => {
    expect(computeForwardTarget({ index: 1, t: 5 }, [10, 8], 2, 10)).toBe("end");
    expect(computeForwardTarget({ index: 0, t: 0 }, [null], 1, 10)).toBe("end");
  });
});

// Index-aware capture: seeks replay/skip chunks, so completeness must be
// judged by filled slots, never by arrival count or order.

describe("ttsAudioCache index-aware capture", () => {
  beforeAll(() => {
    // jsdom implements neither blob URLs nor anchor navigation; the download
    // helper is exercised only as a completeness probe here.
    if (!URL.createObjectURL) {
      Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    }
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  const buf = (n: number) => {
    const b = new ArrayBuffer(4);
    new Uint8Array(b).fill(n);
    return b;
  };

  it("completes only when every slot is filled, regardless of arrival order", () => {
    beginTtsCapture("m1", 3);
    addTtsChunkAt("m1", 2, buf(3));
    addTtsChunkAt("m1", 0, buf(1));
    completeTtsCapture("m1");
    expect(downloadTtsAudio("m1", "text")).toBe(false); // slot 1 missing
    addTtsChunkAt("m1", 1, buf(2));
    completeTtsCapture("m1");
    expect(downloadTtsAudio("m1", "text")).toBe(true);
    discardTtsCapture("m1");
  });

  it("ignores chunks for a different or out-of-range id", () => {
    beginTtsCapture("m2", 1);
    addTtsChunkAt("other", 0, buf(1));
    addTtsChunkAt("m2", 5, buf(1));
    completeTtsCapture("m2");
    expect(downloadTtsAudio("m2", "text")).toBe(false);
    addTtsChunkAt("m2", 0, buf(1));
    completeTtsCapture("m2");
    expect(downloadTtsAudio("m2", "text")).toBe(true);
    discardTtsCapture("m2");
  });

  it("never completes an empty or discarded capture", () => {
    beginTtsCapture("m3", 0);
    completeTtsCapture("m3");
    expect(downloadTtsAudio("m3", "text")).toBe(false);
    beginTtsCapture("m4", 1);
    addTtsChunkAt("m4", 0, buf(1));
    discardTtsCapture("m4");
    completeTtsCapture("m4");
    expect(downloadTtsAudio("m4", "text")).toBe(false);
  });
});
