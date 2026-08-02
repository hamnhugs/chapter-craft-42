// Lean Mode — budget-aware capability tiers.
//
// WHY THREE STOPS AND NOT A SWITCH. The costs differ by orders of magnitude:
// a chat turn is fractions of a cent, an image is 4–13¢, a video is ~$0.96,
// a 3D splat is dollars. One switch that killed images along with video
// would throw away the cheap thing to stop the expensive one. Three stops
// map to how the money actually behaves.
//
// WHY THE NAME. Every mode of this kind that works — Low Power, Battery
// Saver, Low Data — names the resource being saved, never the user's
// situation. People live in these modes for months; a label that describes
// you rather than the setting becomes one you avoid looking at. The user's
// own words ("broke mode", "I can't afford images") are honoured as ALIASES
// at the entry point instead — warm where it's spoken, neutral in the
// furniture.
//
// ENFORCEMENT IS THE ROSTER, NOT THE PROMPT. Telling a model in prose not to
// use a tool gets roughly half compliance, and the failures are ugly: it
// narrates an image it never made ("tool bypass"). So blocked capabilities
// are REMOVED from the tool list — a capability the model cannot see is one
// it cannot pretend to use. The prompt block exists only so it can talk
// about the situation gracefully, and the executor keeps a terminal refusal
// as a backstop for tool calls replayed from earlier history.

export type LeanMode = "full" | "lean" | "chat_only";

export const LEAN_MODES: LeanMode[] = ["full", "lean", "chat_only"];

export interface LeanModeInfo {
  id: LeanMode;
  label: string;
  /** One line, plain language, no euphemism. */
  summary: string;
}

export const LEAN_MODE_INFO: Record<LeanMode, LeanModeInfo> = {
  full: {
    id: "full",
    label: "Full",
    summary: "Everything on. Images, video and 3D can be generated normally.",
  },
  lean: {
    id: "lean",
    label: "Lean",
    summary: "Video and 3D generation off — they cost dollars each. Images stay on.",
  },
  chat_only: {
    id: "chat_only",
    label: "Chat only",
    summary: "All generation off — no images, video or 3D — and web search stops too, free backend or not.",
  },
};

/** Tools removed from the model's roster at each tier.
 *
 *  Only GENERATION is ever blocked. Everything that shows, lists or recalls
 *  media the user already paid for stays available in every tier — a budget
 *  mode that hid your own library would be punishing you for being broke. */
const BLOCKED_AT: Record<LeanMode, string[]> = {
  full: [],
  lean: ["generate_video", "generate_splat"],
  chat_only: [
    "generate_video", "generate_splat",
    "generate_image", "edit_image",
    // Blocked at the user's explicit request. Note this stops search even
    // when the free Tavily backend is configured — the tier means "nothing
    // reaches out", not just "nothing bills", and the summary says so.
    "web_search",
  ],
};

/** Capability names for human-facing copy, keyed by tool name. */
const CAPABILITY_OF: Record<string, string> = {
  generate_image: "image generation",
  edit_image: "image editing",
  generate_video: "video generation",
  generate_splat: "3D model generation",
  web_search: "web search",
};

export function blockedTools(mode: LeanMode): string[] {
  return BLOCKED_AT[mode] ?? [];
}

export function isToolBlocked(mode: LeanMode, tool: string): boolean {
  return blockedTools(mode).includes(tool);
}

export function capabilityName(tool: string): string {
  return CAPABILITY_OF[tool] || tool.replace(/_/g, " ");
}

/** Terminal refusal for a blocked tool that still reached the executor —
 *  which happens when the model replays a call from earlier in the
 *  transcript, before the mode was switched on. The wording matters: the
 *  documented default is for models to retry a failed call 2–3 times, so
 *  this has to read as final rather than as a fixable input error. */
export function blockedToolResult(mode: LeanMode, tool: string) {
  const cap = capabilityName(tool);
  return {
    error: "lean_mode_blocked",
    capability: cap,
    retriable: false,
    message:
      `${cap} is switched off — the user turned on Lean Mode (${LEAN_MODE_INFO[mode].label}) ` +
      `because they don't want to spend money right now. This is final for this turn: do not retry, ` +
      `and do not substitute a different generation tool. Say so in one sentence and give the best ` +
      `free version of what they asked for instead.`,
  };
}

/** Aliases that turn the mode on when typed or spoken. The user's own words
 *  work; they just aren't what the interface calls it. */
export function leanModeFromPhrase(text: string): LeanMode | null {
  const s = text.toLowerCase();
  // "chat only" names the strictest tier outright — no money word needed.
  if (/\bchat[- ]only\b|\bonly chat\b/.test(s)) return "chat_only";
  // "broke" alone is the past tense of "break". In a novel-writing app "he
  // broke down crying" must never silently switch spending off, so the word
  // only counts when it's clearly about money or about a mode.
  if (!/\b(broke mode|i'?m broke|im broke|can'?t afford|cannot afford|no money|out of money|too expensive|lean mode|cheap mode)\b/.test(s)) {
    return null;
  }
  // Naming images as unaffordable means the middle tier isn't enough.
  if (/\bimages?\b|\bnothing\b/.test(s)) return "chat_only";
  return "lean";
}

/** The system-prompt block. Written to be spoken from, not read as policy:
 *  one sentence of fact, then the model's real job — deliver the best free
 *  version rather than apologising. */
export function leanModePromptBlock(mode: LeanMode): string {
  if (mode === "full") return "";
  const blocked = blockedTools(mode).map(capabilityName);
  const unique = Array.from(new Set(blocked));
  const list = unique.length > 1
    ? `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`
    : unique[0];
  return [
    `## Lean Mode is ON (${LEAN_MODE_INFO[mode].label})`,
    `The user has switched on Lean Mode: ${list} ${unique.length > 1 ? "are" : "is"} off for now. ` +
    `Those tools are NOT in your list this turn. Nothing is broken and no key is missing — the user ` +
    `deliberately turned spending off, and only they can turn it back on.`,
    ``,
    `Everything free is untouched: memory and neurons, books, artifacts, structured blocks, and ` +
    `re-displaying anything already made (show_image, show_video, show_splat, list_images, ` +
    `list_videos, list_splats, view_image, recall_image_memories). They already paid for those — ` +
    `show them freely.`,
    ``,
    `When the user asks for something Lean Mode covers, answer in ONE message, in this order:`,
    `1. Say it plainly in a single sentence — "Image generation is off while Lean Mode is on." ` +
    `No apology, no comment about their money, and don't mention it again later in the turn.`,
    `2. Then actually deliver the best free version. For anything visual, reach for ` +
    `create_blueprint_sheet FIRST — it draws a real production sheet (turnaround, palette swatches, ` +
    `head-unit scale, construction notes) entirely on this machine, and it is genuinely useful work ` +
    `rather than a description of work. Otherwise: write out the finished image prompt so it's ready ` +
    `to run later, describe the shot concretely, draft it with create_artifact as SVG or HTML, or ` +
    `find something already in their library that fits. Give it as a real answer, not a consolation ` +
    `prize — a Lean Mode reply must never be thinner than a normal one.`,
    ``,
    `Never say or imply you generated an image, video or 3D model while Lean Mode is on, and never ` +
    `write a markdown image link to stand in for one — the app renders real media itself, so a ` +
    `hand-written link is a broken image. If a tool result says lean_mode_blocked, that is final: ` +
    `tell the user and move on.`,
  ].join("\n");
}
