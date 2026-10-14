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

/** The image handle a past ASSISTANT reply carries into history. Users'
 *  uploads keep the "[Attached image …]" note; a reply's own pictures don't,
 *  because a small local model reads a reply ending in that note as the way
 *  pictures are made and starts writing the note instead of calling a tool
 *  (seen 2026-10-13: three turns of invented image_ids, no tool calls). This
 *  shape says the picture came from a tool call. */
export function assistantImageNote(images: { id: string; prompt?: string }[] | undefined): string {
  if (!images || images.length === 0) return "";
  const list = images.map((im) => `image_id: ${im.id}${im.prompt ? ` ("${im.prompt.slice(0, 80)}")` : ""}`);
  return `[App note — picture(s) a tool call made and the app displayed with this reply: ${list.join("; ")}]`;
}

const IMAGE_TOOLS = new Set(["generate_image", "edit_image", "show_image"]);

/** What a past reply's pictures need to be replayed as a real tool call. */
export interface ImageReplay {
  tool: "generate_image" | "edit_image" | "show_image";
  images: { id: string; prompt?: string }[];
  /** The reply's content without the image note (the tool result carries the ids). */
  content: string;
}

/** The replay record for an assistant reply whose pictures came from an image
 *  tool, or null (no pictures, or Memory Lens attached them without a call). */
export function imageReplayFor(
  m: { role: string; images?: { id: string; prompt?: string; lens_auto?: boolean }[]; toolEvents?: ToolEvent[] },
  content: string,
): ImageReplay | null {
  if (m.role !== "assistant" || !m.images?.length) return null;
  const tool = m.toolEvents?.find((e) => e.ok && IMAGE_TOOLS.has(e.name))?.name as ImageReplay["tool"] | undefined;
  const images = m.images.filter((im) => !im.lens_auto).map((im) => ({ id: im.id, prompt: im.prompt }));
  if (!tool || images.length === 0) return null;
  return { tool, images, content };
}

/** For local models: each past reply that made or showed pictures goes back
 *  as the tool call that did it, its result, then the reply. Fed a text-only
 *  history, a 4B model copies the earlier reply's shape and writes a fake
 *  image note instead of calling the tool — 5 of 6 times on the second image
 *  request; replayed as calls, 0 of 6 (eval 2026-10-13, Qwen3-4B Q6_K). Other
 *  providers keep the text note, and the replay field is always removed. */
export function expandImageTurns(history: any[], replay: boolean): any[] {
  const out: any[] = [];
  let lastImageId: string | undefined;
  let lastUserText = "";
  history.forEach((m, i) => {
    const r: ImageReplay | undefined = m?.__imageReplay;
    if (m?.role === "user") lastUserText = typeof m.content === "string" ? m.content : (m.content || []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
    if (m?.__imageIds) {
      const { __imageIds: ids, ...rest } = m;
      lastImageId = ids[ids.length - 1] ?? lastImageId;
      out.push(rest);
      return;
    }
    if (!r) { out.push(m); return; }
    const { __imageReplay: _drop, ...plain } = m;
    if (!replay) { out.push(plain); lastImageId = r.images[r.images.length - 1].id; return; }
    const first = r.images[0];
    const prompts = r.images.map((im) => im.prompt || "");
    const args =
      r.tool === "show_image" ? { image_id: first.id }
      : r.tool === "edit_image" ? { ...(lastImageId ? { image_id: lastImageId } : {}), instruction: lastUserText.slice(0, 300) }
      : new Set(prompts).size > 1 ? { prompts }
      : { prompt: prompts[0], ...(r.images.length > 1 ? { count: r.images.length } : {}) };
    const id = `replay_${i}`;
    const result = r.images.length === 1
      ? { image_id: first.id, ...(first.prompt ? { prompt: first.prompt.slice(0, 80) } : {}), shown_to_user: true }
      : { images: r.images.map((im) => ({ image_id: im.id, ...(im.prompt ? { prompt: im.prompt.slice(0, 80) } : {}) })), shown_to_user: true };
    out.push(
      { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: r.tool, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, name: r.tool, content: JSON.stringify(result) },
      { ...plain, content: r.content },
    );
    lastImageId = r.images[r.images.length - 1].id;
  });
  return out;
}

// Notes only the app writes. In a reply they are always fabricated, and an
// image one means the model believes it showed a picture that doesn't exist.
const APP_NOTE_RE = /\[\s*(?:attached[\s\-_]*image|app[\s\-_]*note)\b[^\]\n]*\]?/gi;
const IMAGE_CLAIM_RE = /attached[\s\-_]*image|image_id|picture/i;

/** Remove app-style notes the model wrote into its own reply. `claimsImage`
 *  is true when one of them pretended to attach or display a picture. */
export function stripFabricatedNotes(text: string): { text: string; found: boolean; claimsImage: boolean } {
  let claimsImage = false;
  let found = false;
  const cleaned = text.replace(APP_NOTE_RE, (m) => {
    found = true;
    if (IMAGE_CLAIM_RE.test(m)) claimsImage = true;
    return "";
  });
  if (!found) return { text, found, claimsImage };
  return { text: cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), found, claimsImage };
}

/** Sent after a reply that wrote an image note instead of calling a tool.
 *  Names only tools this turn offers. */
export function fabricatedImageNote(offered: Set<string>): string {
  const make = ["generate_image", "edit_image"].filter((n) => offered.has(n));
  const steps = [
    make.length ? `to make or change a picture, call ${make.join(" or ")}` : "",
    offered.has("show_image") ? "to show a stored picture again, call show_image with its image_id" : "",
  ].filter(Boolean);
  return (
    "[App note — no picture was made or shown: the last reply wrote an image note as text, and only the app writes those. Nothing appeared in the chat. " +
    (steps.length ? `Now ${steps.join("; ")}.` : "Tell the user plainly that no picture was made.") +
    " Don't write image notes or image ids as if they were pictures.]"
  );
}

// --- "Done!" with nothing done, in DesignCraft --------------------------------
// The commonest failure the user reported: asked to change the page, the model
// replied as if it had ("The headline is now red", "Let me add one:") and no
// craft call ran, so the document never changed. Small models do it most
// (Qwen3-4B: "**Headline:** …" then stop, 2026-10-13/14). Same shape as the
// fabricated-image check: detect it, tell the model once, let it act.

const DESIGN_REQUEST_RE = /\[Selected in DesignCraft|designcraft|\b(flyer|poster|cover|headline|subhead|footer|caption|template|layout|font|colou?r|bigger|smaller|page|look)\b/i;
const DONE_RE = /\b(i'?ve|i have|has been|have been|is now|are now|now (?:has|have|shows?|features?|looks?|reads?|says?|is|uses?)|(?:updated|changed|made|added|moved|set|applied|placed|replaced|resized|recolou?red|turned|removed|deleted|swapped|centred|centered|aligned|enlarged|shrunk|bolded)\b)/i;
const INTENT_RE = /\b(let me|i'?ll|i will|i'?m going to|going to)\b/i;
// The request asks for a change to the page, not for ideas or an opinion.
const EDIT_REQUEST_RE = /\b(make|change|add|put|place|insert|move|remove|delete|replace|use|turn|set|resize|apply|swap|align|cent(?:er|re)|recolou?r|bold|bigger|smaller|larger|shrink|enlarge|try|redesign|restyle|fix|open|create|save|write)\b/i;
const ADVICE_RE = /\b(ideas?|suggest(?:ions?)?|options|what do you think|should i|which (?:one|is better)|opinion)\b/i;

/** True when `reply` says the page was changed (or is about to be), or is
 *  empty, though no craft call ran this turn, for a request to change a
 *  DesignCraft page. A reply that only asks the user something doesn't
 *  count — asking is allowed. */
export function claimsUnmadeDesignEdit(reply: string, request: string, designContext = false): boolean {
  const r = String(reply || "").trim();
  const q = String(request || "");
  if (!(designContext || DESIGN_REQUEST_RE.test(q))) return false;
  if (!EDIT_REQUEST_RE.test(q.replace(/\[Selected in DesignCraft[^\]]*\]/, "")) || ADVICE_RE.test(q)) return false;
  // No reply at all to an edit request is the same failure (Qwen3-4B ended
  // "save this design as a template" with nothing, 2026-10-14).
  if (!r) return true;
  const claims = DONE_RE.test(r) || INTENT_RE.test(r);
  if (!claims) return false;
  // "Which part do you mean — the headline or the footer?" is a question, not a claim.
  const lastLine = r.split("\n").filter((l) => l.trim()).pop() || "";
  if (/\?\s*$/.test(lastLine) && !DONE_RE.test(r)) return false;
  return true;
}

/** Sent once after such a reply. `ids`: what the user selected, if anything. */
export function unmadeDesignEditNote(ids: number[] = []): string {
  return (
    "[App note — nothing changed in DesignCraft: no craft call ran this turn, so the user's page is exactly as it was, whatever the last reply said. " +
    `Make the change now by calling the craft tool${ids.length ? ` — the user selected ids [${ids.join(", ")}]: action "send", app "designcraft", ids [${ids.join(", ")}] with text, image_id or options` : ` (action "send", app "designcraft", with the part's role, or a look)`}. ` +
    "Call it first; describe the result after it returns.]"
  );
}

/** Whether a message's tool events touched DesignCraft. */
export function touchedDesignCraft(events: { name?: string; summary?: string }[] | undefined): boolean {
  return (events || []).some((ev) => ev?.name === "craft" && /DesignCraft|template/i.test(String(ev.summary || "")));
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
