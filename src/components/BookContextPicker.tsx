import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { useChatSettings } from "@/hooks/useChatSettings";
import { listFolders, type BookFolder } from "@/lib/bookFolders";
import {
  bookContextStore, selectContextBooks, isEmptySelection,
  BOOK_CONTEXT_MAX_BOOKS, type BookContextMode,
} from "@/lib/chatBooks";
import { acquireGistRun, generateBookGists, releaseGistRun } from "@/lib/chapterGists";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";

// Book-context picker: load a shelf (membership resolves fresh every turn —
// books added to the shelf later appear automatically) or hand-pick books.
// The NotebookLM interaction contract: cheap per-conversation sub-selection
// via checkboxes, never a reorganization of the library itself.

const BookContextPicker: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { books, activeBookId, applyChapterGists } = useApp();
  const { user } = useAuth();
  const { selectedModel, apiKey, geminiApiKey, nvidiaKeyLast4 } = useChatSettings();
  const [shelves, setShelves] = useState<BookFolder[]>([]);
  const [gistProgress, setGistProgress] = useState<string | null>(null);
  const selection = useSyncExternalStore(bookContextStore.subscribe, bookContextStore.get);
  const mode: BookContextMode = selection.mode === "catalog" ? "catalog" : "full";

  useEffect(() => {
    bookContextStore.init(user?.id ?? null);
  }, [user?.id]);

  useEffect(() => {
    if (!open) return;
    listFolders().then(setShelves).catch(() => {
      toast.error("Couldn't load your shelves");
    });
  }, [open]);

  const shelfMembers = useMemo(
    () => (selection.shelfId ? books.filter((b) => b.folderIds.includes(selection.shelfId!)) : []),
    [books, selection.shelfId],
  );
  // One O(memberships) pass for the dropdown's per-shelf counts, not a filter
  // per option per render (store emits re-render the open dialog on every toggle).
  const countByShelf = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of books) {
      for (const folderId of b.folderIds) map.set(folderId, (map.get(folderId) || 0) + 1);
    }
    return map;
  }, [books]);
  // Hand-pick mode lists the whole (search-independent) library.
  const listed = selection.shelfId ? shelfMembers : books;
  const effective = useMemo(
    () => selectContextBooks(books, selection, activeBookId ?? null),
    [books, selection, activeBookId],
  );

  const gistCoverage = useMemo(() => {
    let have = 0;
    let total = 0;
    for (const b of effective) {
      for (const c of b.chapters) {
        total++;
        if ((c.gist || "").trim()) have++;
      }
    }
    return { have, total };
  }, [effective]);

  // Generates with the user's own selected chat model + key — an explicit,
  // user-initiated spend (a few cents per book), never automatic.
  const runGists = async () => {
    if (gistProgress) return;
    // Chapterless books have nothing to summarize — and "every chapter
    // already has a summary" would be a lie about zero chapters.
    if (gistCoverage.total === 0) {
      toast.info("No chapters isolated yet — open a book and isolate its chapters first");
      return;
    }
    const targets = effective.filter((b) => b.chapters.some((c) => !(c.gist || "").trim()));
    if (targets.length === 0) {
      toast.info("Every chapter already has a summary");
      return;
    }
    // Module-scope lock: component state dies on a tab switch while the run
    // keeps going — without this, a remounted picker's button double-spends.
    if (!acquireGistRun()) {
      toast.info("Summaries are already being generated — hang on");
      return;
    }
    setGistProgress("Starting…");
    try {
      let written = 0;
      let failed = 0;
      for (const b of targets) {
        const res = await generateBookGists(
          b,
          { model: selectedModel, keys: { apiKey, geminiApiKey, nvidiaKeyLast4 } },
          (msg) => setGistProgress(`${(b.title || "Untitled").slice(0, 24)}: ${msg}`),
        );
        // Apply BEFORE surfacing any stop error: everything in res.written is
        // already in the DB, and state must mirror it or they diverge.
        applyChapterGists(res.written);
        written += Object.keys(res.written).length;
        failed += res.failed;
        if (res.stopError) {
          toast.error(res.stopError);
          if (written > 0) toast.info(`${written} summar${written === 1 ? "y" : "ies"} were saved before the stop.`);
          return;
        }
      }
      if (written > 0) {
        toast.success(
          `Catalog updated — ${written} chapter summar${written === 1 ? "y" : "ies"}` +
          (failed ? `, ${failed} failed (run again to retry)` : ""),
        );
      } else {
        toast.error(failed ? "The model returned no usable summaries — try again or switch models" : "Nothing to summarize");
      }
    } catch (e: any) {
      toast.error(e?.message || "Couldn't generate summaries");
    } finally {
      releaseGistRun();
      setGistProgress(null);
    }
  };

  const isChecked = (id: string) =>
    selection.shelfId ? !selection.excludedIds.includes(id) : selection.bookIds.includes(id);

  const toggleBook = (id: string) => {
    if (selection.shelfId) {
      const excluded = selection.excludedIds.includes(id)
        ? selection.excludedIds.filter((x) => x !== id)
        : [...selection.excludedIds, id];
      bookContextStore.set({ ...selection, excludedIds: excluded });
    } else {
      const bookIds = selection.bookIds.includes(id)
        ? selection.bookIds.filter((x) => x !== id)
        : [...selection.bookIds, id];
      bookContextStore.set({ ...selection, bookIds });
    }
  };

  const pickShelf = (shelfId: string) => {
    if (!shelfId) {
      // Leaving shelf mode keeps the currently effective books as a
      // hand-picked set, so switching modes never silently empties context.
      bookContextStore.set({ shelfId: null, bookIds: effective.map((b) => b.id), excludedIds: [] });
    } else {
      bookContextStore.set({ shelfId, bookIds: [], excludedIds: [] });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl text-primary">Books in context</DialogTitle>
          <DialogDescription>
            {mode === "catalog"
              ? "Each message carries the checked books' chapter catalogs (titles + one-line summaries); the AI reads a chapter's text only when it needs it. Cheap and fast."
              : "The checked books' text rides with every message, up to the context budget — very large books degrade to honest excerpts, and the reply's receipt shows exactly what was sent."}
            {" "}Load a shelf to keep it in sync — books you add to the shelf join the conversation automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">How books ride</label>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-container-high p-1">
              {(
                [
                  ["full", "Full text", "everything, every message"],
                  ["catalog", "Catalog", "summaries + fetch on demand"],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => bookContextStore.set({ ...selection, mode: value })}
                  className={`rounded-md px-2 py-1.5 text-left transition-colors ${
                    mode === value ? "bg-primary-container/60 text-foreground" : "text-on-surface-variant hover:bg-surface-container-highest"
                  }`}
                >
                  <span className="block text-xs font-semibold">{label}</span>
                  <span className="block text-[10px] opacity-80">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {mode === "catalog" && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-container-high px-3 py-2">
              <span className="min-w-0 truncate text-[11px] text-on-surface-variant">
                {gistProgress ??
                  (gistCoverage.total === 0
                    ? "The loaded books have no chapters yet."
                    : `${gistCoverage.have}/${gistCoverage.total} chapters have summaries.`)}
              </span>
              <button
                type="button"
                onClick={runGists}
                disabled={!!gistProgress || effective.length === 0}
                className="shrink-0 text-[11px] font-bold uppercase tracking-widest text-primary disabled:opacity-50"
              >
                {gistProgress ? "Working…" : "Generate summaries"}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">Shelf</label>
            <select
              value={selection.shelfId || ""}
              onChange={(e) => pickShelf(e.target.value)}
              className="w-full bg-surface-container-high border-none rounded-lg text-sm py-2 px-3"
            >
              <option value="">Hand-picked books</option>
              {shelves.map((f) => {
                const n = countByShelf.get(f.id) || 0;
                return <option key={f.id} value={f.id}>{f.name} ({n} book{n === 1 ? "" : "s"})</option>;
              })}
            </select>
          </div>

          {listed.length === 0 ? (
            <p className="text-sm text-on-surface-variant py-4 text-center">
              {selection.shelfId ? "This shelf has no books yet." : "Your library is empty."}
            </p>
          ) : (
            <div className="flex flex-col gap-1 max-h-72 overflow-y-auto pr-1">
              {listed.map((b) => (
                <label key={b.id} className="flex items-start gap-2 text-sm px-2 py-1.5 rounded-lg hover:bg-surface-container-high cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isChecked(b.id)}
                    onChange={() => toggleBook(b.id)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {b.title}
                      {b.id === activeBookId ? <span className="ml-1.5 text-[10px] font-bold uppercase tracking-widest text-primary">reading</span> : null}
                    </span>
                    <span className="block text-[11px] text-on-surface-variant">
                      {b.chapters.length > 0
                        ? `${b.chapters.length} chapter${b.chapters.length === 1 ? "" : "s"}`
                        : "no chapters isolated — its text can't be sent yet"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 text-[11px] text-on-surface-variant">
            <span>
              {effective.length === 0
                ? "Nothing loaded."
                : `${effective.length} book${effective.length === 1 ? "" : "s"} will ride with each message.`}
              {effective.length >= BOOK_CONTEXT_MAX_BOOKS ? ` (max ${BOOK_CONTEXT_MAX_BOOKS})` : ""}
            </span>
            {!isEmptySelection(selection) && (
              <button
                onClick={() => bookContextStore.clear()}
                className="font-bold uppercase tracking-widest hover:text-destructive"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BookContextPicker;
