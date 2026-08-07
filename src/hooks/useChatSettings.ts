import { useCallback, useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { isEmbeddingModel } from "@/lib/utils";
import { modelProvider, providerConfigured, providerLabel } from "@/lib/providers/registry";

export type LeanMode = "full" | "lean" | "chat_only";

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_DEEP_RESEARCH_MODEL = "google/gemini-2.5-pro";
const DEFAULT_TTS_RATE = 1.05;
const DEFAULT_HANDS_FREE_TTS_RATE = 1.0;

interface ChatSettings {
  apiKey: string;
  /** Last 4 chars of the saved NVIDIA key — the ONLY part the client ever
   *  holds. The full key is write-only: saved via saveNvidiaKey, read back
   *  exclusively by the nvidia-chat edge function under RLS, and excluded
   *  from the debounced full-row upsert so unrelated saves can't clobber it.
   *  Non-empty ⇒ "an NVIDIA key is configured". */
  nvidiaKeyLast4: string;
  /** Google Gemini key. CLIENT-READ, unlike the NVIDIA key: Gemini's API is
   *  CORS-open, so the browser calls it directly and needs the value. Same
   *  posture as inworldApiKey. */
  geminiApiKey: string;
  /** Tavily key — the free web-search backend (1,000/month, no card).
   *  Used by web_search when no Burplexity token is set. */
  tavilyApiKey: string;
  /** Budget tier. 'full' = everything on · 'lean' = no video/3D · 'chat_only'
   *  = also no image generation and no paid web search. Enforced by removing
   *  tools from the model's roster (a capability it cannot see is one it
   *  cannot pretend to use) AND by a terminal refusal in the executor. */
  leanMode: LeanMode;
  savedModels: string[];
  selectedModel: string;
  deepResearchModel: string;
  voiceModel: string; // "" = same as selectedModel
  ttsRate: number;
  handsFreeTtsRate: number;
  autoReadReplies: boolean;
  wikiModel: string; // "" = use default Gemini gateway
  customSystemPrompt: string;
  burplexityApiToken: string;
  inworldApiKey: string;
  inworldEnabled: boolean;
  inworldVoiceId: string;
  /** When true (paid feature), chat retrieval draws on every neuron instead of only the active one. */
  accessAllNeurons: boolean;
  /** Hard cap on sentences per assistant reply (0 = off). Enforced by prompt
   *  steering + stream truncation in ChatContext; Digest/Deep Research exempt. */
  maxReplySentences: number;
  /** Memory Lens: auto-show a recalled memory's attached image the first time
   *  it's ever seen (repeats collapse to chips). Off = chips only. */
  autoShowMemoryImages: boolean;
  /** Tool Foundry progressive trust: version updates with UNCHANGED
   *  capabilities and green tests apply without a manual approval tap.
   *  New tools and capability changes always ask. Default OFF. */
  autoApproveToolUpdates: boolean;
  /** Optional override model used for chat turns that include image attachments. Falls back to selectedModel if empty. */
  visionModel: string;
  /** Vision model that describes figures extracted from uploaded documents. "" = built-in default. */
  imageExtractionModel: string;
  /** When true, figure extraction runs automatically after a book is digested. */
  autoExtractFigures: boolean;
  libraryIngestModel: string;
  libraryIngestAutoFile: boolean;
  imageModelPrimary: string;
  imageModelFallback: string;
  imageQuality: string;
  imageSize: string;
  savedImageModels: string[];
  chatToolPermissions: Record<string, boolean>;
  /** Video generation preferences (OpenRouter /api/v1/videos). */
  videoModelPrimary: string;
  savedVideoModels: string[];
  videoDefaultDuration: number; // 0 = auto (model default)
  videoDefaultResolution: string; // "" = auto
  videoDefaultAspect: string; // "" = auto
  videoGenerateAudio: boolean;
  /** USD estimate above which generate_video must be confirmed. Default 0.25,
   *  NOT 1.00: a standard 8-second clip costs ≈$0.96, so a $1 threshold meant
   *  the app's most expensive routine action never once asked first. */
  videoConfirmThreshold: number;
  videoIdentityScale: number; // default appearance-pinning strength (0-1) for identity-locked clips
  videoQcEnabled: boolean; // run the client-side consistency check on identity-locked clips
  videoMotionModel: string; // preferred fal motion-transfer endpoint ("" = default)
  /** 3D Gaussian splat generation (fal.ai). Billed to a SEPARATE fal key. */
  falApiKey: string;
  splatModelPrimary: string;
  splatDefaultQuality: string; // fast | standard | high
  splatMaxFileMb: number; // hard ceiling; an oversized asset is refused pre-upload
  splatConfirmThreshold: number;
  splatClickToActivate: boolean;
  splatMonthlyQuota: number; // 0 = unlimited
  splatAutoFallback: boolean;
}

const defaults: ChatSettings = {
  apiKey: "",
  nvidiaKeyLast4: "",
  geminiApiKey: "",
  tavilyApiKey: "",
  leanMode: "full",
  savedModels: [DEFAULT_MODEL],
  selectedModel: DEFAULT_MODEL,
  deepResearchModel: DEFAULT_DEEP_RESEARCH_MODEL,
  voiceModel: "",
  ttsRate: DEFAULT_TTS_RATE,
  handsFreeTtsRate: DEFAULT_HANDS_FREE_TTS_RATE,
  autoReadReplies: false,
  wikiModel: "",
  customSystemPrompt: "",
  burplexityApiToken: "",
  inworldApiKey: "",
  inworldEnabled: false,
  inworldVoiceId: "",
  accessAllNeurons: false,
  maxReplySentences: 0,
  autoShowMemoryImages: true,
  autoApproveToolUpdates: false,
  visionModel: "",
  imageExtractionModel: "",
  autoExtractFigures: true,
  libraryIngestModel: "",
  libraryIngestAutoFile: true,
  imageModelPrimary: "",
  imageModelFallback: "",
  imageQuality: "",
  imageSize: "",
  savedImageModels: [],
  chatToolPermissions: {},
  videoModelPrimary: "",
  savedVideoModels: [],
  videoDefaultDuration: 0,
  videoDefaultResolution: "",
  videoDefaultAspect: "",
  videoGenerateAudio: true,
  videoConfirmThreshold: 0.25,
  videoIdentityScale: 0.85,
  videoQcEnabled: true,
  videoMotionModel: "",
  falApiKey: "",
  splatModelPrimary: "",
  splatDefaultQuality: "standard",
  splatMaxFileMb: 25,
  splatConfirmThreshold: 0.1,
  splatClickToActivate: true,
  splatMonthlyQuota: 0,
  splatAutoFallback: true,
};


// ---------------------------------------------------------------------------
// Module-level shared store.
//
// useChatSettings() is mounted in several components at once (ChatPanel,
// useReadAloud, ChatContext, WikiPanel, Library). It used to keep its state in
// a per-instance useState loaded once from the DB, which caused two bugs:
//   1. Changing a setting in one place (e.g. the Inworld voice picker) never
//      reached the other copies — read-aloud kept speaking with the old voice.
//   2. Every copy's debounced save wrote the ENTIRE settings row, so a stale
//      copy saving later clobbered fresh changes in the DB (the voice kept
//      "defaulting back").
// A single store shared via useSyncExternalStore fixes both: one source of
// truth in memory, one snapshot persisted.
// ---------------------------------------------------------------------------

interface Snapshot {
  settings: ChatSettings;
  loaded: boolean;
}

let snapshot: Snapshot = { settings: defaults, loaded: false };
let loadedForUser: string | null | undefined = undefined; // undefined = never resolved
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getSnapshot = () => snapshot;

// Cross-tab sync: the Model Explorer page opens in its own tab and saves
// models there; this re-pulls settings so the main tab picks them up live.
// (BroadcastChannel never echoes to the posting tab.)
const settingsChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("bookworm-settings") : null;
settingsChannel?.addEventListener("message", (e) => {
  if (e.data !== "settings-updated") return;
  if (typeof loadedForUser !== "string") return;
  const uid = loadedForUser;
  loadedForUser = undefined;
  ensureLoaded(uid);
});

function rowToSettings(data: any): ChatSettings {
  return {
    apiKey: data.openrouter_api_key || "",
    // Deliberately NOT data.nvidia_api_key — the full key never enters
    // client state (write-only convention; see the interface comment).
    nvidiaKeyLast4: data.nvidia_key_last4 || "",
    geminiApiKey: data.gemini_api_key || "",
    tavilyApiKey: data.tavily_api_key || "",
    leanMode: (["full", "lean", "chat_only"] as const).includes(data.lean_mode)
      ? (data.lean_mode as LeanMode)
      : "full",
    savedModels: (data.saved_models as string[]) || [DEFAULT_MODEL],
    selectedModel: data.selected_model || DEFAULT_MODEL,
    deepResearchModel: data.deep_research_model || DEFAULT_DEEP_RESEARCH_MODEL,
    voiceModel: data.voice_model || "",
    ttsRate: typeof data.tts_rate === "number" && data.tts_rate > 0
      ? data.tts_rate
      : DEFAULT_TTS_RATE,
    handsFreeTtsRate: typeof data.hands_free_tts_rate === "number" && data.hands_free_tts_rate > 0
      ? data.hands_free_tts_rate
      : DEFAULT_HANDS_FREE_TTS_RATE,
    autoReadReplies: !!data.auto_read_replies,
    wikiModel: data.wiki_model || "",
    customSystemPrompt: data.custom_system_prompt || "",
    burplexityApiToken: data.burplexity_api_token || "",
    inworldApiKey: data.inworld_api_key || "",
    inworldEnabled: !!data.inworld_enabled,
    inworldVoiceId: data.inworld_voice_id || "",
    accessAllNeurons: !!data.access_all_neurons,
    maxReplySentences: typeof data.max_reply_sentences === "number" && data.max_reply_sentences > 0
      ? Math.min(12, Math.floor(data.max_reply_sentences))
      : 0,
    autoShowMemoryImages: data.auto_show_memory_images !== false,
    autoApproveToolUpdates: data.auto_approve_tool_updates === true,
    visionModel: data.vision_model || "",
    imageExtractionModel: data.image_extraction_model || "",
    autoExtractFigures: data.auto_extract_figures !== false,
    libraryIngestModel: data.library_ingest_model || "",
    libraryIngestAutoFile: data.library_ingest_auto_file !== false,
    imageModelPrimary: data.image_model_primary || "",
    imageModelFallback: data.image_model_fallback || "",
    imageQuality: data.image_quality || "",
    imageSize: data.image_size || "",
    savedImageModels: Array.isArray(data.saved_image_models) ? (data.saved_image_models as string[]) : [],
    chatToolPermissions: (data.chat_tool_permissions && typeof data.chat_tool_permissions === "object")
      ? (data.chat_tool_permissions as Record<string, boolean>)
      : {},
    videoModelPrimary: data.video_model_primary || "",
    savedVideoModels: Array.isArray(data.saved_video_models) ? (data.saved_video_models as string[]) : [],
    videoDefaultDuration: typeof data.video_default_duration === "number" ? data.video_default_duration : 0,
    videoDefaultResolution: data.video_default_resolution || "",
    videoDefaultAspect: data.video_default_aspect || "",
    videoGenerateAudio: data.video_generate_audio !== false,
    videoConfirmThreshold: typeof data.video_confirm_threshold === "number" ? data.video_confirm_threshold : 0.25,
    videoIdentityScale: typeof data.video_identity_scale === "number" ? data.video_identity_scale : 0.85,
    videoQcEnabled: data.video_qc_enabled !== false,
    videoMotionModel: data.video_motion_model || "",
    falApiKey: data.fal_api_key || "",
    splatModelPrimary: data.splat_model_primary || "",
    splatDefaultQuality: data.splat_default_quality || "standard",
    splatMaxFileMb: typeof data.splat_max_file_mb === "number" ? data.splat_max_file_mb : 25,
    splatConfirmThreshold: typeof data.splat_confirm_threshold === "number" ? data.splat_confirm_threshold : 0.1,
    splatClickToActivate: data.splat_click_to_activate !== false,
    splatMonthlyQuota: typeof data.splat_monthly_quota === "number" ? data.splat_monthly_quota : 0,
    splatAutoFallback: data.splat_auto_fallback !== false,
  };
}

// Load once per signed-in user (or resolve immediately when signed out), no
// matter how many components mount the hook.
function ensureLoaded(userId: string | null) {
  if (loadedForUser === userId) return;
  loadedForUser = userId;
  if (!userId) {
    publish({ settings: defaults, loaded: true });
    return;
  }
  void (async () => {
    // Explicit column list, NOT select("*"): the NVIDIA key must never
    // transit to the browser at all (only the relay reads it, server-side).
    // With "*" the plaintext key would sit in every settings response's JSON
    // — visible in devtools and to any XSS — even though rowToSettings drops
    // it. Falls back to "*" if a column here hasn't been migrated yet, so a
    // lagging migration still loads settings (same resilience convention as
    // the chat_messages select cascade).
    const READ_COLUMNS: string[] = [
      "user_id", "openrouter_api_key", "nvidia_key_last4", "saved_models", "selected_model",
      "deep_research_model", "voice_model", "tts_rate", "hands_free_tts_rate", "auto_read_replies",
      "wiki_model", "custom_system_prompt", "burplexity_api_token", "inworld_api_key",
      "inworld_enabled", "inworld_voice_id", "access_all_neurons", "max_reply_sentences",
      "auto_show_memory_images", "auto_approve_tool_updates", "vision_model",
      "image_extraction_model", "auto_extract_figures", "library_ingest_model",
      "library_ingest_auto_file", "image_model_primary", "image_model_fallback", "image_quality",
      "image_size", "saved_image_models", "chat_tool_permissions", "video_model_primary",
      "saved_video_models", "video_default_duration", "video_default_resolution",
      "video_default_aspect", "video_generate_audio", "video_confirm_threshold",
      "video_identity_scale", "video_qc_enabled", "video_motion_model", "fal_api_key",
      "splat_model_primary", "splat_default_quality", "splat_max_file_mb",
      "splat_confirm_threshold", "splat_click_to_activate", "splat_monthly_quota",
      "splat_auto_fallback", "gemini_api_key", "tavily_api_key", "lean_mode",
    ];
    const sel = (cols: string) => supabase
      .from("user_settings")
      .select(cols as any)
      .eq("user_id", userId)
      .maybeSingle() as any;
    // Migrations lag deploys here, so a named column may not exist yet. Strip
    // the offender and retry — the SAME convention persistSettings uses — and
    // never fall back to select("*"): that would put the write-only NVIDIA key
    // in the response body, which is the one thing the explicit list exists to
    // prevent.
    const OPTIONAL_READ = [
      "gemini_api_key", "tavily_api_key", "lean_mode", "nvidia_key_last4",
      "auto_show_memory_images", "auto_approve_tool_updates", "access_all_neurons",
      "max_reply_sentences", "image_extraction_model", "auto_extract_figures",
      "video_model_primary", "saved_video_models", "video_default_duration",
      "video_default_resolution", "video_default_aspect", "video_generate_audio",
      "video_confirm_threshold", "video_identity_scale", "video_qc_enabled",
      "video_motion_model", "fal_api_key", "splat_model_primary",
      "splat_default_quality", "splat_max_file_mb", "splat_confirm_threshold",
      "splat_click_to_activate", "splat_monthly_quota", "splat_auto_fallback",
    ];
    let cols = [...READ_COLUMNS];
    let { data, error } = await sel(cols.join(", "));
    for (let pass = 0; error && pass < OPTIONAL_READ.length; pass++) {
      const msg = (error.message || "").toLowerCase();
      const offender = OPTIONAL_READ.find((c) => cols.includes(c) && msg.includes(c));
      if (!offender) break;
      cols = cols.filter((c) => c !== offender);
      ({ data, error } = await sel(cols.join(", ")));
    }
    if (loadedForUser !== userId) return; // user changed mid-flight
    if (error) {
      console.error("Failed to load settings:", error);
      publish({ loaded: true });
      return;
    }
    publish({ settings: data ? rowToSettings(data) : defaults, loaded: true });
  })();
}

/** Human names for the settings a save carries, so a failure can say WHICH
 *  switch didn't stick. "Couldn't save settings" is not actionable; "couldn't
 *  save AI permissions" sends the user straight back to the toggle they just
 *  flipped. Anything not listed falls back to the generic phrasing. */
const SETTING_LABEL: Partial<Record<keyof ChatSettings, string>> = {
  chatToolPermissions: "AI permissions",
  apiKey: "your OpenRouter key",
  geminiApiKey: "your Gemini key",
  tavilyApiKey: "your Tavily key",
  falApiKey: "your fal.ai key",
  burplexityApiToken: "your Burplexity token",
  inworldApiKey: "your Inworld key",
  savedModels: "your saved models",
  selectedModel: "the chat model",
  deepResearchModel: "the Deep Research model",
  visionModel: "the vision model",
  voiceModel: "the voice model",
  wikiModel: "the neuron model",
  customSystemPrompt: "your custom instructions",
  autoApproveToolUpdates: "Tool Foundry auto-approval",
  accessAllNeurons: "the neuron access setting",
  maxReplySentences: "the reply-length cap",
  imageModelPrimary: "the image model",
  videoModelPrimary: "the video model",
  splatModelPrimary: "the 3D model setting",
};

/** Fields written by saves that have not yet succeeded. Accumulated across
 *  debounced calls (the timer coalesces several updates into one write), so a
 *  failure can name everything that is still only in memory. */
const pendingSaveKeys = new Set<keyof ChatSettings>();

// Debounced full-row save. Safe to write the whole row now that there is a
// single in-memory source of truth — the snapshot can no longer be stale.
//
// A failure here used to reach console.error and nowhere else, which produced
// the worst class of bug this app has: the switch reads ON, the store says ON,
// and the executors — which re-read chat_tool_permissions from the database on
// every call — still see OFF. The user is then staring at a control that is
// telling the truth about the app's memory and lying about its behaviour, with
// nothing on screen to reconcile the two. So the cascade still runs to
// exhaustion, and only then does it say so out loud.
function persistSettings(userId: string, next: ChatSettings, changed?: Array<keyof ChatSettings>) {
  if (changed) for (const k of changed) pendingSaveKeys.add(k);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // NOTE: lean_mode is intentionally absent too. It is a deliberate
    // self-binding choice, and a stale tab's full-row write must never be
    // able to silently switch spending back on — it saves through its own
    // targeted upsert (setLeanMode) instead.
    // NOTE: nvidia_api_key / nvidia_key_last4 are intentionally absent —
    // they save ONLY through saveNvidiaKey's targeted upsert, so this
    // full-row write can never blank a key the client doesn't hold.
    const payload: any = {
      user_id: userId,
      openrouter_api_key: next.apiKey,
      saved_models: next.savedModels as any,
      selected_model: next.selectedModel,
      deep_research_model: next.deepResearchModel,
      voice_model: next.voiceModel || null,
      tts_rate: next.ttsRate,
      hands_free_tts_rate: next.handsFreeTtsRate,
      auto_read_replies: next.autoReadReplies,
      wiki_model: next.wikiModel || null,
      custom_system_prompt: next.customSystemPrompt || "",
      burplexity_api_token: next.burplexityApiToken || "",
      inworld_api_key: next.inworldApiKey || "",
      gemini_api_key: next.geminiApiKey || "",
      tavily_api_key: next.tavilyApiKey || "",
      inworld_enabled: next.inworldEnabled,
      inworld_voice_id: next.inworldVoiceId || "",
      access_all_neurons: next.accessAllNeurons,
      max_reply_sentences: next.maxReplySentences || 0,
      auto_show_memory_images: next.autoShowMemoryImages,
      auto_approve_tool_updates: next.autoApproveToolUpdates,
      vision_model: next.visionModel || null,
      image_extraction_model: next.imageExtractionModel || null,
      auto_extract_figures: next.autoExtractFigures,
      library_ingest_model: next.libraryIngestModel || null,
      library_ingest_auto_file: next.libraryIngestAutoFile,
      image_model_primary: next.imageModelPrimary || null,
      image_model_fallback: next.imageModelFallback || null,
      image_quality: next.imageQuality || null,
      image_size: next.imageSize || null,
      saved_image_models: next.savedImageModels as any,
      chat_tool_permissions: next.chatToolPermissions as any,
      video_model_primary: next.videoModelPrimary || null,
      saved_video_models: next.savedVideoModels as any,
      video_default_duration: next.videoDefaultDuration || null,
      video_default_resolution: next.videoDefaultResolution || null,
      video_default_aspect: next.videoDefaultAspect || null,
      video_generate_audio: next.videoGenerateAudio,
      video_confirm_threshold: next.videoConfirmThreshold,
      video_identity_scale: next.videoIdentityScale,
      video_qc_enabled: next.videoQcEnabled,
      video_motion_model: next.videoMotionModel || null,
      fal_api_key: next.falApiKey || "",
      splat_model_primary: next.splatModelPrimary || null,
      splat_default_quality: next.splatDefaultQuality || null,
      splat_max_file_mb: next.splatMaxFileMb,
      splat_confirm_threshold: next.splatConfirmThreshold,
      splat_click_to_activate: next.splatClickToActivate,
      splat_monthly_quota: next.splatMonthlyQuota || null,
      splat_auto_fallback: next.splatAutoFallback,
    };

    let { error } = await supabase
      .from("user_settings")
      .upsert(payload, { onConflict: "user_id" });
    // Migrations can lag the client deploy — strip any not-yet-migrated
    // column and retry so one new column never breaks every settings save.
    // PostgREST reports ONE missing column per attempt (alphabetically
    // first), so keep retrying until no optional column is named.
    const optionalColumns = ["access_all_neurons", "max_reply_sentences", "auto_show_memory_images", "auto_approve_tool_updates", "image_extraction_model", "auto_extract_figures",
      "video_model_primary", "saved_video_models", "video_default_duration", "video_default_resolution",
      "video_default_aspect", "video_generate_audio", "video_confirm_threshold",
      "video_identity_scale", "video_qc_enabled", "video_motion_model",
      "gemini_api_key", "tavily_api_key", "fal_api_key", "splat_model_primary", "splat_default_quality", "splat_max_file_mb",
      "splat_confirm_threshold", "splat_click_to_activate", "splat_monthly_quota", "splat_auto_fallback"];
    for (let pass = 0; error && pass < optionalColumns.length; pass++) {
      const offender = optionalColumns.find(
        (col) => col in payload && (error!.message || "").toLowerCase().includes(col),
      );
      if (!offender) break;
      delete payload[offender];
      ({ error } = await supabase.from("user_settings").upsert(payload, { onConflict: "user_id" }));
    }
    // Report ONLY after the optional-column cascade has genuinely given up —
    // a stripped-and-retried column is a successful save, not a failure, and
    // toasting mid-cascade would cry wolf on every lagging migration.
    if (error) {
      console.error("Failed to save settings:", error);
      const named = Array.from(new Set(
        Array.from(pendingSaveKeys).map((k) => SETTING_LABEL[k]).filter((s): s is string => !!s),
      ));
      const what = named.length > 0
        ? (named.length > 2 ? `${named.slice(0, 2).join(", ")} and ${named.length - 2} more` : named.join(" and "))
        : "your settings";
      toast.error(`Couldn't save ${what}`, {
        description:
          "The change is live in this browser but never reached the server, so it won't survive a reload " +
          "and won't reach your other devices. Check your connection and change it again.",
        duration: 12000,
      });
      return;
    }
    pendingSaveKeys.clear();
    settingsChannel?.postMessage("settings-updated");
  }, 500);
}

function updateStore(userId: string | undefined, partial: Partial<ChatSettings>) {
  const next = { ...snapshot.settings, ...partial };
  publish({ settings: next });
  if (userId) persistSettings(userId, next, Object.keys(partial) as Array<keyof ChatSettings>);
}

export function useChatSettings() {
  const { user } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const settings = snap.settings;

  useEffect(() => {
    ensureLoaded(user?.id ?? null);
  }, [user]);

  const update = useCallback((partial: Partial<ChatSettings>) => {
    updateStore(user?.id, partial);
  }, [user]);

  const saveApiKey = useCallback((key: string) => {
    update({ apiKey: key });
    if (key) toast.success("API key saved");
    else toast.success("API key removed");
  }, [update]);

  /** Lean Mode saves through its OWN targeted upsert, never the debounced
   *  full-row write. A budget choice is a self-binding commitment: if a stale
   *  tab on another device could quietly revert it by saving an unrelated
   *  setting, the guarantee is worthless — and the failure mode (spending
   *  silently switched back on) is the exact one this feature exists to
   *  prevent. */
  const setLeanMode = useCallback(async (mode: LeanMode) => {
    const uid = user?.id;
    const prev = snapshot.settings.leanMode;
    if (prev === mode) return;
    publish({ settings: { ...snapshot.settings, leanMode: mode } });
    // Any failure below must ROLL BACK. A budget control that shows a tier it
    // didn't save is worse than one that refuses — the user would believe
    // spending was off. Re-spread the CURRENT snapshot so a concurrent change
    // to an unrelated field isn't clobbered, and use publish (not update) so
    // this never triggers the debounced full-row write lean_mode is excluded
    // from.
    const rollback = () => publish({ settings: { ...snapshot.settings, leanMode: prev } });
    if (!uid) { rollback(); toast.error("Sign in to change spending settings"); return; }
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: uid, lean_mode: mode } as any, { onConflict: "user_id" });
    if (error) {
      rollback();
      if ((error.message || "").toLowerCase().includes("lean_mode")) {
        toast.error("Lean Mode needs its migration — ask Lovable to run 20260731140000_gemini_and_lean_mode.sql");
      } else {
        toast.error(`Couldn't save Lean Mode: ${error.message}`);
      }
      return;
    }
    settingsChannel?.postMessage("settings-updated");
  }, [user]);

  /** Write-only NVIDIA key save: a targeted upsert of just the key columns,
   *  never part of the debounced full-row write. Only the last-4 sibling
   *  enters client state; the full key is read back exclusively by the
   *  nvidia-chat edge function. */
  const saveNvidiaKey = useCallback(async (key: string): Promise<boolean> => {
    const uid = user?.id;
    if (!uid) { toast.error("Sign in first"); return false; }
    const trimmed = key.trim();
    if (trimmed && !trimmed.startsWith("nvapi-")) {
      toast.error("NVIDIA keys start with nvapi- — generate one at build.nvidia.com → Settings → API Keys");
      return false;
    }
    const last4 = trimmed ? trimmed.slice(-4) : "";
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: uid, nvidia_api_key: trimmed, nvidia_key_last4: last4 } as any, { onConflict: "user_id" });
    if (error) {
      const m = (error.message || "").toLowerCase();
      if (m.includes("nvidia_api_key") || m.includes("nvidia_key_last4")) {
        toast.error("NVIDIA columns missing — ask Lovable to run migration 20260731093000_nvidia_provider.sql first");
      } else {
        toast.error(`Failed to save NVIDIA key: ${error.message}`);
      }
      return false;
    }
    publish({ settings: { ...snapshot.settings, nvidiaKeyLast4: last4 } });
    settingsChannel?.postMessage("settings-updated");
    toast.success(trimmed ? "NVIDIA key saved" : "NVIDIA key removed");
    return true;
  }, [user]);

  const addModel = useCallback((model: string) => {
    const id = model.trim();
    if (!id) return;
    const cur = getSnapshot().settings;
    if (cur.savedModels.includes(id)) { toast.error("Model already saved"); return; }
    const embed = isEmbeddingModel(id);
    // A model whose provider has no key can't run — adding one to try later
    // must not silently replace a working Active Chat Model. Registry-driven
    // so a new provider is covered the moment its row exists.
    const idProvider = modelProvider(id);
    const unusable = !providerConfigured(idProvider, {
      apiKey: cur.apiKey, geminiApiKey: cur.geminiApiKey, nvidiaKeyLast4: cur.nvidiaKeyLast4,
    });
    update({
      savedModels: [...cur.savedModels, id],
      // Don't make embedding models the active Chat model — they only work for Wiki reindex.
      selectedModel: embed || unusable ? cur.selectedModel : id,
    });
    if (embed) {
      toast.success(`Embedding model "${id}" added — select it in Neuron Settings.`);
    } else if (unusable) {
      toast.success(`Model "${id}" added — add your ${providerLabel(idProvider)} key in Settings to chat with it.`);
    } else {
      toast.success(`Model "${id}" added`);
    }
  }, [update]);

  const removeModel = useCallback((model: string) => {
    const cur = getSnapshot().settings;
    if (cur.savedModels.length <= 1) { toast.error("You need at least one model"); return; }
    const next = cur.savedModels.filter(m => m !== model);
    const sel = cur.selectedModel === model ? next[0] : cur.selectedModel;
    update({ savedModels: next, selectedModel: sel });
  }, [update]);

  return {
    ...settings,
    loaded: snap.loaded,
    saveApiKey,
    saveNvidiaKey,
    setLeanMode,
    setGeminiApiKey: (k: string) => update({ geminiApiKey: k.trim() }),
    setTavilyApiKey: (k: string) => update({ tavilyApiKey: k.trim() }),
    setSelectedModel: (m: string) => update({ selectedModel: m }),
    setDeepResearchModel: (m: string) => update({ deepResearchModel: m }),
    setVoiceModel: (m: string) => update({ voiceModel: m }),
    setTtsRate: (r: number) => update({ ttsRate: Math.min(2, Math.max(0.5, r)) }),
    setHandsFreeTtsRate: (r: number) => update({ handsFreeTtsRate: Math.min(2, Math.max(0.5, r)) }),
    setAutoReadReplies: (v: boolean) => update({ autoReadReplies: v }),
    setWikiModel: (m: string) => update({ wikiModel: m }),
    setCustomSystemPrompt: (p: string) => update({ customSystemPrompt: p }),
    setBurplexityApiToken: (t: string) => update({ burplexityApiToken: t.trim() }),
    setInworldApiKey: (k: string) => update({ inworldApiKey: k.trim() }),
    setInworldEnabled: (v: boolean) => update({ inworldEnabled: v }),
    setInworldVoiceId: (v: string) => update({ inworldVoiceId: v }),
    setAccessAllNeurons: (v: boolean) => update({ accessAllNeurons: v }),
    setMaxReplySentences: (n: number) => update({ maxReplySentences: Math.max(0, Math.min(12, Math.floor(Number(n) || 0))) }),
    setAutoShowMemoryImages: (v: boolean) => update({ autoShowMemoryImages: v }),
    setAutoApproveToolUpdates: (v: boolean) => update({ autoApproveToolUpdates: v }),
    setVisionModel: (m: string) => update({ visionModel: m }),
    setImageExtractionModel: (m: string) => update({ imageExtractionModel: m }),
    setAutoExtractFigures: (v: boolean) => update({ autoExtractFigures: v }),
    setLibraryIngestModel: (m: string) => update({ libraryIngestModel: m }),
    setLibraryIngestAutoFile: (v: boolean) => update({ libraryIngestAutoFile: v }),
    setImageModelPrimary: (m: string) => update({ imageModelPrimary: m }),
    setImageModelFallback: (m: string) => update({ imageModelFallback: m }),
    setImageQuality: (q: string) => update({ imageQuality: q }),
    setImageSize: (s: string) => update({ imageSize: s }),
    addImageModel: (m: string) => {
      const id = m.trim(); if (!id) return;
      const cur = getSnapshot().settings;
      if (cur.savedImageModels.includes(id)) { toast.error("Image model already saved"); return; }
      update({ savedImageModels: [...cur.savedImageModels, id], imageModelPrimary: cur.imageModelPrimary || id });
      toast.success(`Image model "${id}" added`);
    },
    removeImageModel: (m: string) => {
      const cur = getSnapshot().settings;
      const next = cur.savedImageModels.filter(x => x !== m);
      const primary = cur.imageModelPrimary === m ? (next[0] || "") : cur.imageModelPrimary;
      const fallback = cur.imageModelFallback === m ? "" : cur.imageModelFallback;
      update({ savedImageModels: next, imageModelPrimary: primary, imageModelFallback: fallback });
    },
    setVideoModelPrimary: (m: string) => update({ videoModelPrimary: m }),
    setVideoDefaultDuration: (d: number) => update({ videoDefaultDuration: Math.max(0, Math.floor(d) || 0) }),
    setVideoDefaultResolution: (r: string) => update({ videoDefaultResolution: r }),
    setVideoDefaultAspect: (a: string) => update({ videoDefaultAspect: a }),
    setVideoGenerateAudio: (v: boolean) => update({ videoGenerateAudio: v }),
    setVideoConfirmThreshold: (n: number) => update({ videoConfirmThreshold: Math.max(0, Number(n) || 0) }),
    setVideoIdentityScale: (n: number) => update({ videoIdentityScale: Math.min(1, Math.max(0, Number(n) || 0)) }),
    setVideoQcEnabled: (v: boolean) => update({ videoQcEnabled: v }),
    setVideoMotionModel: (m: string) => update({ videoMotionModel: m }),
    addVideoModel: (m: string) => {
      const id = m.trim(); if (!id) return;
      const cur = getSnapshot().settings;
      if (cur.savedVideoModels.includes(id)) { toast.error("Video model already saved"); return; }
      update({ savedVideoModels: [...cur.savedVideoModels, id], videoModelPrimary: cur.videoModelPrimary || id });
      toast.success(`Video model "${id}" added`);
    },
    removeVideoModel: (m: string) => {
      const cur = getSnapshot().settings;
      const next = cur.savedVideoModels.filter(x => x !== m);
      const primary = cur.videoModelPrimary === m ? (next[0] || "") : cur.videoModelPrimary;
      update({ savedVideoModels: next, videoModelPrimary: primary });
    },
    setFalApiKey: (k: string) => update({ falApiKey: k.trim() }),
    setSplatModelPrimary: (m: string) => update({ splatModelPrimary: m }),
    setSplatDefaultQuality: (q: string) => update({ splatDefaultQuality: q }),
    setSplatMaxFileMb: (n: number) => update({ splatMaxFileMb: Math.max(1, Math.min(50, Number(n) || 25)) }),
    setSplatConfirmThreshold: (n: number) => update({ splatConfirmThreshold: Math.max(0, Number(n) || 0) }),
    setSplatClickToActivate: (v: boolean) => update({ splatClickToActivate: v }),
    setSplatMonthlyQuota: (n: number) => update({ splatMonthlyQuota: Math.max(0, Math.floor(Number(n) || 0)) }),
    setSplatAutoFallback: (v: boolean) => update({ splatAutoFallback: v }),
    setChatToolPermission: (tool: string, allowed: boolean) => {
      const cur = getSnapshot().settings;
      update({ chatToolPermissions: { ...cur.chatToolPermissions, [tool]: allowed } });
    },
    setChatToolPermissions: (perms: Record<string, boolean>) => update({ chatToolPermissions: perms }),
    addModel,
    removeModel,
    setNewModelInput: undefined, // handled in component
  };

}
