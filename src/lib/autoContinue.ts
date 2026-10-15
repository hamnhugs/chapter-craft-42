/** Auto-continue: let Counsel keep working on a multi-step request without the
 *  user typing "keep going" between replies (the "Ralph loop" pattern).
 *
 *  Each reply is still bounded by TOOL_ROUNDS_PER_REPLY. When a reply ends,
 *  the RUNTIME — not the model — decides whether to send another turn:
 *
 *  - The model ends every reply with one status line (`STATUS: DONE`,
 *    `STATUS: NEEDS_USER`, `STATUS: CONTINUE`). It reports; it does not own
 *    the loop. Model-declared completion is the most common false-finish
 *    failure, so the first DONE after real multi-turn work earns one
 *    verification turn before the loop accepts it.
 *  - Hard caps the model cannot talk its way past: a continuation limit, a
 *    stall guard (turns that call no tools and make no claim), errors and the
 *    Stop button all end the loop.
 *  - Every continuation restates the original request, so the goal survives
 *    the rolling summary dropping old history.
 */

export const AUTO_CONTINUE_MAX = 8;
/** Consecutive continuation turns with no tool calls before the loop gives up. */
export const AUTO_CONTINUE_STALL_LIMIT = 2;

export type TaskStatus = "done" | "needs_user" | "continue";

const STATUS_RE = /(?:^|\n)[ \t>*_`]*STATUS:\s*\**\s*(DONE|NEEDS_USER|CONTINUE)\b[^\n]*\s*$/i;

/** The status the reply ended with, or null when it carries none. Only the
 *  LAST line counts — a status quoted mid-reply is not a report. */
export function parseTaskStatus(text: string): TaskStatus | null {
  const m = STATUS_RE.exec(text.trimEnd());
  if (!m) return null;
  return m[1].toLowerCase() as TaskStatus;
}

/** The reply without its trailing status line, for display. */
export function stripTaskStatus(text: string): string {
  return text.trimEnd().replace(STATUS_RE, "").trimEnd();
}

/** System-prompt section, present only while auto-continue is on. */
export function autoContinuePrompt(): string {
  return [
    "## Auto-continue mode",
    "The user turned on auto-continue: when your reply ends, the app may send you a continuation turn so you can finish a multi-step task without the user typing \"keep going\". Work through the task yourself — do not stop to offer the next step (\"say 'finish' and I will…\"); just do it on this or the next turn.",
    "End EVERY reply with exactly one status line, as the last line:",
    "- `STATUS: CONTINUE` — work remains and you can do it without the user.",
    "- `STATUS: NEEDS_USER` — you cannot proceed without something only the user can give (missing information, a choice between options they must make, approval for something destructive or costly). Say exactly what you need.",
    "- `STATUS: DONE` — every part of the request is finished AND you checked it with your tools (not from memory). Name the check.",
    "Simple questions and conversation end with `STATUS: DONE`.",
  ].join("\n");
}

export interface AutoTurn {
  text: string;
  /** Tool calls the reply made. */
  toolCalls: number;
  /** The Stop button ended the turn. */
  aborted: boolean;
}

export interface AutoLoopState {
  /** Continuation turns sent so far (the user's own message is not one). */
  continuations: number;
  /** Consecutive continuation turns that made no tool calls. */
  stalls: number;
  /** A verification turn has already been spent on a DONE claim. */
  verified: boolean;
  max: number;
}

export function initialAutoLoopState(max = AUTO_CONTINUE_MAX): AutoLoopState {
  return { continuations: 0, stalls: 0, verified: false, max };
}

export type AutoDecision =
  | { action: "stop"; reason: "done" | "needs_user" | "aborted" | "limit" | "stalled" | "no_status" }
  | { action: "continue"; kind: "continue" | "verify"; state: AutoLoopState };

export function decideNext(state: AutoLoopState, turn: AutoTurn): AutoDecision {
  if (turn.aborted) return { action: "stop", reason: "aborted" };
  const status = parseTaskStatus(turn.text);
  if (status === "needs_user") return { action: "stop", reason: "needs_user" };

  const stalls = state.continuations > 0 && turn.toolCalls === 0 ? state.stalls + 1 : 0;

  if (status === "done") {
    // Accept DONE outright when there is nothing to re-check: a first reply
    // that used no tools (a plain answer), or a claim re-made after the
    // verification turn. Anything that changed state gets checked once.
    if (state.verified || (state.continuations === 0 && turn.toolCalls === 0)) return { action: "stop", reason: "done" };
  } else if (status === null && turn.toolCalls === 0) {
    // No claim and no work: a plain reply, or a model ignoring the protocol.
    // Either way another turn would only produce more of the same.
    return { action: "stop", reason: "no_status" };
  }

  if (stalls >= AUTO_CONTINUE_STALL_LIMIT) return { action: "stop", reason: "stalled" };
  if (state.continuations >= state.max) return { action: "stop", reason: "limit" };

  const kind = status === "done" ? "verify" : "continue";
  return {
    action: "continue",
    kind,
    state: {
      ...state,
      continuations: state.continuations + 1,
      stalls,
      verified: state.verified || kind === "verify",
    },
  };
}

const GOAL_CHARS = 600;

/** The continuation message sent as the user's turn. Visible in the
 *  transcript — it is exactly what the model saw. */
export function continuationMessage(goal: string, kind: "continue" | "verify", n: number, max: number): string {
  const g = goal.trim();
  const quoted = g.length > GOAL_CHARS ? `${g.slice(0, GOAL_CHARS)}…` : g;
  const head = `↻ Auto-continue ${n}/${max}.`;
  const body =
    kind === "verify"
      ? "Before this counts as done: check the original request item by item with your tools (inspect the actual result — do not rely on what you remember doing). Fix anything missing or wrong. End with STATUS: DONE only if the check passes."
      : "Keep going with the next part of the task. Don't repeat finished work or ask me to confirm routine steps.";
  return `${head} ${body}\n\nOriginal request:\n> ${quoted.replace(/\n/g, "\n> ")}`;
}

export function stopReasonLabel(reason: Extract<AutoDecision, { action: "stop" }>["reason"], max: number): string | null {
  switch (reason) {
    case "limit": return `Auto-continue paused after ${max} extra turns — send "continue" to keep going.`;
    case "stalled": return "Auto-continue stopped: the last turns made no progress.";
    default: return null;
  }
}
