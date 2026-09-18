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
  /** What kinds of request this prompt is FOR — the text the router matches
   *  against. Empty pre-migration, and empty for prompts the user never
   *  described. */
  when_to_use: string;
  /** Whether the router may choose this prompt on its own. */
  routing_enabled: boolean;
  /** 'assistant' = drafted by the AI and approved by the user. */
  origin: "user" | "assistant";
}

interface PresetRow {
  id: string;
  name: string;
  body: string;
  scope: string;
  is_active: boolean;
  when_to_use?: string | null;
  routing_enabled?: boolean | null;
  origin?: string | null;
}

/** 42703 / PGRST204 = a column the routing migration adds is not there yet;
 *  PGRST205 = a whole table is unknown to the schema cache. Same predicate
 *  shape as isMissingSupersessionSchema — until the migration lands, every
 *  routing feature reports itself as unavailable instead of erroring. */
export function isMissingPromptRoutingSchema(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42703" || code === "PGRST204" || code === "PGRST205";
}

export function usePromptPresets() {
  const { user } = useAuth();
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Routing settings live on user_settings, read with a targeted select and
  // written with a targeted upsert — the same treatment Lean Mode and the
  // provider keys get, and deliberately NOT part of useChatSettings' debounced
  // whole-row upsert, which would write these columns on every unrelated
  // settings change and fail the whole row pre-migration.
  const [routingEnabled, setRoutingEnabledState] = useState(false);
  const [plainOnRecall, setPlainOnRecallState] = useState(true);
  /** False until proven otherwise: the migration is not applied, so no UI may
   *  offer routing and ChatContext must not ask for it. */
  const [routingSchemaReady, setRoutingSchemaReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) { setPresets([]); setLoaded(true); return; }
    // Routing columns are requested first and dropped on a schema error, so a
    // deployment without the migration still lists prompts normally instead of
    // showing the user an empty library.
    const read = async (cols: string) => {
      const res = await supabase
        .from("prompt_presets").select(cols)
        .eq("user_id", user.id).order("created_at", { ascending: true });
      return { rows: (res.data || []) as unknown as PresetRow[], error: res.error };
    };
    let { rows, error } = await read("id, name, body, scope, is_active, when_to_use, routing_enabled, origin");
    if (error && isMissingPromptRoutingSchema(error)) {
      ({ rows, error } = await read("id, name, body, scope, is_active"));
    }
    if (error) { console.error("Failed to load prompt presets:", error); setLoaded(true); return; }
    setPresets(rows.map(r => ({
      id: r.id, name: r.name, body: r.body, scope: (r.scope as PromptScope) || "both", is_active: !!r.is_active,
      when_to_use: r.when_to_use || "", routing_enabled: !!r.routing_enabled,
      origin: r.origin === "assistant" ? "assistant" : "user",
    })));
    setLoaded(true);
  }, [user]);

  const refreshRouting = useCallback(async () => {
    if (!user) { setRoutingSchemaReady(false); return; }
    const { data, error } = await supabase
      .from("user_settings")
      .select("prompt_routing_enabled, prompt_plain_on_recall")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      // Pre-migration is the expected case, not a fault — say nothing.
      if (!isMissingPromptRoutingSchema(error)) console.error("Failed to load prompt routing settings:", error);
      setRoutingSchemaReady(false);
      return;
    }
    setRoutingSchemaReady(true);
    const row = (data || {}) as { prompt_routing_enabled?: boolean; prompt_plain_on_recall?: boolean };
    setRoutingEnabledState(!!row.prompt_routing_enabled);
    // Absent means "no row yet", and the guard's default is ON.
    setPlainOnRecallState(row.prompt_plain_on_recall !== false);
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { refreshRouting(); }, [refreshRouting]);

  const writeRouting = useCallback(async (patch: Record<string, boolean>) => {
    if (!user) return false;
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: user.id, ...patch }, { onConflict: "user_id" });
    if (error) {
      toast.error(isMissingPromptRoutingSchema(error)
        ? "Prompt routing needs a database update that hasn't been applied yet."
        : "Couldn't save that setting");
      return false;
    }
    return true;
  }, [user]);

  const setRoutingEnabled = useCallback(async (on: boolean) => {
    // Optimistic, then reconciled: a refused write must not leave the switch
    // showing a state the database does not have.
    setRoutingEnabledState(on);
    if (!(await writeRouting({ prompt_routing_enabled: on }))) setRoutingEnabledState(!on);
  }, [writeRouting]);

  const setPlainOnRecall = useCallback(async (on: boolean) => {
    setPlainOnRecallState(on);
    if (!(await writeRouting({ prompt_plain_on_recall: on }))) setPlainOnRecallState(!on);
  }, [writeRouting]);

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
    const base = {
      user_id: user.id,
      name: preset.name.trim() || "Untitled",
      body: preset.body || "",
      scope: (preset.scope as PromptScope) || "both",
    };
    // The routing fields are written when they are known and dropped on a
    // schema error, so saving a prompt keeps working before the migration —
    // the user just cannot describe when it should be chosen yet.
    const full = {
      ...base,
      ...(preset.when_to_use !== undefined ? { when_to_use: preset.when_to_use } : {}),
      ...(preset.routing_enabled !== undefined ? { routing_enabled: preset.routing_enabled } : {}),
    };
    // src/integrations/supabase/types.ts is generated and will not know the
    // routing columns until Lovable regenerates it after the migration, so the
    // writes go through a narrow hand-written shape rather than the generated
    // one. Narrow on purpose: a bare `any` here would also switch off the
    // check that the column NAMES are strings and the values are scalars.
    type PresetWrite = Record<string, string | boolean>;
    type LooseTable = {
      update: (p: PresetWrite) => { eq: (col: string, val: string) => Promise<{ error: unknown }> };
      insert: (p: PresetWrite) => Promise<{ error: unknown }>;
    };
    const table = supabase.from("prompt_presets") as unknown as LooseTable;
    const write = (payload: PresetWrite) =>
      preset.id ? table.update(payload).eq("id", preset.id) : table.insert(payload);
    let { error } = await write(full);
    if (error && isMissingPromptRoutingSchema(error)) ({ error } = await write(base));
    if (error) { toast.error("Failed to save prompt"); return; }
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

  return {
    presets, loaded, activePreset, savePreset, deletePreset, setActive, getActiveBodyForScope, migrate, refresh,
    routingEnabled, plainOnRecall, routingSchemaReady, setRoutingEnabled, setPlainOnRecall, refreshRouting,
  };
}
