import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useApp } from "@/context/AppContext";
import { usePlan } from "@/hooks/usePlan";
import { computeLockedWikiIds } from "@/lib/neuronAccess";
import { createWiki, isSystemWiki } from "@/lib/wikisApi";
import { COVER_PALETTE } from "@/components/NotebookFormDialog";
import { useFilingRequest, useWorkspaceItems, workspaceStore } from "@/lib/workspaceStore";

/**
 * "Which notebook is this for?" — the one place a Workspace item gets a
 * notebook when Counsel had none loaded, and the same sheet the Workspace's
 * "Move" uses.
 *
 * The files in question are ALREADY saved. This asks where they belong; it
 * never decides whether they exist, so closing it loses nothing — they wait
 * under "Needs a notebook" in the Workspace.
 *
 * Mounted once, app-wide (the question can be raised from any tab).
 */
const WorkspaceFilingPrompt: React.FC = () => {
  const request = useFilingRequest();
  const allItems = useWorkspaceItems();
  const { wikis, activeWikiIds, setActiveWiki, refreshWikis } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();

  const [keepOpen, setKeepOpen] = useState(true);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const isNew = request?.mode === "new";
  const open = !!request;

  // Re-seed each time a question opens.
  useEffect(() => {
    if (!open) return;
    setNewName("");
    setKeepOpen(true);
  }, [open, request?.mode]);

  const files = useMemo(
    () => (request ? allItems.filter((i) => request.ids.includes(i.id)) : []),
    [allItems, request],
  );

  // Free-plan locked notebooks can hold files but cannot be loaded.
  const lockedIds = useMemo(
    () => computeLockedWikiIds(wikis, isPaid, planLoaded),
    [wikis, isPaid, planLoaded],
  );
  const choices = useMemo(
    () => wikis.filter((w) => !isSystemWiki(w) || activeWikiIds.includes(w.id)),
    [wikis, activeWikiIds],
  );
  // Where a single file being moved lives now.
  const currentId = !isNew && files.length === 1 ? files[0].meta?.wikiId ?? null : null;

  const file = async (wikiId: string, name: string, canLoad: boolean) => {
    if (!request) return;
    const count = request.ids.length;
    workspaceStore.assignNotebook(request.ids, wikiId);
    let loaded = false;
    if (isNew && keepOpen && canLoad) {
      try {
        await setActiveWiki(wikiId);
        loaded = true;
      } catch {
        /* the files are filed either way; Counsel just stays as it was */
      }
    }
    toast.success(
      `${count === 1 ? "Filed" : `${count} files filed`} in “${name}”`,
      loaded ? { description: "Counsel is using this notebook now — new files go here on their own." } : undefined,
    );
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const wiki = await createWiki({
        name,
        cover_color: COVER_PALETTE[Math.floor(Math.random() * COVER_PALETTE.length)],
      });
      await refreshWikis();
      // A free plan's second notebook is created locked: file there, don't load.
      const locked = computeLockedWikiIds([...wikis, wiki], isPaid, planLoaded).has(wiki.id);
      await file(wiki.id, wiki.name, !locked);
    } catch (err: any) {
      toast.error(err?.message || "Couldn't create that notebook");
    } finally {
      setBusy(false);
    }
  };

  const title = isNew
    ? files.length > 1 ? "Which notebook are these for?" : "Which notebook is this for?"
    : "Move to a notebook";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) workspaceStore.dismissFiling(); }}>
      <DialogContent
        className="max-w-md gap-3 max-h-[calc(100dvh-1.5rem)] flex flex-col"
        // Never focus the name field on open: on Android that raises the
        // keyboard over the list the person came to tap (src/lib/focusPolicy.ts).
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "No notebook was open, so Counsel didn't know where to put this. Pick one and the Workspace stays tidy."
              : "Files show up in the Workspace and in the notebook they belong to."}
          </DialogDescription>
        </DialogHeader>

        {/* What is being filed */}
        <ul className="rounded-lg border border-outline-variant/15 bg-surface-container-low divide-y divide-outline-variant/10 text-sm shrink-0">
          {files.slice(0, 3).map((f) => (
            <li key={f.id} className="flex items-center gap-2 px-3 py-1.5 min-w-0">
              <span className="material-symbols-outlined text-[18px] text-primary-container shrink-0" aria-hidden>draft</span>
              <span className="truncate text-foreground">{f.title}</span>
            </li>
          ))}
          {files.length > 3 && (
            <li className="px-3 py-1.5 text-xs text-on-surface-variant">and {files.length - 3} more</li>
          )}
        </ul>

        {/* Pick one */}
        {choices.length > 0 && (
          <ul className="min-h-0 overflow-auto -mx-1 px-1 space-y-1" aria-label="Notebooks">
            {choices.map((w) => {
              const locked = lockedIds.has(w.id);
              const here = w.id === currentId;
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    disabled={busy || here}
                    onClick={() => void file(w.id, w.name, !locked)}
                    className="flex items-center gap-3 w-full min-h-[44px] text-left rounded-lg px-3 py-2 border border-outline-variant/15 bg-surface-container-high/50 hover:border-primary-container/50 hover:bg-surface-container-high disabled:opacity-60 disabled:hover:border-outline-variant/15 transition-colors"
                  >
                    <span aria-hidden className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: w.cover_color || "#7C3AED" }} />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{w.name}</span>
                    {here && <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Here now</span>}
                    {locked && isNew && (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant" title="Files can go here, but the free plan can't open this notebook in Counsel">
                        <Lock className="w-3 h-3" aria-hidden /> Files only
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Or make one */}
        <form
          className="flex items-center gap-2 shrink-0"
          onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={80}
            aria-label="New notebook name"
            placeholder={choices.length ? "Or name a new notebook" : "Name your first notebook"}
            className="flex-1 min-w-0 h-10 bg-surface-container-low border border-outline-variant/20 rounded-lg px-3 text-sm text-foreground placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <button
            type="submit"
            disabled={!newName.trim() || busy}
            className="shrink-0 h-10 px-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
            Create
          </button>
        </form>

        <div className="flex items-center gap-3 shrink-0 min-w-0">
          {isNew && (
            <label className="flex items-center gap-2 text-xs text-on-surface-variant min-w-0 cursor-pointer">
              <input
                type="checkbox"
                checked={keepOpen}
                onChange={(e) => setKeepOpen(e.target.checked)}
                className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
              />
              <span className="min-w-0">Keep it open in Counsel, so I'm not asked again</span>
            </label>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => workspaceStore.dismissFiling()}
            className="ml-auto shrink-0 h-9 px-3 rounded-lg text-sm text-on-surface-variant hover:text-foreground hover:bg-surface-container-high"
          >
            {isNew ? "Decide later" : "Cancel"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default WorkspaceFilingPrompt;
