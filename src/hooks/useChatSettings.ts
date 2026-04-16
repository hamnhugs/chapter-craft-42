import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_DEEP_RESEARCH_MODEL = "google/gemini-2.5-pro";

interface ChatSettings {
  apiKey: string;
  savedModels: string[];
  selectedModel: string;
  deepResearchModel: string;
}

const defaults: ChatSettings = {
  apiKey: "",
  savedModels: [DEFAULT_MODEL],
  selectedModel: DEFAULT_MODEL,
  deepResearchModel: DEFAULT_DEEP_RESEARCH_MODEL,
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
      const payload = {
        user_id: user.id,
        openrouter_api_key: next.apiKey,
        saved_models: next.savedModels as any,
        selected_model: next.selectedModel,
        deep_research_model: next.deepResearchModel,
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
    if (!model.trim()) return;
    if (settings.savedModels.includes(model.trim())) { toast.error("Model already saved"); return; }
    update({
      savedModels: [...settings.savedModels, model.trim()],
      selectedModel: model.trim(),
    });
    toast.success(`Model "${model.trim()}" added`);
  }, [settings.savedModels, update]);

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
    addModel,
    removeModel,
    setNewModelInput: undefined, // handled in component
  };
}
