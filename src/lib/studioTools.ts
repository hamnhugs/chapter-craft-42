// The production-studio tool pack: video, 3D, master assets, blueprint
// sheets, stage plans, scenes and the production ledger.
//
// WHY A PACK. These 20 tools and their prompt guidance are ~10k tokens —
// about 45% of the fixed payload every chat request carries, re-sent on
// every tool round — for work most reading conversations never touch. The
// tool-selection literature puts the accuracy knee at ~30 always-visible
// tools; the full roster is 69.
//
// WHY STICKY, NOT PER-QUERY. Adaptive per-query shortlisting measurably LOST
// to a fixed roster (arXiv:2605.24660, 71.7% vs 73.3%): when the ranker
// misses, the tool is simply absent. And a roster that flips turn to turn
// invalidates every provider prompt cache from the tools onward. So the pack
// turns on for the conversation once there is evidence of studio work — the
// user asks for it, or studio media already sits in the loaded transcript —
// and stays on (12h) rather than following each message.

export const STUDIO_TOOLS: ReadonlySet<string> = new Set([
  "generate_video", "show_video", "list_videos", "delete_video",
  "generate_splat", "show_splat", "list_splats", "delete_splat", "render_splat_views",
  "lock_master_asset", "list_master_assets", "delete_master_asset",
  "create_blueprint_sheet", "create_stage_plan",
  "list_scenes", "lock_scene", "delete_scene",
  "accept_generation", "reject_generation", "get_production_stats",
]);

/** Tools whose only output is visual — a voice reply cannot show them. */
export const VISUAL_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "render_blocks", "create_artifact", "create_blueprint_sheet", "create_stage_plan",
]);

export type StudioToolsMode = "auto" | "always" | "off";

/** Words that only mean studio work. Deliberately excludes "scene", "clip"
 *  and "motion", which reading conversations use all the time. */
const STUDIO_INTENT_RE =
  /\b(videos?|animat(e|ed|es|ing|ion|ions)|3-?d|splats?|turntable|blueprints?|stage plans?|shot lists?|storyboards?|master assets?|character sheets?|turnarounds?|production ledger)\b/i;

export function mentionsStudioWork(text: string | undefined): boolean {
  return !!text && STUDIO_INTENT_RE.test(text);
}

interface HistoryLike {
  videos?: unknown[];
  splats?: unknown[];
  toolEvents?: Array<{ name: string }>;
}

export function historyHasStudioWork(history: readonly HistoryLike[]): boolean {
  return history.some((m) =>
    (m.videos?.length ?? 0) > 0 ||
    (m.splats?.length ?? 0) > 0 ||
    (m.toolEvents ?? []).some((e) => STUDIO_TOOLS.has(e.name)));
}

export const STUDIO_STICKY_MS = 12 * 60 * 60 * 1000;
const stickyKey = (uid: string | null) => `cc_studio_sticky_${uid ?? "anon"}`;

function readSticky(uid: string | null, now: number): boolean {
  try {
    const until = Number(localStorage.getItem(stickyKey(uid)) || 0);
    return until > now;
  } catch {
    return false;
  }
}

function writeSticky(uid: string | null, now: number): void {
  try { localStorage.setItem(stickyKey(uid), String(now + STUDIO_STICKY_MS)); } catch { /* private mode */ }
}

/** Whether the studio pack rides on this turn. `latestUserText` is undefined
 *  for the prospective status chip, which cannot know the next message. */
export function studioToolsActive(input: {
  mode: StudioToolsMode | undefined;
  userId: string | null;
  history: readonly HistoryLike[];
  latestUserText?: string;
  now?: number;
}): boolean {
  const mode = input.mode ?? "auto";
  if (mode === "always") return true;
  if (mode === "off") return false;
  const now = input.now ?? Date.now();
  if (mentionsStudioWork(input.latestUserText) || historyHasStudioWork(input.history)) {
    if (input.latestUserText !== undefined) writeSticky(input.userId, now);
    return true;
  }
  return readSticky(input.userId, now);
}
