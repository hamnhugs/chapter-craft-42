/**
 * What the pocket screen shows under the worm.
 *
 * Pure, like wormMood.ts and for the same reason: this is a priority ladder,
 * and a priority ladder that lives inside a 1900-line component is one nobody
 * can test or argue with. ChatPanel gathers the signals; the ordering lives
 * here.
 *
 * "The current message" is a different thing in each hands-free state, and the
 * ordering below is the design:
 *
 *  - SPEAKING wins, and shows the chunk being spoken rather than the whole
 *    reply, so the caption advances sentence by sentence in step with the
 *    voice. That text arrives already stripped of markdown, because the speech
 *    engine needed it that way first.
 *  - LISTENING shows the live interim transcript — the single most reassuring
 *    thing you can put on a screen that is currently holding a microphone open.
 *  - THINKING shows the question that is waiting on an answer, because the
 *    alternative is a blank screen during the longest pause in the cycle.
 *  - Otherwise nothing. A stale line left over from the last turn is worse than
 *    an empty screen, and this one is meant to be empty.
 */

export interface PocketCaption {
  text: string;
  from: "user" | "assistant";
}

export interface CaptionSignals {
  handsFreeActive: boolean;
  /** Hands-free FSM state. */
  state: string;
  /** Live partial transcript of what the user is saying. */
  interim: string;
  /** The sentence chunk being spoken, or null. */
  spokenText: string | null;
  /** The most recent thing the user asked, or null. */
  lastUserText: string | null;
}

/** Long enough for any spoken chunk (they cap at 240), short enough that a
 *  pasted essay cannot put a novel in the DOM behind a four-line clamp. */
export const CAPTION_MAX = 400;

const cut = (t: string) => {
  const s = t.trim();
  return s.length > CAPTION_MAX ? s.slice(0, CAPTION_MAX) + "…" : s;
};

export function resolvePocketCaption(s: CaptionSignals): PocketCaption | null {
  if (!s.handsFreeActive) return null;

  if (s.spokenText && s.spokenText.trim()) {
    return { text: cut(s.spokenText), from: "assistant" };
  }
  if (s.state === "listening" && s.interim.trim()) {
    return { text: cut(s.interim), from: "user" };
  }
  if (s.state === "thinking" && s.lastUserText && s.lastUserText.trim()) {
    return { text: cut(s.lastUserText), from: "user" };
  }
  return null;
}
