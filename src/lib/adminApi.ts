import { supabase } from "@/integrations/supabase/client";

// The admin signs in with a friendly username; internally it maps to a
// dedicated Supabase Auth account. The password is verified server-side by
// Supabase (hashed) — it is never compared in client code.
export const ADMIN_USERNAME = "bvprivate";
const ADMIN_EMAIL = "bvprivate@admin.local";

export interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  selected_model: string | null;
  deep_research_model: string | null;
  voice_model: string | null;
  wiki_model: string | null;
  openrouter_api_key: string | null;
  inworld_api_key: string | null;
  burplexity_api_token: string | null;
  is_admin: boolean;
  visits_total: number;
  visits_today: number;
  last_seen: string | null;
}

export interface AdminSettingsUpdate {
  selectedModel?: string | null;
  deepResearchModel?: string | null;
  voiceModel?: string | null;
  wikiModel?: string | null;
  openrouterApiKey?: string | null;
  inworldApiKey?: string | null;
  burplexityApiToken?: string | null;
}

export interface DailyVisit {
  day: string;
  visits: number;
}

/** Returns true if the CURRENT session belongs to an admin (server-checked). */
export async function checkIsAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin" as any);
  if (error) {
    console.warn("is_admin check failed:", error.message);
    return false;
  }
  return !!data;
}

/** Sign in as the admin. Throws on bad credentials or non-admin account. */
export async function signInAsAdmin(username: string, password: string): Promise<void> {
  if (username.trim().toLowerCase() !== ADMIN_USERNAME) {
    throw new Error("Invalid username or password");
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password,
  });
  if (error) throw new Error("Invalid username or password");

  const ok = await checkIsAdmin();
  if (!ok) {
    await supabase.auth.signOut();
    throw new Error("This account does not have admin access");
  }
}

export async function fetchAdminUsers(): Promise<AdminUserRow[]> {
  const { data, error } = await supabase.rpc("admin_list_users" as any);
  if (error) throw error;
  return (data || []) as unknown as AdminUserRow[];
}

export async function adminUpdateUserSettings(
  userId: string,
  fields: AdminSettingsUpdate
): Promise<void> {
  const { error } = await supabase.rpc("admin_update_user_settings" as any, {
    _user_id: userId,
    _selected_model: fields.selectedModel ?? null,
    _deep_research_model: fields.deepResearchModel ?? null,
    _voice_model: fields.voiceModel ?? null,
    _wiki_model: fields.wikiModel ?? null,
    _openrouter_api_key: fields.openrouterApiKey ?? null,
    _inworld_api_key: fields.inworldApiKey ?? null,
    _burplexity_api_token: fields.burplexityApiToken ?? null,
  } as any);
  if (error) throw error;
}

export async function adminDeleteUser(userId: string): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_user" as any, {
    _user_id: userId,
  } as any);
  if (error) throw error;
}

export async function fetchUserDailyVisits(
  userId: string,
  days = 30
): Promise<DailyVisit[]> {
  const { data, error } = await supabase.rpc("admin_user_daily_visits" as any, {
    _user_id: userId,
    _days: days,
  } as any);
  if (error) throw error;
  return (data || []) as unknown as DailyVisit[];
}
