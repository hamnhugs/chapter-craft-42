/**
 * Long-press-to-save-a-note classification for chat bubbles. Pure (no DOM) so
 * the rules are unit-tested; `ChatPanel` feeds it samples from touch events.
 *
 * The first version fired after a flat 500ms hold, saved immediately, and threw
 * the notes panel open over the transcript. 500ms is the pause a thumb makes
 * *before* it starts a scroll, so the gesture collided with the most common
 * touch in the app, and the payoff for a misfire was a stray note plus a panel
 * covering what you were reading. Reported by the user, not by a test.
 *
 * A save now needs a hold that is long enough to be a decision, still enough to
 * not be a scroll, single-fingered, and not already a text selection (the
 * selection toolbar offers the same save, and double-offering it means whichever
 * one you didn't mean wins).
 */

export interface NotePressSample {
  /** Furthest the finger travelled from where it landed, in CSS px. */
  movedPx: number;
  /** Most fingers down at once during the press (2+ = pinch/zoom). */
  maxPointers: number;
  /** A non-empty text selection exists — the selection toolbar owns this. */
  selecting: boolean;
  /** The transcript scrolled while the finger was down. */
  scrolled: boolean;
  /** How long the finger has been down. */
  heldMs: number;
}

export const NOTE_PRESS = {
  /**
   * Android's own long-press is 500ms and iOS's is ~500ms too, which is why the
   * old value misfired: it fired at exactly the moment the OS trains your thumb
   * to expect *nothing yet*. 900ms sits past every accidental rest and is still
   * well inside the ~1s people will hold before assuming a control is dead.
   */
  holdMs: 900,
  /**
   * Cancelling on any movement at all sounds safer but isn't: browsers emit
   * touchmove for sub-pixel jitter, so a deliberate press fails while a resting
   * thumb (which reports no move) succeeds — exactly backwards. A slop lets a
   * still finger be still.
   */
  slopPx: 10,
  /** How long the undo stays on screen after a save. */
  undoMs: 6000,
} as const;

/** Should this press save a note? */
export function classifyNotePress(s: NotePressSample): "save" | null {
  if (s.maxPointers > 1 || s.selecting || s.scrolled) return null;
  if (s.movedPx > NOTE_PRESS.slopPx) return null;
  if (s.heldMs < NOTE_PRESS.holdMs) return null;
  return "save";
}
