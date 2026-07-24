import { supabase } from "@/integrations/supabase/client";
import { BookDocument, Chapter } from "@/types/library";
import { parseBlocksVerbose } from "@/lib/responseBlocks";
import { parseArtifact } from "@/lib/artifacts";
import {
  generateImage, storeGeneratedImage, saveImageNeuron,
  fetchImageById, searchImages, loadImageAsDataUrl,
  deleteImageAttachment, deleteImageMemory,
  IMAGE_ASPECT_RATIOS, type ChatImageRef,
} from "@/lib/imageGen";
import {
  submitVideo, insertPendingVideo, fetchVideoById, searchVideos,
  deleteVideoGeneration, DEFAULT_VIDEO_MODEL, type ChatVideoRef,
  videoIdentityMigrated, resolveVideoSourceImages, buildPassthrough,
  getSignedVideoUrl,
} from "@/lib/videoGen";
import {
  fetchVideoModels, estimateClipCostUSD, isTokenPriced, formatUSD,
  supportsFrameImage, supportsReferenceImages, maxReferenceImages,
  referenceCapableModelIds, type VideoModel,
} from "@/lib/videoCatalog";
import {
  submitMotionTransfer, submitReferenceDraft, estimateFalVideoCostUSD,
  getFalVideoModel, DEFAULT_MOTION_MODEL, DRAFT_RESOLUTIONS, hasInFlightFalVideo,
} from "@/lib/falVideoGen";
import {
  mastersMigrated, resolveMaster, listMasterAssets, createMasterAsset,
  updateMasterAsset, deleteMasterAsset, masterNegatives,
  type MasterAssetRow,
} from "@/lib/masterAssets";
import { renderSplatViews } from "@/lib/splatViews";

/** Best-effort reverse lookup: which master(s) reference these images/splats.
 *  Returns empty maps when the master_assets migration isn't applied — the
 *  list tools must keep working without it. */
async function masterLinkageFor(): Promise<{
  byImage: Map<string, string>;
  bySplat: Map<string, string>;
}> {
  const byImage = new Map<string, string>();
  const bySplat = new Map<string, string>();
  try {
    if (!(await mastersMigrated())) return { byImage, bySplat };
    for (const m of await listMasterAssets()) {
      const label = `@${m.name}`;
      if (m.hero_image_id && !byImage.has(m.hero_image_id)) byImage.set(m.hero_image_id, `${label} (hero)`);
      for (const v of m.view_image_ids || []) {
        if (v && !byImage.has(v)) byImage.set(v, `${label} (view)`);
      }
      if (m.splat_id && !bySplat.has(m.splat_id)) bySplat.set(m.splat_id, label);
    }
  } catch { /* advisory linkage only */ }
  return { byImage, bySplat };
}
import {
  submitSplat, insertPendingSplat, fetchSplatById, searchSplats,
  deleteSplatGeneration, resolveSourceImageUrl, hasInFlightSplat,
  countSplatsThisMonth, tierToSubmitParams, DEFAULT_SPLAT_MODEL, type ChatSplatRef,
} from "@/lib/splatGen";
import {
  getTier, getSplatModel, estimateSplatCostUSD, tierSizeLabel,
  FALLBACK_SPLAT_MODEL, type QualityTier,
} from "@/lib/splatCatalog";
import { fetchChains, touchChainUsed, emitChainsChanged, isChainsMigrationMissing, CHAINS_MIGRATION_MESSAGE } from "@/lib/chainsApi";
import { sessionActiveWikiIds } from "@/lib/wikisApi";
import { MAX_ACTIVE_NEURONS, FREE_NEURON_LIMIT } from "@/lib/neuronAccess";
import { OPEN_ACCESS } from "@/lib/openAccess";

export interface ToolDeps {
  books: BookDocument[];
  activeBookId: string | null;
  setActiveBookId: (id: string) => void;
  addChapter: (bookId: string, chapter: Chapter) => Promise<void>;
  updateChapter: (bookId: string, chapterId: string, name: string) => Promise<void> | void;
  removeChapter: (bookId: string, chapterId: string) => Promise<void> | void;
  burplexityApiToken?: string;
  /** OpenRouter key — needed by the image generation tools. */
  openRouterApiKey?: string;
  /** Paid plan flag — image generation/editing are Pro features. */
  isPaid?: boolean;
  /** Optional user-preferred image model overrides. */
  imageModelPrimary?: string;
  imageModelFallback?: string;
  /** Optional user-preferred video model + generation defaults. */
  videoModelPrimary?: string;
  videoDefaultDuration?: number;
  videoDefaultResolution?: string;
  videoDefaultAspect?: string;
  videoGenerateAudio?: boolean;
  /** Estimated-cost (USD) above which generate_video must be confirmed. */
  videoConfirmThreshold?: number;
  /** Default identity-pinning strength (0-1) for image-conditioned video. */
  videoIdentityScale?: number;
  /** Run the client-side consistency scorer on identity-conditioned clips. */
  videoQcEnabled?: boolean;
  /** Preferred fal motion-transfer endpoint for motion_plate clips. */
  videoMotionModel?: string;
  /** fal.ai key — 3D splat generation bills to this, NOT the OpenRouter key. */
  falApiKey?: string;
  splatModelPrimary?: string;
  splatDefaultQuality?: string;
  splatMaxFileMb?: number;
  splatConfirmThreshold?: number;
  splatMonthlyQuota?: number;
  /** Retry a rejected splat once on the cheaper fallback model. */
  splatAutoFallback?: boolean;
}


/** Tool results may carry side-channel fields for the chat UI. They are
 *  stripped before the result is sent back to the model:
 *  - `__images`: ChatImageRef[] to render inline in the assistant's bubble.
 *  - `__vision`: data-URL image to inject as vision input next iteration. */
export interface ToolSideChannel {
  __images?: ChatImageRef[];
  __videos?: ChatVideoRef[];
  __splats?: ChatSplatRef[];
  __vision?: string;
}

export const BURPLEXITY_BOT_ASK_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-ask";
const BURPLEXITY_QUICK_SEARCH_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-search-quick";

// Burplexity's response shape has varied over time. Accept several common
// field names so a backend rename doesn't silently zero out the source list
// (the "0 source(s)" symptom). `citations` is still tried first for back-compat.
// True when a search-backend response looks rate-limited (HTTP 429, or a 5xx
// whose body mentions a 429/rate-limit — e.g. bot-ask wraps an upstream
// OpenRouter 429 in its own 500). Lets us show a calm "try again" message
// instead of a scary raw error.
export function isSearchRateLimited(status: number, message?: string): boolean {
  if (status === 429) return true;
  return /\b429\b|rate.?limit|temporarily|too many requests/i.test(message || "");
}

const RATE_LIMIT_MESSAGE = "The web search service is busy (rate-limited). Please try again in a moment.";

// Resolve the AI's neuron scope for this user: which wiki is active (primary),
// the full LOADED SET (active_wiki_ids — the multi-neuron feature), and
// whether the paid "Access all neurons" setting widens search/conflict tools
// to every wiki. (Locked-neuron content is additionally blocked by RLS, so
// even an unscoped query can never surface it for free accounts.)
// active_wiki_ids is read in its own error-tolerant query: a combined select
// would 400 — taking active_wiki_id down with it — until the neuron-chains
// migration is applied.
async function getNeuronScope(): Promise<{ activeWikiId: string | null; activeWikiIds: string[]; allNeurons: boolean }> {
  const [{ data: settings }, { data: sub }] = await Promise.all([
    supabase.from("user_settings").select("active_wiki_id, access_all_neurons" as any).maybeSingle(),
    supabase.from("subscribers" as any).select("subscribed").maybeSingle(),
  ]);
  const activeWikiId = (settings as any)?.active_wiki_id || null;
  let set: string[] = [];
  {
    const { data, error } = await supabase.from("user_settings").select("active_wiki_ids" as any).maybeSingle();
    if (!error) {
      set = (((data as any)?.active_wiki_ids as string[]) || []).filter(Boolean);
    } else {
      // Column missing (migration not applied): honor this session's
      // multi-load so the tools' scope matches what the prompt promises.
      set = sessionActiveWikiIds.current.slice();
    }
  }
  if (activeWikiId && !set.includes(activeWikiId)) set = [activeWikiId, ...set];
  return {
    activeWikiId,
    activeWikiIds: set,
    allNeurons: !!(settings as any)?.access_all_neurons && !!(sub as any)?.subscribed,
  };
}

// Persist a new loaded neuron set (ids[0] = primary). Retries without the
// active_wiki_ids column while the neuron-chains migration is missing, so
// the primary still switches (multi-load degrades to primary-only).
async function persistActiveSet(uid: string, ids: string[]): Promise<{ degraded: boolean }> {
  await supabase.from("wikis" as any).update({ last_loaded_at: new Date().toISOString() } as any).in("id", ids);
  const payload: Record<string, unknown> = { user_id: uid, active_wiki_id: ids[0] ?? null, active_wiki_ids: ids };
  let { error } = await supabase.from("user_settings").upsert(payload as any, { onConflict: "user_id" });
  let degraded = false;
  if (error && /active_wiki_ids/i.test(error.message || "")) {
    degraded = true;
    delete payload.active_wiki_ids;
    ({ error } = await supabase.from("user_settings").upsert(payload as any, { onConflict: "user_id" }));
  }
  if (error) throw error;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wiki-active-changed"));
  return { degraded };
}

// Free plan: only the OLDEST neuron is unlocked (mirrors accessible_wiki_ids()
// and the ⌘K/BRAIN gates); admins bypass. Returns an error string when the
// requested ids aren't allowed, else null.
async function checkNeuronPlanGate(ids: string[]): Promise<string | null> {
  if (OPEN_ACCESS) return null; // paywall retired — mirror computeLockedWikiIds
  const { data: isAdminData } = await supabase.rpc("is_admin" as any);
  if (isAdminData) return null;
  const { data: sub } = await supabase.from("subscribers" as any).select("subscribed, plan").maybeSingle();
  const paid = !!(sub as any)?.subscribed && (sub as any)?.plan !== "free";
  if (paid) return null;
  const { data: oldest } = await supabase
    .from("wikis" as any)
    .select("id")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  const oldestId = (oldest as any)?.id || null;
  if (ids.length > 1 || (ids[0] && ids[0] !== oldestId)) {
    return "Loading multiple neurons (and any neuron other than the oldest) requires Pro. Tell the user that upgrading to Pro or Lifetime unlocks all of their neurons and neuron chains.";
  }
  return null;
}

export function pickCitations(j: any): Array<{ title: string; url: string; snippet: string }> {
  const raw = j?.citations ?? j?.sources ?? j?.results ?? j?.references ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: any) => ({
      title: String(c?.title ?? c?.name ?? c?.url ?? c?.link ?? "Source"),
      url: String(c?.url ?? c?.link ?? c?.href ?? c?.source ?? ""),
      snippet: String(c?.snippet ?? c?.text ?? c?.description ?? c?.content ?? "").slice(0, 240),
    }))
    .filter((c) => c.url);
}

export const CHAT_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_books",
      description: "List every book in the user's library with id, title, page count and chapter count.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_book",
      description: "Get a single book with all its chapters and page ranges.",
      parameters: {
        type: "object",
        properties: { book_id: { type: "string", description: "Book id." } },
        required: ["book_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_chapter_text",
      description: "Fetch the extracted text for a chapter. Use when you need to quote or analyse exact wording.",
      parameters: {
        type: "object",
        properties: {
          chapter_id: { type: "string" },
          max_chars: { type: "number", description: "Optional cap on returned characters (default 8000)." },
        },
        required: ["chapter_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_active_book",
      description: "Switch the user's active/focused book so future context includes its chapters.",
      parameters: {
        type: "object",
        properties: { book_id: { type: "string" } },
        required: ["book_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_wiki",
      description: "Keyword search the user's knowledge wiki (title + content). Returns up to `limit` entries.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Default 10." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Live web search via the user's Burplexity instance. Use this whenever the user asks to search the internet, look something up online, or wants current/time-sensitive info. Returns a synthesized answer plus citation URLs. Prefer this over search_wiki for anything not stored locally.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_conflicts",
      description:
        "List knowledge wiki contradictions (conflicts) flagged by the system. Use when the user asks to review, go over, or resolve contradictions/conflicts in their wiki. Each item includes both conflicting entries (a and b) with title + snippet so you can present them.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "acknowledged", "resolved", "dismissed"], description: "Default 'open'." },
          limit: { type: "number", description: "Default 10, max 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_conflict",
      description: "Fetch full text of both entries in a specific conflict plus the AI's rationale. Use before proposing a resolution if list_conflicts snippets aren't enough.",
      parameters: {
        type: "object",
        properties: { conflict_id: { type: "string" } },
        required: ["conflict_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_conflict",
      description:
        "Resolve a wiki conflict. NEVER call with a destructive action (keep_a_delete_b, keep_b_delete_a, merge, edit_a, edit_b) until the user has explicitly approved that exact action for that exact conflict in the current turn. 'acknowledge' and 'dismiss' may be applied after a clear yes.",
      parameters: {
        type: "object",
        properties: {
          conflict_id: { type: "string" },
          action: {
            type: "string",
            enum: ["keep_a_delete_b", "keep_b_delete_a", "merge", "edit_a", "edit_b", "acknowledge", "dismiss"],
          },
          merged_title: { type: "string", description: "Required when action='merge'. Written into entry A; entry B is deleted." },
          merged_content: { type: "string", description: "Required when action='merge'." },
          merged_tags: { type: "array", items: { type: "string" } },
          new_title: { type: "string", description: "Used with edit_a/edit_b." },
          new_content: { type: "string", description: "Used with edit_a/edit_b." },
          new_tags: { type: "array", items: { type: "string" } },
        },
        required: ["conflict_id", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_conflict_status",
      description: "Set a conflict's status directly (acknowledge or dismiss it) without editing entries.",
      parameters: {
        type: "object",
        properties: {
          conflict_id: { type: "string" },
          status: { type: "string", enum: ["open", "acknowledged", "resolved", "dismissed"] },
        },
        required: ["conflict_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "isolate_chapter",
      description:
        "Create a new chapter in a book by specifying its page range. The chapter text is empty unless extracted separately.",
      parameters: {
        type: "object",
        properties: {
          book_id: { type: "string" },
          name: { type: "string" },
          start_page: { type: "number" },
          end_page: { type: "number" },
          text_content: { type: "string", description: "Optional chapter text content." },
        },
        required: ["book_id", "name", "start_page", "end_page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_chapter",
      description: "Rename a chapter.",
      parameters: {
        type: "object",
        properties: { chapter_id: { type: "string" }, book_id: { type: "string" }, name: { type: "string" } },
        required: ["chapter_id", "book_id", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_chapter",
      description: "Delete a chapter from a book.",
      parameters: {
        type: "object",
        properties: { chapter_id: { type: "string" }, book_id: { type: "string" } },
        required: ["chapter_id", "book_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_wikis",
      description: "List all of the user's knowledge wikis with id, name, description, default/meta flags, and current entry count. Use when the user asks 'what wikis do I have' or before switching.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_wiki",
      description: "Return the currently active wiki (the one new knowledge gets saved to and searches are biased toward).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "switch_wiki",
      description: "Switch the active wiki by id. Future ingest / search / conflict scope follows the new active wiki. Use after the user explicitly asks to switch.",
      parameters: {
        type: "object",
        properties: { wiki_id: { type: "string" } },
        required: ["wiki_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_wiki",
      description: "Create a new wiki. Optionally make it the active wiki immediately.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          activate: { type: "boolean", description: "If true, set this as active after creation. Default true." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_active_neurons",
      description:
        "Replace the LOADED neuron set with 1–5 wikis (use ids from list_wikis). The FIRST id becomes the primary neuron — where new knowledge is saved; the rest are loaded alongside so retrieval and search span all of them. Use when the user asks to load/study several neurons together. Suggest 2–3 related neurons; 5 is the hard cap.",
      parameters: {
        type: "object",
        properties: {
          wiki_ids: {
            type: "array",
            items: { type: "string" },
            description: "Ordered wiki ids — first = primary. 1 to 5 entries.",
          },
        },
        required: ["wiki_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_chains",
      description:
        "List the user's saved neuron chains (named sets of neurons that load together in one click): id, name, description, and member neuron names in order.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_chain",
      description:
        "Activate a saved neuron chain by id or name — REPLACES the loaded neuron set with the chain's members (first member = primary). Use after the user asks to load/activate a chain; find it with list_chains if unsure.",
      parameters: {
        type: "object",
        properties: {
          chain_id: { type: "string", description: "Chain id (preferred when known)." },
          name: { type: "string", description: "Chain name — case-insensitive match when chain_id is absent." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_wiki",
      description:
        "Permanently delete a wiki (neuron) and ALL of its entries, edges, and conflicts. DESTRUCTIVE — never call until the user has, in the current turn, explicitly approved deleting this exact wiki by name or id. Must be invoked with confirm:true; without confirm:true the tool will refuse so you can ask the user again.",
      parameters: {
        type: "object",
        properties: {
          wiki_id: { type: "string" },
          confirm: { type: "boolean", description: "Must be true. Set only after the user has explicitly approved deletion of this exact wiki in this turn." },
        },
        required: ["wiki_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate one or more AI images with Nano Banana (Google's Gemini image model) and show them to the user inline. By default each image is also saved to the user's memory as a neuron. Use when the user asks for an image, picture, illustration, visualization, logo, scene, character art, etc. For multiple images in one turn: pass `count` (2–4) for variations of the SAME prompt, or `prompts: [...]` (2–4 entries) for a DISTINCT set in one call. Each image costs a few cents on their OpenRouter key — match the count to what the user asked for, don't pad.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image description — subject, style, composition, colors, mood. Required unless `prompts` is used." },
          prompts: { type: "array", items: { type: "string" }, description: "Optional. Up to 4 distinct prompts to generate as a set in one call (e.g. logo in red/blue/green). Overrides `prompt` and `count`." },
          count: { type: "integer", minimum: 1, maximum: 4, description: "Optional. Number of variations of `prompt` to generate (1–4, default 1). Ignored if `prompts` is provided." },
          aspect_ratio: { type: "string", enum: [...IMAGE_ASPECT_RATIOS], description: "Optional. Default 1:1. Applied to every image in the batch." },
          remember: { type: "boolean", description: "Save to memory as neurons (default true). Set false only if the user says they're throwaways." },
          attach_to_entry_id: { type: "string", description: "Optional: attach ALL generated images to an EXISTING knowledge entry id instead of creating new neurons." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_image",
      description:
        "Edit or refine a previously generated image (by image_id) using a text instruction — Nano Banana keeps the subject consistent. The result is a NEW image shown to the user and linked to the same memory as the original. Use for 'make it blue', 'add a hat', 'same character but at night', etc.",
      parameters: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "Id of the source image (from generate_image, list_images, or a memory's attached-image note)." },
          instruction: { type: "string", description: "What to change." },
          aspect_ratio: { type: "string", enum: [...IMAGE_ASPECT_RATIOS] },
        },
        required: ["image_id", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_image",
      description:
        "Re-display a stored image to the user inline (free, instant). Use when the user asks to see an image again, or when a retrieved memory mentions an attached image worth showing.",
      parameters: {
        type: "object",
        properties: { image_id: { type: "string" } },
        required: ["image_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description:
        "Load a stored image as VISION input so you can actually see its contents. Use ONLY when the question requires visual details (colors, layout, text in the image, what's depicted) that the stored prompt/caption can't answer — it costs ~1300 tokens. For merely re-showing an image to the user, use show_image instead.",
      parameters: {
        type: "object",
        properties: { image_id: { type: "string" } },
        required: ["image_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_images",
      description:
        "List the user's generated images (newest first), optionally filtered by a keyword matched against prompt/caption. Returns image_id, prompt, caption, linked entry_id, and created date. Use to find an image the user refers to ('that fox logo from last week').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter." },
          limit: { type: "number", description: "Default 10, max 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_image_memories",
      description:
        "Search the user's stored image memories (images they previously uploaded into chat). Returns up to N matches with memory_id, caption, OCR text, tags, and a short-lived URL that you can embed in your reply via standard markdown image syntax (![alt](url)) to show the image to the user. Use whenever the user references a picture they uploaded earlier ('that diagram I shared', 'the screenshot from yesterday').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter matched against caption + OCR text." },
          limit: { type: "number", description: "Default 5, max 15." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_image",
      description:
        "Permanently delete a generated image (the row in image_attachments AND the underlying file in storage). Use `list_images` first to find the image_id. DESTRUCTIVE: only call when the user has explicitly approved deleting this specific image in the current turn — paraphrase the image (prompt/date) back, get a clear 'yes', then call with confirm:true. Honors the user's per-tool permissions in Settings → AI permissions.",
      parameters: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "The id returned by list_images / show_image." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["image_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_image_memory",
      description:
        "Permanently delete an uploaded image memory (a picture the USER shared earlier). Removes both the image_memories row and the storage file. Use `recall_image_memories` first to find the memory_id. DESTRUCTIVE: only call after the user has explicitly approved this specific deletion in the current turn (paraphrase caption/date, get 'yes'). Honors per-tool permissions in Settings.",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "The id returned by recall_image_memories." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["memory_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description:
        "Generate a short AI VIDEO clip, shown inline as a live 'generating…' card that fills in when ready (~30s to a few minutes). Saved to memory as a video neuron by default. Billed PER SECOND to the user's OpenRouter key (motion transfer / draft tier bill to the fal key instead) — keep clips short and prefer the default fast model. IDENTITY LOCK (critical): when the user wants to animate an EXISTING character/asset — anything with a master asset, generated image, or splat — you MUST pass master_id or image_id instead of re-describing it in text. Text prompts CANNOT hold a character's identity; the reference images do. With any identity input attached, write the prompt as MOTION + CAMERA ONLY (e.g. 'walks forward, slow push-in'), ONE motion verb per clip (walk OR wave OR turn — stacked actions cause redesign drift), and NEVER re-describe the character's appearance (appearance text fights the image conditioning). If a master exists for the subject, refuse to generate from pure text unless the user explicitly says to ignore the master. If the estimated cost exceeds the user's threshold the tool refuses until you confirm the exact cost with the user and call again with confirm:true. After submitting, report to the user: which master/source images were used, the condition_mode, identity_scale, and that a consistency check runs when the clip completes.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "With identity inputs: MOTION + CAMERA only, one motion verb ('turns slowly to the right, camera orbits'). Without identity inputs: full scene description." },
          master_id: { type: "string", description: "PREFERRED. Master asset id or @name (from list_master_assets). Auto-loads its hero image, multi-view pack, assembly tag, negative constraints, and palette." },
          image_id: { type: "string", description: "Identity/first-frame source image (from generate_image / list_images). Use when no master exists." },
          image_url: { type: "string", description: "Public http(s) image URL as the identity source, if the user supplied one directly." },
          reference_image_ids: { type: "array", items: { type: "string" }, description: "Up to 4 image ids forming a multi-view identity pack (front, 3/4, side, back). Requires a reference-capable model." },
          splat_id: { type: "string", description: "A 3D splat as the identity source: consistent multi-view stills are rendered from it automatically and used as the reference pack (honest path — the splat itself is not animated)." },
          condition_mode: { type: "string", enum: ["identity_lock", "first_frame", "reference"], description: "identity_lock (default) auto-picks the strongest mode the model supports. first_frame = exact composition anchor. reference = multi-image identity pack." },
          identity_scale: { type: "number", description: "0-1, how hard to pin appearance (default from user settings, 0.85). Mapped to the model's own knob (Veo conditioningScale, Kling cfg_scale); reported as skipped when the model has none." },
          assembly_instruction: { type: "string", description: "ONE short discriminative tag matching the references ('the teal-and-white cartoon robot'). Kept short BY DESIGN — long appearance prose fights image conditioning. Defaults from the master." },
          negative_constraints: { type: "array", items: { type: "string" }, description: "Hard bans as descriptive noun phrases ('extra limbs', 'new panels', 'palette shift') — never 'no X' phrasing. Sent via the model's negative-prompt parameter when it has one; enforced by the QC check otherwise." },
          lock_palette: { type: "array", items: { type: "string" }, description: "Hex colors (#RRGGBB) the clip must stay inside — drives the post-generation palette-drift score. Defaults from the master." },
          motion_mode: { type: "string", enum: ["text", "motion_plate"], description: "motion_plate = transfer kinematics from a driving video (motion_video_id) onto the identity image, via the user's fal key. The driving clip must show a HUMAN performer, unoccluded, head + upper body visible." },
          motion_video_id: { type: "string", description: "video_id (from list_videos) of the driving clip for motion_plate." },
          tier: { type: "string", enum: ["standard", "draft"], description: "draft = cheap flat-priced reference clip (~$0.10-0.30, Vidu Q2 on the fal key) for iterating on identity before a premium render. Requires reference images." },
          model: { type: "string", description: "Optional OpenRouter video model id (e.g. google/veo-3.1-fast). For identity work the tool validates the model supports the requested conditioning and errors with alternatives if not." },
          duration: { type: "integer", description: "Clip length in seconds; snapped to the model's allowed lengths. Keep short (5-8s holds identity best)." },
          resolution: { type: "string", description: "e.g. 720p, 1080p, 4K. Defaults to a cost-efficient option the model supports." },
          aspect_ratio: { type: "string", description: "e.g. 16:9, 9:16, 1:1. Optional." },
          generate_audio: { type: "boolean", description: "Generate native audio (default true for models that support it)." },
          confirm: { type: "boolean", description: "Set true ONLY after the user has approved the estimated cost in the current turn." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_video",
      description:
        "Re-display a previously generated video clip to the user inline (free, instant). Use list_videos first to find the video_id.",
      parameters: {
        type: "object",
        properties: { video_id: { type: "string", description: "The id from list_videos." } },
        required: ["video_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_videos",
      description:
        "List the user's generated video clips (newest first), optionally filtered by a keyword matched against prompt/caption. Returns video_id, job_id, prompt, model, status, and whether each is saved to memory. Use to find a clip the user refers to.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter." },
          limit: { type: "number", description: "Default 10, max 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_video",
      description:
        "Permanently delete a generated video clip (its row AND the stored MP4). DESTRUCTIVE: only call after the user has explicitly approved deleting this specific clip in the current turn — paraphrase the clip (prompt/date) back, get a clear 'yes', then call with confirm:true. Honors per-tool permissions in Settings.",
      parameters: {
        type: "object",
        properties: {
          video_id: { type: "string", description: "The id returned by list_videos." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["video_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_splat",
      description:
        "Turn an IMAGE into an interactive 3D Gaussian splat and show it to the user inline (they can orbit it in the chat). Takes about 5-20 seconds and costs about $0.05, billed to the user's fal.ai key. IMPORTANT: there is NO text-to-3D — this tool needs an image. If the user asks for a 3D version of something that doesn't exist yet, call generate_image FIRST, then pass that image's id here. If they refer to an image already in the chat or their library, use list_images to find its id. The result is saved to memory as a 3D neuron by default. Use when the user asks for a 3D model, a 3D version, a splat, or something they can rotate/spin/look around.",
      parameters: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "Id of the source image (from generate_image or list_images). Preferred." },
          image_url: { type: "string", description: "Public http(s) image URL, if the user supplied one directly instead of an image_id." },
          prompt: { type: "string", description: "Short description of the subject — used as the caption, the alt text and the memory title." },
          quality: { type: "string", enum: ["fast", "standard", "high"], description: "fast = 65k gaussians (2.1 MB), standard = 131k (4.2 MB, default), high = 262k PLY (much larger file, may be refused by the size limit)." },
          model: { type: "string", description: "Optional fal model id. Defaults to the user's chosen 3D model (tripo3d/triposplat)." },
          confirm: { type: "boolean", description: "Set true ONLY after the user has approved the cost in the current turn." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_splat",
      description:
        "Re-display a previously generated 3D splat to the user inline (free, instant). Use list_splats first to find the splat_id.",
      parameters: {
        type: "object",
        properties: { splat_id: { type: "string", description: "The id from list_splats." } },
        required: ["splat_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_splats",
      description:
        "List the user's generated 3D splats (newest first), optionally filtered by a keyword matched against prompt/caption. Returns splat_id, prompt, model, status, file size and whether each is saved to memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter." },
          limit: { type: "number", description: "Default 10, max 25." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_splat",
      description:
        "Permanently delete a generated 3D splat (its row AND the stored file). DESTRUCTIVE: only call after the user has explicitly approved deleting this specific model in the current turn — paraphrase it (prompt/date) back, get a clear 'yes', then call with confirm:true. Honors per-tool permissions in Settings.",
      parameters: {
        type: "object",
        properties: {
          splat_id: { type: "string", description: "The id returned by list_splats." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["splat_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_splat_views",
      description:
        "Render consistent multi-view stills (turntable) from a generated 3D splat — FREE, runs on the user's GPU in ~5-15s, no API spend. Each view is saved as an image with an image_id, so the set works as a multi-view identity pack for generate_video (reference_image_ids) or as a master asset's view pack. Default set: front, three_quarter, side, back — the back view matters most (video models hallucinate turnarounds without one). This is the honest splat→video path: the splat itself is never animated; it contributes geometry-consistent reference stills.",
      parameters: {
        type: "object",
        properties: {
          splat_id: { type: "string", description: "The id from list_splats (must be a completed splat)." },
          views: { type: "array", items: { type: "string", enum: ["front", "three_quarter", "side", "back", "three_quarter_left", "side_left"] }, description: "Which views to render. Default: front, three_quarter, side, back." },
          resolution: { type: "integer", description: "Square output size in px (512-1024, default 768)." },
          attach_to_master: { type: "string", description: "Optional master id or @name — the rendered views are appended to that master's identity pack." },
        },
        required: ["splat_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_master_asset",
      description:
        "Lock an image and/or splat as a named MASTER ASSET — the single source of truth for a character/asset's identity. Use when the user says 'lock this as the master', 'save this character', or approves a design. Once locked, generate_video takes master_id (or @name) and auto-loads the hero image, multi-view pack, assembly tag, negative constraints, and palette — the user never has to re-describe the character. Free (writes a record + an Asset Factory neuron; if a splat is given without views, a 4-view pack is rendered from it on the user's GPU). Keep assembly_tag SHORT ('the teal-and-white cartoon robot') — it goes into prompts, and long appearance text fights image conditioning; put full construction details in tech_pack instead.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Handle for @name references (2-40 chars: letters, digits, - or _). E.g. 'robby'." },
          hero_image_id: { type: "string", description: "The canonical hero image (from generate_image / list_images). Required unless splat_id is given." },
          splat_id: { type: "string", description: "Optional 3D splat. A 4-view reference pack is auto-rendered from it unless view_image_ids are supplied." },
          view_image_ids: { type: "array", items: { type: "string" }, description: "Optional multi-view pack image ids (front, 3/4, side, back)." },
          assembly_tag: { type: "string", description: "ONE short discriminative identity tag used in prompts. Keep under ~15 words." },
          tech_pack: { type: "string", description: "Full technical spec (body construction, materials, joints, eye type…). Stored for QC and the Asset Factory neuron; NOT injected into prompts." },
          negative_constraints: { type: "array", items: { type: "string" }, description: "Hard bans as noun phrases ('second design language', 'new panels', 'proportion drift', 'extra limbs')." },
          banned_traits: { type: "array", items: { type: "string" }, description: "Traits this character must never have ('antenna', 'tracks')." },
          palette: { type: "array", items: { type: "string" }, description: "Locked palette as hex (#RRGGBB)." },
          style_lock: { type: "string", enum: ["vector", "soft_3d", "live_action", "custom"], description: "Rendering style family. Default custom." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_master_assets",
      description:
        "List the user's locked master assets: master_id, @name, assembly tag, whether each has a hero image / view pack / splat, palette and negative constraints. ALWAYS check this before generating character video — if a master exists for the subject, pass its master_id to generate_video instead of describing the character in text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_master_asset",
      description:
        "Delete a master asset bundle (the record only — its hero image, views, splat and neuron are NOT deleted). DESTRUCTIVE: paraphrase the master (@name) back to the user, get a clear 'yes', then call with confirm:true. Honors per-tool permissions in Settings.",
      parameters: {
        type: "object",
        properties: {
          master_id: { type: "string", description: "The id (or @name) from list_master_assets." },
          confirm: { type: "boolean", description: "Must be true — proof the user just approved this exact deletion." },
        },
        required: ["master_id", "confirm"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_blocks",
      description:
        "Render rich, structured UI blocks INLINE in your reply (cards, tables, charts, timelines, step lists, key-value lists, comparisons, quizzes). Use this when structured/dense information is clearer than prose — e.g. comparisons, data, step-by-step guides, study quizzes. Still write a short prose reply too. Each item is an object with a `type` field. Text fields support markdown.",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            description:
              "Up to 20 blocks. Allowed shapes by `type`: " +
              "callout{variant:info|success|warning|danger|tip, title?, body}; " +
              "card{title, body, footer?}; " +
              "table{columns:string[], rows:string[][]}; " +
              "chart{chart:bar|line|area|pie, data:object[], xKey:string, series:string[]}; " +
              "timeline{items:[{when, label}]}; " +
              "steps{ordered?:boolean, items:string[]}; " +
              "keyValue{pairs:[{key, value}]}; " +
              "comparison{columns:string[2..3], rows:[{label, cells:string[]}]}; " +
              "quiz{question, options:string[], answerIndex:number, explanation?}.",
            items: { type: "object", properties: { type: { type: "string" } }, required: ["type"], additionalProperties: true },
          },
        },
        required: ["blocks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_artifact",
      description:
        "Render a self-contained interactive HTML or SVG 'artifact' in a side panel — for output best shown as a live rendered document: a diagram, an interactive widget, a hand-coded chart, a small HTML/CSS/JS demo, an SVG illustration, or a styled document. Provide ONLY the inner body markup (you MAY include <style> and <script> tags); do NOT include <html>, <head>, or <body> wrappers. It runs fully sandboxed with NO network access and no access to the page. Use `render_blocks` for simple structured data; use this for rich/visual/interactive output.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title shown on the artifact panel." },
          kind: { type: "string", enum: ["html", "svg"], description: "html (default) or svg." },
          content: { type: "string", description: "Inner body markup. May include <style>/<script>. No <html>/<head>/<body> wrappers and no external network calls (blocked by sandbox CSP)." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_memory_entry",
      description:
        "Create a new knowledge entry (a 'neuron memory') in the user's active wiki. Use for facts the user explicitly asks you to remember. Honors the user's Settings → AI permissions (may be disabled).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the entry." },
          content: { type: "string", description: "Body text of the memory." },
          entry_type: { type: "string", description: "e.g. fact, person, place, concept, event.", default: "fact" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
          confidence: { type: "number", description: "0.0–1.0, default 0.8." },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory_entry",
      description:
        "Edit a knowledge entry the user already has (title / content / tags / confidence). Requires entry_id. Honors per-tool permissions.",
      parameters: {
        type: "object",
        properties: {
          entry_id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: ["entry_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory_entry",
      description:
        "Permanently delete a knowledge entry. Only call when the user has explicitly approved deleting this specific entry in the current turn. Honors per-tool permissions.",
      parameters: {
        type: "object",
        properties: {
          entry_id: { type: "string" },
        },
        required: ["entry_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_memory_entries",
      description:
        "Create or remove a typed edge between two knowledge entries (supports, contradicts, refines, related, etc.). Honors per-tool permissions.",
      parameters: {
        type: "object",
        properties: {
          source_entry_id: { type: "string" },
          target_entry_id: { type: "string" },
          relation: { type: "string", description: "e.g. supports | contradicts | refines | related | causes" },
          action: { type: "string", enum: ["upsert", "delete"], default: "upsert" },
        },
        required: ["source_entry_id", "target_entry_id", "relation"],
      },
    },
  },
] as const;


export interface ToolEvent {
  name: string;
  summary: string;
  ok: boolean;
}

export async function executeChatTool(
  name: string,
  rawArgs: string,
  deps: ToolDeps
): Promise<{ result: unknown; event: ToolEvent }> {
  let args: any = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return {
      result: { error: "Invalid JSON arguments" },
      event: { name, summary: `${name}: invalid arguments`, ok: false },
    };
  }

  try {
    switch (name) {
      case "list_books": {
        const list = deps.books.map((b) => ({
          id: b.id,
          title: b.title,
          page_count: b.pageCount,
          chapter_count: b.chapters.length,
          is_active: b.id === deps.activeBookId,
        }));
        return { result: list, event: { name, summary: `Listed ${list.length} book(s)`, ok: true } };
      }
      case "get_book": {
        const book = deps.books.find((b) => b.id === args.book_id);
        if (!book) return { result: { error: "Book not found" }, event: { name, summary: "Book not found", ok: false } };
        return {
          result: {
            id: book.id,
            title: book.title,
            page_count: book.pageCount,
            chapters: book.chapters.map((c) => ({
              id: c.id,
              name: c.name,
              start_page: c.startPage,
              end_page: c.endPage,
              has_text: !!c.textContent,
            })),
          },
          event: { name, summary: `Opened "${book.title}"`, ok: true },
        };
      }
      case "get_chapter_text": {
        const maxChars = Math.max(500, Math.min(20000, Number(args.max_chars) || 8000));
        let chapter: Chapter | undefined;
        let bookTitle = "";
        for (const b of deps.books) {
          const c = b.chapters.find((ch) => ch.id === args.chapter_id);
          if (c) {
            chapter = c;
            bookTitle = b.title;
            break;
          }
        }
        if (!chapter) {
          return { result: { error: "Chapter not found" }, event: { name, summary: "Chapter not found", ok: false } };
        }
        const text = chapter.textContent || "";
        return {
          result: {
            id: chapter.id,
            name: chapter.name,
            start_page: chapter.startPage,
            end_page: chapter.endPage,
            text: text.slice(0, maxChars),
            truncated: text.length > maxChars,
          },
          event: { name, summary: `Read "${chapter.name}" from ${bookTitle}`, ok: true },
        };
      }
      case "set_active_book": {
        const book = deps.books.find((b) => b.id === args.book_id);
        if (!book) return { result: { error: "Book not found" }, event: { name, summary: "Book not found", ok: false } };
        deps.setActiveBookId(args.book_id);
        return { result: { ok: true }, event: { name, summary: `Focused on "${book.title}"`, ok: true } };
      }
      case "search_wiki": {
        const q = String(args.query || "").trim();
        if (!q) return { result: { error: "Empty query" }, event: { name, summary: "Empty query", ok: false } };
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const { activeWikiId, activeWikiIds, allNeurons } = await getNeuronScope();
        let q1: any = supabase
          .from("knowledge_entries")
          .select("id, title, content, entry_type, confidence, source_book_id, tags, wiki_id")
          .or(`title.ilike.%${q}%,content.ilike.%${q}%`)
          .limit(limit);
        if (!allNeurons && activeWikiIds.length > 0) q1 = q1.in("wiki_id", activeWikiIds);
        const { data, error } = await q1;
        if (error) throw error;
        const entries = (data || []).map((e: any) => ({
          id: e.id,
          title: e.title,
          entry_type: e.entry_type,
          confidence: e.confidence,
          snippet: (e.content || "").slice(0, 400),
        }));
        const scopeNote = allNeurons
          ? " across all neurons"
          : activeWikiIds.length > 1
            ? ` across ${activeWikiIds.length} loaded neurons`
            : activeWikiId
              ? " in active wiki"
              : "";
        return { result: entries, event: { name, summary: `Searched wiki for "${q}" — ${entries.length} hit(s)${scopeNote}`, ok: true } };
      }
      case "web_search": {
        const q = String(args.query || "").trim();
        if (!q) return { result: { error: "Empty query" }, event: { name, summary: "Empty query", ok: false } };
        const token = (deps.burplexityApiToken || "").trim();
        if (!token) {
          return {
            result: { error: "Burplexity API token not configured. Ask the user to paste a pp_… token in Settings → Burplexity API Token." },
            event: { name, summary: "Burplexity token missing — add it in Settings", ok: false },
          };
        }
        try {
          const r = await fetch(BURPLEXITY_BOT_ASK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": token },
            body: JSON.stringify({ query: q, save_to_wiki: false }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            const msg = j?.error || `HTTP ${r.status}`;
            if (isSearchRateLimited(r.status, msg)) {
              return {
                result: { error: RATE_LIMIT_MESSAGE },
                event: { name, summary: "Web search rate-limited — try again shortly", ok: false },
              };
            }
            return {
              result: { error: `Burplexity search failed: ${msg}` },
              event: { name, summary: `Web search failed: ${msg}`, ok: false },
            };
          }
          const answer = String(j.answer || "").slice(0, 16000);
          const citations = pickCitations(j).slice(0, 8);
          return {
            result: { answer, citations },
            event: { name, summary: `Searched the web for "${q}" — ${citations.length} source(s)`, ok: true },
          };
        } catch (e: any) {
          return {
            result: { error: `Web search error: ${e?.message || "network failure"}` },
            event: { name, summary: `Web search failed: ${e?.message || "network"}`, ok: false },
          };
        }
      }
      case "list_conflicts": {
        const status = (args.status as string) || "open";
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const { data: conflicts, error } = await supabase
          .from("knowledge_conflicts")
          .select("id, kind, rationale, status, entry_a, entry_b, created_at")
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        const ids = Array.from(new Set((conflicts || []).flatMap((c: any) => [c.entry_a, c.entry_b])));
        const { data: ents } = ids.length
          ? await supabase.from("knowledge_entries").select("id, title, content, entry_type, confidence, source_book_id, wiki_id" as any).in("id", ids)
          : { data: [] as any[] };
        const byId = new Map(((ents as any[]) || []).map((e: any) => [e.id, e]));
        // Scope to the loaded neuron set — entries must live in one of the
        // loaded neurons (or be unscoped legacy entries). "Access all
        // neurons" (paid) lifts the filter.
        const { activeWikiId, activeWikiIds, allNeurons } = await getNeuronScope();
        const inScope = (id: string) => {
          if (allNeurons || activeWikiIds.length === 0) return true;
          const e: any = byId.get(id);
          if (!e) return true; // missing — surface anyway so user knows
          return !e.wiki_id || activeWikiIds.includes(e.wiki_id);
        };
        const hydrate = (id: string) => {
          const e: any = byId.get(id);
          if (!e) return { id, missing: true };
          return { id, title: e.title, entry_type: e.entry_type, confidence: e.confidence, source_book_id: e.source_book_id, snippet: (e.content || "").slice(0, 500) };
        };
        const out = (conflicts || [])
          .filter((c: any) => inScope(c.entry_a) || inScope(c.entry_b))
          .map((c: any) => ({
            conflict_id: c.id, kind: c.kind, status: c.status, rationale: c.rationale,
            entry_a: hydrate(c.entry_a), entry_b: hydrate(c.entry_b),
          }));
        const conflictScopeNote = allNeurons
          ? " across all neurons"
          : activeWikiIds.length > 1
            ? ` across ${activeWikiIds.length} loaded neurons`
            : activeWikiId
              ? " in active wiki"
              : "";
        return { result: out, event: { name, summary: `Listed ${out.length} ${status} conflict(s)${conflictScopeNote}`, ok: true } };
      }
      case "get_conflict": {
        const id = String(args.conflict_id || "");
        if (!id) return { result: { error: "conflict_id required" }, event: { name, summary: "Missing conflict_id", ok: false } };
        const { data: c, error } = await supabase
          .from("knowledge_conflicts").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!c) return { result: { error: "Conflict not found" }, event: { name, summary: "Conflict not found", ok: false } };
        const { data: ents } = await supabase
          .from("knowledge_entries").select("id, title, content, entry_type, confidence, tags, source_book_id")
          .in("id", [c.entry_a, c.entry_b]);
        const byId = new Map((ents || []).map((e: any) => [e.id, e]));
        return {
          result: {
            conflict_id: c.id, kind: c.kind, status: c.status, rationale: c.rationale,
            entry_a: byId.get(c.entry_a) || { id: c.entry_a, missing: true },
            entry_b: byId.get(c.entry_b) || { id: c.entry_b, missing: true },
          },
          event: { name, summary: `Loaded conflict ${c.id.slice(0, 8)}`, ok: true },
        };
      }
      case "resolve_conflict": {
        const id = String(args.conflict_id || "");
        const action = String(args.action || "");
        if (!id || !action) return { result: { error: "conflict_id and action required" }, event: { name, summary: "Missing args", ok: false } };
        const { data: c, error: cErr } = await supabase
          .from("knowledge_conflicts").select("*").eq("id", id).maybeSingle();
        if (cErr) throw cErr;
        if (!c) return { result: { error: "Conflict not found" }, event: { name, summary: "Conflict not found", ok: false } };

        const setStatus = async (status: string) => {
          const { error } = await supabase.from("knowledge_conflicts").update({ status }).eq("id", id);
          if (error) throw error;
        };
        const deleteEntry = async (eid: string) => {
          const { error } = await supabase.from("knowledge_entries").delete().eq("id", eid);
          if (error) throw error;
        };
        const updateEntry = async (eid: string, patch: any) => {
          const { error } = await supabase.from("knowledge_entries").update(patch).eq("id", eid);
          if (error) throw error;
        };

        switch (action) {
          case "acknowledge":
            await setStatus("acknowledged");
            return { result: { ok: true, status: "acknowledged" }, event: { name, summary: "Conflict acknowledged", ok: true } };
          case "dismiss":
            await setStatus("dismissed");
            return { result: { ok: true, status: "dismissed" }, event: { name, summary: "Conflict dismissed (false positive)", ok: true } };
          case "keep_a_delete_b":
            await deleteEntry(c.entry_b);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: "Resolved — kept entry A, deleted entry B", ok: true } };
          case "keep_b_delete_a":
            await deleteEntry(c.entry_a);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: "Resolved — kept entry B, deleted entry A", ok: true } };
          case "merge": {
            const title = String(args.merged_title || "").trim();
            const content = String(args.merged_content || "").trim();
            if (!title || !content) return { result: { error: "merged_title and merged_content required" }, event: { name, summary: "Merge missing fields", ok: false } };
            const patch: any = { title, content };
            if (Array.isArray(args.merged_tags)) patch.tags = args.merged_tags;
            await updateEntry(c.entry_a, patch);
            await deleteEntry(c.entry_b);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: `Merged into "${title}"`, ok: true } };
          }
          case "edit_a":
          case "edit_b": {
            const targetId = action === "edit_a" ? c.entry_a : c.entry_b;
            const patch: any = {};
            if (typeof args.new_title === "string" && args.new_title.trim()) patch.title = args.new_title.trim();
            if (typeof args.new_content === "string" && args.new_content.trim()) patch.content = args.new_content.trim();
            if (Array.isArray(args.new_tags)) patch.tags = args.new_tags;
            if (Object.keys(patch).length === 0) return { result: { error: "Provide new_title and/or new_content" }, event: { name, summary: "Edit missing fields", ok: false } };
            await updateEntry(targetId, patch);
            await setStatus("resolved");
            return { result: { ok: true }, event: { name, summary: `Edited entry ${action === "edit_a" ? "A" : "B"} and resolved`, ok: true } };
          }
          default:
            return { result: { error: `Unknown action ${action}` }, event: { name, summary: `Unknown action ${action}`, ok: false } };
        }
      }
      case "update_conflict_status": {
        const id = String(args.conflict_id || "");
        const status = String(args.status || "");
        if (!id || !status) return { result: { error: "conflict_id and status required" }, event: { name, summary: "Missing args", ok: false } };
        const { error } = await supabase.from("knowledge_conflicts").update({ status }).eq("id", id);
        if (error) throw error;
        return { result: { ok: true, status }, event: { name, summary: `Conflict → ${status}`, ok: true } };
      }
      case "list_wikis": {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        const [{ data: wikis, error: wErr }, scope, { data: counts }] = await Promise.all([
          supabase.from("wikis" as any).select("id, name, description, is_default, is_meta, created_at, updated_at").order("updated_at", { ascending: false }),
          getNeuronScope(),
          supabase.from("knowledge_entries").select("wiki_id" as any),
        ]);
        if (wErr) throw wErr;
        const activeId = scope.activeWikiId;
        const countMap = new Map<string, number>();
        for (const r of ((counts as any[]) || [])) {
          if (!r?.wiki_id) continue;
          countMap.set(r.wiki_id, (countMap.get(r.wiki_id) || 0) + 1);
        }
        const out = ((wikis as any[]) || []).map((w) => ({
          id: w.id, name: w.name, description: w.description, is_default: w.is_default, is_meta: w.is_meta,
          is_active: w.id === activeId, is_loaded: scope.activeWikiIds.includes(w.id),
          is_primary: w.id === activeId, entry_count: countMap.get(w.id) || 0,
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} wiki(s)`, ok: true } };
      }
      case "get_active_wiki": {
        const scope = await getNeuronScope();
        const activeId = scope.activeWikiId;
        if (!activeId) return { result: { active_wiki_id: null, loaded_neurons: [] }, event: { name, summary: "No active wiki set", ok: true } };
        const { data: loadedWikis } = scope.activeWikiIds.length
          ? await supabase.from("wikis" as any).select("id, name, description, is_default, is_meta").in("id", scope.activeWikiIds)
          : { data: [] as any[] };
        const byId = new Map(((loadedWikis as any[]) || []).map((w: any) => [w.id, w]));
        const loaded = scope.activeWikiIds.map((id) => byId.get(id)).filter(Boolean);
        const wiki = byId.get(activeId) || null;
        return {
          result: { active_wiki_id: activeId, wiki, loaded_neurons: loaded },
          event: { name, summary: `Active wiki: ${(wiki as any)?.name || activeId.slice(0, 8)}${loaded.length > 1 ? ` (+${loaded.length - 1} loaded alongside)` : ""}`, ok: true },
        };
      }
      case "switch_wiki": {
        const wid = String(args.wiki_id || "");
        if (!wid) return { result: { error: "wiki_id required" }, event: { name, summary: "Missing wiki_id", ok: false } };
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        const { data: wiki, error: wErr } = await supabase.from("wikis" as any).select("id, name").eq("id", wid).maybeSingle();
        if (wErr) throw wErr;
        if (!wiki) return { result: { error: "Wiki not found" }, event: { name, summary: "Wiki not found", ok: false } };
        // Free plan: only the oldest neuron is unlocked — the AI must not be a
        // side door into locked ones (mirrors the BRAIN tab and ⌘K switcher).
        // One shared gate with set_active_neurons/activate_chain so the AI
        // paths can never diverge (it honors OPEN_ACCESS and admin bypass).
        const switchGateError = await checkNeuronPlanGate([wid]);
        if (switchGateError) {
          return {
            result: { error: `"${(wiki as any).name}" is locked on the free plan. Tell the user that upgrading to Pro or Lifetime unlocks all of their neurons.` },
            event: { name, summary: `"${(wiki as any).name}" is locked on the free plan`, ok: false },
          };
        }
        // Switching replaces the whole loaded set with just this wiki — the
        // same semantics as every "Load" button in the UI.
        await persistActiveSet(uid, [wid]);
        return { result: { ok: true, active_wiki_id: wid, name: (wiki as any).name }, event: { name, summary: `Switched to "${(wiki as any).name}"`, ok: true } };
      }
      case "create_wiki": {
        const wname = String(args.name || "").trim();
        if (!wname) return { result: { error: "name required" }, event: { name, summary: "Missing name", ok: false } };
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        // Mirror the UI's neuron-limit gate (WikiLibrary.handleNewWiki): the
        // AI must not be a side door into creating — and auto-activating — a
        // neuron that the free plan immediately locks. Dormant under
        // OPEN_ACCESS; the DB trigger enforce_neuron_limit backstops anyway.
        if (!OPEN_ACCESS) {
          const { data: isAdminData } = await supabase.rpc("is_admin" as any);
          if (!isAdminData) {
            const { data: sub } = await supabase.from("subscribers" as any).select("subscribed, plan").maybeSingle();
            const paid = !!(sub as any)?.subscribed && (sub as any)?.plan !== "free";
            if (!paid) {
              const { count } = await supabase
                .from("wikis" as any)
                .select("id", { count: "exact", head: true });
              if ((count ?? 0) >= FREE_NEURON_LIMIT) {
                return {
                  result: { error: "The free plan includes one neuron. Tell the user that upgrading to Pro or Lifetime unlocks creating more neurons." },
                  event: { name, summary: "Neuron limit reached on the free plan", ok: false },
                };
              }
            }
          }
        }
        const { data, error } = await supabase.from("wikis" as any).insert({
          user_id: uid, name: wname, description: String(args.description || ""), tags: [],
        } as any).select().single();
        if (error || !data) throw error || new Error("Create failed");
        const activate = args.activate !== false;
        if (activate) {
          await persistActiveSet(uid, [(data as any).id]);
        } else if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("wiki-active-changed"));
        }
        return { result: { ok: true, id: (data as any).id, name: wname, activated: activate }, event: { name, summary: `Created wiki "${wname}"${activate ? " (active)" : ""}`, ok: true } };
      }
      case "set_active_neurons": {
        const rawIds = Array.isArray(args.wiki_ids) ? args.wiki_ids.map((x: unknown) => String(x)) : [];
        const ids = Array.from(new Set(rawIds)).filter(Boolean) as string[];
        if (ids.length === 0) return { result: { error: "wiki_ids required (1–5 ids from list_wikis)" }, event: { name, summary: "Missing wiki_ids", ok: false } };
        if (ids.length > MAX_ACTIVE_NEURONS) {
          return {
            result: { error: `At most ${MAX_ACTIVE_NEURONS} neurons can be loaded at once. Suggest the user pick the 2–3 most related to their current goal.` },
            event: { name, summary: `Refused: more than ${MAX_ACTIVE_NEURONS} neurons`, ok: false },
          };
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        const { data: found, error: fErr } = await supabase
          .from("wikis" as any)
          .select("id, name")
          .in("id", ids);
        if (fErr) throw fErr;
        const byId = new Map(((found as any[]) || []).map((w: any) => [w.id, w]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          return { result: { error: `Unknown wiki id(s): ${missing.join(", ")}. Use list_wikis to get valid ids.` }, event: { name, summary: "Unknown wiki id(s)", ok: false } };
        }
        const gateError = await checkNeuronPlanGate(ids);
        if (gateError) return { result: { error: gateError }, event: { name, summary: "Blocked by free plan", ok: false } };
        const { degraded } = await persistActiveSet(uid, ids);
        const names = ids.map((id) => (byId.get(id) as any).name);
        return {
          result: {
            ok: true,
            loaded_neurons: names,
            primary: names[0],
            ...(degraded ? { note: "The multi-neuron database migration isn't applied yet — only the primary neuron persisted." } : {}),
          },
          event: { name, summary: `Loaded ${names.length} neuron(s): ${names.join(", ")}`, ok: true },
        };
      }
      case "list_chains": {
        try {
          const chains = await fetchChains();
          const wikiIds = Array.from(new Set(chains.flatMap((c) => c.wiki_ids)));
          const { data: wikiRows } = wikiIds.length
            ? await supabase.from("wikis" as any).select("id, name").in("id", wikiIds)
            : { data: [] as any[] };
          const nameById = new Map(((wikiRows as any[]) || []).map((w: any) => [w.id, w.name]));
          const out = chains.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            neurons: c.wiki_ids.map((id) => nameById.get(id) || id.slice(0, 8)),
          }));
          return { result: out, event: { name, summary: `Listed ${out.length} chain(s)`, ok: true } };
        } catch (e) {
          if (isChainsMigrationMissing(e)) {
            return { result: { error: CHAINS_MIGRATION_MESSAGE }, event: { name, summary: "Chains migration not applied yet", ok: false } };
          }
          throw e;
        }
      }
      case "activate_chain": {
        const chainId = String(args.chain_id || "").trim();
        const chainName = String(args.name || "").trim();
        if (!chainId && !chainName) {
          return { result: { error: "Provide chain_id or name (see list_chains)." }, event: { name, summary: "Missing chain reference", ok: false } };
        }
        let chains;
        try {
          chains = await fetchChains();
        } catch (e) {
          if (isChainsMigrationMissing(e)) {
            return { result: { error: CHAINS_MIGRATION_MESSAGE }, event: { name, summary: "Chains migration not applied yet", ok: false } };
          }
          throw e;
        }
        const lower = chainName.toLowerCase();
        const chain =
          (chainId && chains.find((c) => c.id === chainId)) ||
          (lower && (chains.find((c) => c.name.toLowerCase() === lower) || chains.find((c) => c.name.toLowerCase().includes(lower)))) ||
          null;
        if (!chain) return { result: { error: "Chain not found. Call list_chains to see the user's chains." }, event: { name, summary: "Chain not found", ok: false } };
        const ids = chain.wiki_ids.slice(0, MAX_ACTIVE_NEURONS);
        if (ids.length === 0) return { result: { error: `Chain "${chain.name}" has no member neurons.` }, event: { name, summary: "Empty chain", ok: false } };
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };
        // Drop members whose neuron was deleted since the chain was saved.
        // (Propagate query failures — a transient error must not read as
        // "all your neurons were deleted".)
        const { data: found, error: foundErr } = await supabase.from("wikis" as any).select("id, name").in("id", ids);
        if (foundErr) throw foundErr;
        const byId = new Map(((found as any[]) || []).map((w: any) => [w.id, w]));
        const liveIds = ids.filter((id) => byId.has(id));
        if (liveIds.length === 0) return { result: { error: `All neurons in chain "${chain.name}" have been deleted.` }, event: { name, summary: "Chain members deleted", ok: false } };
        const gateError = await checkNeuronPlanGate(liveIds);
        if (gateError) return { result: { error: gateError }, event: { name, summary: "Blocked by free plan", ok: false } };
        const { degraded } = await persistActiveSet(uid, liveIds);
        touchChainUsed(chain.id);
        const names = liveIds.map((id) => (byId.get(id) as any).name);
        return {
          result: {
            ok: true,
            chain: chain.name,
            loaded_neurons: names,
            primary: names[0],
            ...(degraded ? { note: "The multi-neuron database migration isn't applied yet — only the primary neuron persisted." } : {}),
          },
          event: { name, summary: `Activated chain "${chain.name}" — ${names.length} neuron(s) loaded`, ok: true },
        };
      }
      case "delete_wiki": {
        // Per-tool permission gate. Defaults to allowed.
        const { data: prefs } = await supabase
          .from("user_settings")
          .select("chat_tool_permissions, active_wiki_id" as any)
          .maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms.delete_wiki === false) {
          return {
            result: { error: "Tool 'delete_wiki' is disabled in the user's AI permissions. Ask the user to enable it in Settings." },
            event: { name, summary: "delete_wiki blocked by user settings", ok: false },
          };
        }
        const wid = String(args.wiki_id || "");
        if (!wid) return { result: { error: "wiki_id required" }, event: { name, summary: "Missing wiki_id", ok: false } };
        if (args.confirm !== true) {
          return {
            result: { error: "Deletion requires confirm:true. Ask the user to explicitly confirm deleting this exact wiki by name, then retry with confirm:true." },
            event: { name, summary: "Refused: confirmation required", ok: false },
          };
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };

        const { data: target, error: tErr } = await supabase
          .from("wikis" as any)
          .select("id, name, is_default")
          .eq("id", wid)
          .eq("user_id", uid)
          .maybeSingle();
        if (tErr) throw tErr;
        if (!target) return { result: { error: "Wiki not found" }, event: { name, summary: "Wiki not found", ok: false } };

        const { data: allWikis } = await supabase
          .from("wikis" as any)
          .select("id, created_at")
          .eq("user_id", uid)
          .order("created_at", { ascending: true });
        const wikis = (allWikis as any[]) || [];
        if (wikis.length <= 1) {
          return {
            result: { error: "Cannot delete the only remaining wiki. Ask the user to create another wiki first." },
            event: { name, summary: "Refused: last remaining wiki", ok: false },
          };
        }
        if ((target as any).is_default) {
          return {
            result: { error: "This wiki is marked as the default. Ask the user to set a different wiki as default before deleting." },
            event: { name, summary: "Refused: default wiki", ok: false },
          };
        }

        const scopeBefore = await getNeuronScope();
        const wasActive = scopeBefore.activeWikiId === wid;
        const { error: dErr } = await supabase
          .from("wikis" as any)
          .delete()
          .eq("id", wid)
          .eq("user_id", uid);
        if (dErr) throw dErr;

        // Prune the deleted wiki out of the loaded set; if it was the
        // primary, the next loaded neuron (or the oldest survivor) takes over.
        if (scopeBefore.activeWikiIds.includes(wid) || wasActive) {
          let nextSet = scopeBefore.activeWikiIds.filter((id) => id !== wid);
          if (nextSet.length === 0) {
            const survivor = wikis.find((w) => w.id !== wid)?.id || null;
            nextSet = survivor ? [survivor] : [];
          }
          await persistActiveSet(uid, nextSet);
        }
        try {
          window.dispatchEvent(new CustomEvent("wiki-active-changed"));
          window.dispatchEvent(new Event("knowledge-entries-changed"));
          emitChainsChanged(); // membership rows cascaded away with the wiki
        } catch {}
        return {
          result: { ok: true, deleted_id: wid, name: (target as any).name },
          event: { name, summary: `Deleted wiki "${(target as any).name}"`, ok: true },
        };
      }
      case "isolate_chapter": {
        const book = deps.books.find((b) => b.id === args.book_id);
        if (!book) return { result: { error: "Book not found" }, event: { name, summary: "Book not found", ok: false } };
        const sp = Number(args.start_page);
        const ep = Number(args.end_page);
        if (!Number.isFinite(sp) || !Number.isFinite(ep) || sp < 1 || ep < sp) {
          return {
            result: { error: "Invalid page range" },
            event: { name, summary: "Invalid page range", ok: false },
          };
        }
        const newChapter: Chapter = {
          id: crypto.randomUUID(),
          name: String(args.name || "Untitled chapter"),
          startPage: sp,
          endPage: ep,
          textContent: String(args.text_content || ""),
        };
        await deps.addChapter(book.id, newChapter);
        return {
          result: { id: newChapter.id, name: newChapter.name, start_page: sp, end_page: ep },
          event: { name, summary: `Isolated "${newChapter.name}" (p.${sp}–${ep}) in ${book.title}`, ok: true },
        };
      }
      case "rename_chapter": {
        await deps.updateChapter(String(args.book_id), String(args.chapter_id), String(args.name));
        return {
          result: { ok: true },
          event: { name, summary: `Renamed chapter to "${args.name}"`, ok: true },
        };
      }
      case "delete_chapter": {
        await deps.removeChapter(String(args.book_id), String(args.chapter_id));
        return { result: { ok: true }, event: { name, summary: `Deleted chapter`, ok: true } };
      }
      case "generate_image": {
        const apiKey = (deps.openRouterApiKey || "").trim();
        if (!apiKey) {
          return {
            result: { error: "OpenRouter API key not configured — ask the user to add one in Settings." },
            event: { name, summary: "OpenRouter key missing", ok: false },
          };
        }
        if (deps.isPaid === false) {
          return {
            result: { error: "Image generation is a Pro feature. Tell the user that upgrading to Pro or Lifetime unlocks it." },
            event: { name, summary: "Image generation is a Pro feature", ok: false },
          };
        }
        // Normalize into a prompts[] (1–4 items).
        let prompts: string[] = [];
        if (Array.isArray(args.prompts) && args.prompts.length > 0) {
          prompts = args.prompts.map((p: unknown) => String(p || "").trim()).filter(Boolean).slice(0, 4);
        } else {
          const base = String(args.prompt || "").trim();
          if (!base) return { result: { error: "prompt (or non-empty prompts[]) required" }, event: { name, summary: "Missing prompt", ok: false } };
          const count = Math.min(4, Math.max(1, Number(args.count) || 1));
          prompts = Array(count).fill(base);
        }
        if (prompts.length === 0) return { result: { error: "No valid prompts." }, event: { name, summary: "Missing prompts", ok: false } };

        const aspectRatio = args.aspect_ratio ? String(args.aspect_ratio) : undefined;
        const remember = args.remember !== false;
        const sharedEntryId: string | null = String(args.attach_to_entry_id || "").trim() || null;

        const settled = await Promise.allSettled(
          prompts.map(async (p) => {
            const gen = await generateImage({ apiKey, prompt: p, aspectRatio, primaryModel: deps.imageModelPrimary, fallbackModel: deps.imageModelFallback });
            let entryId: string | null = sharedEntryId;
            let neuronCreated = false;
            if (remember && !entryId) {
              entryId = await saveImageNeuron({ prompt: p, caption: gen.text, model: gen.modelUsed });
              neuronCreated = !!entryId;
            }
            const ref = await storeGeneratedImage({
              prompt: p, caption: gen.text, model: gen.modelUsed,
              dataUrl: gen.dataUrl, mime: gen.mime, entryId,
            });
            return { ref, entryId, neuronCreated, model: gen.modelUsed, prompt: p };
          }),
        );

        const successes = settled.flatMap((s) => s.status === "fulfilled" ? [s.value] : []);
        const failures = settled.flatMap((s, i) => s.status === "rejected" ? [{ prompt: prompts[i], error: String((s as PromiseRejectedResult).reason?.message || (s as PromiseRejectedResult).reason || "unknown") }] : []);

        if (successes.length === 0) {
          return {
            result: { error: "All image generations failed.", failures },
            event: { name, summary: `Image generation failed (${failures.length})`, ok: false },
          };
        }

        const refs = successes.map((s) => s.ref);
        const firstPrompt = prompts[0];
        const summary = successes.length === 1
          ? `Generated image: "${firstPrompt.slice(0, 60)}"${successes[0].neuronCreated ? " · saved to memory" : successes[0].entryId ? " · attached to memory" : ""}`
          : `Generated ${successes.length} images${failures.length ? ` (${failures.length} failed)` : ""}`;

        return {
          result: {
            ok: true,
            count: successes.length,
            images: successes.map((s) => ({
              image_id: s.ref.id,
              entry_id: s.entryId,
              saved_to_memory: !!s.entryId,
              prompt: s.prompt,
              model: s.model,
            })),
            failures: failures.length ? failures : undefined,
            note: "All images above are ALREADY displayed to the user inline — do NOT output markdown image links. Briefly describe what you created.",
            __images: refs,
          },
          event: { name, summary, ok: true },
        };
      }
      case "edit_image": {
        const imageId = String(args.image_id || "").trim();
        const instruction = String(args.instruction || "").trim();
        if (!imageId || !instruction) return { result: { error: "image_id and instruction required" }, event: { name, summary: "Missing args", ok: false } };
        const apiKey = (deps.openRouterApiKey || "").trim();
        if (!apiKey) return { result: { error: "OpenRouter API key not configured." }, event: { name, summary: "OpenRouter key missing", ok: false } };
        if (deps.isPaid === false) {
          return {
            result: { error: "Image editing is a Pro feature. Tell the user that upgrading to Pro or Lifetime unlocks it." },
            event: { name, summary: "Image editing is a Pro feature", ok: false },
          };
        }
        const src = await fetchImageById(imageId);
        if (!src) return { result: { error: "Image not found" }, event: { name, summary: "Image not found", ok: false } };
        const srcDataUrl = await loadImageAsDataUrl(src.storage_path);
        if (!srcDataUrl) return { result: { error: "Could not load source image" }, event: { name, summary: "Source image unavailable", ok: false } };
        const gen = await generateImage({
          apiKey,
          prompt: instruction,
          aspectRatio: args.aspect_ratio ? String(args.aspect_ratio) : undefined,
          inputImageDataUrl: srcDataUrl,
          primaryModel: deps.imageModelPrimary,
          fallbackModel: deps.imageModelFallback,
        });

        const ref = await storeGeneratedImage({
          prompt: `${src.prompt} → ${instruction}`.slice(0, 2000),
          caption: gen.text, model: gen.modelUsed,
          dataUrl: gen.dataUrl, mime: gen.mime,
          entryId: src.entry_id, sourceImageId: src.id,
        });
        return {
          result: {
            ok: true, image_id: ref.id, entry_id: src.entry_id, model: gen.modelUsed,
            note: "The edited image is already displayed to the user inline. Briefly describe the change.",
            __images: [ref],
          },
          event: { name, summary: `Edited image: "${instruction.slice(0, 60)}"`, ok: true },
        };
      }
      case "show_image": {
        const imageId = String(args.image_id || "").trim();
        if (!imageId) return { result: { error: "image_id required" }, event: { name, summary: "Missing image_id", ok: false } };
        const row = await fetchImageById(imageId);
        if (!row) return { result: { error: "Image not found" }, event: { name, summary: "Image not found", ok: false } };
        const ref: ChatImageRef = { id: row.id, storage_path: row.storage_path, prompt: row.prompt, entry_id: row.entry_id };
        return {
          result: {
            ok: true, image_id: row.id, prompt: row.prompt, caption: row.caption,
            note: "The image is now displayed to the user inline.",
            __images: [ref],
          },
          event: { name, summary: `Showed image: "${row.prompt.slice(0, 60)}"`, ok: true },
        };
      }
      case "view_image": {
        const imageId = String(args.image_id || "").trim();
        if (!imageId) return { result: { error: "image_id required" }, event: { name, summary: "Missing image_id", ok: false } };
        const row = await fetchImageById(imageId);
        if (!row) return { result: { error: "Image not found" }, event: { name, summary: "Image not found", ok: false } };
        const dataUrl = await loadImageAsDataUrl(row.storage_path);
        if (!dataUrl) return { result: { error: "Could not load image" }, event: { name, summary: "Image unavailable", ok: false } };
        return {
          result: {
            ok: true, image_id: row.id, prompt: row.prompt,
            note: "The image is attached as vision input in the next user message — look at it there.",
            __vision: dataUrl,
          },
          event: { name, summary: `Looked at image: "${row.prompt.slice(0, 60)}"`, ok: true },
        };
      }
      case "list_images": {
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const rows = await searchImages(args.query ? String(args.query) : undefined, limit);
        const { byImage } = await masterLinkageFor();
        const out = rows.map((r) => ({
          image_id: r.id,
          prompt: (r.prompt || "").slice(0, 200),
          caption: (r.caption || "").slice(0, 200),
          entry_id: r.entry_id,
          created_at: r.created_at,
          ...(byImage.has(r.id) ? { master: byImage.get(r.id) } : {}),
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} image(s)${args.query ? ` matching "${String(args.query).slice(0, 40)}"` : ""}`, ok: true } };
      }
      case "recall_image_memories": {
        const limit = Math.min(15, Math.max(1, Number(args.limit) || 5));
        const q = typeof args.query === "string" ? args.query.trim() : "";
        let query: any = (supabase.from("image_memories" as any) as any)
          .select("id, caption, ocr_text, tags, storage_path, created_at, wiki_id")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (q) {
          const safe = q.replace(/[%,()]/g, " ");
          query = query.or(`caption.ilike.%${safe}%,ocr_text.ilike.%${safe}%`);
        }
        const { data, error } = await query;
        if (error) {
          return { result: { error: error.message }, event: { name, summary: "Image memory search failed", ok: false } };
        }
        const rows: any[] = data || [];
        const out = await Promise.all(rows.map(async (r) => {
          let url: string | null = null;
          try {
            const signed = await supabase.storage.from("generated-images").createSignedUrl(r.storage_path, 60 * 60);
            url = signed.data?.signedUrl || null;
          } catch { /* ignore */ }
          return {
            memory_id: r.id,
            caption: (r.caption || "").slice(0, 240),
            ocr_excerpt: (r.ocr_text || "").slice(0, 240),
            tags: r.tags || [],
            created_at: r.created_at,
            url,
          };
        }));
        return {
          result: out,
          event: { name, summary: `Recalled ${out.length} image memory${out.length === 1 ? "" : "s"}${q ? ` matching "${q.slice(0, 40)}"` : ""}`, ok: true },
        };
      }
      case "delete_image":
      case "delete_image_memory": {
        // Per-tool permission gate. Defaults to allowed.
        const { data: prefs } = await supabase
          .from("user_settings")
          .select("chat_tool_permissions" as any)
          .maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return {
            result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings → AI permissions → Images.` },
            event: { name, summary: `${name} blocked by user settings`, ok: false },
          };
        }
        if (args.confirm !== true) {
          return {
            result: { error: "Deletion requires confirm:true. Paraphrase the exact image back to the user, get explicit approval, then retry with confirm:true." },
            event: { name, summary: "Refused: confirmation required", ok: false },
          };
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return { result: { error: "Not signed in" }, event: { name, summary: "Not signed in", ok: false } };

        if (name === "delete_image") {
          const imageId = String(args.image_id || "").trim();
          if (!imageId) return { result: { error: "image_id required" }, event: { name, summary: "Missing image_id", ok: false } };
          const row = await fetchImageById(imageId);
          if (!row) return { result: { error: "Image not found or not owned by current user" }, event: { name, summary: "Image not found", ok: false } };
          try {
            await deleteImageAttachment({ id: row.id, storage_path: row.storage_path });
          } catch (e: any) {
            return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Image delete failed", ok: false } };
          }
          try { window.dispatchEvent(new CustomEvent("image-attachments-changed", { detail: { deleted: [row.id] } })); } catch {}
          return {
            result: { ok: true, deleted_id: row.id, prompt: (row.prompt || "").slice(0, 80) },
            event: { name, summary: `Deleted image: "${(row.prompt || "").slice(0, 60)}"`, ok: true },
          };
        } else {
          const memId = String(args.memory_id || "").trim();
          if (!memId) return { result: { error: "memory_id required" }, event: { name, summary: "Missing memory_id", ok: false } };
          const { data: mem, error: fErr } = await (supabase.from("image_memories" as any) as any)
            .select("id, caption, storage_path, user_id")
            .eq("id", memId)
            .maybeSingle();
          if (fErr) throw fErr;
          if (!mem || (mem as any).user_id !== uid) {
            return { result: { error: "Image memory not found or not owned by current user" }, event: { name, summary: "Memory not found", ok: false } };
          }
          try {
            await deleteImageMemory({ id: (mem as any).id, storage_path: (mem as any).storage_path });
          } catch (e: any) {
            return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Memory delete failed", ok: false } };
          }
          try { window.dispatchEvent(new CustomEvent("image-memories-changed", { detail: { deleted: [(mem as any).id] } })); } catch {}
          return {
            result: { ok: true, deleted_id: (mem as any).id, caption: ((mem as any).caption || "").slice(0, 80) },
            event: { name, summary: `Deleted image memory${(mem as any).caption ? `: "${(mem as any).caption.slice(0, 60)}"` : ""}`, ok: true },
          };
        }
      }
      case "generate_video": {
        if (deps.isPaid === false) {
          return { result: { error: "Video generation is a Pro feature. Tell the user that upgrading to Pro or Lifetime unlocks it." }, event: { name, summary: "Video generation is a Pro feature", ok: false } };
        }
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return { result: { error: "prompt required" }, event: { name, summary: "Missing prompt", ok: false } };

        // Pre-flight: don't spend if the video tables/bucket aren't migrated
        // yet (Lovable doesn't auto-run migrations). Refuse cleanly so the
        // user isn't billed for a clip that can't be stored or shown.
        {
          const { error: capErr } = await (supabase.from("video_generations" as any) as any)
            .select("id", { head: true, count: "exact" }).limit(1);
          if (capErr) {
            return {
              result: { error: "Video generation isn't set up yet — the database migration (the generated-videos bucket + video_generations table) hasn't been applied. Tell the user to run the pending video SQL migration in Supabase, then try again." },
              event: { name, summary: "Video tables not migrated yet", ok: false },
            };
          }
        }

        // ── Identity inputs (explicit args override the master's bundle) ────
        const motionMode = String(args.motion_mode || "text").trim();
        const tierArg = String(args.tier || "standard").trim();
        const refIdsArg: string[] = Array.isArray(args.reference_image_ids)
          ? args.reference_image_ids.map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 4)
          : [];
        const wantsIdentity = !!(args.master_id || args.image_id || args.image_url || args.splat_id
          || refIdsArg.length > 0 || motionMode === "motion_plate" || tierArg === "draft");

        // Identity features need their migration; pure text-to-video does not.
        if (wantsIdentity && !(await videoIdentityMigrated())) {
          return {
            result: { error: "Identity-conditioned video isn't set up yet — the video_identity SQL migration hasn't been applied (plain text-to-video still works). Tell the user to run it in Supabase, then try again." },
            event: { name, summary: "Identity migration not applied", ok: false },
          };
        }

        let master: MasterAssetRow | null = null;
        if (args.master_id) {
          if (!(await mastersMigrated())) {
            return {
              result: { error: "Master assets aren't set up yet — the master_assets SQL migration hasn't been applied. Tell the user to run it in Supabase. Meanwhile you can pass image_id / reference_image_ids directly." },
              event: { name, summary: "Master assets not migrated yet", ok: false },
            };
          }
          master = await resolveMaster(String(args.master_id));
          if (!master) {
            return {
              result: { error: `No master asset "${String(args.master_id)}" found. Use list_master_assets to see what exists, or lock_master_asset to create one.` },
              event: { name, summary: "Master asset not found", ok: false },
            };
          }
        }

        const heroImageId: string | null = String(args.image_id || "").trim() || master?.hero_image_id || null;
        const heroImageUrlDirect: string | null = String(args.image_url || "").trim() || null;
        if (heroImageUrlDirect && !/^https?:\/\//i.test(heroImageUrlDirect)) {
          return { result: { error: "image_url must be an http(s) URL." }, event: { name, summary: "Bad image_url", ok: false } };
        }
        const refIds: string[] = refIdsArg.length > 0 ? refIdsArg : (master?.view_image_ids || []);
        const splatId: string | null = String(args.splat_id || "").trim() || master?.splat_id || null;
        const masterId = master?.id || null;

        const negatives: string[] = [
          ...(Array.isArray(args.negative_constraints)
            ? args.negative_constraints
            : typeof args.negative_constraints === "string" && args.negative_constraints.trim()
              ? [args.negative_constraints]
              : []),
          ...(master ? masterNegatives(master) : []),
        ].map((s: any) => String(s || "").trim()).filter(Boolean)
          .filter((s: string, i: number, a: string[]) => a.indexOf(s) === i).slice(0, 20);
        const lockPalette: string[] = (Array.isArray(args.lock_palette) && args.lock_palette.length > 0
          ? args.lock_palette : (master?.palette || []))
          .map((s: any) => String(s || "").trim()).filter(Boolean).slice(0, 12);
        const assemblyTag = (String(args.assembly_instruction || "").trim() || master?.assembly_tag || "").slice(0, 300);
        const identityScale = typeof args.identity_scale === "number"
          ? Math.min(1, Math.max(0, args.identity_scale))
          : (typeof deps.videoIdentityScale === "number" ? deps.videoIdentityScale : 0.85);
        const threshold = typeof deps.videoConfirmThreshold === "number" ? deps.videoConfirmThreshold : 1.0;

        // ── Branch 1: motion transfer (fal key — OpenRouter has no driving-video path) ──
        if (motionMode === "motion_plate") {
          const falKey = (deps.falApiKey || "").trim();
          if (!falKey) {
            return {
              result: { error: "Motion transfer bills to a fal.ai key (separate from OpenRouter), and none is set. Tell the user to add one in Settings → 3D models." },
              event: { name, summary: "No fal.ai key for motion transfer", ok: false },
            };
          }
          const motionVideoId = String(args.motion_video_id || "").trim();
          if (!motionVideoId) {
            return {
              result: { error: "motion_plate needs motion_video_id — a stored clip (see list_videos) of a HUMAN performing the motion (unoccluded, head and upper body visible). The character's identity comes from the master/image; the clip only supplies kinematics." },
              event: { name, summary: "Missing motion_video_id", ok: false },
            };
          }
          const driver = await fetchVideoById(motionVideoId);
          if (!driver || driver.status !== "completed" || !driver.storage_path) {
            return { result: { error: "That driving clip wasn't found or isn't finished yet." }, event: { name, summary: "Driving clip unavailable", ok: false } };
          }
          // One paid fal job at a time (fal keys have no spend ceiling) —
          // same cross-tab rail the splat path uses.
          try {
            if (await hasInFlightFalVideo()) {
              return {
                result: { error: "A fal-billed video is already generating. Wait for it to finish before starting another." },
                event: { name, summary: "A fal video is already in flight", ok: false },
              };
            }
          } catch { /* if the check itself fails, fall through rather than block */ }
          let motionModel = String(args.model || "").trim();
          if (!getFalVideoModel(motionModel) || getFalVideoModel(motionModel)?.kind !== "motion") {
            motionModel = (deps.videoMotionModel && getFalVideoModel(deps.videoMotionModel)?.kind === "motion")
              ? deps.videoMotionModel : DEFAULT_MOTION_MODEL;
          }
          const mInfo = getFalVideoModel(motionModel)!;
          // The output length follows the DRIVER clip. Reconstructed rows can
          // have duration_s null — unknown length means unknown price AND an
          // unverifiable driving-length cap, so it must fail safe to explicit
          // confirmation instead of assuming the cheapest case.
          const knownDuration = typeof driver.duration_s === "number" && driver.duration_s > 0
            ? driver.duration_s : null;
          const cap = mInfo.maxDrivingSeconds || 30;
          if (knownDuration != null && knownDuration > cap) {
            return {
              result: { error: `The driving clip is ${knownDuration}s but ${motionModel} caps driving video at ${cap}s. Use a shorter clip${motionModel === DEFAULT_MOTION_MODEL ? "" : ` or the default ${DEFAULT_MOTION_MODEL} (30s cap)`}.` },
              event: { name, summary: "Driving clip too long", ok: false },
            };
          }
          if (knownDuration == null && args.confirm !== true) {
            return {
              result: {
                needs_confirmation: true, model: motionModel,
                error: `The driving clip's length isn't recorded, so I can't estimate the cost (billed per output second to the user's fal.ai key, up to ~${formatUSD((mInfo.perSecondUSD || 0.126) * cap)} at the ${cap}s cap) or verify it fits the model's ${cap}s driving limit. Tell the user this and only recall with confirm:true after they accept the unknown cost.`,
              },
              event: { name, summary: "Confirm needed — driving clip length unknown", ok: false },
            };
          }
          const durationS = knownDuration ?? cap; // post-confirm: estimate at the cap, never below
          const refsIgnoredNote = refIdsArg.length > 0
            ? "reference_image_ids do not apply to motion transfer (identity comes from the single character image) — they were not sent."
            : null;
          let charUrl: string;
          let sourceIds: string[] = [];
          if (heroImageUrlDirect) {
            charUrl = heroImageUrlDirect;
          } else if (heroImageId) {
            try {
              const r = await resolveVideoSourceImages([heroImageId]);
              charUrl = r.urls[0];
              sourceIds = [heroImageId];
            } catch (e: any) {
              return { result: { error: e?.message || "Could not prepare the identity image." }, event: { name, summary: "Identity image unavailable", ok: false } };
            }
          } else {
            return {
              result: { error: "Motion transfer needs an identity image — pass master_id (preferred) or image_id so the character's appearance is locked." },
              event: { name, summary: "No identity image for motion transfer", ok: false },
            };
          }
          const estCost = estimateFalVideoCostUSD(motionModel, { durationS });
          if (args.confirm !== true) {
            if (estCost != null && estCost > threshold) {
              return {
                result: {
                  needs_confirmation: true, estimated_cost_usd: Number(estCost.toFixed(2)), model: motionModel, duration_s: durationS,
                  error: `This ${durationS}s motion-transfer clip on ${motionModel} will cost about ${formatUSD(estCost)}, billed to the user's fal.ai key. Tell the user and only recall with confirm:true after they agree.`,
                },
                event: { name, summary: `Confirm needed — ~${formatUSD(estCost)} motion transfer`, ok: false },
              };
            }
            if (estCost == null) {
              return {
                result: { needs_confirmation: true, model: motionModel, error: `I couldn't verify the price for "${motionModel}". Ask the user to approve before proceeding; only then recall with confirm:true.` },
                event: { name, summary: `Confirm needed — price unknown for ${motionModel}`, ok: false },
              };
            }
          }
          const driverUrl = await getSignedVideoUrl(driver.storage_path);
          if (!driverUrl) {
            return { result: { error: "Could not prepare the driving clip." }, event: { name, summary: "Driving clip unavailable", ok: false } };
          }
          let jobId: string;
          try {
            ({ jobId } = await submitMotionTransfer({
              apiKey: falKey, model: motionModel,
              characterImageUrl: charUrl, drivingVideoUrl: driverUrl, prompt,
            }));
          } catch (e: any) {
            return { result: { error: e?.message || "Motion transfer submit failed" }, event: { name, summary: "Motion transfer submit failed", ok: false } };
          }
          try {
            await insertPendingVideo({
              // Store the KNOWN duration only — durationS may be the cap used
              // for a conservative estimate, which is not clip metadata.
              jobId, model: motionModel, prompt, durationS: knownDuration, estCost,
              provider: "fal", motionMode: "motion_plate", motionVideoId,
              sourceImageIds: sourceIds, masterId,
              assemblyInstruction: assemblyTag || null,
              negativeConstraints: negatives, lockPalette,
            });
          } catch (e) {
            console.warn("[generate_video] insertPendingVideo failed", e);
          }
          const ref: ChatVideoRef = { job_id: jobId, prompt, model: motionModel };
          return {
            result: {
              ok: true, job_id: jobId, provider: "fal", model: motionModel, motion_mode: "motion_plate",
              duration_s: knownDuration, estimated_cost_usd: estCost != null ? Number(estCost.toFixed(2)) : null,
              source: { master: master?.name || null, image_ids: sourceIds, motion_video_id: motionVideoId },
              ...(refsIgnoredNote ? { not_applicable: [refsIgnoredNote] } : {}),
              note: "A live 'generating video' card is shown inline. Identity comes from the image; kinematics from the driving clip (which must show a human performer — if it doesn't, the model will likely fail or produce garbage; warn the user if unsure). Report the source master/image and driving clip to the user. Do NOT claim the video is ready.",
              __videos: [ref],
            },
            event: { name, summary: `Motion transfer from clip ${motionVideoId.slice(0, 8)}`, ok: true },
          };
        }

        // ── Branch 2: draft reference tier (fal / Vidu Q2, flat-priced) ─────
        if (tierArg === "draft") {
          const falKey = (deps.falApiKey || "").trim();
          if (!falKey) {
            return {
              result: { error: "The draft tier bills to a fal.ai key (separate from OpenRouter), and none is set. Tell the user to add one in Settings → 3D models, or use the standard tier." },
              event: { name, summary: "No fal.ai key for draft tier", ok: false },
            };
          }
          // One paid fal job at a time — same rail as the motion branch.
          try {
            if (await hasInFlightFalVideo()) {
              return {
                result: { error: "A fal-billed video is already generating. Wait for it to finish before starting another." },
                event: { name, summary: "A fal video is already in flight", ok: false },
              };
            }
          } catch { /* if the check itself fails, fall through rather than block */ }
          const draftModel = "fal-ai/vidu/q2/reference-to-video";
          const durationS = Math.min(8, Math.max(1, Number(args.duration) || 4));
          // Snap the resolution BEFORE pricing so the estimate always matches
          // what is actually submitted (an unknown string must never be
          // silently priced as another tier).
          let resolution = String(args.resolution || "720p").toLowerCase();
          if (!(DRAFT_RESOLUTIONS as readonly string[]).includes(resolution)) resolution = "720p";
          // Cost gate FIRST — the price doesn't depend on the pack, and
          // gating early avoids rendering splat views on a call that only
          // comes back as needs_confirmation.
          const estCost = estimateFalVideoCostUSD(draftModel, { durationS, resolution });
          if (args.confirm !== true) {
            if (estCost != null && estCost > threshold) {
              return {
                result: {
                  needs_confirmation: true, estimated_cost_usd: Number(estCost.toFixed(2)), model: draftModel,
                  error: `This ${durationS}s ${resolution} draft clip costs about ${formatUSD(estCost)}, billed to the user's fal.ai key. Confirm with the user, then recall with confirm:true.`,
                },
                event: { name, summary: `Confirm needed — ~${formatUSD(estCost)} draft clip`, ok: false },
              };
            }
            if (estCost == null) {
              // Unknown price must fail safe — never assume the cheap tier.
              return {
                result: { needs_confirmation: true, model: draftModel, error: `I couldn't verify the draft-tier price for ${resolution}. Ask the user to approve before proceeding; only then recall with confirm:true.` },
                event: { name, summary: "Confirm needed — draft price unknown", ok: false },
              };
            }
          }
          let packIds: string[] = [];
          if (heroImageId) packIds.push(heroImageId);
          for (const r of refIds) if (!packIds.includes(r)) packIds.push(r);
          let sourceSplatId: string | null = null;
          if (packIds.length === 0 && !heroImageUrlDirect && splatId) {
            try {
              const rendered = await renderSplatViews({
                splatId, frontAzimuthDeg: master?.front_azimuth_deg || 0,
                promptStem: assemblyTag || prompt,
              });
              packIds = rendered.map((r) => r.image.id);
              sourceSplatId = splatId;
            } catch (e: any) {
              return { result: { error: `Couldn't render reference views from the splat: ${e?.message || "render failed"}` }, event: { name, summary: "Splat view render failed", ok: false } };
            }
          }
          if (packIds.length === 0 && !heroImageUrlDirect) {
            return {
              result: { error: "The draft tier is reference-to-video — it needs identity images. Pass master_id, image_id, image_url, or reference_image_ids." },
              event: { name, summary: "Draft tier needs references", ok: false },
            };
          }
          // Vidu takes at most 7 references. Cap EXPLICITLY (direct URL first,
          // then ids in order) and report anything cut — never silently drop
          // an identity input, and never record an image that wasn't sent.
          const VIDU_MAX_REFS = 7;
          const idBudget = VIDU_MAX_REFS - (heroImageUrlDirect ? 1 : 0);
          const sentIds = packIds.slice(0, Math.max(0, idBudget));
          const droppedIds = packIds.slice(Math.max(0, idBudget));
          let urls: string[];
          try {
            ({ urls } = await resolveVideoSourceImages(sentIds));
          } catch (e: any) {
            return { result: { error: e?.message || "Could not prepare the reference images." }, event: { name, summary: "Reference images unavailable", ok: false } };
          }
          if (heroImageUrlDirect) urls.unshift(heroImageUrlDirect);
          const draftPrompt = `${assemblyTag ? assemblyTag + ". " : ""}${prompt} Keep the character exactly as shown in the reference images; change only what the motion describes.`;
          let jobId: string;
          try {
            ({ jobId } = await submitReferenceDraft({
              apiKey: falKey, prompt: draftPrompt, referenceImageUrls: urls,
              durationS, resolution, aspectRatio: String(args.aspect_ratio || "").trim() || undefined,
            }));
          } catch (e: any) {
            return { result: { error: e?.message || "Draft submit failed" }, event: { name, summary: "Draft submit failed", ok: false } };
          }
          try {
            await insertPendingVideo({
              jobId, model: draftModel, prompt: draftPrompt, durationS, resolution, estCost,
              provider: "fal", conditionMode: "reference", identityScale,
              // Only images that were ACTUALLY sent — the row feeds QC.
              sourceImageIds: sentIds, sourceSplatId, masterId,
              assemblyInstruction: assemblyTag || null,
              negativeConstraints: negatives, lockPalette,
            });
          } catch (e) {
            console.warn("[generate_video] insertPendingVideo failed", e);
          }
          const ref: ChatVideoRef = { job_id: jobId, prompt: draftPrompt, model: draftModel };
          return {
            result: {
              ok: true, job_id: jobId, provider: "fal", model: draftModel, tier: "draft",
              condition_mode: "reference", reference_count: urls.length,
              estimated_cost_usd: estCost != null ? Number(estCost.toFixed(2)) : null,
              source: { master: master?.name || null, image_ids: sentIds, splat_id: sourceSplatId },
              ...(droppedIds.length > 0 ? {
                refs_truncated: `${droppedIds.length} reference image(s) exceeded Vidu's ${VIDU_MAX_REFS}-image cap and were NOT sent: ${droppedIds.join(", ")}. Mention this to the user; trim the master's view pack if it grew too large.`,
              } : {}),
              note: "Draft identity clip generating (flat-priced). Report the sources and condition_mode to the user; suggest re-rendering the winning motion on the standard tier for final quality. Do NOT claim the video is ready.",
              __videos: [ref],
            },
            event: { name, summary: `Draft identity clip (${urls.length} refs): "${prompt.slice(0, 40)}"`, ok: true },
          };
        }

        // ── Branch 3: standard OpenRouter path (text or image-conditioned) ──
        const apiKey = (deps.openRouterApiKey || "").trim();
        if (!apiKey) {
          return { result: { error: "OpenRouter API key not configured — ask the user to add one in Settings." }, event: { name, summary: "OpenRouter key missing", ok: false } };
        }

        const model = String(args.model || deps.videoModelPrimary || DEFAULT_VIDEO_MODEL).trim();

        // Load the (cached) video catalog to validate params + estimate cost.
        let catalogModel: VideoModel | null = null;
        try {
          const models = await fetchVideoModels();
          catalogModel = models.find((m) => m.id === model) || null;
        } catch { /* offline — handled below: identity needs the catalog, text doesn't */ }

        const supportedDurations: number[] = catalogModel?.supported_durations || [];
        const supportedResolutions: string[] = catalogModel?.supported_resolutions || [];

        let duration = Number(args.duration) || Number(deps.videoDefaultDuration) || 6;
        if (supportedDurations.length) {
          duration = supportedDurations.reduce(
            (best, d) => (Math.abs(d - duration) < Math.abs(best - duration) ? d : best),
            supportedDurations[0],
          );
        }
        let resolution = String(args.resolution || deps.videoDefaultResolution || "").trim();
        if (supportedResolutions.length && (!resolution || !supportedResolutions.includes(resolution))) {
          resolution = supportedResolutions.includes("720p") ? "720p" : supportedResolutions[0];
        }
        const aspectRatio = String(args.aspect_ratio || deps.videoDefaultAspect || "").trim() || undefined;
        const generateAudio = typeof args.generate_audio === "boolean"
          ? args.generate_audio
          : (typeof deps.videoGenerateAudio === "boolean" ? deps.videoGenerateAudio : undefined);

        // ── Resolve the conditioning mode. NEVER silently drop an identity
        //    input: unsupported combinations error with working alternatives,
        //    and anything not sent is REPORTED, never omitted quietly. ──
        let frameImages: Array<{ url: string; frameType: "first_frame" | "last_frame" }> | undefined;
        let inputReferences: string[] | undefined;
        let conditionMode: "first_frame" | "reference" | null = null;
        let sourceImageIds: string[] = [];
        let sourceSplatId: string | null = null;
        const identityNotes: string[] = [];

        if (wantsIdentity) {
          if (!catalogModel) {
            return {
              result: { error: `Couldn't load the video model catalog to validate image conditioning for "${model}" (offline?). Try again, or generate without identity inputs.` },
              event: { name, summary: "Catalog unavailable for identity validation", ok: false },
            };
          }
          // Early cost gate on the BASE estimate (no conditioning surcharge
          // yet): when even the base price needs confirmation, return before
          // the splat render below so the confirm round-trip doesn't create a
          // duplicate set of view images.
          if (args.confirm !== true && splatId && !heroImageId && refIds.length === 0 && !heroImageUrlDirect) {
            const baseEst = estimateClipCostUSD(catalogModel, { duration, resolution, audio: generateAudio });
            if (baseEst != null && baseEst > threshold) {
              return {
                result: {
                  needs_confirmation: true,
                  estimated_cost_usd: Number(baseEst.toFixed(2)),
                  model, duration_s: duration, resolution,
                  error: `This ${duration}s ${resolution} clip on ${model} will cost about ${formatUSD(baseEst)} (image conditioning can add slightly more on some models), billed to the user's OpenRouter key. Tell the user and only recall with confirm:true after they agree.`,
                },
                event: { name, summary: `Confirm needed — ~${formatUSD(baseEst)} for a ${duration}s clip`, ok: false },
              };
            }
          }
          // Splat → auto-rendered multi-view pack (free, client GPU) when no
          // explicit images were given. The splat is never animated directly.
          let effHeroId = heroImageId;
          let effRefIds = [...refIds];
          if (splatId && !effHeroId && effRefIds.length === 0 && !heroImageUrlDirect) {
            try {
              const rendered = await renderSplatViews({
                splatId, frontAzimuthDeg: master?.front_azimuth_deg || 0,
                promptStem: assemblyTag || prompt,
              });
              effHeroId = rendered.find((r) => r.view === "front")?.image.id || rendered[0]?.image.id || null;
              effRefIds = rendered.map((r) => r.image.id).filter((id) => id !== effHeroId);
              sourceSplatId = splatId;
            } catch (e: any) {
              return { result: { error: `Couldn't render views from the splat: ${e?.message || "render failed"}. You can call render_splat_views yourself, then pass the image ids.` }, event: { name, summary: "Splat view render failed", ok: false } };
            }
          } else if (splatId) {
            sourceSplatId = splatId;
          }

          // Precedence when BOTH a stored image and a direct URL are given:
          // the stored image wins (it stays recorded on the row and drives
          // QC); the URL is set aside and the override is reported.
          let heroUrlDirect: string | null = heroImageUrlDirect;
          if (effHeroId && heroUrlDirect) {
            identityNotes.push("Both image_id and image_url were given — the stored image (image_id) was used; the raw image_url was not sent.");
            heroUrlDirect = null;
          }

          const canFirst = supportsFrameImage(catalogModel, "first_frame");
          const canRefs = supportsReferenceImages(model);
          const requested = String(args.condition_mode || "identity_lock");
          const hasHero = !!(effHeroId || heroUrlDirect);
          const hasRefs = effRefIds.length > 0;

          // A view pack with no hero on a first-frame-only model: promote the
          // first view (front, by pack construction) to the frame anchor
          // rather than dead-ending — common for splat-locked masters on the
          // default Veo model.
          const promoteViewToHero = () => {
            effHeroId = effRefIds[0];
            effRefIds = effRefIds.slice(1);
            identityNotes.push(`No hero image was set, so the pack's front view (${effHeroId}) anchors the first frame.`);
          };

          let mode: "first_frame" | "reference";
          if (requested === "first_frame") {
            if (!canFirst) {
              return {
                result: { error: `"${model}" does not support first-frame image conditioning — no silent ignore. Switch to a model that does (e.g. ${DEFAULT_VIDEO_MODEL}, kwaivgi/kling-v3.0-std, alibaba/wan-2.7) or detach the image.` },
                event: { name, summary: `${model} can't do first_frame`, ok: false },
              };
            }
            if (!hasHero && hasRefs) promoteViewToHero();
            else if (!hasHero) return { result: { error: "condition_mode first_frame needs image_id (or a master with a hero image)." }, event: { name, summary: "first_frame needs an image", ok: false } };
            mode = "first_frame";
          } else if (requested === "reference") {
            if (!hasHero && !hasRefs) return { result: { error: "condition_mode reference needs reference_image_ids and/or image_id (or a master with a view pack)." }, event: { name, summary: "reference needs images", ok: false } };
            if (!canRefs) {
              return {
                result: { error: `"${model}" does not support multi-image reference packs — no silent ignore. Reference-capable models: ${referenceCapableModelIds().join(", ")}. Or use condition_mode first_frame with just image_id.` },
                event: { name, summary: `${model} can't do reference packs`, ok: false },
              };
            }
            mode = "reference";
          } else {
            // identity_lock: strongest mode this model supports.
            if (hasRefs && canRefs) mode = "reference";
            else if (hasHero && canFirst) mode = "first_frame";
            else if ((hasHero || hasRefs) && canRefs) mode = "reference";
            else if (hasRefs && canFirst) { promoteViewToHero(); mode = "first_frame"; }
            else {
              return {
                result: { error: `"${model}" supports no image conditioning at all (e.g. Sora 2 Pro is text-only on this API) — attaching identity inputs would either fail or be silently ignored, so this call is refused. Use ${DEFAULT_VIDEO_MODEL} (first-frame) or a reference-capable model: ${referenceCapableModelIds().slice(0, 3).join(", ")}.` },
                event: { name, summary: `${model} does not support identity lock`, ok: false },
              };
            }
          }

          // Resolve the actual URLs (signed, 24h) — after mode selection so we
          // never sign images that won't be sent, and record ONLY what is sent.
          try {
            if (mode === "first_frame") {
              let heroUrl = heroUrlDirect;
              if (effHeroId) {
                const r = await resolveVideoSourceImages([effHeroId]);
                heroUrl = r.urls[0];
                sourceImageIds = [effHeroId];
              }
              frameImages = [{ url: heroUrl as string, frameType: "first_frame" }];
              if (effRefIds.length > 0) {
                identityNotes.push(`first_frame mode uses only the anchor image — the ${effRefIds.length}-image reference pack was NOT sent. For full multi-view identity lock use one of: ${referenceCapableModelIds().slice(0, 4).join(", ")} — or tier:"draft".`);
              }
            } else {
              const maxRefs = Math.max(1, maxReferenceImages(model));
              const allIds = [...(effHeroId ? [effHeroId] : []), ...effRefIds]
                .filter((id, i, a) => a.indexOf(id) === i);
              const idBudget = maxRefs - (heroUrlDirect ? 1 : 0);
              const sentIds = allIds.slice(0, Math.max(0, idBudget));
              const droppedIds = allIds.slice(Math.max(0, idBudget));
              const r = await resolveVideoSourceImages(sentIds);
              const urls = heroUrlDirect ? [heroUrlDirect, ...r.urls] : [...r.urls];
              inputReferences = urls;
              sourceImageIds = sentIds;
              if (droppedIds.length > 0) {
                identityNotes.push(`${droppedIds.length} reference image(s) exceeded "${model}"'s ${maxRefs}-image cap and were NOT sent: ${droppedIds.join(", ")}. Mention this to the user.`);
              }
            }
          } catch (e: any) {
            return { result: { error: e?.message || "Could not prepare the identity images." }, event: { name, summary: "Identity images unavailable", ok: false } };
          }
          conditionMode = mode;
        }

        // Prompt composition: identity lives in the images; the text carries
        // ONE short tag + motion/camera. The tag must never contradict the refs.
        const finalPrompt = conditionMode
          ? `${assemblyTag ? assemblyTag + ". " : ""}${prompt}${conditionMode === "reference" ? " Keep the character exactly as shown in the reference images; change only what the motion describes." : ""}`
          : prompt;

        // Negatives + identity strength via provider passthrough, gated on the
        // model's live allowlist (unknown keys are silently dropped upstream,
        // so we report what was actually applied).
        const passthrough = buildPassthrough({
          modelId: model, catalogModel,
          negatives: conditionMode ? negatives : (negatives.length > 0 ? negatives : undefined),
          identityScale: conditionMode ? identityScale : undefined,
        });

        const imageInputCount = frameImages ? frameImages.length : (inputReferences?.length || 0);
        const estCost = catalogModel
          ? estimateClipCostUSD(catalogModel, { duration, resolution, audio: generateAudio, imageInputCount })
          : null;
        // A null estimate is only "safe/cheap" for a KNOWN token-priced model
        // (e.g. Seedance). A null from a missing catalog OR an unrecognized
        // per-second pricing shape must fail safe and confirm.
        const tokenPriced = catalogModel ? isTokenPriced(catalogModel) : false;
        if (args.confirm !== true) {
          if (estCost != null && estCost > threshold) {
            return {
              result: {
                needs_confirmation: true,
                estimated_cost_usd: Number(estCost.toFixed(2)),
                model, duration_s: duration, resolution,
                error: `This ${duration}s ${resolution} clip on ${model}${imageInputCount ? ` (${imageInputCount} conditioning image${imageInputCount > 1 ? "s" : ""} — some providers price image-conditioned video higher)` : ""} will cost about ${formatUSD(estCost)}, billed to the user's OpenRouter key. Tell the user the estimated cost and ask them to confirm; only then call generate_video again with confirm:true.`,
              },
              event: { name, summary: `Confirm needed — ~${formatUSD(estCost)} for a ${duration}s clip`, ok: false },
            };
          }
          if (estCost == null && !tokenPriced) {
            // Fail safe: no per-second price (catalog unavailable or an
            // unrecognized pricing shape). Don't silently spend — one unguarded
            // clip can cost 10–50× an image. Require confirmation.
            return {
              result: {
                needs_confirmation: true,
                model, duration_s: duration, resolution,
                error: `I couldn't verify the per-second price for "${model}" right now. Video is billed per second to the user's OpenRouter key, so tell the user you can't confirm the exact cost and ask them to approve before proceeding; only then call generate_video again with confirm:true.`,
              },
              event: { name, summary: `Confirm needed — price unknown for ${model}`, ok: false },
            };
          }
        }

        let jobId: string;
        try {
          ({ jobId } = await submitVideo({
            apiKey, model, prompt: finalPrompt, duration,
            resolution: resolution || undefined, aspectRatio, generateAudio,
            frameImages, inputReferences, providerOptions: passthrough.providerOptions,
          }));
        } catch (e: any) {
          return { result: { error: e?.message || "Video submit failed" }, event: { name, summary: "Video submit failed", ok: false } };
        }
        try {
          await insertPendingVideo({
            jobId, model, prompt: finalPrompt,
            durationS: duration, resolution: resolution || null,
            aspectRatio: aspectRatio || null, hasAudio: generateAudio ?? null, estCost,
            sourceImageIds: sourceImageIds.length > 0 ? sourceImageIds : null,
            sourceSplatId, masterId,
            conditionMode, identityScale: conditionMode ? identityScale : null,
            assemblyInstruction: conditionMode && assemblyTag ? assemblyTag : null,
            negativeConstraints: negatives, lockPalette,
          });
        } catch (e: any) {
          // The job is running on OpenRouter; the bubble can still poll by job_id.
          console.warn("[generate_video] insertPendingVideo failed", e);
        }
        const ref: ChatVideoRef = { job_id: jobId, prompt: finalPrompt, model };
        return {
          result: {
            ok: true, job_id: jobId, model, prompt: finalPrompt, duration_s: duration, resolution,
            estimated_cost_usd: estCost != null ? Number(estCost.toFixed(2)) : null,
            ...(conditionMode ? {
              condition_mode: conditionMode,
              identity_scale: identityScale,
              identity_scale_applied: passthrough.applied.identity_scale,
              negative_prompt_applied: passthrough.applied.negative_prompt,
              ...(passthrough.skipped.length > 0 ? { not_applicable: passthrough.skipped } : {}),
              source: { master: master?.name || null, image_ids: sourceImageIds, splat_id: sourceSplatId },
              ...(identityNotes.length > 0 ? { identity_notes: identityNotes } : {}),
            } : {}),
            note: `A live 'generating video' card is now shown to the user inline; it will fill in when the clip is ready (~30s to a few minutes). Do NOT claim the video is ready or output any video/markdown link — just briefly tell the user it's generating${conditionMode ? `, and report: the identity source (master/images), condition_mode=${conditionMode}, identity_scale=${identityScale}, and that a consistency check runs automatically when it completes` : ""}.`,
            __videos: [ref],
          },
          event: { name, summary: `Generating a ${duration}s ${conditionMode ? "identity-locked " : ""}video: "${prompt.slice(0, 50)}"`, ok: true },
        };
      }
      case "show_video": {
        const videoId = String(args.video_id || "").trim();
        if (!videoId) return { result: { error: "video_id required" }, event: { name, summary: "Missing video_id", ok: false } };
        const row = await fetchVideoById(videoId);
        if (!row) return { result: { error: "Video not found" }, event: { name, summary: "Video not found", ok: false } };
        const ref: ChatVideoRef = { job_id: row.job_id, prompt: row.prompt, model: row.model };
        return {
          result: {
            ok: true, video_id: row.id, status: row.status, prompt: row.prompt,
            note: row.status === "completed"
              ? "The clip is now displayed to the user inline."
              : "The clip is shown inline; it is still generating and will fill in when ready.",
            __videos: [ref],
          },
          event: { name, summary: `Showed video: "${row.prompt.slice(0, 50)}"`, ok: true },
        };
      }
      case "list_videos": {
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const rows = await searchVideos(args.query ? String(args.query) : undefined, limit);
        const out = rows.map((r) => ({
          video_id: r.id, job_id: r.job_id, prompt: (r.prompt || "").slice(0, 200),
          model: r.model, status: r.status, saved_to_memory: !!r.entry_id, created_at: r.created_at,
          // Identity linkage (absent on rows/databases from before the
          // video_identity migration).
          ...(r.master_id ? { master_id: r.master_id } : {}),
          ...(r.condition_mode ? { condition_mode: r.condition_mode } : {}),
          ...(r.motion_mode ? { motion_mode: r.motion_mode } : {}),
          ...(r.source_image_ids && r.source_image_ids.length > 0 ? { source_image_ids: r.source_image_ids } : {}),
          ...(r.source_splat_id ? { source_splat_id: r.source_splat_id } : {}),
          ...(r.qc ? { qc_verdict: r.qc.verdict, qc_identity_sim: r.qc.ref_sim_mean } : {}),
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} video(s)${args.query ? ` matching "${String(args.query).slice(0, 40)}"` : ""}`, ok: true } };
      }
      case "delete_video": {
        const { data: prefs } = await supabase.from("user_settings").select("chat_tool_permissions" as any).maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return { result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings.` }, event: { name, summary: `${name} blocked by user settings`, ok: false } };
        }
        if (args.confirm !== true) {
          return { result: { error: "Deletion requires confirm:true. Paraphrase the exact clip back to the user, get explicit approval, then retry with confirm:true." }, event: { name, summary: "Refused: confirmation required", ok: false } };
        }
        const videoId = String(args.video_id || "").trim();
        if (!videoId) return { result: { error: "video_id required" }, event: { name, summary: "Missing video_id", ok: false } };
        const row = await fetchVideoById(videoId);
        if (!row) return { result: { error: "Video not found or not owned by current user" }, event: { name, summary: "Video not found", ok: false } };
        try {
          await deleteVideoGeneration({ id: row.id, storage_path: row.storage_path, poster_path: row.poster_path });
        } catch (e: any) {
          return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Video delete failed", ok: false } };
        }
        try { window.dispatchEvent(new CustomEvent("video-generations-changed", { detail: { deleted: [row.id] } })); } catch {}
        return { result: { ok: true, deleted_id: row.id, prompt: (row.prompt || "").slice(0, 80) }, event: { name, summary: `Deleted video: "${(row.prompt || "").slice(0, 50)}"`, ok: true } };
      }
      case "generate_splat": {
        if (deps.isPaid === false) {
          return { result: { error: "3D generation is a Pro feature. Tell the user that upgrading to Pro or Lifetime unlocks it." }, event: { name, summary: "3D generation is a Pro feature", ok: false } };
        }
        const falKey = (deps.falApiKey || "").trim();
        if (!falKey) {
          return {
            result: { error: "No fal.ai API key is set. 3D generation bills to a fal.ai key, which is separate from the OpenRouter key. Tell the user to add one in Settings → 3D models (they can create one at fal.ai/dashboard/keys)." },
            event: { name, summary: "No fal.ai key set", ok: false },
          };
        }

        // Pre-flight: never spend money on fal if the splat tables/bucket aren't
        // migrated yet — the asset would be paid for and then unstorable.
        try {
          const { error: capErr } = await (supabase.from("splat_generations" as any) as any)
            .select("id", { head: true, count: "exact" })
            .limit(1);
          if (capErr) {
            return {
              result: { error: "3D generation isn't set up yet — the database migration (the generated-splats bucket + splat_generations table) hasn't been applied. Tell the user to run the pending splat SQL migration in Supabase, then try again." },
              event: { name, summary: "Splat tables not migrated yet", ok: false },
            };
          }
        } catch {
          return {
            result: { error: "3D generation isn't set up yet — the database migration hasn't been applied. Tell the user to run the pending splat SQL migration in Supabase." },
            event: { name, summary: "Splat tables not migrated yet", ok: false },
          };
        }

        // fal keys have no spend ceiling, so cap concurrency at one paid job.
        try {
          if (await hasInFlightSplat()) {
            return {
              result: { error: "A 3D model is already being generated. Wait for it to finish before starting another." },
              event: { name, summary: "A 3D generation is already in flight", ok: false },
            };
          }
        } catch { /* if the check itself fails, fall through rather than block */ }

        const quota = Number(deps.splatMonthlyQuota) || 0;
        if (quota > 0) {
          try {
            const used = await countSplatsThisMonth();
            if (used >= quota) {
              return {
                result: { error: `The user's monthly 3D limit of ${quota} is used up (${used} this month). Tell them they can raise or clear it in Settings → 3D models.` },
                event: { name, summary: `Monthly 3D limit (${quota}) reached`, ok: false },
              };
            }
          } catch { /* advisory only — the DB trigger is the real backstop */ }
        }

        const model = String(args.model || deps.splatModelPrimary || DEFAULT_SPLAT_MODEL).trim();
        const quality = String(args.quality || deps.splatDefaultQuality || "standard").trim() as QualityTier;
        const tier = getTier(quality);
        const { numGaussians, format } = tierToSubmitParams(tier.id);

        // Cost gate. Flat pricing means this normally passes silently, but it
        // still catches a price change or an unknown model.
        const estCost = estimateSplatCostUSD(model);
        const threshold = typeof deps.splatConfirmThreshold === "number" ? deps.splatConfirmThreshold : 0.1;
        if (args.confirm !== true) {
          if (estCost != null && estCost > threshold) {
            return {
              result: { error: `This 3D model will cost about ${formatUSD(estCost)}, billed to the user's fal.ai key. Tell the user the cost and ask them to confirm; only then call generate_splat again with confirm:true.` },
              event: { name, summary: `Needs confirmation (~${formatUSD(estCost)})`, ok: false },
            };
          }
          if (estCost == null) {
            return {
              result: { error: `I don't have a verified price for the 3D model "${model}". Tell the user you can't confirm the cost and ask them to approve before proceeding; only then call generate_splat again with confirm:true.` },
              event: { name, summary: "Unknown 3D model price — needs confirmation", ok: false },
            };
          }
        }

        let source: { url: string; imageId: string | null };
        try {
          source = await resolveSourceImageUrl({ imageId: args.image_id, imageUrl: args.image_url });
        } catch (e: any) {
          return {
            result: { error: `${e?.message || "No source image."} 3D generation always starts from an image — call generate_image first if one doesn't exist yet, then pass its id as image_id.` },
            event: { name, summary: "No usable source image", ok: false },
          };
        }

        const prompt = String(args.prompt || "").trim() || "3D model";

        let submitted: Awaited<ReturnType<typeof submitSplat>>;
        let usedModel = model;
        let usedFormat = format;
        try {
          submitted = await submitSplat({
            apiKey: falKey, model, imageUrl: source.url,
            numGaussians, outputFormat: format,
          });
        } catch (e: any) {
          const msg = String(e?.message || "3D submit failed");
          // A bad key or empty balance will fail identically on the fallback —
          // only retry things that look model-specific.
          const worthRetry = deps.splatAutoFallback !== false
            && model !== FALLBACK_SPLAT_MODEL
            && !/invalid .*key|insufficient/i.test(msg);
          if (!worthRetry) {
            return { result: { error: msg }, event: { name, summary: "3D submit failed", ok: false } };
          }
          try {
            usedModel = FALLBACK_SPLAT_MODEL;
            usedFormat = "splat";
            submitted = await submitSplat({ apiKey: falKey, model: usedModel, imageUrl: source.url });
          } catch (e2: any) {
            return {
              result: { error: `${msg} The backup model also failed: ${e2?.message || "unknown error"}.` },
              event: { name, summary: "3D submit failed on both models", ok: false },
            };
          }
        }

        try {
          await insertPendingSplat({
            requestId: submitted.requestId, model: usedModel, prompt,
            sourceImageId: source.imageId, format: usedFormat,
            // Only record a count the model actually honours — otherwise the
            // row (and the memory neuron built from it) would state a splat
            // count that was requested but ignored.
            splatCount: getSplatModel(usedModel)?.supportsGaussianCount ? numGaussians : null,
            statusUrl: submitted.statusUrl, responseUrl: submitted.responseUrl,
            estCost: estimateSplatCostUSD(usedModel),
          });
        } catch (e) {
          // The job is already paid for; the bubble reconstructs the row on
          // finalize, so a failed insert must not abort the turn.
          console.warn("[generate_splat] insertPendingSplat failed", e);
        }

        const ref: ChatSplatRef = { request_id: submitted.requestId, prompt, model: usedModel };
        return {
          result: {
            ok: true, request_id: submitted.requestId, model: usedModel,
            ...(usedModel !== model ? { fell_back_from: model } : {}),
            quality: tier.id, approx_file_size: tierSizeLabel(tier),
            note: "A live 'building 3D model' card is now shown to the user inline; it becomes an interactive 3D preview they can orbit. Do NOT claim it's ready or output any link — just briefly say it's being built.",
            __splats: [ref],
          },
          event: { name, summary: `Building a 3D model: "${prompt.slice(0, 50)}"`, ok: true },
        };
      }
      case "show_splat": {
        const splatId = String(args.splat_id || "").trim();
        if (!splatId) return { result: { error: "splat_id required" }, event: { name, summary: "Missing splat_id", ok: false } };
        const row = await fetchSplatById(splatId);
        if (!row) return { result: { error: "3D model not found" }, event: { name, summary: "Splat not found", ok: false } };
        const ref: ChatSplatRef = { request_id: row.request_id, prompt: row.prompt, model: row.model };
        return {
          result: {
            ok: true, splat_id: row.id, status: row.status, prompt: row.prompt,
            saved_to_memory: !!row.entry_id,
            note: "The 3D model is now shown inline. Don't output a link.",
            __splats: [ref],
          },
          event: { name, summary: `Showed 3D model: "${(row.prompt || "").slice(0, 50)}"`, ok: true },
        };
      }
      case "list_splats": {
        const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
        const rows = await searchSplats(args.query ? String(args.query) : undefined, limit);
        const { bySplat } = await masterLinkageFor();
        const out = rows.map((r) => ({
          splat_id: r.id, prompt: (r.prompt || "").slice(0, 200), model: r.model,
          status: r.status, format: r.format, splat_count: r.splat_count,
          file_bytes: r.file_bytes, saved_to_memory: !!r.entry_id, created_at: r.created_at,
          ...(bySplat.has(r.id) ? { master: bySplat.get(r.id) } : {}),
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} 3D model(s)${args.query ? ` matching "${String(args.query).slice(0, 40)}"` : ""}`, ok: true } };
      }
      case "delete_splat": {
        const { data: prefs } = await supabase.from("user_settings").select("chat_tool_permissions" as any).maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return { result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings.` }, event: { name, summary: `${name} blocked by user settings`, ok: false } };
        }
        if (args.confirm !== true) {
          return { result: { error: "Deletion requires confirm:true. Paraphrase the exact 3D model back to the user, get explicit approval, then retry with confirm:true." }, event: { name, summary: "Refused: confirmation required", ok: false } };
        }
        const splatId = String(args.splat_id || "").trim();
        if (!splatId) return { result: { error: "splat_id required" }, event: { name, summary: "Missing splat_id", ok: false } };
        const row = await fetchSplatById(splatId);
        if (!row) return { result: { error: "3D model not found or not owned by current user" }, event: { name, summary: "Splat not found", ok: false } };
        try {
          await deleteSplatGeneration({ id: row.id, storage_path: row.storage_path, poster_path: row.poster_path });
        } catch (e: any) {
          return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Splat delete failed", ok: false } };
        }
        try { window.dispatchEvent(new CustomEvent("splat-generations-changed", { detail: { deleted: [row.id] } })); } catch {}
        return { result: { ok: true, deleted_id: row.id, prompt: (row.prompt || "").slice(0, 80) }, event: { name, summary: `Deleted 3D model: "${(row.prompt || "").slice(0, 50)}"`, ok: true } };
      }
      case "render_splat_views": {
        const splatId = String(args.splat_id || "").trim();
        if (!splatId) return { result: { error: "splat_id required" }, event: { name, summary: "Missing splat_id", ok: false } };
        // Free (client GPU) — but the rendered views become image rows, so the
        // image table must exist; renderSplatViews surfaces that on its own.
        let attachMaster: MasterAssetRow | null = null;
        if (args.attach_to_master) {
          if (!(await mastersMigrated())) {
            return { result: { error: "Master assets aren't set up yet — run the master_assets SQL migration first, or call again without attach_to_master." }, event: { name, summary: "Master assets not migrated yet", ok: false } };
          }
          attachMaster = await resolveMaster(String(args.attach_to_master));
          if (!attachMaster) {
            return { result: { error: `No master asset "${String(args.attach_to_master)}" found — use list_master_assets.` }, event: { name, summary: "Master asset not found", ok: false } };
          }
        }
        let rendered;
        try {
          rendered = await renderSplatViews({
            splatId,
            views: Array.isArray(args.views) ? args.views.map(String) : undefined,
            resolution: Number(args.resolution) || undefined,
            frontAzimuthDeg: attachMaster?.front_azimuth_deg || 0,
          });
        } catch (e: any) {
          return { result: { error: e?.message || "Splat view render failed" }, event: { name, summary: "Splat view render failed", ok: false } };
        }
        if (attachMaster) {
          try {
            const merged = [...(attachMaster.view_image_ids || [])];
            for (const r of rendered) if (!merged.includes(r.image.id)) merged.push(r.image.id);
            await updateMasterAsset(attachMaster.id, { view_image_ids: merged });
          } catch (e: any) {
            // The views exist either way — report the partial failure honestly.
            return {
              result: {
                ok: true,
                views: rendered.map((r) => ({ view: r.view, azimuth_deg: r.azimuthDeg, image_id: r.image.id })),
                warning: `Views rendered, but attaching them to @${attachMaster.name} failed: ${e?.message || "update failed"}`,
                __images: rendered.map((r) => r.image),
              },
              event: { name, summary: `Rendered ${rendered.length} view(s); master attach failed`, ok: false },
            };
          }
        }
        return {
          result: {
            ok: true,
            views: rendered.map((r) => ({ view: r.view, azimuth_deg: r.azimuthDeg, image_id: r.image.id })),
            ...(attachMaster ? { attached_to_master: attachMaster.name } : {}),
            note: "The rendered views are shown to the user inline. Use their image_ids as reference_image_ids in generate_video (or they're already on the master if attached).",
            __images: rendered.map((r) => r.image),
          },
          event: { name, summary: `Rendered ${rendered.length} splat view(s)${attachMaster ? ` → @${attachMaster.name}` : ""}`, ok: true },
        };
      }
      case "lock_master_asset": {
        if (!(await mastersMigrated())) {
          return {
            result: { error: "Master assets aren't set up yet — the master_assets SQL migration hasn't been applied. Tell the user to run it in Supabase, then try again." },
            event: { name, summary: "Master assets not migrated yet", ok: false },
          };
        }
        const splatIdArg = String(args.splat_id || "").trim() || null;
        let viewIds: string[] = Array.isArray(args.view_image_ids)
          ? args.view_image_ids.map((s: any) => String(s || "").trim()).filter(Boolean)
          : [];
        // A splat with no explicit views → auto-render the 4-view pack (free).
        let autoRendered = 0;
        if (splatIdArg && viewIds.length === 0) {
          try {
            const rendered = await renderSplatViews({
              splatId: splatIdArg,
              promptStem: String(args.assembly_tag || args.name || "").trim() || undefined,
            });
            viewIds = rendered.map((r) => r.image.id);
            autoRendered = rendered.length;
          } catch (e: any) {
            return { result: { error: `Couldn't render the view pack from the splat: ${e?.message || "render failed"}. Pass view_image_ids explicitly, or lock without the splat.` }, event: { name, summary: "Splat view render failed", ok: false } };
          }
        }
        let created: MasterAssetRow;
        try {
          created = await createMasterAsset({
            name: String(args.name || ""),
            heroImageId: String(args.hero_image_id || "").trim() || null,
            viewImageIds: viewIds,
            splatId: splatIdArg,
            assemblyTag: String(args.assembly_tag || ""),
            techPack: String(args.tech_pack || ""),
            negativeConstraints: Array.isArray(args.negative_constraints) ? args.negative_constraints.map(String) : [],
            bannedTraits: Array.isArray(args.banned_traits) ? args.banned_traits.map(String) : [],
            palette: Array.isArray(args.palette) ? args.palette.map(String) : [],
            styleLock: String(args.style_lock || "custom"),
          });
        } catch (e: any) {
          return { result: { error: e?.message || "Master asset could not be created" }, event: { name, summary: "Master lock failed", ok: false } };
        }
        return {
          result: {
            ok: true, master_id: created.id, name: `@${created.name}`,
            hero_image_id: created.hero_image_id, view_count: created.view_image_ids.length,
            splat_id: created.splat_id, palette: created.palette,
            negative_constraints: created.negative_constraints, banned_traits: created.banned_traits,
            ...(autoRendered > 0 ? { auto_rendered_views: autoRendered } : {}),
            note: `Master locked. From now on, animate this asset by passing master_id "${created.id}" (or "@${created.name}") to generate_video — never re-describe its appearance in text.`,
          },
          event: { name, summary: `Locked master asset @${created.name}`, ok: true },
        };
      }
      case "list_master_assets": {
        if (!(await mastersMigrated())) {
          return {
            result: { masters: [], note: "The master_assets migration hasn't been applied yet — no masters can exist. If the user wants one, ask them to run the pending SQL migration first." },
            event: { name, summary: "Master assets not migrated yet", ok: true },
          };
        }
        const masters = await listMasterAssets();
        const out = masters.map((m) => ({
          master_id: m.id, name: `@${m.name}`, assembly_tag: m.assembly_tag,
          has_hero: !!m.hero_image_id, view_count: (m.view_image_ids || []).length,
          has_splat: !!m.splat_id, style_lock: m.style_lock,
          palette: m.palette, negative_constraints: m.negative_constraints,
          banned_traits: m.banned_traits, created_at: m.created_at,
        }));
        return { result: out, event: { name, summary: `Listed ${out.length} master asset(s)`, ok: true } };
      }
      case "delete_master_asset": {
        const { data: prefs } = await supabase.from("user_settings").select("chat_tool_permissions" as any).maybeSingle();
        const perms = (((prefs as any)?.chat_tool_permissions) || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return { result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings.` }, event: { name, summary: `${name} blocked by user settings`, ok: false } };
        }
        if (args.confirm !== true) {
          return { result: { error: "Deletion requires confirm:true. Paraphrase the master (@name) back to the user, get explicit approval, then retry with confirm:true." }, event: { name, summary: "Refused: confirmation required", ok: false } };
        }
        const master = await resolveMaster(String(args.master_id || ""));
        if (!master) return { result: { error: "Master asset not found" }, event: { name, summary: "Master not found", ok: false } };
        try {
          await deleteMasterAsset(master.id);
        } catch (e: any) {
          return { result: { error: e?.message || "Delete failed" }, event: { name, summary: "Master delete failed", ok: false } };
        }
        return {
          result: { ok: true, deleted_id: master.id, name: `@${master.name}`, note: "Only the bundle was deleted — its images, splat and neuron still exist." },
          event: { name, summary: `Deleted master asset @${master.name}`, ok: true },
        };
      }
      case "create_artifact": {
        const art = parseArtifact(args);
        if (!art) {
          return { result: { error: "Artifact needs non-empty `content` (the inner HTML/SVG body markup, no wrappers)." }, event: { name, summary: "Artifact invalid", ok: false } };
        }
        // Rendered client-side from the tool-call arguments (see ChatContext).
        return { result: { ok: true, title: art.title, kind: art.kind, bytes: art.content.length }, event: { name, summary: `Created artifact "${art.title}"`, ok: true } };
      }
      case "render_blocks": {
        const { blocks, issues } = parseBlocksVerbose((args as any).blocks ?? args);
        if (!blocks.length) {
          // Hand the validation errors back so the model can fix and re-call.
          return {
            result: {
              error: "No blocks passed validation. Fix the issues and call render_blocks again with the exact whitelisted shapes.",
              issues: issues.slice(0, 6),
            },
            event: { name, summary: "Blocks invalid — asked model to retry", ok: false },
          };
        }
        // Blocks are rendered client-side from the tool-call arguments (see
        // ChatContext); here we acknowledge + report any dropped ones.
        return {
          result: { ok: true, rendered: blocks.length, dropped: issues.length, issues: issues.slice(0, 4) },
          event: { name, summary: `Rendered ${blocks.length} block(s)${issues.length ? `, dropped ${issues.length}` : ""}`, ok: true },
        };
      }
      case "create_memory_entry":
      case "update_memory_entry":
      case "delete_memory_entry":
      case "link_memory_entries": {
        // Per-tool permission gate. Defaults to allowed.
        const { data: prefs } = await supabase
          .from("user_settings")
          .select("chat_tool_permissions" as any)
          .maybeSingle();
        const perms = ((prefs as any)?.chat_tool_permissions || {}) as Record<string, boolean>;
        if (perms[name] === false) {
          return {
            result: { error: `Tool '${name}' is disabled in the user's AI permissions. Ask the user to enable it in Settings.` },
            event: { name, summary: `${name} blocked by user settings`, ok: false },
          };
        }

        if (name === "create_memory_entry") {
          const { activeWikiId } = await getNeuronScope();
          if (!activeWikiId) return { result: { error: "No active wiki" }, event: { name, summary: "No active wiki", ok: false } };
          const { data, error } = await supabase.rpc("memory_entry_upsert" as any, {
            _id: null,
            _wiki_id: activeWikiId,
            _title: String(args.title || "").slice(0, 200),
            _content: String(args.content || ""),
            _entry_type: String(args.entry_type || "fact"),
            _tags: Array.isArray(args.tags) ? args.tags : [],
            _confidence: typeof args.confidence === "number" ? args.confidence : 0.8,
          });
          if (error) throw error;
          try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch {}
          return { result: { ok: true, entry_id: data }, event: { name, summary: `Created memory "${args.title}"`, ok: true } };
        }
        if (name === "update_memory_entry") {
          if (!args.entry_id) return { result: { error: "entry_id required" }, event: { name, summary: "Missing entry_id", ok: false } };
          const { data, error } = await supabase.rpc("memory_entry_upsert" as any, {
            _id: args.entry_id,
            _wiki_id: null,
            _title: args.title ?? null,
            _content: args.content ?? null,
            _entry_type: args.entry_type ?? null,
            _tags: Array.isArray(args.tags) ? args.tags : null,
            _confidence: typeof args.confidence === "number" ? args.confidence : null,
          });
          if (error) throw error;
          try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch {}
          return { result: { ok: true, entry_id: data }, event: { name, summary: `Updated memory`, ok: true } };
        }
        if (name === "delete_memory_entry") {
          if (!args.entry_id) return { result: { error: "entry_id required" }, event: { name, summary: "Missing entry_id", ok: false } };
          const { error } = await supabase.from("knowledge_entries").delete().eq("id", args.entry_id);
          if (error) throw error;
          try { window.dispatchEvent(new Event("knowledge-entries-changed")); } catch {}
          return { result: { ok: true }, event: { name, summary: `Deleted memory entry`, ok: true } };
        }
        // link_memory_entries
        const action = String(args.action || "upsert");
        if (action === "delete") {
          const { error } = await supabase.rpc("memory_edge_delete" as any, {
            _source: args.source_entry_id, _target: args.target_entry_id,
          });
          if (error) throw error;
          return { result: { ok: true }, event: { name, summary: `Removed link`, ok: true } };
        }
        const { error } = await supabase.rpc("memory_edge_upsert" as any, {
          _source: args.source_entry_id, _target: args.target_entry_id, _relationship: args.relation,
        });
        if (error) throw error;
        return { result: { ok: true }, event: { name, summary: `Linked entries (${args.relation})`, ok: true } };
      }

      default:
        return { result: { error: `Unknown tool ${name}` }, event: { name, summary: `Unknown tool ${name}`, ok: false } };
    }

  } catch (e: any) {
    return {
      result: { error: e?.message || "Tool failed" },
      event: { name, summary: `${name} failed: ${e?.message || "error"}`, ok: false },
    };
  }
}

export async function executeQuickSearch(
  query: string,
  token: string
): Promise<{
  citations: Array<{ title: string; url: string; snippet: string }>;
  answer?: string;
  elapsed_ms?: number;
  backend?: string;
  error?: string;
}> {
  try {
    const r = await fetch(BURPLEXITY_QUICK_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token },
      body: JSON.stringify({ query, max_results: 8, include_snippets: true }),
    });
    if (r.status === 404) {
      // Fallback to bot-ask with 15 s timeout
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);
      try {
        const fb = await fetch(BURPLEXITY_BOT_ASK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": token },
          body: JSON.stringify({ query, save_to_wiki: false }),
          signal: controller.signal,
        });
        clearTimeout(tid);
        const j = await fb.json().catch(() => ({}));
        if (!fb.ok) return { citations: [], error: j?.error || `HTTP ${fb.status}` };
        return {
          citations: pickCitations(j),
          answer: j.answer || "",
          backend: "bot-ask",
        };
      } catch {
        clearTimeout(tid);
        return { citations: [], error: "timeout" };
      }
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { citations: [], error: j?.error || `HTTP ${r.status}` };
    return {
      citations: pickCitations(j),
      answer: j.answer || "",
      elapsed_ms: j.elapsed_ms,
      backend: j.backend,
    };
  } catch (e: any) {
    return { citations: [], error: e?.message || "network failure" };
  }
}
