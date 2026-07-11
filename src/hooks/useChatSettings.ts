import { useCallback, useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { isEmbeddingModel } from "@/lib/utils";

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_DEEP_RESEARCH_MODEL = "google/gemini-2.5-pro";
const DEFAULT_TTS_RATE = 1.05;
const DEFAULT_HANDS_FREE_TTS_RATE = 1.0;

interface ChatSettings {
  apiKey: string;
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
}

const defaults: ChatSettings = {
  apiKey: "",
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
    const { data, error } = await supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (loadedForUser !== userId) return; // user changed mid-flight
    if (error) {
      console.error("Failed to load settings:", error);
      publish({ loaded: true });
      return;
    }
    publish({ settings: data ? rowToSettings(data) : defaults, loaded: true });
  })();
}

// Debounced full-row save. Safe to write the whole row now that there is a
// single in-memory source of truth — the snapshot can no longer be stale.
function persistSettings(userId: string, next: ChatSettings) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
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
      inworld_enabled: next.inworldEnabled,
      inworld_voice_id: next.inworldVoiceId || "",
      access_all_neurons: next.accessAllNeurons,
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
    };

    let { error } = await supabase
      .from("user_settings")
      .upsert(payload, { onConflict: "user_id" });
    // Migrations can lag the client deploy — strip any not-yet-migrated
    // column and retry so one new column never breaks every settings save.
    // PostgREST reports ONE missing column per attempt (alphabetically
    // first), so keep retrying until no optional column is named.
    const optionalColumns = ["access_all_neurons", "image_extraction_model", "auto_extract_figures"];
    for (let pass = 0; error && pass < optionalColumns.length; pass++) {
      const offender = optionalColumns.find(
        (col) => col in payload && (error!.message || "").toLowerCase().includes(col),
      );
      if (!offender) break;
      delete payload[offender];
      ({ error } = await supabase.from("user_settings").upsert(payload, { onConflict: "user_id" }));
    }
    if (error) console.error("Failed to save settings:", error);
    else settingsChannel?.postMessage("settings-updated");
  }, 500);
}

function updateStore(userId: string | undefined, partial: Partial<ChatSettings>) {
  const next = { ...snapshot.settings, ...partial };
  publish({ settings: next });
  if (userId) persistSettings(userId, next);
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

  const addModel = useCallback((model: string) => {
    const id = model.trim();
    if (!id) return;
    const cur = getSnapshot().settings;
    if (cur.savedModels.includes(id)) { toast.error("Model already saved"); return; }
    const embed = isEmbeddingModel(id);
    update({
      savedModels: [...cur.savedModels, id],
      // Don't make embedding models the active Chat model — they only work for Wiki reindex.
      selectedModel: embed ? cur.selectedModel : id,
    });
    if (embed) {
      toast.success(`Embedding model "${id}" added — select it in Neuron Settings.`);
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
