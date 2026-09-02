import React, { useEffect, useMemo, useState } from "react";
import { BookDocument } from "@/types/library";
import type { BookFolder } from "@/lib/bookFolders";
import { categoryColor, UNCATEGORIZED } from "@/lib/categoryColors";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { bookContextStore } from "@/lib/chatBooks";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

// Shelves: the Vault's single grouping surface. One user-managed primitive
// (book_folders rows, presented as "shelves") replaces the former Folders view
// (virtual category groups) and Collections view (managed folders + the
// retired digestion controls). Categories and tags survive as filter chips
// over the All-books section — computed facets over metadata, never a second
// container (the Calibre "virtual library" model). Membership is
// NON-EXCLUSIVE (book_shelf_members junction) — checkbox membership, the
// Kindle/Apple Books model — degrading to one-shelf-per-book while the
// junction migration hasn't been applied (multiShelf false: checking a shelf
// moves the book, matching what books.folder_id can actually store).
//
// Membership has exactly ONE client copy: books[].folderIds in AppContext
// (loaded paged at startup, patched by toggleBookShelf on every change).
// This view derives everything from the books prop — no second fetch, no
// local assignments map, so the two can never disagree and the PostgREST
// 1000-row cap on un-ranged selects never applies here.

/** The pile's pseudo-shelf id. Not a book_folders row and never written —
 *  it only ever names the drill-in the unshelved books open into. */
const UNSHELVED_ID = "__unshelved__";

/** Group books by shelf id. Module scope so the two memos below share one
 *  implementation and neither closes over a per-render function. */
function groupByShelf(source: BookDocument[]): Map<string, BookDocument[]> {
  const map = new Map<string, BookDocument[]>();
  for (const b of source) {
    for (const folderId of b.folderIds) {
      const list = map.get(folderId) || [];
      list.push(b);
      map.set(folderId, list);
    }
  }
  return map;
}

interface Props {
  /** The books to RENDER — already narrowed by the Vault search query. */
  books: BookDocument[];
  /** The whole library, unfiltered. COUNTS come from here, never from
   *  `books`. A shelf card is an overview surface, and an overview that
   *  silently reports the filtered subtotal is worse than none: typing one
   *  letter into search made a 40-book shelf read "2 books" with nothing
   *  saying why. While a filter is active the card shows the true total AND
   *  how many match, so neither number has to be inferred. */
  allBooks: BookDocument[];
  renderBook: (book: BookDocument, index: number) => React.ReactNode;
  /** True while the Vault search query is filtering the books prop — empty
   *  states must not claim a shelf is empty when its books are just filtered
   *  out of view. */
  filtered?: boolean;
}

const LibraryShelves: React.FC<Props> = ({ books, allBooks, renderBook, filtered = false }) => {
  // The roster and its mutations live in AppContext — ONE copy for the whole
  // app. This view used to fetch its own, as did BookContextPicker, and the
  // two drifted (a shelf created here was invisible to a mounted picker).
  const {
    toggleBookShelf, multiShelf, setActiveTab,
    shelves, shelvesLoading, createShelf, renameShelf, deleteShelf,
  } = useApp();
  const { user } = useAuth();

  // This view WRITES to the book-context store, so it must init it — on a
  // cold start straight to the Vault, no chat surface has mounted yet, and
  // an un-init'd store can't persist (the selection would then be wiped by
  // ChatPanel's own init when the tab switches).
  useEffect(() => {
    bookContextStore.init(user?.id ?? null);
  }, [user?.id]);

  // The shelf's headline AI action — the successor to the retired "Digest
  // folder into neuron": load the shelf as chat context and jump to Counsel.
  const chatWithShelf = (shelf: BookFolder) => {
    bookContextStore.init(user?.id ?? null); // idempotent belt-and-braces
    bookContextStore.set({ shelfId: shelf.id, bookIds: [], excludedIds: [] });
    toast.success(`"${shelf.name}" loaded into chat — its books ride with every message.`);
    setActiveTab("chat");
  };
  // The pile has no book_folders row, so it rides as a HAND-PICKED set — a
  // snapshot, not a live membership. The toast says so rather than implying
  // the shelf-mode contract (books added later join the conversation).
  const chatWithBooks = (list: BookDocument[], label: string) => {
    bookContextStore.init(user?.id ?? null);
    bookContextStore.set({ shelfId: null, bookIds: list.map((b) => b.id), excludedIds: [] });
    toast.success(
      `${label} loaded into chat — ${list.length} book${list.length === 1 ? "" : "s"}, as a fixed set.`,
    );
    setActiveTab("chat");
  };

  const [openShelfId, setOpenShelfId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Facet filters. These narrow the WHOLE view — shelf-card matching counts,
  // the open shelf, and the All-books grid alike. They used to narrow only
  // the All-books section, which left shelf cards above quoting unfiltered
  // sizes: two different answers to "how many books" on one screen.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const tagged = (b: BookDocument, t: string) => (b.tags || []).includes(t);
  const inCategory = (b: BookDocument) => (b.category || UNCATEGORIZED) === activeCategory;

  // One facet-narrowed set, used by every grid and every matching count.
  const narrowed = useMemo(() => books.filter((b) => {
    if (activeCategory && (b.category || UNCATEGORIZED) !== activeCategory) return false;
    return activeTags.every((t) => tagged(b, t));
  }), [books, activeCategory, activeTags]);

  /** True whenever anything is narrowing the view — search or facets. */
  const narrowing = filtered || !!activeCategory || activeTags.length > 0;

  // Membership derived once per books/shelves change, not per shelf card.
  // TWO maps, deliberately: `membersByShelf` is the truth (whole library) and
  // feeds every COUNT; `visibleByShelf` is what search + facets leave on
  // screen and feeds every GRID. Keeping them separate is what stops a filter
  // from quietly restating how big a shelf is.
  const membersByShelf = useMemo(() => groupByShelf(allBooks), [allBooks]);
  const visibleByShelf = useMemo(() => groupByShelf(narrowed), [narrowed]);

  // The pile. Malone's finding is that people under-file and that forcing
  // classification at capture is where systems get abandoned — so the books
  // nobody has filed need a name and a place, not silent absorption into
  // "All books". This is a computed pseudo-shelf: no row, no membership.
  const unshelvedAll = useMemo(() => allBooks.filter((b) => b.folderIds.length === 0), [allBooks]);
  const unshelvedVisible = useMemo(() => narrowed.filter((b) => b.folderIds.length === 0), [narrowed]);

  const isUnshelved = openShelfId === UNSHELVED_ID;
  const booksOnShelf = useMemo(
    () => (isUnshelved ? unshelvedVisible : openShelfId ? visibleByShelf.get(openShelfId) || [] : []),
    [isUnshelved, unshelvedVisible, visibleByShelf, openShelfId],
  );
  /** True size of the open shelf, independent of search and facets. */
  const openShelfTotal = isUnshelved
    ? unshelvedAll.length
    : openShelfId ? (membersByShelf.get(openShelfId) || []).length : 0;

  // Facet chips carry QUERY PREVIEWS (Hearst): each facet's counts are taken
  // with the OTHER facet applied, so a count never promises results that the
  // current selection would rule out. The two are orthogonal — picking a
  // category no longer clears tags, and tags are selectable on their own.
  const categoryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of books) {
      if (!activeTags.every((t) => tagged(b, t))) continue;
      const cat = b.category || UNCATEGORIZED;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [books, activeTags]);

  const tagChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of books) {
      if (activeCategory && !inCategory(b)) continue;
      for (const t of b.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [books, activeCategory]);

  // The search box filters the books prop, so an active facet can vanish from
  // its chip row — and a chip is the only control that clears it, which would
  // strand an invisible, unclearable filter. Drop each the moment its chip is
  // gone. Tags are dropped individually now that they are not category-bound.
  useEffect(() => {
    if (activeCategory && !categoryChips.some(([c]) => c === activeCategory)) {
      setActiveCategory(null);
    }
  }, [categoryChips, activeCategory]);

  useEffect(() => {
    if (activeTags.length === 0) return;
    const available = new Set(tagChips.map(([t]) => t));
    if (activeTags.some((t) => !available.has(t))) {
      setActiveTags((prev) => prev.filter((t) => available.has(t)));
    }
  }, [tagChips, activeTags]);

  const visibleBooks = narrowed;

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createShelf(name);
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
      await renameShelf(id, name);
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
      // deleteShelf drops the row, the roster entry, and the shelf from every
      // book's folderIds — the DB cascades junction rows and SET NULLs the
      // folder_id mirror, so client state must follow without a reload.
      await deleteShelf(id);
      if (openShelfId === id) setOpenShelfId(null);
      toast.success("Shelf deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  // Toggle semantics (multi-shelf add/remove vs exclusive-fallback move)
  // live in AppContext.toggleBookShelf, which patches state optimistically —
  // this view only surfaces failures.
  const toggleShelf = async (b: BookDocument, shelfId: string) => {
    try {
      await toggleBookShelf(b.id, shelfId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Shelf change failed");
    }
  };

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  // Orthogonal facets: choosing a category leaves the tag selection alone.
  const pickCategory = (cat: string) => {
    setActiveCategory((prev) => (prev === cat ? null : cat));
  };

  const clearFacets = () => { setActiveCategory(null); setActiveTags([]); };

  // A book card with the checkbox shelf-membership menu overlaid on hover.
  // onSelect preventDefault keeps the menu open across toggles — putting a
  // book on three shelves is one open, three clicks.
  const renderBookCard = (b: BookDocument, index: number) => (
    <div key={b.id} className="relative group">
      {renderBook(b, index)}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="cc-hover-reveal cc-tap-44 absolute top-2 right-2 flex items-center gap-1 bg-surface-container-high text-xs rounded-md px-1.5 py-0.5 border border-outline-variant/30 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity"
            title="Shelves"
            aria-label={`Shelves for “${b.title}” (on ${b.folderIds.length})`}
          >
            <span className="material-symbols-outlined text-sm" aria-hidden>shelves</span>
            {b.folderIds.length > 0 ? b.folderIds.length : ""}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-on-surface-variant">
            {multiShelf ? "Shelves" : "Shelf (one per book until the database update lands)"}
          </DropdownMenuLabel>
          {shelves.length === 0 && (
            <DropdownMenuLabel className="font-normal text-xs">No shelves yet — create one above.</DropdownMenuLabel>
          )}
          {shelves.map((f) => (
            <DropdownMenuCheckboxItem
              key={f.id}
              checked={b.folderIds.includes(f.id)}
              onCheckedChange={() => toggleShelf(b, f.id)}
              onSelect={(e) => e.preventDefault()}
            >
              {f.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  if (shelvesLoading) {
    return <div className="py-16 text-center text-on-surface-variant text-sm">Loading shelves…</div>;
  }

  // Open-shelf drill-in view.
  if (openShelfId) {
    const shelf = shelves.find((f) => f.id === openShelfId);
    const openName = isUnshelved ? "Unshelved" : shelf?.name;
    return (
      <div className="cc-container flex flex-col gap-5">
        <nav aria-label="Shelf navigation" className="flex flex-wrap items-center gap-1.5 text-sm">
          <button
            onClick={() => setOpenShelfId(null)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>shelves</span>
            All shelves
          </button>
          <span className="text-on-surface-variant/50" aria-hidden>/</span>
          <span className="flex min-w-0 items-center gap-1.5 px-2 py-1 font-semibold text-foreground">
            <span className="material-symbols-outlined text-base text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>
              {isUnshelved ? "inbox" : "folder_open"}
            </span>
            <span className="truncate">{openName}</span>
            <span className="shrink-0 text-on-surface-variant font-normal">
              ({narrowing ? `${booksOnShelf.length} of ${openShelfTotal}` : openShelfTotal})
            </span>
          </span>
          <span className="ml-auto" />
          {isUnshelved && booksOnShelf.length > 0 && (
            <button
              onClick={() => chatWithBooks(booksOnShelf, "Unshelved")}
              className="inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary-container text-xs font-bold"
              title="Load these books as chat context and open Counsel"
            >
              <span className="material-symbols-outlined text-sm">psychology</span>
              Chat with these
            </button>
          )}
          {shelf && (
            <button
              onClick={() => chatWithShelf(shelf)}
              className="inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary-container text-xs font-bold"
              title="Load this shelf's books as chat context and open Counsel"
            >
              <span className="material-symbols-outlined text-sm">psychology</span>
              Chat with this shelf
            </button>
          )}
        </nav>

        {booksOnShelf.length === 0 ? (
          <div className="py-12 text-center text-on-surface-variant text-sm">
            {narrowing
              ? `No books here match your ${filtered ? "search" : "filters"}.`
              : isUnshelved
                ? "Nothing is waiting to be filed — every book is on a shelf."
                : "This shelf is empty — hover any book card and use the shelf menu to add it here."}
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
    <div className="cc-container flex flex-col gap-6">
      {/* Shelf cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {shelves.map((f) => {
          const members = membersByShelf.get(f.id) || [];
          // Computed while ANYTHING narrows the view — search or facets.
          const matching = narrowing ? (visibleByShelf.get(f.id) || []).length : null;
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
              {/* `w-full`, not just `min-w-0`: this is a flex item in a COLUMN
                  flex container, so `min-width` does not constrain it — the
                  cross-axis size is fit-content, and a `truncate` child's
                  nowrap min-content would push the card wider than its track.
                  A definite width is what makes the ellipsis reachable. */}
              <div className="w-full min-w-0 z-10 pointer-events-none">
                {renaming === f.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => handleRename(f.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(f.id); if (e.key === "Escape") setRenaming(null); }}
                    className="w-full min-w-0 bg-surface-container-highest rounded px-2 py-0.5 text-sm pointer-events-auto"
                  />
                ) : (
                  <p className="font-headline font-bold text-base text-foreground truncate w-full">{f.name}</p>
                )}
                <p className="text-xs text-on-surface-variant mt-0.5">
                  {members.length} book{members.length === 1 ? "" : "s"}
                  {matching !== null && (
                    <span className="text-primary"> · {matching} matching</span>
                  )}
                </p>
              </div>
              {/* On a touch screen these are the ONLY route to renaming or
                  deleting a shelf, and `hover` never fires there — so
                  `.cc-hover-reveal` un-hides them and `.cc-tap-32` gives each
                  one a real target. Desktop hover behaviour is unchanged. */}
              <div className="cc-hover-reveal absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                <button
                  onClick={(e) => { e.stopPropagation(); chatWithShelf(f); }}
                  title={`Chat with "${f.name}" — load its books as chat context`}
                  aria-label={`Chat with "${f.name}" — load its books as chat context`}
                  className="cc-tap-32 p-1 rounded bg-surface-container-high hover:bg-primary/20 text-primary"
                >
                  <span className="material-symbols-outlined text-sm">psychology</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setRenameDraft(f.name); setRenaming(f.id); }}
                  title="Rename"
                  aria-label={`Rename shelf "${f.name}"`}
                  className="cc-tap-32 p-1 rounded bg-surface-container-high hover:bg-surface-container-highest"
                >
                  <span className="material-symbols-outlined text-sm">edit</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(f.id); }}
                  title="Delete"
                  aria-label={`Delete shelf "${f.name}"`}
                  className="cc-tap-32 p-1 rounded bg-surface-container-high hover:bg-red-500/20 text-red-300"
                >
                  <span className="material-symbols-outlined text-sm">delete</span>
                </button>
              </div>
            </div>
          );
        })}
        {/* The pile. Rendered alongside real shelves because that is where a
            user looks for "the books I haven't dealt with" — but visually
            distinct (dashed edge, inbox glyph) since it is computed, has no
            row, and cannot be renamed or deleted. */}
        {unshelvedAll.length > 0 && (
          <div className="group relative flex flex-col items-start gap-3 rounded-2xl p-5 text-left border border-dashed border-outline-variant/40 bg-surface-container-low transition-all hover:-translate-y-0.5 hover:shadow-xl">
            <button
              onClick={() => setOpenShelfId(UNSHELVED_ID)}
              className="absolute inset-0"
              aria-label={`Open Unshelved (${unshelvedAll.length} book${unshelvedAll.length === 1 ? "" : "s"})`}
            />
            <div className="flex items-center justify-between w-full pointer-events-none">
              <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>inbox</span>
              <div className="flex -space-x-2">
                {unshelvedAll.filter((b) => b.coverImageUrl).slice(0, 3).map((b, i) => (
                  <img
                    key={b.id}
                    src={b.coverImageUrl as string}
                    alt=""
                    className="w-7 h-10 object-cover rounded-sm border border-black/40 shadow-sm"
                    style={{ transform: `rotate(${(i - 1) * 6}deg)` }}
                  />
                ))}
              </div>
            </div>
            <div className="w-full min-w-0 z-10 pointer-events-none">
              <p className="font-headline font-bold text-base text-foreground truncate w-full">Unshelved</p>
              <p className="text-xs text-on-surface-variant mt-0.5">
                {unshelvedAll.length} book{unshelvedAll.length === 1 ? "" : "s"}
                {narrowing && (
                  <span className="text-primary"> · {unshelvedVisible.length} matching</span>
                )}
              </p>
            </div>
          </div>
        )}

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
            All books ({visibleBooks.length}{visibleBooks.length !== allBooks.length ? ` of ${allBooks.length}` : ""})
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

        {tagChips.length > 0 && (
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
            {(activeTags.length > 0 || activeCategory) && (
              <button
                onClick={clearFacets}
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
