import React, { useEffect, useMemo, useState } from "react";
import { BookDocument } from "@/types/library";
import { listFolders, createFolder, renameFolder, deleteFolder, BookFolder } from "@/lib/bookFolders";
import { categoryColor, UNCATEGORIZED } from "@/lib/categoryColors";
import { useApp } from "@/context/AppContext";
import { toast } from "sonner";

// Shelves: the Vault's single grouping surface. One user-managed primitive
// (book_folders rows, presented as "shelves") replaces the former Folders view
// (virtual category groups) and Collections view (managed folders + the
// retired digestion controls). Categories and tags survive as filter chips
// over the All-books section — computed facets over metadata, never a second
// container (the Calibre "virtual library" model). Membership is still
// one-shelf-per-book (books.folder_id); the junction-table migration that
// makes shelves non-exclusive is a later, separate change.
//
// Membership has exactly ONE client copy: books[].folderId in AppContext
// (loaded paged at startup, patched by updateBookFolder on every move). This
// view derives everything from the books prop — no second fetch, no local
// assignments map, so the two can never disagree and the PostgREST 1000-row
// cap on un-ranged selects never applies here.

interface Props {
  books: BookDocument[];
  renderBook: (book: BookDocument, index: number) => React.ReactNode;
  /** True while the Vault search query is filtering the books prop — empty
   *  states must not claim a shelf is empty when its books are just filtered
   *  out of view. */
  filtered?: boolean;
}

const LibraryShelves: React.FC<Props> = ({ books, renderBook, filtered = false }) => {
  const { updateBookFolder, clearBookFolderLocal } = useApp();
  const [shelves, setShelves] = useState<BookFolder[]>([]);
  const [openShelfId, setOpenShelfId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Facet filters for the All-books section only.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const f = await listFolders();
        if (!cancel) setShelves(f);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load shelves");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  // Membership derived once per books/shelves change, not per shelf card.
  const membersByShelf = useMemo(() => {
    const map = new Map<string, BookDocument[]>();
    for (const b of books) {
      if (!b.folderId) continue;
      const list = map.get(b.folderId) || [];
      list.push(b);
      map.set(b.folderId, list);
    }
    return map;
  }, [books]);

  const booksOnShelf = useMemo(
    () => (openShelfId ? membersByShelf.get(openShelfId) || [] : []),
    [membersByShelf, openShelfId],
  );

  // Category chips with counts, colored like the old virtual folders.
  const categoryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of books) {
      const cat = b.category || UNCATEGORIZED;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [books]);

  // The search box filters the books prop, so an active category can vanish
  // from the chip row — its chip is the only control that clears it, which
  // would strand an invisible, unclearable filter. Drop the filter the moment
  // its chip is gone.
  useEffect(() => {
    if (activeCategory && !categoryChips.some(([c]) => c === activeCategory)) {
      setActiveCategory(null);
      setActiveTags([]);
    }
  }, [categoryChips, activeCategory]);

  const categoryBooks = useMemo(() => {
    if (!activeCategory) return books;
    return books.filter((b) => (b.category || UNCATEGORIZED) === activeCategory);
  }, [books, activeCategory]);

  // Tag chips scoped to the active category selection; most-used first.
  const tagChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of categoryBooks) {
      for (const t of b.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [categoryBooks]);

  const visibleBooks = useMemo(() => {
    if (activeTags.length === 0) return categoryBooks;
    return categoryBooks.filter((b) => activeTags.every((t) => (b.tags || []).includes(t)));
  }, [categoryBooks, activeTags]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const f = await createFolder(name);
      setShelves((prev) => [...prev, f]);
      setNewName("");
      toast.success(`Shelf "${name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create shelf");
    }
  };

  const handleRename = async (id: string) => {
    const name = renameDraft.trim();
    if (!name) { setRenaming(null); return; }
    try {
      await renameFolder(id, name);
      setShelves((prev) => prev.map((f) => f.id === id ? { ...f, name } : f));
      setRenaming(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const handleDelete = async (id: string) => {
    const f = shelves.find((x) => x.id === id);
    if (!f) return;
    if (!window.confirm(`Delete shelf "${f.name}"? Books on it stay in your library (nothing is deleted).`)) return;
    try {
      await deleteFolder(id);
      setShelves((prev) => prev.filter((x) => x.id !== id));
      // The DB FK is ON DELETE SET NULL — mirror it in client state so the
      // freed books show as unshelved without a reload.
      clearBookFolderLocal(id);
      if (openShelfId === id) setOpenShelfId(null);
      toast.success("Shelf deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const assignBook = async (bookId: string, shelfId: string | null) => {
    try {
      await updateBookFolder(bookId, shelfId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    }
  };

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const pickCategory = (cat: string) => {
    setActiveTags([]);
    setActiveCategory((prev) => (prev === cat ? null : cat));
  };

  // A book card with the shelf-assignment dropdown overlaid on hover.
  const renderBookCard = (b: BookDocument, index: number) => (
    <div key={b.id} className="relative group">
      {renderBook(b, index)}
      <select
        value={b.folderId || ""}
        onChange={(e) => assignBook(b.id, e.target.value || null)}
        className="absolute top-2 right-2 bg-surface-container-high text-xs rounded-md px-1.5 py-0.5 border border-outline-variant/30 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        title="Move to shelf"
      >
        <option value="">No shelf</option>
        {shelves.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </div>
  );

  if (loading) {
    return <div className="py-16 text-center text-on-surface-variant text-sm">Loading shelves…</div>;
  }

  // Open-shelf drill-in view.
  if (openShelfId) {
    const shelf = shelves.find((f) => f.id === openShelfId);
    return (
      <div className="flex flex-col gap-5">
        <nav aria-label="Shelf navigation" className="flex items-center gap-1.5 text-sm">
          <button
            onClick={() => setOpenShelfId(null)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>shelves</span>
            All shelves
          </button>
          <span className="text-on-surface-variant/50" aria-hidden>/</span>
          <span className="flex items-center gap-1.5 px-2 py-1 font-semibold text-foreground">
            <span className="material-symbols-outlined text-base text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>folder_open</span>
            {shelf?.name}
            <span className="text-on-surface-variant font-normal">({booksOnShelf.length})</span>
          </span>
        </nav>

        {booksOnShelf.length === 0 ? (
          <div className="py-12 text-center text-on-surface-variant text-sm">
            {filtered
              ? "No books on this shelf match your search."
              : "This shelf is empty — hover any book card and use the dropdown to move it here."}
          </div>
        ) : (
          <div className="book-grid">
            {booksOnShelf.map((b, i) => renderBookCard(b, i))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Shelf cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {shelves.map((f) => {
          const members = membersByShelf.get(f.id) || [];
          const covers = members
            .filter((b) => b.coverImageUrl)
            .slice(0, 3)
            .map((b) => b.coverImageUrl as string);
          return (
            <div
              key={f.id}
              className="group relative flex flex-col items-start gap-3 rounded-2xl p-5 text-left border border-outline-variant/15 bg-surface-container-high transition-all hover:-translate-y-0.5 hover:shadow-xl"
            >
              <button onClick={() => setOpenShelfId(f.id)} className="absolute inset-0" aria-label={`Open ${f.name}`} />
              <div className="flex items-center justify-between w-full pointer-events-none">
                <span className="material-symbols-outlined text-4xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>shelves</span>
                {/* Cover peeks — covers are the highest-recognition cue for books */}
                <div className="flex -space-x-2">
                  {covers.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt=""
                      className="w-7 h-10 object-cover rounded-sm border border-black/40 shadow-sm"
                      style={{ transform: `rotate(${(i - 1) * 6}deg)` }}
                    />
                  ))}
                </div>
              </div>
              <div className="min-w-0 z-10 pointer-events-none">
                {renaming === f.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => handleRename(f.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(f.id); if (e.key === "Escape") setRenaming(null); }}
                    className="bg-surface-container-highest rounded px-2 py-0.5 text-sm pointer-events-auto"
                  />
                ) : (
                  <p className="font-headline font-bold text-base text-foreground truncate w-full">{f.name}</p>
                )}
                <p className="text-xs text-on-surface-variant mt-0.5">{members.length} book{members.length === 1 ? "" : "s"}</p>
              </div>
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                <button
                  onClick={(e) => { e.stopPropagation(); setRenameDraft(f.name); setRenaming(f.id); }}
                  title="Rename"
                  className="p-1 rounded bg-surface-container-high hover:bg-surface-container-highest"
                >
                  <span className="material-symbols-outlined text-sm">edit</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(f.id); }}
                  title="Delete"
                  className="p-1 rounded bg-surface-container-high hover:bg-red-500/20 text-red-300"
                >
                  <span className="material-symbols-outlined text-sm">delete</span>
                </button>
              </div>
            </div>
          );
        })}
        {/* Create card */}
        <div className="flex flex-col items-stretch gap-2 rounded-2xl p-5 border-2 border-dashed border-outline-variant/30">
          <p className="text-xs uppercase tracking-widest text-on-surface-variant">New shelf</p>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            placeholder="Shelf name"
            className="bg-surface-container-high rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40 border-none"
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim()}
            className="px-3 py-1.5 bg-primary/10 text-primary text-sm font-bold rounded-lg hover:bg-primary hover:text-on-primary-container disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>

      {/* All books, filterable by category/tag facets (the old virtual-folder
          grouping, flattened into chips) */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-2 px-1">
          <p className="text-xs uppercase tracking-widest text-on-surface-variant">
            All books ({visibleBooks.length}{visibleBooks.length !== books.length ? ` of ${books.length}` : ""})
          </p>
        </div>

        {categoryChips.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {categoryChips.map(([cat, count]) => {
              const active = activeCategory === cat;
              const color = categoryColor(cat);
              return (
                <button
                  key={cat}
                  onClick={() => pickCategory(cat)}
                  aria-pressed={active}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] border capitalize transition-all ${
                    active
                      ? "bg-primary/15 text-primary border-primary/40 font-semibold"
                      : "bg-surface-container-high text-on-surface-variant border-outline-variant/10 hover:text-primary"
                  }`}
                  style={active ? undefined : { borderColor: `${color}30` }}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
                  {cat}
                  <span className="opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {activeCategory && tagChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tagChips.map(([tag, count]) => {
              const active = activeTags.includes(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  aria-pressed={active}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] border transition-all ${
                    active
                      ? "bg-primary/15 text-primary border-primary/40 font-semibold"
                      : "bg-surface-container-high text-on-surface-variant border-outline-variant/10 hover:text-primary"
                  }`}
                >
                  #{tag}
                  <span className="opacity-60">{count}</span>
                  {active && <span className="material-symbols-outlined text-sm" aria-hidden>close</span>}
                </button>
              );
            })}
            {activeTags.length > 0 && (
              <button
                onClick={() => setActiveTags([])}
                className="px-2.5 py-1 rounded-full text-[12px] text-on-surface-variant hover:text-primary underline underline-offset-2"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {visibleBooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
            <span className="material-symbols-outlined text-5xl mb-3 opacity-30">filter_alt_off</span>
            <p className="text-sm">No books match the selected filters</p>
          </div>
        ) : (
          <div className="book-grid">
            {visibleBooks.map((b, i) => renderBookCard(b, i))}
          </div>
        )}
      </section>
    </div>
  );
};

export default LibraryShelves;
