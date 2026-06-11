import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ExternalLink, Plus, Trash2, Pencil, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { fetchAdminUsers, AdminUserRow } from "@/lib/adminApi";
import {
  Announcement,
  AnnouncementDraft,
  AdminWikiRow,
  AdminWikiEntry,
  AuditLogRow,
  adminListAnnouncements,
  adminSaveAnnouncement,
  adminDeleteAnnouncement,
  adminListAllWikis,
  adminListWikiEntries,
  adminFetchAuditLog,
  isSafeHttpsUrl,
} from "@/lib/announcementsApi";
import { AnnouncementGif } from "@/components/WelcomeGate";

// Admin tab — visible only to admin accounts; every query below is
// re-authorized server-side (RLS / SECURITY DEFINER), so this UI is a
// convenience, not the security boundary.
//
// Layout follows enterprise-dashboard guidance: counts-first overview,
// table for the user list, verb-labeled destructive confirmations, and a
// visible audit trail of admin access to user content.

type Section = "overview" | "users" | "neurons" | "welcome" | "announcements" | "audit";

const SECTIONS: { id: Section; icon: string; label: string }[] = [
  { id: "overview", icon: "monitoring", label: "Overview" },
  { id: "users", icon: "group", label: "Users" },
  { id: "neurons", icon: "neurology", label: "Neurons" },
  { id: "welcome", icon: "waving_hand", label: "Welcome dialog" },
  { id: "announcements", icon: "campaign", label: "Announcements" },
  { id: "audit", icon: "receipt_long", label: "Audit log" },
];

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString() : "—";

const AdminPanel: React.FC = () => {
  const { isAdmin, loaded } = useIsAdmin();
  const [section, setSection] = useState<Section>("overview");

  // Shared data, loaded once and reused across sections.
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [wikis, setWikis] = useState<AdminWikiRow[] | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [audit, setAudit] = useState<AuditLogRow[] | null>(null);

  const reloadAnnouncements = useCallback(async () => {
    try {
      setAnnouncements(await adminListAnnouncements());
    } catch (err: any) {
      toast.error(err.message || "Failed to load announcements");
    }
  }, []);

  useEffect(() => {
    if (!loaded || !isAdmin) return;
    fetchAdminUsers().then(setUsers).catch(() => setUsers([]));
    adminListAllWikis().then(setWikis).catch(() => setWikis([]));
    void reloadAnnouncements();
    adminFetchAuditLog().then(setAudit).catch(() => setAudit([]));
  }, [loaded, isAdmin, reloadAnnouncements]);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-on-surface-variant">
        <span className="material-symbols-outlined text-5xl">lock</span>
        <p className="text-sm">This area is restricted to administrators.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-7xl mx-auto px-6 py-10 pb-32 w-full">
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
              Admin
            </span>
            <span className="inline-flex items-center gap-1 text-on-surface-variant text-xs font-medium">
              <ShieldCheck className="w-3.5 h-3.5" /> Server-verified access — content reads are logged
            </span>
          </div>
          <h2 className="font-headline font-bold text-5xl text-primary tracking-tight">Mission Control</h2>
        </section>

        {/* Section switcher */}
        <div className="mb-8 flex items-center gap-1 overflow-x-auto pb-2 hide-scrollbar">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                section === s.id
                  ? "bg-primary-container text-on-primary-container"
                  : "text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              <span className="material-symbols-outlined text-sm" aria-hidden>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>

        {section === "overview" && (
          <OverviewSection users={users} wikis={wikis} announcements={announcements} audit={audit} />
        )}
        {section === "users" && <UsersSection users={users} />}
        {section === "neurons" && <NeuronsSection wikis={wikis} />}
        {section === "welcome" && (
          <WelcomeEditor announcements={announcements} onSaved={reloadAnnouncements} />
        )}
        {section === "announcements" && (
          <AnnouncementsSection announcements={announcements} onChanged={reloadAnnouncements} />
        )}
        {section === "audit" && <AuditSection audit={audit} />}
      </main>
    </div>
  );
};

// ---------------------------------------------------------------------------

const StatCard: React.FC<{ icon: string; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="bg-surface-container-high rounded-2xl border border-outline-variant/10 p-5 flex items-center gap-4">
    <span className="material-symbols-outlined text-3xl text-primary" aria-hidden>{icon}</span>
    <div>
      <div className="font-headline text-3xl text-foreground leading-none">{value}</div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mt-1.5">{label}</div>
    </div>
  </div>
);

const OverviewSection: React.FC<{
  users: AdminUserRow[] | null;
  wikis: AdminWikiRow[] | null;
  announcements: Announcement[] | null;
  audit: AuditLogRow[] | null;
}> = ({ users, wikis, announcements, audit }) => {
  const entryTotal = useMemo(
    () => (wikis || []).reduce((sum, w) => sum + w.entry_count, 0),
    [wikis]
  );
  const activeAnnouncements = (announcements || []).filter(
    (a) => a.kind === "announcement" && a.is_active
  ).length;
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon="group" label="Users" value={users ? String(users.length) : "…"} />
        <StatCard icon="neurology" label="Neurons" value={wikis ? String(wikis.length) : "…"} />
        <StatCard icon="article" label="Entries" value={wikis ? String(entryTotal) : "…"} />
        <StatCard icon="campaign" label="Active announcements" value={announcements ? String(activeAnnouncements) : "…"} />
      </div>

      <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-high p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-headline text-xl text-foreground">Recent admin activity</h3>
          <a
            href="#/admin"
            className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
          >
            Full admin dashboard <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        {!audit ? (
          <Loader2 className="w-5 h-5 animate-spin text-on-surface-variant" />
        ) : audit.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No logged admin access yet.</p>
        ) : (
          <div className="divide-y divide-outline-variant/10">
            {audit.slice(0, 6).map((row) => (
              <div key={row.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground font-medium">{row.action.replace(/_/g, " ")}</span>
                <span className="text-on-surface-variant text-xs truncate">
                  {String((row.detail as any)?.wiki_name || row.target_id || "")}
                </span>
                <span className="text-on-surface-variant text-xs shrink-0">{fmtDate(row.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const UsersSection: React.FC<{ users: AdminUserRow[] | null }> = ({ users }) => {
  if (!users) {
    return <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />;
  }
  return (
    <div className="rounded-2xl border border-outline-variant/10 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-container-high text-left text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Joined</th>
              <th className="px-4 py-3">Last seen</th>
              <th className="px-4 py-3 text-right">Visits</th>
              <th className="px-4 py-3">Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr key={u.id} className={i % 2 === 1 ? "bg-surface-container-high/50" : ""}>
                <td className="px-4 py-3 font-medium text-foreground">{u.email || u.id}</td>
                <td className="px-4 py-3 text-on-surface-variant">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-on-surface-variant">{fmtDate(u.last_seen)}</td>
                <td className="px-4 py-3 text-right text-on-surface-variant">{u.visits_total}</td>
                <td className="px-4 py-3">
                  {u.is_admin ? (
                    <span className="px-2 py-0.5 rounded-full bg-primary-container text-on-primary-container text-[10px] font-bold uppercase tracking-widest">
                      Admin
                    </span>
                  ) : (
                    <span className="text-on-surface-variant text-xs">User</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 bg-surface-container-high text-xs text-on-surface-variant">
        Settings and account management live in the{" "}
        <a href="#/admin" className="text-primary font-bold hover:underline">full admin dashboard</a>.
      </div>
    </div>
  );
};

const NeuronsSection: React.FC<{ wikis: AdminWikiRow[] | null }> = ({ wikis }) => {
  const [selected, setSelected] = useState<AdminWikiRow | null>(null);
  const [entries, setEntries] = useState<AdminWikiEntry[] | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, AdminWikiRow[]>();
    for (const w of wikis || []) {
      if (!map.has(w.owner_email)) map.set(w.owner_email, []);
      map.get(w.owner_email)!.push(w);
    }
    return Array.from(map.entries());
  }, [wikis]);

  const openEntries = async (wiki: AdminWikiRow) => {
    setSelected(wiki);
    setEntries(null);
    try {
      setEntries(await adminListWikiEntries(wiki.id, 50));
    } catch (err: any) {
      toast.error(err.message || "Failed to load entries");
      setEntries([]);
    }
  };

  if (!wikis) {
    return <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />;
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-on-surface-variant max-w-2xl">
        Every neuron across all accounts. Opening a neuron's entries is recorded in the audit
        log — access user content only for support, moderation, or security purposes.
      </p>
      {grouped.map(([email, list]) => (
        <div key={email}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-bold text-foreground">{email}</span>
            <span className="text-xs text-on-surface-variant">
              {list.length} neuron{list.length === 1 ? "" : "s"} ·{" "}
              {list.reduce((s, w) => s + w.entry_count, 0)} entries
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {list.map((w) => (
              <button
                key={w.id}
                onClick={() => openEntries(w)}
                className="text-left rounded-xl overflow-hidden border border-outline-variant/10 hover:shadow-xl transition-all active:scale-[0.98]"
              >
                <div className="h-2" style={{ background: w.cover_color }} />
                <div className="p-3 bg-surface-container-high">
                  <div className="font-headline font-bold text-sm text-foreground line-clamp-1">{w.name}</div>
                  <div className="text-[10px] uppercase tracking-widest text-on-surface-variant mt-1">
                    {w.entry_count} {w.entry_count === 1 ? "entry" : "entries"}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="font-headline text-2xl">{selected.name}</DialogTitle>
                <DialogDescription>
                  {selected.owner_email} · {selected.entry_count} entries · created{" "}
                  {new Date(selected.created_at).toLocaleDateString()}. This access was recorded
                  in the audit log.
                </DialogDescription>
              </DialogHeader>
              {!entries ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
                </div>
              ) : entries.length === 0 ? (
                <p className="text-sm text-on-surface-variant py-4">This neuron has no entries.</p>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {entries.map((e) => (
                    <div key={e.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-bold text-sm text-foreground">{e.title}</div>
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          {e.entry_type}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface-variant line-clamp-3 mt-1 whitespace-pre-wrap">
                        {e.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Announcement form fields shared by the welcome editor and splash editor
// ---------------------------------------------------------------------------

interface FormState {
  title: string;
  body: string;
  gif_url: string;
  gif_alt: string;
  gif_clickable: boolean;
  gif_link_url: string;
  gif_new_tab: boolean;
  is_active: boolean;
  priority: number;
}

const draftFrom = (a?: Announcement | null): FormState => ({
  title: a?.title || "",
  body: a?.body || "",
  gif_url: a?.gif_url || "",
  gif_alt: a?.gif_alt || "",
  gif_clickable: a?.gif_clickable ?? false,
  gif_link_url: a?.gif_link_url || "",
  gif_new_tab: a?.gif_new_tab ?? true,
  is_active: a?.is_active ?? true,
  priority: a?.priority ?? 0,
});

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
      {label}
    </label>
    {children}
  </div>
);

const ToggleRow: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, hint, checked, onChange }) => (
  <div className="flex items-start justify-between gap-4 p-3 rounded-lg bg-surface-container-high border border-outline-variant/10">
    <div>
      <div className="text-sm font-bold text-foreground">{label}</div>
      {hint && <div className="text-xs text-on-surface-variant mt-0.5">{hint}</div>}
    </div>
    <Switch checked={checked} onCheckedChange={onChange} />
  </div>
);

const GifFields: React.FC<{ form: FormState; setForm: (f: FormState) => void }> = ({ form, setForm }) => (
  <>
    <Field label="GIF / image URL (https only)">
      <Input
        value={form.gif_url}
        onChange={(e) => setForm({ ...form, gif_url: e.target.value })}
        placeholder="https://media.giphy.com/…/giphy.gif"
      />
    </Field>
    <Field label="Image description (alt text, for screen readers)">
      <Input
        value={form.gif_alt}
        onChange={(e) => setForm({ ...form, gif_alt: e.target.value })}
        placeholder="What does the image show?"
      />
    </Field>
    <ToggleRow
      label="GIF is clickable"
      hint="Clicking the GIF opens the link below."
      checked={form.gif_clickable}
      onChange={(v) => setForm({ ...form, gif_clickable: v })}
    />
    {form.gif_clickable && (
      <>
        <Field label="Click-through link (https only)">
          <Input
            value={form.gif_link_url}
            onChange={(e) => setForm({ ...form, gif_link_url: e.target.value })}
            placeholder="https://example.com/news"
          />
        </Field>
        <ToggleRow
          label="Open in a new tab"
          checked={form.gif_new_tab}
          onChange={(v) => setForm({ ...form, gif_new_tab: v })}
        />
      </>
    )}
  </>
);

const validateForm = (form: FormState): string | null => {
  if (!form.title.trim()) return "Title is required";
  if (form.gif_url && !isSafeHttpsUrl(form.gif_url)) return "GIF URL must start with https://";
  if (form.gif_clickable && form.gif_link_url && !isSafeHttpsUrl(form.gif_link_url))
    return "Click-through link must start with https://";
  return null;
};

/** Live preview rendered exactly like the user-facing dialog. */
const PreviewDialog: React.FC<{
  open: boolean;
  onOpenChange: (o: boolean) => void;
  form: FormState;
  welcome?: boolean;
}> = ({ open, onOpenChange, form, welcome }) => {
  const fake: Announcement = {
    id: "preview",
    kind: welcome ? "welcome" : "announcement",
    title: form.title,
    body: form.body,
    gif_url: form.gif_url || null,
    gif_alt: form.gif_alt,
    gif_clickable: form.gif_clickable,
    gif_link_url: form.gif_link_url || null,
    gif_new_tab: form.gif_new_tab,
    require_ack: !!welcome,
    is_active: true,
    priority: form.priority,
    starts_at: "",
    ends_at: null,
    policy_version: 1,
    created_at: "",
    updated_at: "",
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-3xl">{fake.title || "Untitled"}</DialogTitle>
          <DialogDescription className="sr-only">Preview</DialogDescription>
        </DialogHeader>
        <AnnouncementGif announcement={fake} />
        <div className="text-sm text-on-surface-variant whitespace-pre-wrap leading-relaxed">{fake.body}</div>
        {welcome && (
          <div className="flex items-start justify-between gap-4 p-3 rounded-lg bg-surface-container-high border border-outline-variant/10">
            <span className="text-sm font-medium text-foreground">
              I have read and accept the privacy statement above.
            </span>
            <Switch checked={false} disabled />
          </div>
        )}
        <DialogFooter>
          <Button disabled className="w-full">
            {welcome ? "Accept & continue" : "Got it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const WelcomeEditor: React.FC<{
  announcements: Announcement[] | null;
  onSaved: () => Promise<void>;
}> = ({ announcements, onSaved }) => {
  const welcome = (announcements || []).find((a) => a.kind === "welcome") || null;
  const [form, setForm] = useState<FormState>(() => draftFrom(welcome));
  const [hydratedFor, setHydratedFor] = useState<string | null>(welcome?.id ?? null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate the form once the welcome row arrives.
  useEffect(() => {
    if (welcome && hydratedFor !== welcome.id) {
      setForm(draftFrom(welcome));
      setHydratedFor(welcome.id);
    }
  }, [welcome, hydratedFor]);

  if (!announcements) {
    return <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />;
  }
  if (!welcome) {
    return (
      <p className="text-sm text-on-surface-variant">
        No welcome dialog found — apply the latest database migration first.
      </p>
    );
  }

  const save = async (bumpVersion: boolean) => {
    const problem = validateForm(form);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (
      bumpVersion &&
      !confirm(
        "Require re-acceptance: every user will see the privacy dialog again on their next login and must accept before continuing. Proceed?"
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const draft: AnnouncementDraft = {
        id: welcome.id,
        title: form.title.trim(),
        body: form.body,
        gif_url: form.gif_url.trim() || null,
        gif_alt: form.gif_alt.trim(),
        gif_clickable: form.gif_clickable,
        gif_link_url: form.gif_link_url.trim() || null,
        gif_new_tab: form.gif_new_tab,
        is_active: form.is_active,
      };
      if (bumpVersion) draft.policy_version = welcome.policy_version + 1;
      await adminSaveAnnouncement(draft);
      await onSaved();
      toast.success(bumpVersion ? "Saved — users will re-accept on next login" : "Welcome dialog saved");
    } catch (err: any) {
      toast.error(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-xs text-on-surface-variant">
        Shown once on every user's first login; they must accept before using the app. Acceptance
        is stored with a timestamp and policy version (v{welcome.policy_version} currently).
        If you materially change the privacy statement, use "Save & require re-acceptance".
      </p>
      <Field label="Title">
        <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <Field label="Privacy statement / message">
        <Textarea
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={12}
        />
      </Field>
      <GifFields form={form} setForm={setForm} />
      <ToggleRow
        label="Welcome dialog enabled"
        hint="When off, new users sign in without the privacy gate."
        checked={form.is_active}
        onChange={(v) => setForm({ ...form, is_active: v })}
      />
      <div className="flex flex-wrap gap-2 pt-2">
        <Button variant="outline" onClick={() => setPreviewOpen(true)}>
          Preview
        </Button>
        <Button onClick={() => save(false)} disabled={saving} className="gap-2">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
        </Button>
        <Button variant="secondary" onClick={() => save(true)} disabled={saving}>
          Save & require re-acceptance
        </Button>
      </div>
      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} form={form} welcome />
    </div>
  );
};

const AnnouncementsSection: React.FC<{
  announcements: Announcement[] | null;
  onChanged: () => Promise<void>;
}> = ({ announcements, onChanged }) => {
  const splashes = (announcements || []).filter((a) => a.kind === "announcement");
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(draftFrom());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialogOpen = creating || !!editing;

  const openCreate = () => {
    setForm(draftFrom());
    setEditing(null);
    setCreating(true);
  };
  const openEdit = (a: Announcement) => {
    setForm(draftFrom(a));
    setCreating(false);
    setEditing(a);
  };
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
  };

  const save = async () => {
    const problem = validateForm(form);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      await adminSaveAnnouncement({
        id: editing?.id,
        kind: "announcement",
        title: form.title.trim(),
        body: form.body,
        gif_url: form.gif_url.trim() || null,
        gif_alt: form.gif_alt.trim(),
        gif_clickable: form.gif_clickable,
        gif_link_url: form.gif_link_url.trim() || null,
        gif_new_tab: form.gif_new_tab,
        is_active: form.is_active,
        priority: form.priority,
      });
      await onChanged();
      toast.success(editing ? "Announcement updated" : "Announcement created");
      closeDialog();
    } catch (err: any) {
      toast.error(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (a: Announcement, active: boolean) => {
    try {
      await adminSaveAnnouncement({ id: a.id, is_active: active });
      await onChanged();
    } catch (err: any) {
      toast.error(err.message || "Update failed");
    }
  };

  const remove = async (a: Announcement) => {
    if (!confirm(`Delete announcement "${a.title}"? Users will no longer see it. This cannot be undone.`)) return;
    try {
      await adminDeleteAnnouncement(a.id);
      await onChanged();
      toast.success("Announcement deleted");
    } catch (err: any) {
      toast.error(err.message || "Delete failed");
    }
  };

  if (!announcements) {
    return <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />;
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-on-surface-variant">
          Login-triggered splash dialogs. Users see at most one per session — the highest
          priority they haven't dismissed — and a dismissal sticks across devices.
        </p>
        <Button onClick={openCreate} className="gap-1.5 shrink-0">
          <Plus className="w-4 h-4" /> New announcement
        </Button>
      </div>

      {splashes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-on-surface-variant gap-2 rounded-2xl border border-dashed border-outline-variant/30">
          <span className="material-symbols-outlined text-4xl">campaign</span>
          <p className="text-sm">No announcements yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {splashes.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-4 rounded-xl border border-outline-variant/10 bg-surface-container-high px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-foreground truncate">{a.title}</div>
                <div className="text-xs text-on-surface-variant truncate">
                  Priority {a.priority} · created {new Date(a.created_at).toLocaleDateString()}
                  {a.gif_url ? " · GIF" : ""}
                  {a.gif_clickable ? " · clickable" : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  checked={a.is_active}
                  onCheckedChange={(v) => toggleActive(a, v)}
                  aria-label={a.is_active ? "Deactivate announcement" : "Activate announcement"}
                />
                <Button variant="ghost" size="icon" onClick={() => openEdit(a)} aria-label="Edit announcement">
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(a)}
                  className="text-destructive hover:text-destructive"
                  aria-label="Delete announcement"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl">
              {editing ? "Edit announcement" : "New announcement"}
            </DialogTitle>
            <DialogDescription>
              Shown as a dialog at login until the user dismisses it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Title">
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Message">
              <Textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={5}
              />
            </Field>
            <GifFields form={form} setForm={setForm} />
            <Field label="Priority (higher shows first)">
              <Input
                type="number"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 0 })}
              />
            </Field>
            <ToggleRow
              label="Active"
              checked={form.is_active}
              onChange={(v) => setForm({ ...form, is_active: v })}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPreviewOpen(true)}>
              Preview
            </Button>
            <Button onClick={save} disabled={saving} className="gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} form={form} />
    </div>
  );
};

const AuditSection: React.FC<{ audit: AuditLogRow[] | null }> = ({ audit }) => {
  if (!audit) {
    return <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-on-surface-variant max-w-2xl">
        Append-only record of admin access to user content. Rows are written server-side and
        cannot be edited or deleted from the app.
      </p>
      {audit.length === 0 ? (
        <p className="text-sm text-on-surface-variant">Nothing logged yet.</p>
      ) : (
        <div className="rounded-2xl border border-outline-variant/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-high text-left text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((row, i) => (
                <tr key={row.id} className={i % 2 === 1 ? "bg-surface-container-high/50" : ""}>
                  <td className="px-4 py-2.5 text-on-surface-variant whitespace-nowrap">{fmtDate(row.created_at)}</td>
                  <td className="px-4 py-2.5 font-medium text-foreground">{row.action.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs truncate max-w-[280px]">
                    {String((row.detail as any)?.wiki_name || row.target_id || "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AdminPanel;
