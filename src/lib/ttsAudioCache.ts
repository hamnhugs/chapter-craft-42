import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Last-spoken Inworld TTS audio capture.
//
// useReadAloud already fetches each sentence chunk of a reply as MP3 bytes to
// play it; this module retains those same ArrayBuffers (instead of letting
// them be GC'd after playback) so the user can download the message audio
// without paying for a second synthesis. Inworld bills per character, so a
// download must be a read of what we already fetched — never a new API call.
//
// Only the most recent message is kept (a few hundred KB of MP3). Starting a
// new capture drops the previous one. The audio is offered for download only
// when every chunk arrived and playback finished naturally — a stopped or
// fallback-interrupted read would produce a truncated file.
//
// Concatenating independently encoded MP3 chunks is safe when they share the
// encoder and config (same voice/model/sample-rate requests): MP3 is a
// frame-based stream, so decoders just keep reading frames. We defensively
// strip ID3v2/ID3v1 tags from each chunk so no metadata blocks land
// mid-stream; sentence-boundary chunks make the tiny encoder-padding gaps
// inaudible.
// ---------------------------------------------------------------------------

// Chunks are stored BY INDEX, not in arrival order: seek controls can replay
// or skip chunks, so arrival order no longer matches message order. The
// capture is complete only when every expected slot is filled — a message the
// user skipped through (leaving unfetched chunks) simply never becomes
// downloadable, same as a stopped read.
interface Capture {
  id: string;
  chunks: (ArrayBuffer | undefined)[];
  expected: number;
  complete: boolean;
}

let capture: Capture | null = null;
const listeners = new Set<() => void>();
// Snapshot for useSyncExternalStore: the id of the message whose audio is
// fully captured, or null. Must be reference-stable between changes.
let downloadableId: string | null = null;

function publish() {
  const next = capture?.complete ? capture.id : null;
  if (next === downloadableId) return;
  downloadableId = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getSnapshot = () => downloadableId;

/** Id of the message whose Inworld audio is ready to download, or null. */
export function useDownloadableTtsId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Start capturing a new message's audio; drops any previous capture. */
export function beginTtsCapture(id: string, expectedChunks: number) {
  capture = { id, chunks: new Array(expectedChunks), expected: expectedChunks, complete: false };
  publish();
}

/** Retain one fetched chunk at its message position. No-op if a different
 *  capture has started since. Idempotent per slot (seeks refetch nothing, but
 *  a retried fetch may deliver the same index twice). */
export function addTtsChunkAt(id: string, index: number, buf: ArrayBuffer) {
  if (!capture || capture.id !== id || capture.complete) return;
  if (index < 0 || index >= capture.expected) return;
  if (buf.byteLength > 0) capture.chunks[index] = buf;
}

/** Mark the capture complete — playback reached the end AND every chunk slot
 *  was filled (a skipped-past chunk was never fetched, so no download). */
export function completeTtsCapture(id: string) {
  if (!capture || capture.id !== id || capture.expected === 0) return;
  for (let i = 0; i < capture.expected; i++) {
    if (!capture.chunks[i]) return;
  }
  capture.complete = true;
  publish();
}

/** Abandon a capture (playback stopped early or fell back to browser TTS). */
export function discardTtsCapture(id: string) {
  if (!capture || capture.id !== id) return;
  capture = null;
  publish();
}

// --- MP3 tag stripping -------------------------------------------------------

function stripId3(buf: ArrayBuffer): ArrayBuffer {
  let bytes = new Uint8Array(buf);
  // ID3v2 header at the start: "ID3" + version(2) + flags(1) + synchsafe size(4).
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
      | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const footer = (bytes[5] & 0x10) ? 10 : 0;
    const skip = 10 + size + footer;
    if (skip < bytes.length) bytes = bytes.subarray(skip);
  }
  // ID3v1: trailing 128-byte block starting with "TAG".
  if (bytes.length > 128) {
    const t = bytes.length - 128;
    if (bytes[t] === 0x54 && bytes[t + 1] === 0x41 && bytes[t + 2] === 0x47) {
      bytes = bytes.subarray(0, t);
    }
  }
  return bytes.byteLength === buf.byteLength ? buf : bytes.slice().buffer;
}

// --- Download ---------------------------------------------------------------

function filenameFor(text: string): string {
  const slug = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
  const date = new Date().toISOString().slice(0, 10);
  return `${slug || "audio-message"}-${date}.mp3`;
}

/**
 * Save the captured audio for `id` as a single local MP3 file.
 * Returns false when no complete capture exists for that id.
 * Synchronous on purpose: iOS Safari ignores programmatic downloads that
 * don't happen inside the original user gesture.
 */
export function downloadTtsAudio(id: string, messageText: string): boolean {
  if (!capture || capture.id !== id || !capture.complete) return false;
  const parts = capture.chunks.filter((c): c is ArrayBuffer => !!c);
  const blob = new Blob(parts.map(stripId3), { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFor(messageText);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the browser has started reading the blob.
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* no-op */ } }, 1000);
  return true;
}
