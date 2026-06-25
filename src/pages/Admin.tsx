import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Shield, ArrowLeft, LogOut, Search, RefreshCw, Trash2, Pencil,
  Loader2, Eye, EyeOff, Users, Activity, KeyRound, BarChart3,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  signInAsAdmin, checkIsAdmin, fetchAdminUsers, adminUpdateUserSettings,
  adminDeleteUser, fetchUserDailyVisits,
  type AdminUserRow, type DailyVisit,
} from "@/lib/adminApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */
const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Never";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
};

const CenterSpinner: React.FC<{ label?: string }> = ({ label }) => (
  <div className="flex flex-col items-center justify-center h-screen text-muted-foreground gap-3">
    <Loader2 className="w-6 h-6 animate-spin" />
    {label && <span className="text-sm">{label}</span>}
  </div>
);

/* ------------------------------------------------------------------ */
/* login gate                                                         */
/* ------------------------------------------------------------------ */
const AdminLogin: React.FC<{ onSuccess: () => void }> = ({ onSuccess }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await signInAsAdmin(username, password);
      toast.success("Welcome back");
      onSuccess();
    } catch (err: any) {
      toast.error(err?.message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-surface-container-low border border-outline-variant/15 rounded-2xl p-8 shadow-xl"
      >
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary-container flex items-center justify-center mb-3">
            <Shield className="w-6 h-6 text-on-primary-container" />
          </div>
          <h1 className="font-headline font-bold text-2xl text-primary">Admin Console</h1>
          <p className="text-sm text-on-surface-variant mt-1">Restricted access — sign in to continue.</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-username">Username</Label>
            <Input
              id="admin-username" autoFocus autoComplete="username"
              value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-password">Password</Label>
            <div className="relative">
              <Input
                id="admin-password" type={show ? "text" : "password"} autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Password" className="pr-10"
              />
              <button
                type="button" onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sign in"}
          </Button>
        </div>

        <div className="mt-6 text-center">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to app
          </Link>
        </div>
      </form>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* per-user daily-visit mini chart                                    */
/* ------------------------------------------------------------------ */
const VisitChart: React.FC<{ userId: string }> = ({ userId }) => {
  const [data, setData] = useState<DailyVisit[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchUserDailyVisits(userId, 30)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData([]));
    return () => { alive = false; };
  }, [userId]);

  if (data === null) return <Skeleton className="h-20 w-full" />;
  if (data.length === 0)
    return <p className="text-xs text-muted-foreground">No visits recorded in the last 30 days.</p>;

  const max = Math.max(...data.map((d) => d.visits), 1);
  const total = data.reduce((s, d) => s + d.visits, 0);

  return (
    <div>
      <div className="flex items-end gap-1 h-20">
        {data.map((d) => (
          <div key={d.day} className="flex-1 flex flex-col justify-end group relative" title={`${d.day}: ${d.visits}`}>
            <div
              className="bg-primary/70 rounded-sm w-full min-h-[2px] group-hover:bg-primary transition-colors"
              style={{ height: `${(d.visits / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        {total} visit{total === 1 ? "" : "s"} across {data.length} day{data.length === 1 ? "" : "s"} (last 30 days)
      </p>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* edit-settings dialog                                               */
/* ------------------------------------------------------------------ */
const FIELD_DEFS: { key: keyof EditForm; label: string; secret?: boolean; placeholder?: string }[] = [
  { key: "selectedModel", label: "Active chat model", placeholder: "e.g. google/gemini-2.5-flash" },
  { key: "deepResearchModel", label: "Deep research model", placeholder: "e.g. google/gemini-2.5-pro" },
  { key: "voiceModel", label: "Voice model (blank = same as chat)", placeholder: "optional" },
  { key: "wikiModel", label: "Neuron model (blank = default)", placeholder: "optional" },
  { key: "openrouterApiKey", label: "OpenRouter API key", secret: true, placeholder: "sk-or-..." },
  { key: "inworldApiKey", label: "Inworld API key", secret: true, placeholder: "optional" },
  { key: "burplexityApiToken", label: "Burplexity search token", secret: true, placeholder: "optional" },
];

interface EditForm {
  selectedModel: string;
  deepResearchModel: string;
  voiceModel: string;
  wikiModel: string;
  openrouterApiKey: string;
  inworldApiKey: string;
  burplexityApiToken: string;
}

const EditUserDialog: React.FC<{
  user: AdminUserRow | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ user, onClose, onSaved }) => {
  const [form, setForm] = useState<EditForm>({
    selectedModel: "", deepResearchModel: "", voiceModel: "", wikiModel: "",
    openrouterApiKey: "", inworldApiKey: "", burplexityApiToken: "",
  });
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setForm({
      selectedModel: user.selected_model || "",
      deepResearchModel: user.deep_research_model || "",
      voiceModel: user.voice_model || "",
      wikiModel: user.wiki_model || "",
      openrouterApiKey: user.openrouter_api_key || "",
      inworldApiKey: user.inworld_api_key || "",
      burplexityApiToken: user.burplexity_api_token || "",
    });
    setReveal({});
  }, [user]);

  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await adminUpdateUserSettings(user.id, {
        selectedModel: form.selectedModel,
        deepResearchModel: form.deepResearchModel,
        voiceModel: form.voiceModel,
        wikiModel: form.wikiModel,
        openrouterApiKey: form.openrouterApiKey,
        inworldApiKey: form.inworldApiKey,
        burplexityApiToken: form.burplexityApiToken,
      });
      toast.success("Settings updated");
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || "Failed to update settings");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage user</DialogTitle>
          <DialogDescription className="break-all">{user?.email}</DialogDescription>
        </DialogHeader>

        {user && (
          <div className="space-y-5">
            {/* metrics */}
            <div className="bg-surface-container-low rounded-xl p-4 border border-outline-variant/10">
              <div className="flex items-center gap-2 mb-3 text-sm font-medium text-primary">
                <BarChart3 className="w-4 h-4" /> Activity
              </div>
              <div className="grid grid-cols-3 gap-3 mb-4 text-center">
                <Stat label="Today" value={user.visits_today} />
                <Stat label="Total visits" value={user.visits_total} />
                <Stat label="Last seen" value={fmtDateTime(user.last_seen)} small />
              </div>
              <VisitChart userId={user.id} />
            </div>

            {/* settings */}
            <div className="space-y-4">
              {FIELD_DEFS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                  <div className="relative">
                    <Input
                      id={`f-${f.key}`}
                      type={f.secret && !reveal[f.key] ? "password" : "text"}
                      value={form[f.key]}
                      placeholder={f.placeholder}
                      onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                      className={f.secret ? "pr-10 font-mono text-xs" : ""}
                    />
                    {f.secret && (
                      <button
                        type="button"
                        onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={reveal[f.key] ? "Hide" : "Show"}
                      >
                        {reveal[f.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode; small?: boolean }> = ({ label, value, small }) => (
  <div>
    <div className={`font-bold text-primary ${small ? "text-xs" : "text-2xl"}`}>{value}</div>
    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">{label}</div>
  </div>
);

/* ------------------------------------------------------------------ */
/* dashboard                                                          */
/* ------------------------------------------------------------------ */
const AdminDashboard: React.FC<{ onSignOut: () => void }> = ({ onSignOut }) => {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [deleting, setDeleting] = useState<AdminUserRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setUsers(await fetchAdminUsers());
    } catch (err: any) {
      toast.error(err?.message || "Failed to load users");
      setUsers([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.email || "").toLowerCase().includes(q));
  }, [users, query]);

  const totals = useMemo(() => {
    const list = users || [];
    return {
      count: list.length,
      visitsToday: list.reduce((s, u) => s + (u.visits_today || 0), 0),
      activeToday: list.filter((u) => (u.visits_today || 0) > 0).length,
    };
  }, [users]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await adminDeleteUser(deleting.id);
      toast.success(`Deleted ${deleting.email}`);
      setDeleting(null);
      load();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete user");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* header */}
      <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl border-b border-outline-variant/15">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-primary" />
            <span className="font-headline font-bold text-lg text-primary">Admin Console</span>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mr-2">
              <ArrowLeft className="w-4 h-4" /> App
            </Link>
            <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="outline" size="sm" onClick={onSignOut}>
              <LogOut className="w-4 h-4 mr-1" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <SummaryCard icon={<Users className="w-5 h-5" />} label="Total users" value={totals.count} />
          <SummaryCard icon={<Activity className="w-5 h-5" />} label="Active today" value={totals.activeToday} />
          <SummaryCard icon={<BarChart3 className="w-5 h-5" />} label="Visits today" value={totals.visitsToday} />
        </div>

        {/* search */}
        <div className="relative mb-4 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by email…" className="pl-9"
          />
        </div>

        {/* table */}
        <div className="border border-outline-variant/15 rounded-xl overflow-hidden bg-surface-container-low">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead className="text-center">Today</TableHead>
                  <TableHead className="text-center">Total</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Keys</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users === null ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                      No users found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="max-w-[220px]">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{u.email || "—"}</span>
                          {u.is_admin && <Badge variant="secondary" className="shrink-0">admin</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(u.created_at)}</TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDateTime(u.last_sign_in_at)}</TableCell>
                      <TableCell className="text-center">{u.visits_today}</TableCell>
                      <TableCell className="text-center">{u.visits_total}</TableCell>
                      <TableCell className="max-w-[160px]">
                        <span className="truncate block text-xs text-muted-foreground" title={u.selected_model || ""}>
                          {u.selected_model || "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {u.openrouter_api_key ? (
                            <Badge variant="outline" className="gap-1"><KeyRound className="w-3 h-3" />OR</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">none</span>
                          )}
                          {u.inworld_api_key && <Badge variant="outline">IW</Badge>}
                          {u.burplexity_api_token && <Badge variant="outline">BX</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(u)} aria-label="Edit user">
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => setDeleting(u)} disabled={u.is_admin}
                          aria-label="Delete user"
                          className="text-destructive hover:text-destructive disabled:opacity-30"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </main>

      <EditUserDialog user={editing} onClose={() => setEditing(null)} onSaved={load} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this user?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <strong className="break-all">{deleting?.email}</strong> and all of
              their data (books, chapters, neurons, settings). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const SummaryCard: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = ({ icon, label, value }) => (
  <div className="bg-surface-container-low border border-outline-variant/15 rounded-xl p-5 flex items-center gap-4">
    <div className="w-10 h-10 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container">
      {icon}
    </div>
    <div>
      <div className="text-2xl font-bold text-primary">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* gate                                                               */
/* ------------------------------------------------------------------ */
const Admin: React.FC = () => {
  const { user, loading, signOut } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const recheck = useCallback(async () => {
    setIsAdmin(await checkIsAdmin());
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) { setIsAdmin(false); return; }
    recheck();
  }, [loading, user, recheck]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    setIsAdmin(false);
  }, [signOut]);

  if (loading || isAdmin === null) return <CenterSpinner label="Checking access…" />;
  if (!isAdmin) return <AdminLogin onSuccess={recheck} />;
  return <AdminDashboard onSignOut={handleSignOut} />;
};

export default Admin;
