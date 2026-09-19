/**
 * What the pocket screen shows under the worm.
 *
 * Pure, like wormMood.ts and for the same reason: this is a priority ladder,
 * and a priority ladder buried in a 1900-line component is one nobody can test
 * or argue with. ChatPanel gathers the signals; the ordering lives here.
 *
 * THE POINT OF THIS SCREEN IS READING. The first version showed only the
 * sentence currently being spoken, which advanced prettily with the voice and
 * was wrong: it vanished the moment speech ended. What this is actually for is
 * quizzing — hearing an answer and then READING it, without unlocking the phone
 * and going back into the app. So the reply PERSISTS. It stays on screen until
 * the next turn genuinely replaces it, and it is the whole message, not a
 * fragment of it.
 *
 * The ladder, highest first:
 *
 *  - LISTENING shows the live interim transcript. The most reassuring thing you
 *    can put on a screen that is currently holding a microphone open.
 *  - THINKING shows the question waiting on an answer, because the alternative
 *    is a blank screen during the longest pause in the cycle.
 *  - Otherwise the newest ASSISTANT message, in full. This covers both speaking
 *    and every quiet moment afterwards, which is what makes it persist.
 *  - Failing that the user's own last line, so the screen is not blank before
 *    the first reply of a session.
 */

export interface PocketCaption {
  /** Stable across edits to `text`. The bubble keys its fade on this: keying
   *  on the text itself would replay the animation on every streamed token. */
  id: string;
  text: string;
  from: "user" | "assistant";
}

export interface CaptionSignals {
  handsFreeActive: boolean;
  /** Hands-free FSM state. */
  state: string;
  /** Live partial transcript of what the user is saying. */
  interim: string;
  /** The newest assistant message, raw, and its id. */
  assistantText: string | null;
  assistantId: string | null;
  /** The newest user message, and its id. */
  lastUserText: string | null;
  lastUserId: string | null;
}

/** Generous: the viewport and a scroll box do the real limiting now. This only
 *  stops a pasted wall of text from sitting in the DOM of a screen that is
 *  supposed to be off. */
export const CAPTION_MAX = 4000;

/**
 * Markdown to something readable.
 *
 * Deliberately NOT `stripMarkdownForTts` from useReadAloud, which flattens every
 * newline to ". " — correct for a speech engine, destructive for something
 * being read. Paragraph breaks are the main thing that makes a long answer
 * scannable, so they survive here.
 */
export function plainText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<!\w)([*_])(?=\S)(.*?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^[ \t]*[-*+]\s+/gm, "• ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const cut = (t: string) => {
  const s = plainText(t);
  return s.length > CAPTION_MAX ? s.slice(0, CAPTION_MAX) + "…" : s;
};

export function resolvePocketCaption(s: CaptionSignals): PocketCaption | null {
  if (!s.handsFreeActive) return null;

  if (s.state === "listening" && s.interim.trim()) {
    return { id: "interim", text: cut(s.interim), from: "user" };
  }
  if (s.state === "thinking" && s.lastUserText?.trim()) {
    return { id: s.lastUserId ?? "user", text: cut(s.lastUserText), from: "user" };
  }
  // The persisting one. No state check: this is what stays up after the voice
  // stops, which is the whole reason the caption exists.
  if (s.assistantText?.trim()) {
    return { id: s.assistantId ?? "assistant", text: cut(s.assistantText), from: "assistant" };
  }
  if (s.lastUserText?.trim()) {
    return { id: s.lastUserId ?? "user", text: cut(s.lastUserText), from: "user" };
  }
  return null;
}
