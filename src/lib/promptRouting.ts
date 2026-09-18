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

/** The minimum a preset must expose for this module to resolve it. */
export interface ResolvablePreset {
  id: string;
  name: string;
  body: string;
  scope: PromptScope;
  is_active: boolean;
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
      return { block: "", used: { id: p.id, name: p.name, source: "manual", why: `"${p.name}" is applied.` } };
    }
    return {
      block: renderTurnPromptBlock({ name: p.name, body: p.body, lane }),
      used: { id: p.id, name: p.name, source: "manual", why: `"${p.name}" is applied for this conversation.` },
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
  return { block: "", used: { id: active.id, name: active.name, source: "default", why: `"${active.name}" is applied (your default).` } };
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
