import { useState, useEffect, useCallback, useRef } from "react";
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
};

export function useChatSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<ChatSettings>(defaults);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Load settings from DB
  useEffect(() => {
    if (!user) { setLoaded(true); return; }
    (async () => {
      const { data, error } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) { console.error("Failed to load settings:", error); setLoaded(true); return; }
      if (data) {
        setSettings({
          apiKey: data.openrouter_api_key || "",
          savedModels: (data.saved_models as string[]) || [DEFAULT_MODEL],
          selectedModel: data.selected_model || DEFAULT_MODEL,
          deepResearchModel: data.deep_research_model || DEFAULT_DEEP_RESEARCH_MODEL,
          voiceModel: (data as any).voice_model || "",
          ttsRate: typeof (data as any).tts_rate === "number" && (data as any).tts_rate > 0
            ? (data as any).tts_rate
            : DEFAULT_TTS_RATE,
          handsFreeTtsRate: typeof (data as any).hands_free_tts_rate === "number" && (data as any).hands_free_tts_rate > 0
            ? (data as any).hands_free_tts_rate
            : DEFAULT_HANDS_FREE_TTS_RATE,
          autoReadReplies: !!(data as any).auto_read_replies,
          wikiModel: (data as any).wiki_model || "",
          customSystemPrompt: (data as any).custom_system_prompt || "",
          burplexityApiToken: (data as any).burplexity_api_token || "",
          inworldApiKey: (data as any).inworld_api_key || "",
          inworldEnabled: !!(data as any).inworld_enabled,
          inworldVoiceId: (data as any).inworld_voice_id || "",
        });
      }
      setLoaded(true);
    })();
  }, [user]);

  // Debounced save to DB
  const persistSettings = useCallback((next: ChatSettings) => {
    if (!user) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const payload: any = {
        user_id: user.id,
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
      };
      const { error } = await supabase
        .from("user_settings")
        .upsert(payload, { onConflict: "user_id" });
      if (error) console.error("Failed to save settings:", error);
    }, 500);
  }, [user]);

  const update = useCallback((partial: Partial<ChatSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      persistSettings(next);
      return next;
    });
  }, [persistSettings]);

  const saveApiKey = useCallback((key: string) => {
    update({ apiKey: key });
    if (key) toast.success("API key saved");
    else toast.success("API key removed");
  }, [update]);

  const addModel = useCallback((model: string) => {
    const id = model.trim();
    if (!id) return;
    if (settings.savedModels.includes(id)) { toast.error("Model already saved"); return; }
    const embed = isEmbeddingModel(id);
    update({
      savedModels: [...settings.savedModels, id],
      // Don't make embedding models the active Chat model — they only work for Wiki reindex.
      selectedModel: embed ? settings.selectedModel : id,
    });
    if (embed) {
      toast.success(`Embedding model "${id}" added — select it in Wiki Settings.`);
    } else {
      toast.success(`Model "${id}" added`);
    }
  }, [settings.savedModels, settings.selectedModel, update]);

  const removeModel = useCallback((model: string) => {
    if (settings.savedModels.length <= 1) { toast.error("You need at least one model"); return; }
    const next = settings.savedModels.filter(m => m !== model);
    const sel = settings.selectedModel === model ? next[0] : settings.selectedModel;
    update({ savedModels: next, selectedModel: sel });
  }, [settings, update]);

  return {
    ...settings,
    loaded,
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
    addModel,
    removeModel,
    setNewModelInput: undefined, // handled in component
  };
}
