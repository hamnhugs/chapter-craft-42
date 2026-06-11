import { supabase } from "@/integrations/supabase/client";

// Data layer for the first-login privacy/welcome dialog, admin-managed
// splash announcements, and the admin neuron/audit views. All cross-user
// reads go through SECURITY DEFINER RPCs that re-check is_admin() server
// side; nothing here trusts the client.

export interface Announcement {
  id: string;
  kind: "welcome" | "announcement";
  title: string;
  body: string;
  gif_url: string | null;
  gif_alt: string;
  gif_clickable: boolean;
  gif_link_url: string | null;
  gif_new_tab: boolean;
  require_ack: boolean;
  is_active: boolean;
  priority: number;
  starts_at: string;
  ends_at: string | null;
  policy_version: number;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementReceipt {
  user_id: string;
  announcement_id: string;
  policy_version: number;
  seen_at: string;
  dismissed_at: string | null;
  acknowledged_at: string | null;
}

export interface AdminWikiRow {
  id: string;
  user_id: string;
  owner_email: string;
  name: string;
  description: string;
  cover_color: string;
  tags: string[];
  is_default: boolean;
  is_meta: boolean;
  last_loaded_at: string | null;
  created_at: string;
  updated_at: string;
  entry_count: number;
}

export interface AdminWikiEntry {
  id: string;
  title: string;
  content: string;
  entry_type: string;
  tags: string[];
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  admin_id: string;
  action: string;
  target_user_id: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

/** https-only guard, applied at render AND save time (the DB CHECKs too). */
export function isSafeHttpsUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// User-facing: welcome gate + splash announcements
// ---------------------------------------------------------------------

export async function fetchAnnouncementsAndReceipts(userId: string): Promise<{
  announcements: Announcement[];
  receipts: AnnouncementReceipt[];
}> {
  const [a, r] = await Promise.all([
    supabase
      .from("announcements" as any)
      .select("*")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true }),
    supabase
      .from("announcement_receipts" as any)
      .select("*")
      .eq("user_id", userId),
  ]);
  if (a.error) throw a.error;
  return {
    announcements: (a.data || []) as unknown as Announcement[],
    receipts: (r.data || []) as unknown as AnnouncementReceipt[],
  };
}

async function upsertReceipt(
  userId: string,
  announcementId: string,
  fields: Partial<Pick<AnnouncementReceipt, "policy_version" | "dismissed_at" | "acknowledged_at">>
): Promise<void> {
  const { error } = await supabase.from("announcement_receipts" as any).upsert(
    {
      user_id: userId,
      announcement_id: announcementId,
      ...fields,
    } as any,
    { onConflict: "user_id,announcement_id" }
  );
  if (error) throw error;
}

/** Record that an announcement was shown (no dismissal yet). */
export async function recordAnnouncementSeen(
  userId: string,
  announcement: Announcement
): Promise<void> {
  await upsertReceipt(userId, announcement.id, {
    policy_version: announcement.policy_version,
  });
}

/** Dismiss a splash announcement (it won't show again on any device). */
export async function dismissAnnouncement(
  userId: string,
  announcement: Announcement
): Promise<void> {
  await upsertReceipt(userId, announcement.id, {
    policy_version: announcement.policy_version,
    dismissed_at: new Date().toISOString(),
  });
}

/** Accept the privacy statement — the versioned consent record. */
export async function acceptWelcome(
  userId: string,
  announcement: Announcement
): Promise<void> {
  await upsertReceipt(userId, announcement.id, {
    policy_version: announcement.policy_version,
    acknowledged_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------
// Admin: announcement CRUD (RLS enforces is_admin on writes)
// ---------------------------------------------------------------------

export type AnnouncementDraft = Partial<Announcement> & { id?: string };

export async function adminListAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from("announcements" as any)
    .select("*")
    .order("kind", { ascending: false }) // welcome first
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []) as unknown as Announcement[];
}

export async function adminSaveAnnouncement(draft: AnnouncementDraft): Promise<void> {
  for (const field of ["gif_url", "gif_link_url"] as const) {
    const value = draft[field];
    if (value && !isSafeHttpsUrl(value)) {
      throw new Error(`${field === "gif_url" ? "GIF URL" : "Link URL"} must start with https://`);
    }
  }
  const payload: any = { ...draft, updated_at: new Date().toISOString() };
  if (draft.id) {
    const { id, ...rest } = payload;
    const { error } = await supabase
      .from("announcements" as any)
      .update(rest)
      .eq("id", draft.id);
    if (error) throw error;
  } else {
    delete payload.id;
    const { error } = await supabase.from("announcements" as any).insert(payload);
    if (error) throw error;
  }
}

export async function adminDeleteAnnouncement(id: string): Promise<void> {
  const { error } = await supabase.from("announcements" as any).delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Admin: all-users neurons + audit log
// ---------------------------------------------------------------------

export async function adminListAllWikis(): Promise<AdminWikiRow[]> {
  const { data, error } = await supabase.rpc("admin_list_all_wikis" as any);
  if (error) throw error;
  return ((data || []) as any[]).map((row) => ({
    ...row,
    entry_count: Number(row.entry_count ?? 0),
  })) as AdminWikiRow[];
}

/** Server-side audit-logged content access. */
export async function adminListWikiEntries(
  wikiId: string,
  limit = 50
): Promise<AdminWikiEntry[]> {
  const { data, error } = await supabase.rpc("admin_list_wiki_entries" as any, {
    _wiki_id: wikiId,
    _limit: limit,
  } as any);
  if (error) throw error;
  return (data || []) as unknown as AdminWikiEntry[];
}

export async function adminFetchAuditLog(limit = 100): Promise<AuditLogRow[]> {
  const { data, error } = await supabase
    .from("admin_audit_log" as any)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []) as unknown as AuditLogRow[];
}
