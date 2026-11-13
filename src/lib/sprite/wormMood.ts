import type { Mood } from "./wormAnimator";

/**
 * Which mood the conversation is in.
 *
 * Kept pure and separate from both the animator and ChatPanel: the animator
 * should not know what a tool call is, and ChatPanel should not own a priority
 * ladder. Everything time-dependent arrives as an elapsed-milliseconds number
 * rather than being read from a clock in here, so the whole ladder is testable
 * by passing numbers.
 *
 * It returns `recheckInMs` alongside the mood so the caller can schedule a
 * single timeout at the next moment the answer could change, instead of
 * polling. A companion that needs a 250ms interval ticking forever just to
 * notice it should look sleepy is a companion that costs more than it gives.
 */
export interface MoodSignals {
  /** Text-to-speech is playing. */
  speaking: boolean;
  /** A microphone is open — hands-free listening, or composer dictation. */
  listening: boolean;
  /** A reply is being generated. */
  thinking: boolean;
  /** ...and prose has started arriving, so there is something to read. */
  streamingText: boolean;
  /** The last assistant turn ended in an error. */
  failed: boolean;
  /** There is draft text in the composer. */
  typing: boolean;
  /** Since the last keystroke. */
  sinceTypedMs: number;
  /** Since a turn completed cleanly. Infinity if none this session. */
  sinceDoneMs: number;
  /** Since anything at all happened. Drives the drop into sleep. */
  idleMs: number;
}

/** How long the worm celebrates a completed reply before going back to idle. */
export const CHEER_MS = 1800;
/** How long it keeps watching the composer after the last keystroke. */
export const WATCH_MS = 2500;
/** How long a failure shows on its face. */
export const OOPS_MS = 4500;
/** How long until it curls up. Long enough that it never happens mid-task. */
export const SLEEP_MS = 90_000;

export interface MoodDecision {
  mood: Mood;
  /** When the answer could next change on time alone. Infinity if never. */
  recheckInMs: number;
}

/**
 * Highest priority first. The ordering is the design:
 *
 *  - Speaking outranks everything, because audio is playing and a mouth that
 *    does not match it is the most noticeable failure available.
 *  - Listening outranks thinking, because an open microphone is a state the
 *    user needs to be sure about.
 *  - Failure outranks the celebration it cancels.
 *  - `read` outranks `think` only once prose has actually arrived, which is why
 *    both exist: the gap between "asked" and "first token" is genuinely a
 *    different moment from "words are appearing".
 */
export function resolveWormMood(s: MoodSignals): MoodDecision {
  const never = Number.POSITIVE_INFINITY;

  if (s.speaking) return { mood: "speak", recheckInMs: never };
  if (s.listening) return { mood: "listen", recheckInMs: never };

  if (s.failed && s.sinceDoneMs < OOPS_MS) {
    return { mood: "oops", recheckInMs: OOPS_MS - s.sinceDoneMs };
  }

  if (s.thinking) {
    return { mood: s.streamingText ? "read" : "think", recheckInMs: never };
  }

  if (!s.failed && s.sinceDoneMs < CHEER_MS) {
    return { mood: "cheer", recheckInMs: CHEER_MS - s.sinceDoneMs };
  }

  // Watching you type is the one mood the user directly causes, so it holds a
  // little past the last keystroke rather than flicking off between words.
  if (s.typing && s.sinceTypedMs < WATCH_MS) {
    return { mood: "watch", recheckInMs: WATCH_MS - s.sinceTypedMs };
  }

  if (s.idleMs >= SLEEP_MS) return { mood: "sleep", recheckInMs: never };
  return { mood: "idle", recheckInMs: SLEEP_MS - s.idleMs };
}
