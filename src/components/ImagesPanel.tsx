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
  UnifiedImage,
  ImageProvenance,
  fetchAllImageMeta,
  filterImages,
  deleteUnifiedImage,
} from "@/lib/imageLibrary";
import { supabase } from "@/integrations/supabase/client";

interface ImagesPanelProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const PAGE_SIZE = 60;

const PROVENANCE_LABELS: Record<ImageProvenance, string> = {
  generated: "AI",
  upload: "Upload",
  figure: "Figure",
  sheet: "Sheet",
  "splat-views": "3D view",
  edit: "Edit",
  "memory-only": "Memory only",
};

// Breakdown line under the title — plural noun per provenance class.
const BREAKDOWN_NOUNS: Array<[ImageProvenance, string, string]> = [
  ["generated", "generated", "generated"],
  ["upload", "upload", "uploads"],
  ["figure", "figure", "figures"],
  ["sheet", "sheet", "sheets"],
  ["splat-views", "3D view", "3D views"],
  ["edit", "edit", "edits"],
  ["memory-only", "memory-only", "memory-only"],
];

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
  const [rows, setRows] = useState<UnifiedImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Single-image delete confirmation
  const [singleTarget, setSingleTarget] = useState<UnifiedImage | null>(null);
  // Keys AND row ids we just deleted optimistically — used to ignore racing
  // realtime/event reloads (realtime carries the attachment id, the window
  // events carry either table's id, our own filter uses the key).
  const recentlyDeletedRef = React.useRef<Set<string>>(new Set());

  const markDeleted = (img: UnifiedImage) => {
    recentlyDeletedRef.current.add(img.key);
    if (img.attachmentId) recentlyDeletedRef.current.add(img.attachmentId);
    if (img.memoryId) recentlyDeletedRef.current.add(img.memoryId);
  };
  const unmarkDeleted = (img: UnifiedImage) => {
    recentlyDeletedRef.current.delete(img.key);
    if (img.attachmentId) recentlyDeletedRef.current.delete(img.attachmentId);
    if (img.memoryId) recentlyDeletedRef.current.delete(img.memoryId);
  };

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchAllImageMeta();
      // Filter out anything we just deleted in case a stale fetch races.
      const filtered = list.filter((r) => !recentlyDeletedRef.current.has(r.key));
      setRows(filtered);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load images");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Realtime: keep panel in sync with new images. Skip our own optimistic
  // deletes. (Dead until the table joins the realtime publication — kept so
  // it self-heals the moment the publication is fixed.)
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

  // Window events from the write paths (imageGen / imageUpload / figureJobs /
  // chatTools) — the working refresh channel while realtime stays dead.
  useEffect(() => {
    if (!open) return;
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const deleted: string[] = Array.isArray(detail.deleted) ? detail.deleted : [];
      // A delete event covering only our own optimistic deletes is an echo.
      if (deleted.length > 0 && deleted.every((id) => recentlyDeletedRef.current.has(id))) return;
      void load();
    };
    window.addEventListener("image-attachments-changed", onChanged);
    window.addEventListener("image-memories-changed", onChanged);
    return () => {
      window.removeEventListener("image-attachments-changed", onChanged);
      window.removeEventListener("image-memories-changed", onChanged);
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

  // New search → new render window.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [debounced]);

  const filtered = useMemo(() => filterImages(rows, debounced), [rows, debounced]);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const remaining = Math.max(0, filtered.length - visibleCount);

  const breakdown = useMemo(() => {
    const counts = new Map<ImageProvenance, number>();
    rows.forEach((r) => counts.set(r.provenance, (counts.get(r.provenance) || 0) + 1));
    return BREAKDOWN_NOUNS
      .filter(([p]) => (counts.get(p) || 0) > 0)
      .map(([p, one, many]) => `${counts.get(p)} ${counts.get(p) === 1 ? one : many}`)
      .join(" · ");
  }, [rows]);

  // Selection operates over the FILTERED set, not just the rendered window.
  const allFilteredKeys = useMemo(() => filtered.map((r) => r.key), [filtered]);
  const allSelected = selected.size > 0 && allFilteredKeys.every((key) => selected.has(key));
  // The selection can hold keys from a PREVIOUS search (it survives query
  // edits by design) — but delete only ever acts on filtered ∩ selected, so
  // every count the user sees must be THIS number, never selected.size.
  const selectedTargets = useMemo(() => filtered.filter((r) => selected.has(r.key)), [filtered, selected]);

  const toggleOne = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allFilteredKeys));
  };

  const handleDeleteSelected = async () => {
    const targets = selectedTargets;
    if (targets.length === 0) return;
    setDeleting(true);
    const snapshot = rows;
    // Track for realtime/event dedupe and optimistically remove — keyed off
    // the ACTUAL target set: removing by the raw selection would also hide
    // selected-but-filtered-out rows that were never deleted.
    const targetKeys = new Set(targets.map((t) => t.key));
    targets.forEach(markDeleted);
    setRows((prev) => prev.filter((r) => !targetKeys.has(r.key)));
    const results = await Promise.allSettled(targets.map((r) => deleteUnifiedImage(r)));
    const failures = results
      .map((r, i) => ({ r, t: targets[i] }))
      .filter((x) => x.r.status === "rejected");
    setDeleting(false);
    setConfirmOpen(false);
    if (failures.length > 0) {
      // Roll back failed ones from the dedupe set and restore them in UI
      failures.forEach((f) => unmarkDeleted(f.t));
      setRows(snapshot.filter((r) => !targets.some((t) => t.key === r.key && !failures.some((f) => f.t.key === r.key))));
      const firstMsg = (failures[0].r as PromiseRejectedResult).reason?.message || "Delete failed";
      toast.error(`${failures.length} of ${targets.length} could not be deleted: ${firstMsg}`);
    } else {
      toast.success(`Deleted ${targets.length} image${targets.length > 1 ? "s" : ""}`);
      setSelected(new Set());
      setSelectMode(false);
    }
  };

  const handleDeleteOne = async (img: UnifiedImage) => {
    markDeleted(img);
    setRows((prev) => prev.filter((r) => r.key !== img.key));
    try {
      await deleteUnifiedImage(img);
      toast.success(img.provenance === "memory-only" ? "Image memory deleted" : "Image deleted");
    } catch (e: any) {
      unmarkDeleted(img);
      setRows((prev) => (prev.some((r) => r.key === img.key) ? prev : [img, ...prev]));
      toast.error(e?.message || "Delete failed");
    } finally {
      setSingleTarget(null);
    }
  };

  const selectedMemoryOnly = useMemo(
    () => filtered.filter((r) => selected.has(r.key) && r.provenance === "memory-only").length,
    [filtered, selected],
  );

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
              All Images
              {rows.length > 0 && (
                <span className="text-xs font-normal text-on-surface-variant">({rows.length})</span>
              )}
            </SheetTitle>
            <SheetDescription className="text-on-surface-variant">
              Every image the app has stored — generated, uploaded, and extracted. Select to delete in bulk.
            </SheetDescription>
            {breakdown && (
              <p className="text-[11px] text-on-surface-variant/80">{breakdown}</p>
            )}
            <div className="flex items-center gap-2 pt-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search prompts, captions, OCR text…"
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
                  {allSelected ? "Deselect all" : `Select all (${filtered.length})`}
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
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 px-4 text-on-surface-variant">
                <ImageIcon className="w-12 h-12 mb-3 opacity-40" />
                <p className="font-semibold text-on-surface mb-1">No images yet</p>
                <p className="text-sm">
                  {debounced
                    ? "No images match your search."
                    : "Generate or upload an image and it will appear here."}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {visible.map((row) => {
                    const isSel = selected.has(row.key);
                    const memoryOnly = row.provenance === "memory-only";
                    return (
                      <div
                        key={row.key}
                        className={`group relative rounded-xl overflow-hidden border transition-all ${
                          isSel
                            ? "border-primary ring-2 ring-primary/40"
                            : "border-outline-variant/20 hover:border-outline-variant/50"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (selectMode) toggleOne(row.key);
                          }}
                          className="block w-full text-left"
                        >
                          <div className="aspect-square bg-surface-container-high flex items-center justify-center overflow-hidden">
                            <GeneratedImage
                              storagePath={row.storagePath}
                              alt={row.title}
                              className="!my-0 w-full h-full [&_img]:!max-h-none [&_img]:w-full [&_img]:h-full [&_img]:object-cover [&_img]:!rounded-none [&_img]:!border-0 [&_img]:!shadow-none"
                            />
                          </div>
                          <div className="p-2 bg-surface-container">
                            <p className="text-[11px] text-on-surface line-clamp-2 leading-tight">
                              {row.title}
                            </p>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span
                                className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-px rounded ${
                                  memoryOnly
                                    ? "border border-dashed border-outline-variant/60 text-on-surface-variant"
                                    : "bg-surface-container-highest text-on-surface-variant"
                                }`}
                              >
                                {PROVENANCE_LABELS[row.provenance]}
                              </span>
                              <span className="text-[10px] text-on-surface-variant">
                                {formatRelative(row.createdAt)}
                              </span>
                            </div>
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
                {remaining > 0 && (
                  <div className="pt-4 flex justify-center">
                    <Button variant="outline" size="sm" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                      Load more ({remaining} remaining)
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          {selectMode && selectedTargets.length > 0 && (
            <div className="border-t border-outline-variant/20 px-4 py-3 bg-surface-container flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                {selectedTargets.length} image{selectedTargets.length > 1 ? "s" : ""}
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
            <AlertDialogTitle>Delete {selectedTargets.length} image{selectedTargets.length > 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected images from your library and storage,
              along with any memory records (captions, OCR text) sharing the same file.
              {selectedMemoryOnly > 0 && (
                <> For memory-only entries, the record is removed; the picture file is kept
                only if a library image still uses it.</>
              )}{" "}
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

      <AlertDialog open={singleTarget !== null} onOpenChange={(v) => { if (!v) setSingleTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete this {singleTarget?.provenance === "memory-only" ? "image memory" : "image"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {singleTarget?.provenance === "memory-only"
                ? "This removes the memory record (caption, OCR text). The picture file is deleted too unless a library image still uses it. This cannot be undone."
                : "This permanently removes the image from your library and storage, along with any memory records sharing the same file. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); if (singleTarget) void handleDeleteOne(singleTarget); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default ImagesPanel;
