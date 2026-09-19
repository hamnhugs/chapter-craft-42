// Pure seek math for chunked TTS playback (useReadAloud).
//
// A read-aloud session plays sentence-sized chunks in order. For the Inworld
// (MP3) path each chunk is a real audio file whose duration becomes known the
// moment it plays (loadedmetadata) — so a "back/forward 10 seconds" press can
// be walked exactly across chunk boundaries wherever durations are known, and
// snaps to a chunk (sentence) start where they aren't. Sentence-start snapping
// is the research-backed fallback: for spoken text the unit of re-comprehension
// is the sentence, so landing at one is at least as useful as a blind offset.
//
// These functions are pure so the boundary arithmetic is unit-testable without
// audio elements.

export interface SeekPos {
  /** Chunk index within the session's chunk list. */
  index: number;
  /** Seconds into that chunk. */
  t: number;
}

/**
 * Position `step` seconds earlier in the chunk timeline.
 * Walks back through chunks using known durations; on reaching a chunk whose
 * duration is unknown (never played this session), lands at its start.
 * Clamps at the very beginning.
 */
export function computeBackTarget(
  pos: SeekPos,
  durations: ReadonlyArray<number | null>,
  step: number,
): SeekPos {
  let idx = pos.index;
  let t = Math.max(0, pos.t);
  let rem = step;
  for (;;) {
    if (t >= rem) return { index: idx, t: t - rem };
    rem -= t;
    if (idx === 0) return { index: 0, t: 0 };
    idx -= 1;
    const d = durations[idx];
    if (d == null || !Number.isFinite(d) || d <= 0) return { index: idx, t: 0 };
    t = d;
  }
}

/**
 * Position `step` seconds later in the chunk timeline, or "end" when the jump
 * runs past the last chunk. Chunks with unknown duration (not yet fetched)
 * absorb the jump at their start — you land on the next sentence rather than
 * skipping audio nobody has measured yet.
 */
export function computeForwardTarget(
  pos: SeekPos,
  durations: ReadonlyArray<number | null>,
  total: number,
  step: number,
): SeekPos | "end" {
  let idx = pos.index;
  let t = Math.max(0, pos.t);
  let rem = step;
  for (;;) {
    if (idx >= total) return "end";
    const d = durations[idx];
    if (d == null || !Number.isFinite(d) || d <= 0) {
      // Unknown length. If we're inside this chunk now, move to the next
      // sentence; if we walked here from an earlier chunk, its start IS the
      // landing point.
      if (idx === pos.index) {
        return idx + 1 < total ? { index: idx + 1, t: 0 } : "end";
      }
      return { index: idx, t: 0 };
    }
    if (t + rem < d) return { index: idx, t: t + rem };
    rem -= d - t;
    t = 0;
    idx += 1;
  }
}
