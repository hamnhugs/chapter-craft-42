// Pure helpers for what the chat pipeline sends as conversation history.
// Kept out of ChatContext so they can be unit-tested without the app.

import type { ToolEvent } from "@/lib/chatTools";
import { GEMINI_PREFIX, NVIDIA_PREFIX } from "@/lib/providers/registry";

/** Bubbles the APP wrote into the assistant's slot — error cards and empty-reply
 *  placeholders. Sent back as history, the model reads provider error text as
 *  its own earlier words (and pays for it every turn). */
const APP_AUTHORED_REPLY = /^(❌|\(No response received\)|\(The model spent its whole reply thinking)/;

export function isModelVisibleMessage(m: { role: string; content?: unknown }): boolean {
  if (m.role !== "assistant") return true;
  return !(typeof m.content === "string" && APP_AUTHORED_REPLY.test(m.content.trim()));
}

/** A compact, app-authored trace of which tools a past reply used. Tool
 *  RESULTS are never replayed across turns (cost, and they are untrusted
 *  text), so without this a follow-up cannot tell what was already read and
 *  re-runs the same lookups — each round re-sending the whole prompt. Only
 *  registry tool names and success flags: no arguments, no result text. */
export function toolTraceNote(events: ToolEvent[] | undefined): string {
  if (!events || events.length === 0) return "";
  const seen = new Map<string, boolean>();
  for (const e of events) {
    if (!/^[a-z][a-z0-9_]*$/.test(e.name)) continue;
    seen.set(e.name, (seen.get(e.name) ?? false) || e.ok);
  }
  if (seen.size === 0) return "";
  const list = [...seen].slice(0, 12).map(([name, ok]) => (ok ? name : `${name} (failed)`));
  return `[App note — tools used for this reply: ${list.join(", ")}]`;
}

/** Append the turn's app-added context to the LAST user message of a history
 *  array, leaving every other message byte-identical. Handles the image-turn
 *  part-array shape by adding one trailing text part. */
export function attachTurnContext(history: any[], suffix: string): any[] {
  if (!suffix) return history;
  let i = history.length - 1;
  while (i >= 0 && history[i]?.role !== "user") i--;
  if (i < 0) return history;
  const m = history[i];
  const out = history.slice();
  if (typeof m.content === "string") {
    out[i] = { ...m, content: m.content + suffix };
  } else if (Array.isArray(m.content)) {
    out[i] = { ...m, content: [...m.content, { type: "text", text: suffix }] };
  } else {
    return history;
  }
  return out;
}

/** Cheap default models for background text jobs, per provider. NVIDIA's
 *  hosted models carry no per-token price, so it keeps the chat model. */
const UTILITY_DEFAULTS: Record<string, string> = {
  openrouter: "google/gemini-2.5-flash-lite",
  gemini: `${GEMINI_PREFIX}gemini-2.5-flash-lite`,
};

/** The model for background text jobs (the rolling summary): the user's
 *  explicit choice, else a cheap sibling on the SAME provider — so it needs no
 *  extra key — else the chat model. A free-tier OpenRouter model stays put: a
 *  cheap model still costs more than a free one. */
export function resolveUtilityModel(explicit: string | undefined, chatModel: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (!chatModel) return chatModel;
  if (chatModel.startsWith(NVIDIA_PREFIX)) return chatModel;
  if (/:free$/i.test(chatModel)) return chatModel;
  const provider = chatModel.startsWith(GEMINI_PREFIX) ? "gemini" : "openrouter";
  return UTILITY_DEFAULTS[provider] ?? chatModel;
}

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "24k in (18k cached) · 512 out · $0.0031" — whatever the provider reported. */
export function formatUsage(u: import("@/lib/providers/types").TokenUsage): string {
  const bits: string[] = [];
  if (u.inputTokens !== undefined) {
    bits.push(`${compact(u.inputTokens)} in${u.cachedTokens ? ` (${compact(u.cachedTokens)} cached)` : ""}`);
  }
  if (u.outputTokens !== undefined) bits.push(`${compact(u.outputTokens)} out`);
  if (u.costUsd !== undefined) bits.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(3)}`);
  return bits.join(" · ");
}
