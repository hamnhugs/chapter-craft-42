import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

export type PromptScope = "both" | "chat" | "voice";

export interface PromptPreset {
  id: string;
  name: string;
  body: string;
  scope: PromptScope;
  is_active: boolean;
}

interface PresetRow {
  id: string;
  name: string;
  body: string;
  scope: string;
  is_active: boolean;
}

export function usePromptPresets() {
  const { user } = useAuth();
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) { setPresets([]); setLoaded(true); return; }
    const { data, error } = await supabase
      .from("prompt_presets")
      .select("id, name, body, scope, is_active")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) { console.error("Failed to load prompt presets:", error); setLoaded(true); return; }
    setPresets(((data || []) as PresetRow[]).map(r => ({
      id: r.id, name: r.name, body: r.body, scope: (r.scope as PromptScope) || "both", is_active: !!r.is_active,
    })));
    setLoaded(true);
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  // One-time migration: if user has a legacy customSystemPrompt and zero presets, seed one.
  const migrate = useCallback(async (legacyBody: string) => {
    if (!user || !legacyBody?.trim()) return;
    const { data: existing } = await supabase
      .from("prompt_presets").select("id").eq("user_id", user.id).limit(1);
    if (existing && existing.length > 0) return;
    const { error } = await supabase.from("prompt_presets").insert({
      user_id: user.id, name: "My Prompt", body: legacyBody, scope: "both", is_active: true,
    });
    // Legacy prompt stays in its own store, so a failed seed retries next session.
    if (error) { console.warn("Failed to migrate legacy prompt:", error); toast.error("Could not migrate your custom prompt"); return; }
    refresh();
  }, [user, refresh]);

  const savePreset = useCallback(async (preset: Partial<PromptPreset> & { name: string; body: string }) => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      name: preset.name.trim() || "Untitled",
      body: preset.body || "",
      scope: (preset.scope as PromptScope) || "both",
    };
    if (preset.id) {
      const { error } = await supabase.from("prompt_presets").update(payload).eq("id", preset.id);
      if (error) { toast.error("Failed to save prompt"); return; }
    } else {
      const { error } = await supabase.from("prompt_presets").insert(payload);
      if (error) { toast.error("Failed to save prompt"); return; }
    }
    toast.success("Prompt saved");
    refresh();
  }, [user, refresh]);

  const deletePreset = useCallback(async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("prompt_presets").delete().eq("id", id);
    if (error) { toast.error("Failed to delete"); return; }
    toast.success("Prompt deleted");
    refresh();
  }, [user, refresh]);

  const setActive = useCallback(async (id: string | null) => {
    if (!user) return;
    // Clear current active first to respect the partial unique index.
    const { error: clearErr } = await supabase
      .from("prompt_presets").update({ is_active: false })
      .eq("user_id", user.id).eq("is_active", true);
    if (clearErr) { toast.error("Failed to update active prompt"); return; }
    if (id) {
      const { error } = await supabase.from("prompt_presets")
        .update({ is_active: true }).eq("id", id);
      if (error) { toast.error("Failed to activate prompt"); return; }
    }
    refresh();
  }, [user, refresh]);

  /** Pick the active preset body to inject for a given scope. */
  const getActiveBodyForScope = useCallback((scope: "chat" | "voice"): string => {
    const active = presets.find(p => p.is_active);
    if (!active) return "";
    if (active.scope !== "both" && active.scope !== scope) return "";
    return active.body || "";
  }, [presets]);

  const activePreset = presets.find(p => p.is_active) || null;

  return { presets, loaded, activePreset, savePreset, deletePreset, setActive, getActiveBodyForScope, migrate, refresh };
}
