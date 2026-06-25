import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Trash2, X, CheckSquare, Square, Image as ImageIcon } from "lucide-react";
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
import GeneratedImage from "@/components/GeneratedImage";
import {
  ImageAttachmentRow,
  deleteImageAttachment,
  searchImages,
} from "@/lib/imageGen";
import { supabase } from "@/integrations/supabase/client";

interface ImagesPanelProps {
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

const ImagesPanel: React.FC<ImagesPanelProps> = ({ open, onOpenChange }) => {
  const [rows, setRows] = useState<ImageAttachmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Single-image delete confirmation
  const [singleTarget, setSingleTarget] = useState<ImageAttachmentRow | null>(null);
  // IDs we just deleted optimistically — used to ignore racing realtime reloads.
  const recentlyDeletedRef = React.useRef<Set<string>>(new Set());

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await searchImages(debounced || undefined, 100);
      // Filter out anything we just deleted in case a stale fetch races.
      const filtered = list.filter((r) => !recentlyDeletedRef.current.has(r.id));
      setRows(filtered);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load images");
    } finally {
      setLoading(false);
    }
  }, [debounced]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Realtime: keep panel in sync with new images. Skip our own optimistic deletes.
  useEffect(() => {
    if (!open) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid || cancelled) return;
      channel = supabase
        .channel(`image_attachments:${uid}`)
        .on(
          "postgres_changes" as any,
          { event: "*", schema: "public", table: "image_attachments", filter: `user_id=eq.${uid}` },
          (payload: any) => {
            const changedId = payload?.new?.id ?? payload?.old?.id;
            if (changedId && recentlyDeletedRef.current.has(changedId)) return;
            void load();
          },
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) { try { supabase.removeChannel(channel); } catch { /* noop */ } }
    };
  }, [open, load]);

  // Reset selection on close
  useEffect(() => {
    if (!open) {
      setSelectMode(false);
      setSelected(new Set());
      setQuery("");
      setSingleTarget(null);
      recentlyDeletedRef.current.clear();
    }
  }, [open]);

  const allVisibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = selected.size > 0 && allVisibleIds.every((id) => selected.has(id));

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allVisibleIds));
  };

  const handleDeleteSelected = async () => {
    const ids = Array.from(selected);
    const targets = rows.filter((r) => ids.includes(r.id));
    if (targets.length === 0) return;
    setDeleting(true);
    const snapshot = rows;
    // Track for realtime dedupe and optimistically remove.
    targets.forEach((t) => recentlyDeletedRef.current.add(t.id));
    setRows((prev) => prev.filter((r) => !selected.has(r.id)));
    const results = await Promise.allSettled(
      targets.map((r) => deleteImageAttachment({ id: r.id, storage_path: r.storage_path })),
    );
    const failures = results
      .map((r, i) => ({ r, t: targets[i] }))
      .filter((x) => x.r.status === "rejected");
    setDeleting(false);
    setConfirmOpen(false);
    if (failures.length > 0) {
      // Roll back failed ones from the dedupe set and restore them in UI
      failures.forEach((f) => recentlyDeletedRef.current.delete(f.t.id));
      setRows(snapshot.filter((r) => !targets.some((t) => t.id === r.id && !failures.some((f) => f.t.id === r.id))));
      const firstMsg = (failures[0].r as PromiseRejectedResult).reason?.message || "Delete failed";
      toast.error(`${failures.length} of ${targets.length} could not be deleted: ${firstMsg}`);
    } else {
      toast.success(`Deleted ${targets.length} image${targets.length > 1 ? "s" : ""}`);
      setSelected(new Set());
      setSelectMode(false);
    }
  };

  const handleDeleteOne = async (row: ImageAttachmentRow) => {
    recentlyDeletedRef.current.add(row.id);
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    try {
      await deleteImageAttachment({ id: row.id, storage_path: row.storage_path });
      toast.success("Image deleted");
    } catch (e: any) {
      recentlyDeletedRef.current.delete(row.id);
      setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
      toast.error(e?.message || "Delete failed");
    } finally {
      setSingleTarget(null);
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 flex flex-col bg-surface text-on-surface"
        >
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-outline-variant/20">
            <SheetTitle className="flex items-center gap-2 text-on-surface">
              <ImageIcon className="w-5 h-5" />
              Generated Images
              {rows.length > 0 && (
                <span className="text-xs font-normal text-on-surface-variant">({rows.length})</span>
              )}
            </SheetTitle>
            <SheetDescription className="text-on-surface-variant">
              All AI-generated images from your chats. Select to delete in bulk.
            </SheetDescription>
            <div className="flex items-center gap-2 pt-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search prompts…"
                  className="pl-8 h-9"
                />
              </div>
              <Button
                variant={selectMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelected(new Set());
                }}
                title={selectMode ? "Exit selection" : "Select images"}
              >
                {selectMode ? <X className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
                <span className="ml-1 hidden sm:inline">{selectMode ? "Cancel" : "Select"}</span>
              </Button>
            </div>
            {selectMode && (
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
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-square rounded-xl bg-surface-container-high animate-pulse"
                  />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 px-4 text-on-surface-variant">
                <ImageIcon className="w-12 h-12 mb-3 opacity-40" />
                <p className="font-semibold text-on-surface mb-1">No images yet</p>
                <p className="text-sm">
                  {debounced
                    ? "No images match your search."
                    : "Ask Counsel to generate an image and it will appear here."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {rows.map((row) => {
                  const isSel = selected.has(row.id);
                  return (
                    <div
                      key={row.id}
                      className={`group relative rounded-xl overflow-hidden border transition-all ${
                        isSel
                          ? "border-primary ring-2 ring-primary/40"
                          : "border-outline-variant/20 hover:border-outline-variant/50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (selectMode) toggleOne(row.id);
                        }}
                        className="block w-full text-left"
                      >
                        <div className="aspect-square bg-surface-container-high flex items-center justify-center overflow-hidden">
                          <GeneratedImage
                            storagePath={row.storage_path}
                            alt={row.prompt}
                            className="!my-0 w-full h-full [&_img]:!max-h-none [&_img]:w-full [&_img]:h-full [&_img]:object-cover [&_img]:!rounded-none [&_img]:!border-0 [&_img]:!shadow-none"
                          />
                        </div>
                        <div className="p-2 bg-surface-container">
                          <p className="text-[11px] text-on-surface line-clamp-2 leading-tight">
                            {row.prompt || "Untitled"}
                          </p>
                          <p className="text-[10px] text-on-surface-variant mt-1">
                            {formatRelative(row.created_at)}
                          </p>
                        </div>
                      </button>

                      {selectMode && (
                        <div className="absolute top-2 left-2 bg-surface/90 backdrop-blur rounded-md p-1 shadow-sm pointer-events-none">
                          {isSel ? (
                            <CheckSquare className="w-4 h-4 text-primary" />
                          ) : (
                            <Square className="w-4 h-4 text-on-surface-variant" />
                          )}
                        </div>
                      )}

                      {!selectMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSingleTarget(row);
                          }}
                          aria-label="Delete image"
                          title="Delete image"
                          className="absolute top-2 right-2 p-1.5 bg-surface/90 backdrop-blur rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-destructive hover:text-destructive-foreground"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {selectMode && selected.size > 0 && (
            <div className="border-t border-outline-variant/20 px-4 py-3 bg-surface-container flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                {selected.size} image{selected.size > 1 ? "s" : ""}
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                <span className="ml-1">Delete</span>
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} image{selected.size > 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected images from your library and storage.
              This cannot be undone.
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
    </>
  );
};

export default ImagesPanel;
