import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Search,
  Trash2,
  X,
  CheckSquare,
  Square,
  Sparkles,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  CleanupItem,
  REASON_LABEL,
  bulkDeleteEntries,
  dismissFlag,
  listCleanupItems,
  rescanCleanup,
} from "@/lib/cleanupFlags";
import { useApp } from "@/context/AppContext";

interface CleanupPanelProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
};

const CleanupPanel: React.FC<CleanupPanelProps> = ({ open, onOpenChange }) => {
  const { activeWikiId } = useApp();
  const [items, setItems] = useState<CleanupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // entry ids
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const recentlyDeleted = useRef<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listCleanupItems(activeWikiId || null, debounced || undefined);
      const filtered = list.filter((i) => !recentlyDeleted.current.has(i.entry.id));
      setItems(filtered);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load cleanup suggestions");
    } finally {
      setLoading(false);
    }
  }, [activeWikiId, debounced]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Realtime: keep panel synced with new flags (e.g. AI added one from chat).
  useEffect(() => {
    if (!open) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid || cancelled) return;
      channel = supabase
        .channel(`cleanup_flags:${uid}`)
        .on(
          "postgres_changes" as any,
          { event: "*", schema: "public", table: "cleanup_flags", filter: `user_id=eq.${uid}` },
          (payload: any) => {
            const eid = payload?.new?.entry_id ?? payload?.old?.entry_id;
            if (eid && recentlyDeleted.current.has(eid)) return;
            void load();
          },
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) {
        try { supabase.removeChannel(channel); } catch { /* noop */ }
      }
    };
  }, [open, load]);

  useEffect(() => {
    if (!open) {
      setSelectMode(false);
      setSelected(new Set());
      setQuery("");
      recentlyDeleted.current.clear();
    }
  }, [open]);

  const allEntryIds = useMemo(() => items.map((i) => i.entry.id), [items]);
  const allSelected = selected.size > 0 && allEntryIds.every((id) => selected.has(id));

  const toggleOne = (entryId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allEntryIds));
  };

  const performDelete = async (entryIds: string[], label: string) => {
    if (entryIds.length === 0) return;
    setDeleting(true);
    const snapshot = items;
    entryIds.forEach((id) => recentlyDeleted.current.add(id));
    setItems((prev) => prev.filter((i) => !entryIds.includes(i.entry.id)));
    try {
      const removed = await bulkDeleteEntries(entryIds);
      toast.success(`Deleted ${removed} ${label}${removed === 1 ? "" : "s"}`);
      setSelected(new Set());
      setSelectMode(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("knowledge-entries-changed"));
      }
    } catch (e: any) {
      entryIds.forEach((id) => recentlyDeleted.current.delete(id));
      setItems(snapshot);
      toast.error(e?.message || "Delete failed");
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
      setConfirmAllOpen(false);
    }
  };

  const handleDeleteSelected = () => performDelete(Array.from(selected), "entry");
  const handleDeleteAll = () => performDelete(allEntryIds, "entry");

  const handleKeep = async (item: CleanupItem) => {
    // Optimistic remove. Dismissing one reason only — others remain visible.
    const snapshot = items;
    setItems((prev) => prev.filter((i) => i.flag.id !== item.flag.id));
    try {
      await dismissFlag(item.flag.id);
    } catch (e: any) {
      setItems(snapshot);
      toast.error(e?.message || "Couldn't dismiss");
    }
  };

  const handleRescan = async () => {
    setScanning(true);
    try {
      const summary = await rescanCleanup(activeWikiId || null);
      const total = summary.reduce((s, r) => s + r.added, 0);
      toast.success(
        total > 0 ? `Found ${total} new suggestion${total === 1 ? "" : "s"}` : "Memory is clean — nothing new to flag",
      );
      recentlyDeleted.current.clear();
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-lg p-0 flex flex-col bg-surface text-on-surface"
        >
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-outline-variant/20">
            <SheetTitle className="flex items-center gap-2 text-on-surface">
              <AlertTriangle className="w-5 h-5 text-destructive" aria-hidden />
              Cleanup Suggestions
              {items.length > 0 && (
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-destructive/15 text-destructive">
                  {items.length}
                </span>
              )}
            </SheetTitle>
            <SheetDescription className="text-on-surface-variant">
              Entries the AI thinks you should delete. Review, dismiss, or wipe them in one click.
            </SheetDescription>
            <div className="flex items-center gap-2 pt-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search flagged entries…"
                  className="pl-8 h-9"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRescan}
                disabled={scanning}
                title="Re-scan this neuron for new cleanup suggestions"
              >
                {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                <span className="ml-1 hidden sm:inline">Re-scan</span>
              </Button>
              <Button
                variant={selectMode ? "default" : "outline"}
                size="sm"
                onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
              >
                {selectMode ? <X className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
                <span className="ml-1 hidden sm:inline">{selectMode ? "Cancel" : "Select"}</span>
              </Button>
            </div>
            {selectMode && items.length > 0 && (
              <div className="flex items-center justify-between pt-2 text-xs">
                <button
                  onClick={toggleAll}
                  className="flex items-center gap-1.5 text-on-surface-variant hover:text-primary transition-colors font-semibold uppercase tracking-wider"
                >
                  {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
                <span className="text-on-surface-variant" aria-live="polite">
                  {selected.size} selected
                </span>
              </div>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-24 rounded-xl bg-surface-container-high animate-pulse" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 px-4 text-on-surface-variant">
                <Sparkles className="w-12 h-12 mb-3 opacity-40" />
                <p className="font-semibold text-on-surface mb-1">Nothing to clean up</p>
                <p className="text-sm">
                  {debounced
                    ? "No flagged entries match your search."
                    : "The AI has no deletion suggestions for this neuron. Hit Re-scan after big edits."}
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {items.map((item) => {
                  const isSel = selected.has(item.entry.id);
                  return (
                    <li
                      key={item.flag.id}
                      className={`relative rounded-xl border-l-4 border-destructive bg-destructive/5 border border-destructive/30 p-4 transition-all ${
                        isSel ? "ring-2 ring-destructive/50" : ""
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {selectMode && (
                          <button
                            type="button"
                            onClick={() => toggleOne(item.entry.id)}
                            aria-label={isSel ? "Deselect" : "Select"}
                            className="mt-1 shrink-0"
                          >
                            {isSel ? (
                              <CheckSquare className="w-4 h-4 text-destructive" />
                            ) : (
                              <Square className="w-4 h-4 text-on-surface-variant" />
                            )}
                          </button>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-destructive text-destructive-foreground">
                              {REASON_LABEL[item.flag.reason]}
                            </span>
                            {item.wikiName && (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
                                · {item.wikiName}
                              </span>
                            )}
                            <span className="text-[10px] text-on-surface-variant ml-auto">
                              {formatRelative(item.flag.created_at)}
                            </span>
                          </div>
                          <h4 className="font-bold text-on-surface line-clamp-1">{item.entry.title}</h4>
                          <p className="text-xs text-on-surface-variant line-clamp-2 mt-1">
                            {item.entry.content.slice(0, 220)}
                          </p>
                          {item.flag.note && (
                            <p className="text-[11px] text-destructive mt-2 italic line-clamp-2">
                              Why: {item.flag.note}
                            </p>
                          )}
                          {!selectMode && (
                            <div className="flex items-center gap-2 mt-3">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleKeep(item)}
                                className="h-7 text-xs"
                              >
                                Keep
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => performDelete([item.entry.id], "entry")}
                                disabled={deleting}
                                className="h-7 text-xs"
                              >
                                <Trash2 className="w-3 h-3 mr-1" />
                                Delete
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {items.length > 0 && (
            <div className="border-t border-outline-variant/20 px-4 py-3 bg-surface-container flex items-center justify-between gap-2">
              {selectMode ? (
                <>
                  <span className="text-sm font-semibold">
                    {selected.size} entr{selected.size === 1 ? "y" : "ies"}
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmOpen(true)}
                    disabled={deleting || selected.size === 0}
                  >
                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    <span className="ml-1">Delete selected</span>
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-xs text-on-surface-variant">
                    {items.length} suggestion{items.length === 1 ? "" : "s"}
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmAllOpen(true)}
                    disabled={deleting}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Delete all
                  </Button>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} entr{selected.size === 1 ? "y" : "ies"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected memory entries and everything attached
              to them (linked images, edges). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleDeleteSelected(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Trash2 className="w-4 h-4 mr-1" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all {items.length} flagged entr{items.length === 1 ? "y" : "ies"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes every memory entry the AI has flagged for cleanup,
              along with their linked images and edges. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleDeleteAll(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Trash2 className="w-4 h-4 mr-1" />}
              Delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default CleanupPanel;
