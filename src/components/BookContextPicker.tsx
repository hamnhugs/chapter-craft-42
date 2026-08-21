import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { listFolders, type BookFolder } from "@/lib/bookFolders";
import {
  bookContextStore, selectContextBooks, isEmptySelection,
  BOOK_CONTEXT_MAX_BOOKS,
} from "@/lib/chatBooks";
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
  const { books, activeBookId } = useApp();
  const { user } = useAuth();
  const [shelves, setShelves] = useState<BookFolder[]>([]);
  const selection = useSyncExternalStore(bookContextStore.subscribe, bookContextStore.get);

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
    () => (selection.shelfId ? books.filter((b) => b.folderId === selection.shelfId) : []),
    [books, selection.shelfId],
  );
  // One O(books) pass for the dropdown's per-shelf counts, not a filter per
  // option per render (store emits re-render the open dialog on every toggle).
  const countByShelf = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of books) {
      if (b.folderId) map.set(b.folderId, (map.get(b.folderId) || 0) + 1);
    }
    return map;
  }, [books]);
  // Hand-pick mode lists the whole (search-independent) library.
  const listed = selection.shelfId ? shelfMembers : books;
  const effective = useMemo(
    () => selectContextBooks(books, selection, activeBookId ?? null),
    [books, selection, activeBookId],
  );

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
            The checked books' text is sent with every message so the AI can quote and cite them.
            Load a shelf to keep it in sync — books you add to the shelf join the conversation automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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
