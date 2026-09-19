/**
 * Variable system prompts — the switchable instruction layer.
 *
 * THE POSITION IS THE POINT. A prompt preset used to ride as
 * `## User Custom Instructions` at the TOP of the ~23,000-character stable
 * system prompt (buildChatSystemPrompt.ts). Providers cache the longest
 * byte-identical PREFIX of a request, so a value that varies sitting at the top
 * of the stable block is the worst case there is: changing it invalidates the
 * whole prompt and every token after it. That is why a per-turn prompt is an
 * architecture change and not a dropdown.
 *
 * So the switchable layer rides in its OWN system message, placed LAST in the
 * leading system block — below every cache breakpoint that protects the stable
 * prompt. Swapping it re-writes only its own bytes. Last is also the position
 * where an instruction is actually obeyed (the same recency reasoning that puts
 * "Hard Response Length Limit" at the end of the stable prompt).
 *
 * ADDITIVE BY CONSTRUCTION. The user's `is_active` preset keeps riding at the
 * top exactly as before, so a user who never touches the switcher sends
 * byte-identical requests and the prompt baseline in promptToolTruth.test.ts is
 * untouched. The block below is built ONLY when an override resolves to a
 * different body than the one already in the stable prompt — compared by BODY,
 * not by id, so the router re-selecting the already-active preset costs nothing.
 *
 * Trust: a preset body is first-party text — the user either wrote it or
 * ratified it on an approval card — so it is injected unfenced, exactly like
 * the `customSystemPrompt` it sits beside. Model-drafted prompts live in
 * `prompt_proposals`, a table this path never reads.
 */

import type { PromptScope } from "@/hooks/usePromptPresets";

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * What the user has chosen for this session.
 *  - `auto`   — follow the saved default (and, once routing ships, the router)
 *  - `plain`  — no prompt at all this session, whatever the default says
 *  - `pinned` — this exact preset, and the router may not move off it
 */
export type TurnPromptSelection =
  | { mode: "auto" }
  | { mode: "plain" }
  | { mode: "pinned"; presetId: string };

export const AUTO_SELECTION: TurnPromptSelection = { mode: "auto" };

/** Where the prompt that actually rode this turn came from. */
export type PromptSource = "manual" | "auto" | "default" | "none";

/** The receipt stamped onto a reply: what was ACTUALLY put on the wire. */
export interface UsedPrompt {
  /** Preset id, or null when no prompt rode. */
  id: string | null;
  /** Display name, or null when no prompt rode. */
  name: string | null;
  source: PromptSource;
  /** Plain-language reason, shown verbatim in the receipt. */
  why: string;
  /** Only set when the ROUTER changed the prompt: what was in force before,
   *  so the reply's Undo can put it back in one tap. null = nothing was. */
  replacedId?: string | null;
}

// ---------------------------------------------------------------------------
// Session store — per-user, sessionStorage, resolved fresh at send.
//
// Not React state and not `SendOpts`: hands-free calls sendMessage directly
// (ChatPanel.tsx onUtterance), so an override that lived only in the composer's
// props would silently vanish on every spoken turn. Mirrors the
// subscribe-in-the-UI / read-at-send shape of bookContextStore.
//
// sessionStorage, not localStorage, on purpose: a pinned prompt is a "for now"
// decision. The durable choice is the preset's own `is_active` flag in the
// database; a pin that outlived the tab would quietly shadow it for days.
// ---------------------------------------------------------------------------

type Listener = () => void;

let currentUid: string | null = null;
let selection: TurnPromptSelection = AUTO_SELECTION;
const listeners = new Set<Listener>();

const storageKey = (uid: string) => `counsel_prompt_override_${uid}`;

function emit(): void {
  for (const l of [...listeners]) l();
}

function sanitizeStored(raw: unknown): TurnPromptSelection {
  if (!raw || typeof raw !== "object") return AUTO_SELECTION;
  const o = raw as Record<string, unknown>;
  if (o.mode === "plain") return { mode: "plain" };
  if (o.mode === "pinned" && typeof o.presetId === "string" && o.presetId) {
    return { mode: "pinned", presetId: o.presetId };
  }
  // Junk, or a mode a newer bundle wrote: fall back to the safe default rather
  // than inventing a third behaviour.
  return AUTO_SELECTION;
}

function persist(): void {
  if (!currentUid) return;
  try {
    if (selection.mode === "auto") sessionStorage.removeItem(storageKey(currentUid));
    else sessionStorage.setItem(storageKey(currentUid), JSON.stringify(selection));
  } catch {
    // Private mode / quota — the pin simply does not survive a reload.
  }
}

export const turnPromptStore = {
  /** Idempotent per uid. Signing out (uid null) clears the pin. */
  init(uid: string | null): void {
    if (uid === currentUid) return;
    currentUid = uid;
    if (!uid) {
      selection = AUTO_SELECTION;
      emit();
      return;
    }
    try {
      const raw = sessionStorage.getItem(storageKey(uid));
      selection = raw ? sanitizeStored(JSON.parse(raw)) : AUTO_SELECTION;
    } catch {
      selection = AUTO_SELECTION;
    }
    emit();
  },
  get(): TurnPromptSelection {
    return selection;
  },
  set(next: TurnPromptSelection): void {
    selection = next;
    persist();
    emit();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Test seam — resets module state without touching storage. */
  _reset(): void {
    currentUid = null;
    selection = AUTO_SELECTION;
    listeners.clear();
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The minimum a preset must expose for this module to resolve it. The
 *  binding fields are optional so a caller with only the old columns (or a
 *  test) still type-checks. */
export interface ResolvablePreset {
  id: string;
  name: string;
  body: string;
  scope: PromptScope;
  is_active: boolean;
  neuron_ids?: string[];
  book_id?: string | null;
  tool_permissions?: Record<string, boolean> | null;
}

/**
 * The context a prompt brings with it, and the two different lifetimes it has.
 *
 * `toolPermissions` is PER TURN. A tool roster is a property of a request, not
 * something that can be "loaded", so it is intersected into the gate map on
 * every turn the prompt is in force. It may only ever REMOVE tools — a prompt
 * must never be able to grant what the user's own permissions withhold.
 *
 * `neuronIds` and `bookId` are PER SWITCH. They are applied once, by the
 * switcher, as a visible action with a toast, and they show up in Counsel's
 * own chips afterwards. Re-applying them every turn would fight the user every
 * time they loaded a neuron by hand; applying them silently from the ROUTER
 * would be worse still, which is why the router never does (see below).
 */
export interface PromptBindings {
  neuronIds: string[];
  bookId: string | null;
  toolPermissions: Record<string, boolean> | null;
}

/** True when a prompt carries context a switch would load. */
export const hasContextBindings = (p: ResolvablePreset): boolean =>
  (p.neuron_ids?.length ?? 0) > 0 || !!p.book_id;

const bindingsOf = (p: ResolvablePreset): PromptBindings => ({
  neuronIds: p.neuron_ids ?? [],
  bookId: p.book_id ?? null,
  toolPermissions: p.tool_permissions ?? null,
});

/**
 * Narrow a permission map by a prompt's tool binding.
 *
 * ONE DIRECTION ONLY. A key the prompt marks false is turned off; a key it
 * marks true is left exactly as the user had it. A prompt that could flip a
 * permission ON would be a grant path around the app's consent gates, reachable
 * by anything that can write a preset row.
 */
export function narrowPermissions(
  userPermissions: Record<string, boolean>,
  binding: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  if (!binding) return userPermissions;
  const out = { ...userPermissions };
  for (const [tool, allowed] of Object.entries(binding)) {
    if (allowed === false) out[tool] = false;
  }
  return out;
}

export interface ResolveInput {
  presets: ResolvablePreset[];
  selection: TurnPromptSelection;
  /** "chat" or "voice" — a preset only rides in a lane its scope allows. */
  lane: "chat" | "voice";
  /** The body already inlined into the stable prompt (the `is_active` preset,
   *  or the legacy free-text). Used to decide whether an override adds
   *  anything at all. */
  inlinedBody: string;
}

export interface ResolvedPrompt {
  /** The extra system message to append, or "" when nothing should be added. */
  block: string;
  /** What actually rode — the receipt. */
  used: UsedPrompt;
  /** The context this prompt carries, or null when no prompt applied. Never
   *  inferred: a prompt that did not apply brings nothing with it. */
  bindings: PromptBindings | null;
}

const scopeAllows = (scope: PromptScope, lane: "chat" | "voice") =>
  scope === "both" || scope === lane;

/**
 * Decide what instruction layer rides this turn, and say why in words a person
 * can read. This is a PURE function: every branch is reachable from a unit test
 * and no branch can claim a prompt it did not return a block for.
 */
export function resolveTurnPrompt(input: ResolveInput): ResolvedPrompt {
  const { presets, selection: sel, lane, inlinedBody } = input;
  const inlined = (inlinedBody || "").trim();

  const none = (source: PromptSource, why: string): ResolvedPrompt => ({
    block: "",
    used: { id: null, name: null, source, why },
    // No prompt applied means no context came with it. Never inferred.
    bindings: null,
  });

  if (sel.mode === "plain") {
    return none(
      "manual",
      inlined
        ? "You set this conversation to Plain, but a saved prompt is still applied from Settings."
        : "You set this conversation to Plain — no prompt applied.",
    );
  }

  if (sel.mode === "pinned") {
    const p = presets.find((x) => x.id === sel.presetId);
    if (!p) return none("auto", "The pinned prompt no longer exists — using your saved default.");
    if (!scopeAllows(p.scope, lane)) {
      return none(
        "manual",
        `"${p.name}" is set to ${p.scope === "chat" ? "Chat only" : "Voice only"}, so it is not applied here.`,
      );
    }
    if (!p.body.trim()) return none("manual", `"${p.name}" has no instructions in it.`);
    if (p.body.trim() === inlined) {
      // Already in the stable prompt — adding it again would be duplicate bytes
      // AND a second cache entry for no behavioural gain.
      return { block: "", used: { id: p.id, name: p.name, source: "manual", why: `"${p.name}" is applied.` }, bindings: bindingsOf(p) };
    }
    return {
      block: renderTurnPromptBlock({ name: p.name, body: p.body, lane }),
      used: { id: p.id, name: p.name, source: "manual", why: `"${p.name}" is applied for this conversation.` },
      bindings: bindingsOf(p),
    };
  }

  // mode === "auto": the saved default is already inlined by the caller. Report
  // it honestly rather than re-injecting it.
  const active = presets.find((p) => p.is_active) || null;
  if (!active) {
    return none("none", inlined ? "Your saved custom instructions are applied." : "No prompt applied.");
  }
  if (!scopeAllows(active.scope, lane)) {
    return none(
      "default",
      `"${active.name}" is set to ${active.scope === "chat" ? "Chat only" : "Voice only"}, so it is not applied here.`,
    );
  }
  const activeBody = active.body.trim();
  if (!activeBody) return none("default", `"${active.name}" has no instructions in it.`);
  // The default is only NAMED when its words are demonstrably the ones the
  // caller inlined. Trusting that they match — they do on the current send
  // path — would make this receipt an assumption rather than an observation,
  // and an assumption is exactly what a receipt may not be.
  if (activeBody !== inlined) {
    return none("default", inlined ? "Your saved custom instructions are applied." : `"${active.name}" was not applied to this turn.`);
  }
  return {
    block: "",
    used: { id: active.id, name: active.name, source: "default", why: `"${active.name}" is applied (your default).` },
    bindings: bindingsOf(active),
  };
}

/**
 * The voice-brevity sentence, duplicated here on purpose.
 *
 * In the stable prompt the preset body sits ABOVE the voice sentence, so
 * brevity wins on recency. The switchable layer rides at the very end, which
 * inverts that — a chatty prompt would now be the last thing said before the
 * question and could talk over "1–3 sentences". Re-stating brevity after the
 * override restores the original precedence. Imported from the builder so the
 * two copies cannot drift.
 */
export function renderTurnPromptBlock(input: { name: string; body: string; lane: "chat" | "voice" }): string {
  const { name, body, lane } = input;
  const parts = [
    `## Active Instructions — "${name.trim() || "Untitled"}"`,
    body.trim(),
    "Where these conflict with the custom instructions above, follow these.",
  ];
  if (lane === "voice") parts.push(VOICE_BREVITY_SENTENCE);
  return parts.join("\n\n");
}

/** Kept in sync with buildChatSystemPrompt.ts's voice branch by
 *  `promptRouting.test.ts`, which asserts the builder still contains it. */
export const VOICE_BREVITY_SENTENCE =
  "You are speaking through a voice interface. Keep replies conversational and concise (usually 1–3 sentences) unless the user explicitly asks for depth. Avoid heavy markdown/lists when the answer will be read aloud.";

// ---------------------------------------------------------------------------
// The router
//
// Deliberately the same shape, and the same numbers, as the Smart Filing
// router that already decides which neuron a memory belongs in
// (supabase/functions/smart-file/index.ts). Those thresholds have been in
// production for months; inventing fresh ones for the same kind of decision
// would mean starting the tuning over for no reason, and a reader who knows
// one router would not recognise the other.
//
// It is a PURE function. Every input it needs is passed in — no clock, no
// storage, no network — so every branch below is reachable from a test, which
// is the only way a heuristic like this stays honest as it is tuned.
// ---------------------------------------------------------------------------

/** Above this, a prompt is a confident match for the turn. */
export const ROUTE_CONFIDENT = 0.78;
/** How far ahead the winner must be, both of the prompt already in force and
 *  of the runner-up. Without the second test, two near-identical prompts
 *  would trade the conversation back and forth on noise. */
export const ROUTE_MARGIN = 0.08;
/** Below this, nothing the user has written fits — evidence that a prompt is
 *  MISSING, which is what the incubator collects. */
export const ROUTE_NOVELTY = 0.55;
/** Anti-flap: a switch has to live for a few turns before another is allowed.
 *  A persona that changes every message is worse than one that is slightly
 *  wrong, because the user cannot learn what the assistant will do. */
export const ROUTE_MIN_TURNS_BETWEEN_SWITCHES = 3;
/** When the best retrieved memory scores above this, the turn is dominated by
 *  recall rather than by style. See the PRISM note on `plainOnRecall`. */
export const ROUTE_RECALL_STRONG = 0.7;

export interface RouteCandidate {
  id: string;
  name: string;
  similarity: number;
}

export interface RouteInput {
  /** Best first, as knowledge-retrieve returns them. */
  candidates: RouteCandidate[];
  /** The prompt in force right now, if any. */
  activeId: string | null;
  activeSimilarity: number | null;
  /** Best retrieved-memory similarity for this turn, or null when unknown. */
  topMemoryScore: number | null;
  /** User setting, default ON. */
  plainOnRecall: boolean;
  /** Turns since the last automatic switch. */
  turnsSinceSwitch: number;
}

export interface RouteDecision {
  action: "keep" | "switch" | "propose_new";
  /** The prompt to switch TO, when action is "switch". */
  promptId: string | null;
  promptName: string | null;
  /** Plain language, shown to the user verbatim. */
  why: string;
  /** Logged to prompt_routing_decisions so accuracy is measurable. */
  scores: { s_max: number; s_active: number; s_2nd: number; novelty: number };
}

/**
 * Pick the prompt for this turn — or, much more often, decline to.
 *
 * The bias is heavily toward KEEP. A router that switches eagerly feels
 * possessed rather than helpful, and every switch costs the user their sense
 * of what the assistant is currently being.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const { candidates, activeId, activeSimilarity, topMemoryScore, plainOnRecall, turnsSinceSwitch } = input;

  const s_max = candidates[0]?.similarity ?? 0;
  const s_2nd = candidates[1]?.similarity ?? 0;
  const s_active = activeSimilarity ?? 0;
  const novelty = 1 - s_max;
  const scores = { s_max, s_active, s_2nd, novelty };

  const keep = (why: string): RouteDecision => ({ action: "keep", promptId: null, promptName: null, why, scores });

  if (candidates.length === 0) return keep("No prompts are set up for routing.");

  const winner = candidates[0];

  // Nothing fits. Park the turn as evidence rather than forcing a bad match —
  // this is what eventually earns the assistant the right to propose a prompt.
  if (s_max < ROUTE_NOVELTY) {
    return {
      action: "propose_new",
      promptId: null,
      promptName: null,
      why: `Nothing you have saved fits this (best match ${pct(s_max)}).`,
      scores,
    };
  }

  // PRISM (arXiv 2603.18507): expert personas reliably improve alignment-style
  // tasks and reliably DAMAGE factual recall — 68.0% vs 71.6% on MMLU. When the
  // turn is mostly "what do I know about X", wearing a persona over the top of
  // the answer makes it worse, so the router stands down and says so.
  if (plainOnRecall && topMemoryScore !== null && topMemoryScore >= ROUTE_RECALL_STRONG && winner.id !== activeId) {
    return keep("This is mostly a recall question, so the voice was left alone — personas cost accuracy on those.");
  }

  if (s_active >= ROUTE_CONFIDENT) {
    return keep("The prompt already in force fits this well.");
  }

  if (winner.id === activeId) {
    return keep("The prompt already in force is still the best fit.");
  }

  if (s_max < ROUTE_CONFIDENT) {
    return keep(`No prompt fits this confidently enough to switch (best ${pct(s_max)}).`);
  }

  if (s_max - s_active < ROUTE_MARGIN) {
    return keep(`"${winner.name}" is not clearly better than what is already on.`);
  }

  if (s_max - s_2nd < ROUTE_MARGIN) {
    return keep(`"${winner.name}" and "${candidates[1]?.name}" fit about equally, so nothing was changed.`);
  }

  if (turnsSinceSwitch < ROUTE_MIN_TURNS_BETWEEN_SWITCHES) {
    return keep("The prompt changed very recently — waiting a few turns before changing it again.");
  }

  return {
    action: "switch",
    promptId: winner.id,
    promptName: winner.name,
    why: `Switched to "${winner.name}" — it matches this request ${pct(winner.similarity)} against ${pct(s_active)} for what was on.`,
    scores,
  };
}

const pct = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
