/** Auto-continue: let Counsel keep working on a multi-step request without the
 *  user typing "keep going" between replies (the "Ralph loop" pattern).
 *
 *  Each reply is still bounded by TOOL_ROUNDS_PER_REPLY. When a reply ends,
 *  the runtime reads it and decides whether to send another turn:
 *
 *  - The model calls the stop: `finish_task` (done / needs_user), else its
 *    last-line `STATUS:`, else a reply that plainly says it finished. A done
 *    is accepted at once; the check belongs in the finishing reply.
 *  - Hard caps the model cannot talk its way past: a continuation limit, a
 *    stall guard (runs that change nothing), errors and the Stop button all
 *    end the loop.
 *  - Every continuation restates the original request and lists what earlier
 *    runs made, so the goal survives compaction and later runs build on the
 *    work instead of redoing or deleting it. Continuation runs also can't
 *    delete pages or start a new document (craftApps protectWork).
 */

export const AUTO_CONTINUE_MAX = 8;
/** Most runs a user can ask for. Each run is a full request; past this a
 *  task wants splitting, not more runs. */
export const AUTO_CONTINUE_MAX_LIMIT = 50;
/** Compact the conversation after this many runs by default (0 = never). */
export const AUTO_COMPACT_EVERY = 3;
/** Messages kept word for word when a loop compacts: the last two exchanges.
 *  Everything older becomes the summary. */
export const LOOP_KEEP_RECENT = 4;

/** A user-entered run count, made safe: whole, 1..AUTO_CONTINUE_MAX_LIMIT. */
export function clampRuns(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return AUTO_CONTINUE_MAX;
  return Math.min(AUTO_CONTINUE_MAX_LIMIT, Math.max(1, v));
}

/** A user-entered compaction interval: 0 (off) .. AUTO_CONTINUE_MAX_LIMIT. */
export function clampCompactEvery(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return AUTO_COMPACT_EVERY;
  return Math.min(AUTO_CONTINUE_MAX_LIMIT, Math.max(0, v));
}

/** Compact before the next run? True after every `every` completed runs, and
 *  never before the first continuation (nothing has piled up yet). */
export function shouldCompact(completedRuns: number, every: number): boolean {
  return every > 0 && completedRuns > 0 && completedRuns % every === 0;
}

/** Instructions for the summary written mid-loop. Structured as a hand-off
 *  so the next run can pick up the work, and with the user's rules in their
 *  own section, copied word for word: summaries written for "task
 *  continuity" drop standing constraints (compactors kept 17% of them in
 *  "Lost in Compaction", arXiv 2608.11242; a separate, verbatim constraint
 *  list brought that above 90%). */
export function loopCompactionInstructions(): string {
  return [
    "You compact the working history of an assistant that is part-way through a multi-step task for a user, so the next step can continue from your notes alone. Merge the existing summary (if any) with the new messages.",
    "Write these sections, in this order, under these exact headings:",
    "USER RULES — every instruction, limit, preference or \"don't\" the user gave, copied word for word. Never paraphrase or drop one, even if it looks old.",
    "GOAL — what the user asked for, in one or two sentences.",
    "DONE — what has been finished, with the names, ids, numbers and file/page names involved. Mark anything the assistant claimed but did not check as (unchecked).",
    "STILL TO DO — the remaining steps, in order.",
    "FACTS — anything else the next step needs: decisions made, errors hit and what fixed them, open questions.",
    "At most ~400 words. Plain text. Output ONLY the summary; do not call tools.",
  ].join("\n");
}
/** Consecutive continuation turns that changed nothing before the loop gives up. */
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

// A reply that says it finished, with nothing said about more to do. DeepSeek
// dropped the STATUS line on 3 of 5 loop replies (2026-10-15), including "I
// have completed the new double-sided sales flyer…" — and the loop, reading
// no status, sent two more runs that only re-saved and re-described it.
const FINISH_CLAIM = /\b(?:I(?:'ve| have)\s+(?:now\s+)?(?:completed|finished)\b|(?:is|are|has been|have been)\s+(?:now\s+)?(?:fully\s+)?(?:complete|completed|finished)\b|all (?:done|set|finished)\b)/i;
const MORE_TO_DO = /\b(?:next turn|on the next|next,? I(?:'ll| will)|I(?:'ll| will) (?:now|then|next)\b|still (?:need|to do|remaining)|remaining (?:steps|work|parts)|not (?:yet )?(?:done|finished|complete))/i;

/** Does a reply WITHOUT a status line read as "the task is finished"? */
export function soundsFinished(text: string): boolean {
  return FINISH_CLAIM.test(text) && !MORE_TO_DO.test(text);
}

/** The loop's stop button, handed to the model (the OpenHands `finish`
 *  pattern): a tool call is a structured signal it can't forget to format,
 *  unlike the last-line STATUS it often left off. Offered only on
 *  auto-continue turns; the app handles it itself (ChatContext). */
export const FINISH_TASK_NAME = "finish_task";
export const FINISH_TASK_DEFINITION = {
  type: "function",
  function: {
    name: FINISH_TASK_NAME,
    description:
      "End the auto-continue loop. status done: the WHOLE request is finished and you have looked at the result with your tools in this reply (inspect/preview) — say what you checked. status needs_user: you can't go on without the user — say what you need. Afterwards write a short final reply; no more tool calls run. Don't call it while work remains.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "needs_user"] },
        checked: { type: "string", description: "done: what you looked at to confirm it, e.g. 'previewed both pages'." },
        question: { type: "string", description: "needs_user: what you need from the user." },
      },
      required: ["status"],
    },
  },
} as const;

/** What a finish_task call does: the status the loop reads, the tool result
 *  the model sees, and the event the user sees. */
export function finishTaskOutcome(rawArgs: string): {
  finish: Exclude<TaskStatus, "continue">;
  result: { ok: true; note: string };
  event: { name: string; summary: string; ok: true };
} {
  let a: any = {};
  try { a = JSON.parse(rawArgs || "{}") || {}; } catch { /* bad args read as done */ }
  const finish = a.status === "needs_user" ? "needs_user" : "done";
  const said = String((finish === "done" ? a.checked : a.question) || "").trim().slice(0, 160);
  return {
    finish,
    result: { ok: true, note: finish === "done"
      ? "Recorded: the task is finished and the loop stops. Now write the user a short final reply — what was made and how you checked it. No more tool calls run."
      : "Recorded: the loop stops for the user. Now ask them, in one short reply, exactly what you need. No more tool calls run." },
    event: { name: FINISH_TASK_NAME, summary: finish === "done" ? `Finished the task${said ? ` (checked: ${said})` : ""}` : `Stopped to ask you${said ? `: ${said}` : ""}`, ok: true },
  };
}

// Tool events that only look (inspect, preview, search, list): no work made.
const LOOK_EVENT = /^(?:Inspected|Looked at|Checked|Searched|Listed|Read|Showed|Found|Viewed|Previewed|Finished the task|Stopped to ask|No more tools)/i;

/** Did this tool event make or change something? */
export function isChangeEvent(e: { name?: string; summary?: string; ok?: boolean }): boolean {
  return e.ok !== false && e.name !== FINISH_TASK_NAME && !LOOK_EVENT.test(String(e.summary || "").trim());
}

/** System-prompt section, present only while auto-continue is on. */
export function autoContinuePrompt(): string {
  return [
    "## Auto-continue mode",
    "The user turned on auto-continue: when your reply ends, the app may send you a continuation turn so you can finish a multi-step task without the user typing \"keep going\". Work through the task yourself — do not stop to offer the next step (\"say 'finish' and I will…\"); just do it on this or the next turn.",
    "Stopping is yours to call: the moment every part of the request is finished and you have looked at the result with your tools, call `finish_task` with status done (name the check), then write a short final reply. If you can't go on without the user (missing information, a choice only they can make, approval for something destructive or costly), call `finish_task` with status needs_user and ask. Don't invent extra work to fill runs — re-saving, re-linking or re-describing finished work is not progress.",
    "Each run builds on the last. Keep what earlier runs made: change the part that is wrong in place (send the same role again to replace it). Don't delete pages, start a new document or clear earlier work — continuation runs refuse those. If you truly think starting over is needed, call `finish_task` with needs_user and ask.",
    "If you didn't call `finish_task`, end the reply with the line `STATUS: CONTINUE`.",
    "Simple questions and conversation: just answer and call `finish_task` with status done.",
  ].join("\n");
}

export interface AutoTurn {
  text: string;
  /** Tool calls the reply made. */
  toolCalls: number;
  /** The Stop button ended the turn. */
  aborted: boolean;
  /** What a finish_task call said, if the reply made one. */
  finish?: Exclude<TaskStatus, "continue"> | null;
  /** The reply's tool events that made or changed something (isChangeEvent). */
  changes?: string[];
}

export interface AutoLoopState {
  /** Continuation turns sent so far (the user's own message is not one). */
  continuations: number;
  /** Consecutive continuation turns that changed nothing. */
  stalls: number;
  /** The last reply said nothing about being finished or not. */
  unreported: boolean;
  /** What earlier runs made — handed to every continuation so the next run
   *  builds on it instead of redoing or deleting it. */
  ledger: string[];
  max: number;
}

export function initialAutoLoopState(max = AUTO_CONTINUE_MAX): AutoLoopState {
  return { continuations: 0, stalls: 0, unreported: false, ledger: [], max };
}

export type AutoDecision =
  | { action: "stop"; reason: "done" | "needs_user" | "aborted" | "limit" | "stalled" | "no_status" }
  | { action: "continue"; state: AutoLoopState };

const LEDGER_MAX = 30;

/** Add a run's changes to the ledger: repeats of one line collapse to "×n",
 *  and the oldest lines go first when it grows long. */
export function addToLedger(ledger: string[], run: number, changes: string[]): string[] {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c, (counts.get(c) || 0) + 1);
  const lines = [...counts].map(([c, k]) => `run ${run}: ${c}${k > 1 ? ` (×${k})` : ""}`);
  return [...ledger, ...lines].slice(-LEDGER_MAX);
}

export function decideNext(state: AutoLoopState, turn: AutoTurn): AutoDecision {
  if (turn.aborted) return { action: "stop", reason: "aborted" };
  // The model owns "finished": a finish_task call, else its STATUS line, else
  // a reply that plainly says it's done. Accepted at once — a forced extra
  // "check it again" run after a checked DONE did nothing visible for ~50 s
  // and the user stopped it (2026-10-15); the check now belongs in the
  // finishing reply (finish_task asks what was looked at).
  const status = turn.finish ?? parseTaskStatus(turn.text) ?? (soundsFinished(turn.text) ? "done" : null);
  if (status === "needs_user") return { action: "stop", reason: "needs_user" };
  if (status === "done") return { action: "stop", reason: "done" };
  // No claim and no work: a plain reply, or a model ignoring the protocol.
  // Either way another turn would only produce more of the same.
  if (status === null && turn.toolCalls === 0) return { action: "stop", reason: "no_status" };

  const changes = turn.changes ?? Array.from({ length: turn.toolCalls }, () => "work");
  // A run that only looked (inspect, preview, search) made no progress either.
  const stalls = state.continuations > 0 && changes.length === 0 ? state.stalls + 1 : 0;
  if (stalls >= AUTO_CONTINUE_STALL_LIMIT) return { action: "stop", reason: "stalled" };
  if (state.continuations >= state.max) return { action: "stop", reason: "limit" };

  return {
    action: "continue",
    state: {
      ...state,
      continuations: state.continuations + 1,
      stalls,
      unreported: status === null,
      ledger: turn.changes ? addToLedger(state.ledger, state.continuations, turn.changes) : state.ledger,
    },
  };
}

const GOAL_CHARS = 600;

/** The continuation message sent as the user's turn. Visible in the
 *  transcript — it is exactly what the model saw. Carries the original
 *  request (the goal survives compaction) and what earlier runs made (the
 *  progress log of Anthropic's long-running-agent harness): without it a run
 *  re-inspected the page, disliked what it saw and deleted three runs of work
 *  (2026-10-15). */
export function continuationMessage(goal: string, state: Pick<AutoLoopState, "continuations" | "max" | "unreported" | "ledger">): string {
  const g = goal.trim();
  const quoted = g.length > GOAL_CHARS ? `${g.slice(0, GOAL_CHARS)}…` : g;
  const parts = [`↻ Auto-continue ${state.continuations}/${state.max}. Keep going with the next part of the task. Don't repeat finished work or ask me to confirm routine steps.`];
  if (state.unreported) parts.push("Your last reply didn't say whether the task is finished. If it is, call finish_task now (status done, after looking at the result) instead of doing more.");
  if (state.ledger.length) {
    parts.push(`Made so far — keep it and build on it; fix a wrong part in place, don't delete it or start over:\n${state.ledger.map((l) => `- ${l}`).join("\n")}`);
  }
  parts.push(`Original request:\n> ${quoted.replace(/\n/g, "\n> ")}`);
  return parts.join("\n\n");
}

export function stopReasonLabel(reason: Extract<AutoDecision, { action: "stop" }>["reason"], max: number): string | null {
  switch (reason) {
    case "limit": return `Auto-continue paused after ${max} extra turns — send "continue" to keep going.`;
    case "stalled": return "Auto-continue stopped: the last turns made no progress.";
    default: return null;
  }
}
