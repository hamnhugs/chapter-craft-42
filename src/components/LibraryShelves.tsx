import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookDocument } from "@/types/library";
import type { BookFolder } from "@/lib/bookFolders";
import { categoryColor, UNCATEGORIZED } from "@/lib/categoryColors";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { bookContextStore, bookHasCatalog } from "@/lib/chatBooks";
import { catalogJobs, useCatalogJobs } from "@/lib/catalogJobs";
import { useChatSettings } from "@/hooks/useChatSettings";
import { acquireDigestRun, generateShelfDigest, releaseDigestRun } from "@/lib/shelfDigest";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useShelfMarks, type ShelfMark } from "@/lib/shelfMarks";

// Shelves: the Vault's single grouping surface. One user-managed primitive
// (book_folders rows, presented as "shelves") replaces the former Folders view
// (virtual category groups) and Collections view (managed folders + the
// retired digestion controls). Categories and tags survive as filter chips
// over the All-books section — computed facets over metadata, never a second
// container (the Calibre "virtual library" model). Membership is
// NON-EXCLUSIVE (book_shelf_members junction) — checkbox membership, the
// Kindle/Apple Books model. The junction is the only store; `multiShelf`
// now means simply "the junction answered", and when it hasn't, shelf
// changes cannot be saved at all rather than silently becoming exclusive.
//
// Membership has exactly ONE client copy: books[].folderIds in AppContext
// (loaded paged at startup, patched by toggleBookShelf on every change).
// This view derives everything from the books prop — no second fetch, no
// local assignments map, so the two can never disagree and the PostgREST
// 1000-row cap on un-ranged selects never applies here.

/** Grids render this many books before asking. The Vault has no
 *  virtualization, and the shelves view renders the WHOLE library under the
 *  shelf cards on every visit — at a few hundred books that is a few hundred
 *  cards with covers, tag rows and two action layouts each, built on every
 *  keystroke in search. A page bound keeps the first paint cheap without
 *  taking anything away: the rest is one click, and the counts above never
 *  lied about how many there are. */
const GRID_PAGE_SIZE = 60;

/**
 * A grid's visible slice plus its "show more" affordance.
 *
 * Resets to the first page when the user narrows the list — a new search or
 * facet selection starts from the top, which is where they are looking.
 *
 * It used to reset on `items` identity, which is a different thing and a bug:
 * `items` is a fresh array whenever `books` changes, so a background catalog
 * job finishing, a gist landing, or one chapter's text being cached threw the
 * reader back to the first 60 books after they had pressed Show more five
 * times. The reset now keys on the filter inputs, which is what it always
 * meant.
 */
function usePagedBooks(items: BookDocument[], resetKey: string) {
  const [shown, setShown] = useState(GRID_PAGE_SIZE);
  useEffect(() => { setShown(GRID_PAGE_SIZE); }, [resetKey]);
  return {
    page: shown >= items.length ? items : items.slice(0, shown),
    remaining: Math.max(0, items.length - shown),
    showMore: () => setShown((n) => n + GRID_PAGE_SIZE),
  };
}

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
    toggleBookShelf, multiShelf, membershipLoaded,
    shelves, shelvesLoading, createShelf, renameShelf, deleteShelf,
    applyChapterGists, applyBookSummary, applyShelfDigest,
    requestShelfLoad, requestBooksLoad,
  } = useApp();
  const { selectedModel, apiKey, geminiApiKey, nvidiaKeyLast4 } = useChatSettings();
  const catJobs = useCatalogJobs();
  const { user } = useAuth();
  // Each shelf's color + glyph. Hovering (or focusing) a shelf card lights up
  // its books in the grid below and dims the rest.
  const marks = useShelfMarks();
  const [spotlight, setSpotlight] = useState<string | null>(null);

  // This view WRITES to the book-context store, so it must init it — on a
  // cold start straight to the Vault, no chat surface has mounted yet, and
  // an un-init'd store can't persist (the selection would then be wiped by
  // ChatPanel's own init when the tab switches).
  useEffect(() => {
    bookContextStore.init(user?.id ?? null);
  }, [user?.id]);

  // The shelf's headline AI action — the successor to the retired "Digest
  // folder into neuron". It routes through the same neuron-pick dialog a
  // book load does, and the load REPLACES what Counsel was discussing
  // (docs/library-agent.md L1/L2) — the dialog says so, the toast undoes it.
  const chatWithShelf = (shelf: BookFolder) => requestShelfLoad(shelf.id);
  // The pile has no book_folders row, so it rides as a HAND-PICKED set — a
  // snapshot, not a live membership.
  const chatWithBooks = (list: BookDocument[], label: string) =>
    requestBooksLoad(list.map((b) => b.id), `${label} (${list.length} book${list.length === 1 ? "" : "s"}, as a fixed set)`);

  // Catalog runs resolve their book at RUN time — the shelf may have changed
  // by the time the queue reaches it.
  const allBooksRef = useRef(allBooks);
  useEffect(() => { allBooksRef.current = allBooks; }, [allBooks]);

  const [digesting, setDigesting] = useState<string | null>(null);
  // Several shelves can be open at once, shown one section after another.
  // Clicking a shelf card opens just that shelf; picking shelves first (the
  // check on a card, or ctrl/shift-click) opens them together, and the open
  // view's "Open another shelf" menu adds or drops one in place.
  const [openShelfIds, setOpenShelfIds] = useState<string[]>([]);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const togglePicked = (id: string) =>
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleOpen = (id: string) =>
    setOpenShelfIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const openShelves = (ids: string[]) => { setOpenShelfIds(ids); setPickedIds([]); };
  const onShelfCardClick = (e: React.MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) togglePicked(id);
    else openShelves(pickedIds.length > 0 ? [...pickedIds.filter((x) => x !== id), id] : [id]);
  };
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Facet filters. These narrow the WHOLE view — shelf-card matching counts,
  // the open shelf, and the All-books grid alike. They used to narrow only
  // the All-books section, which left shelf cards above quoting unfiltered
  // sizes: two different answers to "how many books" on one screen.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);


  // One facet-narrowed set, used by every grid and every matching count.
  const narrowed = useMemo(() => books.filter((b) => {
    if (activeCategory && (b.category || UNCATEGORIZED) !== activeCategory) return false;
    return activeTags.every((t) => (b.tags || []).includes(t));
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

  /**
   * "Chat with this shelf" is the shelf's headline action, and it said
   * nothing about whether the shelf could actually ride catalog mode. Books
   * without a catalog fall back to full text per bookHasCatalog, which is the
   * expensive path and the one the whole Card Catalog exists to avoid — so
   * the readiness belongs next to the button that commits to it.
   */
  const catalogReadiness = (list: BookDocument[]) => ({
    ready: list.filter(bookHasCatalog).length,
    total: list.length,
  });

  const catalogShelf = (list: BookDocument[]) => {
    const missing = list.filter((b) => !bookHasCatalog(b) && b.chapters.length > 0);
    if (missing.length === 0) {
      toast("Every book here that has chapters already has a catalog.");
      return;
    }
    for (const b of missing) {
      catalogJobs.enqueue({
        bookId: b.id,
        getBook: () => allBooksRef.current.find((x) => x.id === b.id),
        settings: {
          model: selectedModel,
          keys: {
            apiKey: apiKey || undefined,
            geminiApiKey: geminiApiKey || undefined,
            nvidiaKeyLast4: nvidiaKeyLast4 || undefined,
          },
        },
        onGists: applyChapterGists,
        onSummary: applyBookSummary,
      });
    }
    toast.success(
      `Cataloguing ${missing.length} book${missing.length === 1 ? "" : "s"} — they run one at a time, and progress shows on each card.`,
    );
  };

  /** Roll the shelf's books up into a digest — the catalog's third level. */
  const writeDigest = async (shelf: BookFolder, members: BookDocument[]) => {
    if (digesting) return;
    if (!acquireDigestRun()) {
      toast("Another digest is still being written.");
      return;
    }
    setDigesting(shelf.id);
    try {
      const result = await generateShelfDigest(
        shelf,
        members,
        {
          model: selectedModel,
          keys: {
            apiKey: apiKey || undefined,
            geminiApiKey: geminiApiKey || undefined,
            nvidiaKeyLast4: nvidiaKeyLast4 || undefined,
          },
        },
      );
      applyShelfDigest(shelf.id, result.summary, result.model);
      toast.success(`Digest written for “${shelf.name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't write the digest");
    } finally {
      releaseDigestRun();
      setDigesting(null);
    }
  };

  // Shelves deleted elsewhere drop out of the open set.
  const openIds = useMemo(
    () => openShelfIds.filter((id) => id === UNSHELVED_ID || shelves.some((f) => f.id === id)),
    [openShelfIds, shelves],
  );
  /** What search + facets leave on screen for one open shelf. */
  const visibleOn = (id: string) => (id === UNSHELVED_ID ? unshelvedVisible : visibleByShelf.get(id) || []);
  /** True contents of one open shelf, independent of search and facets. */
  const membersOf = (id: string) => (id === UNSHELVED_ID ? unshelvedAll : membersByShelf.get(id) || []);

  // Facet chips carry QUERY PREVIEWS (Hearst): each facet's counts are taken
  // with the OTHER facet applied, so a count never promises results that the
  // current selection would rule out. The two are orthogonal — picking a
  // category no longer clears tags, and tags are selectable on their own.
  const categoryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of books) {
      if (!activeTags.every((t) => (b.tags || []).includes(t))) continue;
      const cat = b.category || UNCATEGORIZED;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [books, activeTags]);

  const tagChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of books) {
      if (activeCategory && (b.category || UNCATEGORIZED) !== activeCategory) continue;
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

  // Both grids are paged. Hooks run unconditionally, before the drill-in's
  // early return.
  //
  // The reset key is everything the user can change that should send them back
  // to the top: the search (via `filtered`), the facets, and which shelf is
  // open. Notably NOT the book list itself — see usePagedBooks.
  const facetKey = `${filtered}|${activeCategory ?? ""}|${activeTags.join(",")}`;
  const pageResetKey = `${facetKey}|${openIds.join(",")}`;
  const allBooksPage = usePagedBooks(visibleBooks, pageResetKey);

  /** True when the shelf was made — the form stays open on a failure. */
  const handleCreate = async (): Promise<boolean> => {
    const name = newName.trim();
    if (!name) return false;
    try {
      await createShelf(name);
      setNewName("");
      toast.success(`Shelf "${name}" created`);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create shelf");
      return false;
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
      // book's folderIds — the DB cascades the junction rows, so client state
      // must follow without a reload.
      await deleteShelf(id);
      setOpenShelfIds((prev) => prev.filter((x) => x !== id));
      setPickedIds((prev) => prev.filter((x) => x !== id));
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
    <div
      key={b.id}
      className="relative group h-full transition-[opacity,filter] duration-200"
      style={spotlight && spotlight !== UNSHELVED_ID
        ? (b.folderIds.includes(spotlight) ? undefined : { opacity: 0.22, filter: "grayscale(0.8)" })
        : spotlight === UNSHELVED_ID && b.folderIds.length > 0 ? { opacity: 0.22, filter: "grayscale(0.8)" } : undefined}
    >
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
            {multiShelf ? "Shelves" : "Shelves (unavailable — couldn't reach your shelf data)"}
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
              <MarkChip mark={marks.get(f.id)} />
              {f.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // Deliberately NOT gated on shelvesLoading. The books have already loaded by
  // the time this renders; blanking the entire view — including the All books
  // section, which needs no shelves at all — until an unrelated roster fetch
  // returns is most of why the Vault felt slow to open. The shelf strip below
  // shows its own placeholder while the roster is still coming.

  const actionPill = "inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-high text-foreground text-xs font-bold border border-outline-variant/20 hover:bg-surface-container-highest disabled:opacity-50";

  /** One open shelf: its header and actions, its digest, and its books. */
  const renderShelfSection = (id: string, several: boolean) => {
    const isUnshelved = id === UNSHELVED_ID;
    const shelf = isUnshelved ? undefined : shelves.find((f) => f.id === id);
    const openName = isUnshelved ? "Unshelved" : shelf?.name;
    const source = membersOf(id);
    const booksOnShelf = visibleOn(id);
    const openShelfTotal = source.length;
    const { ready, total } = catalogReadiness(source);
    const running = source.some((b) => {
      const j = catJobs[b.id];
      return j?.status === "queued" || j?.status === "running";
    });
    return (
      <section
        key={id}
        aria-label={openName}
        className="flex flex-col gap-4 rounded-2xl"
        style={shelf && marks.get(shelf.id) ? { borderTop: `3px solid ${marks.get(shelf.id)!.color}`, paddingTop: "0.75rem" } : undefined}
      >
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="flex min-w-0 items-center gap-1.5 px-2 py-1 font-semibold text-foreground">
            {shelf && marks.get(shelf.id) ? (
              <MarkChip mark={marks.get(shelf.id)} size="lg" />
            ) : (
              <span className="material-symbols-outlined text-base text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>
                {isUnshelved ? "inbox" : "folder_open"}
              </span>
            )}
            <span className="truncate">{openName}</span>
            <span className="shrink-0 text-on-surface-variant font-normal">
              ({narrowing ? `${booksOnShelf.length} of ${openShelfTotal}` : openShelfTotal})
            </span>
          </span>
          {several && (
            <button
              onClick={() => toggleOpen(id)}
              aria-label={`Close ${openName}`}
              title="Close this shelf (the others stay open)"
              className="cc-tap-32 p-1 rounded text-on-surface-variant hover:text-primary hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden>close</span>
            </button>
          )}
          <span className="ml-auto" />
          {total > 0 && (
            <>
              <span
                className="shrink-0 text-xs text-on-surface-variant"
                title="Books with a catalog ride the compact chapter map in chat; the rest fall back to full text."
              >
                {ready} of {total} catalogued
              </span>
              {ready < total && (
                <button
                  onClick={() => catalogShelf(source)}
                  disabled={running}
                  className={actionPill}
                  title="Generate chapter summaries and a book summary for the books here that have none (uses your model key)"
                >
                  <span className={`material-symbols-outlined text-sm ${running ? "animate-spin" : ""}`} aria-hidden>
                    {running ? "progress_activity" : "menu_book"}
                  </span>
                  {running ? "Cataloguing…" : `Catalog the rest`}
                </button>
              )}
            </>
          )}
          {shelf && (
            <button
              onClick={() => writeDigest(shelf, source)}
              disabled={digesting === shelf.id}
              className={actionPill}
              title="Summarize what this shelf is about, from its books' summaries (uses your model key)"
            >
              <span className={`material-symbols-outlined text-sm ${digesting === shelf.id ? "animate-spin" : ""}`} aria-hidden>
                {digesting === shelf.id ? "progress_activity" : "summarize"}
              </span>
              {digesting === shelf.id ? "Writing…" : shelf.summary ? "Rewrite digest" : "Write digest"}
            </button>
          )}
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
        </div>

        {shelf?.summary && (
          <div className="rounded-xl bg-surface-container-low/60 border border-outline-variant/10 px-5 py-3">
            <p className="text-sm text-on-surface-variant leading-relaxed">{shelf.summary}</p>
            <p className="text-[10px] text-on-surface-variant/60 mt-1">
              AI digest{shelf.summary_model ? ` · ${shelf.summary_model}` : ""}
            </p>
          </div>
        )}

        {booksOnShelf.length === 0 ? (
          <div className="py-12 text-center text-on-surface-variant text-sm">
            {narrowing
              ? `No books here match your ${filtered ? "search" : "filters"}.`
              : isUnshelved
                ? "Nothing is waiting to be filed — every book is on a shelf."
                : "This shelf is empty — hover any book card and use the shelf menu to add it here."}
          </div>
        ) : (
          <PagedGrid items={booksOnShelf} resetKey={facetKey} render={renderBookCard} />
        )}
      </section>
    );
  };

  // Open-shelf drill-in view: every open shelf, one section after another.
  if (openIds.length > 0) {
    const several = openIds.length > 1;
    // A book on two open shelves is loaded once.
    const unionBooks = several
      ? [...new Map(openIds.flatMap((id) => visibleOn(id)).map((b) => [b.id, b])).values()]
      : [];
    const openableIds = [...shelves.map((f) => f.id), ...(unshelvedAll.length > 0 ? [UNSHELVED_ID] : [])];
    const nameOf = (id: string) => (id === UNSHELVED_ID ? "Unshelved" : shelves.find((f) => f.id === id)?.name || "");
    return (
      <div className="cc-container flex flex-col gap-5">
        <nav aria-label="Shelf navigation" className="flex flex-wrap items-center gap-1.5 text-sm">
          <button
            onClick={() => setOpenShelfIds([])}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>shelves</span>
            All shelves
          </button>
          <span className="text-on-surface-variant/50" aria-hidden>/</span>
          <span className="min-w-0 truncate px-2 py-1 font-semibold text-foreground">
            {several ? `${openIds.length} shelves open` : nameOf(openIds[0])}
          </span>
          <span className="ml-auto" />
          {openableIds.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={actionPill} title="Open more shelves alongside this one, or close some">
                  <span className="material-symbols-outlined text-sm" aria-hidden>library_add</span>
                  Open another shelf
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Open shelves</DropdownMenuLabel>
                {openableIds.map((id) => (
                  <DropdownMenuCheckboxItem
                    key={id}
                    checked={openIds.includes(id)}
                    // The last open shelf is closed with "All shelves", not here.
                    disabled={openIds.length === 1 && openIds[0] === id}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => toggleOpen(id)}
                  >
                    <MarkChip mark={marks.get(id)} />
                    {nameOf(id)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {several && unionBooks.length > 0 && (
            <button
              onClick={() => chatWithBooks(unionBooks, openIds.map(nameOf).join(" + "))}
              className="inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary-container text-xs font-bold"
              title="Load the books on every open shelf as chat context and open Counsel"
            >
              <span className="material-symbols-outlined text-sm">psychology</span>
              Chat with these {openIds.length} shelves
            </button>
          )}
        </nav>

        {openIds.map((id, i) => (
          <React.Fragment key={id}>
            {i > 0 && <hr className="border-outline-variant/15" />}
            {renderShelfSection(id, several)}
          </React.Fragment>
        ))}
      </div>
    );
  }

  return (
    <div className="cc-container flex flex-col gap-6">
      {pickedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-primary/10 border border-primary/30 px-4 py-2 text-sm">
          <span className="font-semibold text-foreground">
            {pickedIds.length} shel{pickedIds.length === 1 ? "f" : "ves"} picked
          </span>
          <span className="ml-auto" />
          <button onClick={() => setPickedIds([])} className="px-2 py-1 text-on-surface-variant hover:text-primary underline underline-offset-2">
            Clear
          </button>
          <button
            onClick={() => openShelves(pickedIds)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary-container text-xs font-bold"
          >
            <span className="material-symbols-outlined text-sm" aria-hidden>folder_open</span>
            Open {pickedIds.length === 1 ? "it" : `these ${pickedIds.length} together`}
          </button>
        </div>
      )}
      {/* Shelf cards */}
      <div className="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {shelves.map((f) => {
          const members = membersByShelf.get(f.id) || [];
          // Computed while ANYTHING narrows the view — search or facets.
          const matching = narrowing ? (visibleByShelf.get(f.id) || []).length : null;
          const covers = members
            .filter((b) => b.coverImageUrl)
            .slice(0, 3)
            .map((b) => b.coverImageUrl as string);
          const mark = marks.get(f.id);
          return (
            <div
              key={f.id}
              data-shelf-card
              onMouseEnter={() => setSpotlight(f.id)}
              onMouseLeave={() => setSpotlight((cur) => (cur === f.id ? null : cur))}
              onFocus={() => setSpotlight(f.id)}
              onBlur={() => setSpotlight((cur) => (cur === f.id ? null : cur))}
              className={`cc-shelf-tile group relative flex items-center gap-3.5 overflow-hidden rounded-2xl min-h-[4.5rem] py-3 pl-5 pr-4 text-left border bg-surface-container-high transition-all hover:-translate-y-0.5 hover:shadow-xl ${pickedIds.includes(f.id) ? "border-primary ring-1 ring-primary/40" : "border-outline-variant/15"}`}
              style={mark ? {
                backgroundImage: `linear-gradient(135deg, ${mark.color}38, transparent 65%)`,
                borderColor: pickedIds.includes(f.id) ? undefined : `${mark.color}66`,
              } : undefined}
            >
              {mark && (
                <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1.5 pointer-events-none" style={{ background: mark.color }} />
              )}
              <button onClick={(e) => onShelfCardClick(e, f.id)} className="absolute inset-0" aria-label={`Open ${f.name}`} />
              {/* A row, not a stack: mark, then name and count, then cover
                  peeks. The stacked tile was ~140px tall, so eight shelves
                  took two screens' worth of the Vault before the first book. */}
              <span className="shrink-0 pointer-events-none">
                {mark ? (
                  <MarkChip mark={mark} size="xl" />
                ) : (
                  <span className="material-symbols-outlined text-4xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>shelves</span>
                )}
              </span>
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
                {/* Books load with empty folderIds and the junction read
                    fills them, so a count rendered before that read settles
                    is a confident zero, not a fact. Say "counting" instead. */}
                <p className="text-xs text-on-surface-variant mt-0.5">
                  {!membershipLoaded ? "counting…" : (
                    <>
                      {members.length} book{members.length === 1 ? "" : "s"}
                      {matching !== null && (
                        <span className="text-primary"> · {matching} matching</span>
                      )}
                    </>
                  )}
                </p>
                {/* The digest — what this shelf is FOR. A card could
                    previously show a name, a count and three covers, none of
                    which says why the shelf exists. */}
                {f.summary && (
                  <p
                    className="text-[11px] leading-snug text-on-surface-variant/80 mt-0.5 line-clamp-1"
                    title={`AI digest: ${f.summary}`}
                  >
                    {f.summary}
                  </p>
                )}
              </div>
              {/* Cover peeks — covers are the highest-recognition cue for books.
                  They make way for the actions on hover. */}
              {covers.length > 0 && (
                <div className="shrink-0 flex -space-x-2 pointer-events-none transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
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
              )}
              {/* On a touch screen these are the ONLY route to renaming or
                  deleting a shelf, and `hover` never fires there — so
                  `.cc-hover-reveal` un-hides them and `.cc-tap-32` gives each
                  one a real target. Desktop hover behaviour is unchanged. */}
              {/* focus-within matters as much as hover: these are tab-focusable
                  buttons, so without it a keyboard user moves focus onto a
                  control that is fully transparent and cannot see where they
                  are (WCAG 2.4.7). The book card's shelf trigger already had
                  this; the shelf card was missed. */}
              <div className="cc-hover-reveal cc-shelf-actions absolute top-1/2 -translate-y-1/2 right-3 flex gap-1 rounded-lg bg-surface-container-high/90 p-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-20">
                <PickButton picked={pickedIds.includes(f.id)} name={f.name} onClick={() => togglePicked(f.id)} />
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
        {membershipLoaded && unshelvedAll.length > 0 && (
          <div
            onMouseEnter={() => setSpotlight(UNSHELVED_ID)}
            onMouseLeave={() => setSpotlight((cur) => (cur === UNSHELVED_ID ? null : cur))}
            className={`cc-shelf-tile group relative flex items-center gap-3.5 rounded-2xl min-h-[4.5rem] py-3 pl-5 pr-4 text-left border border-dashed bg-surface-container-low transition-all hover:-translate-y-0.5 hover:shadow-xl ${pickedIds.includes(UNSHELVED_ID) ? "border-primary ring-1 ring-primary/40" : "border-outline-variant/40"}`}>
            <div className="cc-hover-reveal cc-shelf-actions absolute top-1/2 -translate-y-1/2 right-3 flex gap-1 rounded-lg bg-surface-container-low/90 p-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-20">
              <PickButton picked={pickedIds.includes(UNSHELVED_ID)} name="Unshelved" onClick={() => togglePicked(UNSHELVED_ID)} />
            </div>
            <button
              onClick={(e) => onShelfCardClick(e, UNSHELVED_ID)}
              className="absolute inset-0"
              aria-label={`Open Unshelved (${unshelvedAll.length} book${unshelvedAll.length === 1 ? "" : "s"})`}
            />
            <span className="shrink-0 grid w-11 h-11 place-items-center pointer-events-none">
              <span className="material-symbols-outlined text-[32px] text-on-surface-variant" aria-hidden>inbox</span>
            </span>
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

        {/* New shelf: a quiet tile until it is wanted. It used to be a
            standing form — label, field and button — the tallest card in the
            grid, for something done a handful of times in a library's life. */}
        {creating ? (
          <form
            onSubmit={(e) => { e.preventDefault(); void handleCreate().then((ok) => ok && setCreating(false)); }}
            className="flex items-center gap-2 rounded-2xl min-h-[4.5rem] px-3 border-2 border-dashed border-primary/40 bg-surface-container-low"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setNewName(""); setCreating(false); } }}
              onBlur={() => { if (!newName.trim()) setCreating(false); }}
              placeholder="Name the shelf"
              aria-label="New shelf name"
              className="min-w-0 flex-1 bg-surface-container-high rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40 border-none"
            />
            <button
              type="submit"
              disabled={!newName.trim()}
              className="shrink-0 px-3 py-2 bg-primary/10 text-primary text-sm font-bold rounded-lg hover:bg-primary hover:text-on-primary-container disabled:opacity-40"
            >
              Create
            </button>
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center justify-center gap-2 rounded-2xl min-h-[4.5rem] border-2 border-dashed border-outline-variant/30 text-sm font-semibold text-on-surface-variant hover:text-primary hover:border-primary/40 hover:bg-surface-container-low transition-colors"
          >
            <span className="material-symbols-outlined text-xl" aria-hidden>add</span>
            New shelf
          </button>
        )}
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
          <>
            <div className="book-grid">
              {allBooksPage.page.map((b, i) => renderBookCard(b, i))}
            </div>
            <ShowMore remaining={allBooksPage.remaining} onClick={allBooksPage.showMore} />
          </>
        )}
      </section>
    </div>
  );
};

/** A paged book grid. Its own component so every open shelf keeps its own
 *  "Show more" position (hooks can't run in a loop). */
const PagedGrid: React.FC<{ items: BookDocument[]; resetKey: string; render: (b: BookDocument, i: number) => React.ReactNode }> = ({ items, resetKey, render }) => {
  const paged = usePagedBooks(items, resetKey);
  return (
    <>
      <div className="book-grid">{paged.page.map((b, i) => render(b, i))}</div>
      <ShowMore remaining={paged.remaining} onClick={paged.showMore} />
    </>
  );
};

/** A shelf's mark as a small badge: its glyph on its color. */
const MarkChip: React.FC<{ mark?: ShelfMark; size?: "sm" | "lg" | "xl" }> = ({ mark, size = "sm" }) => {
  if (!mark) return null;
  const box = size === "xl" ? "w-11 h-11 rounded-xl text-[26px]" : size === "lg" ? "w-6 h-6 rounded-md text-[15px]" : "w-4 h-4 rounded text-[11px] mr-1.5";
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center shadow-sm ${box}`}
      style={{ background: mark.color, color: mark.ink }}
    >
      <span className="material-symbols-outlined leading-none" style={{ fontSize: "inherit", fontVariationSettings: "'FILL' 1" }}>
        {mark.glyph}
      </span>
    </span>
  );
};

/** The check on a shelf card that picks it to open with others. */
const PickButton: React.FC<{ picked: boolean; name: string; onClick: () => void }> = ({ picked, name, onClick }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    aria-pressed={picked}
    aria-label={picked ? `Unpick ${name}` : `Pick ${name} to open with other shelves`}
    title={picked ? "Picked — open it together with the other picked shelves" : "Pick to open several shelves at once (or ctrl-click the shelf)"}
    className={`cc-tap-32 p-1 rounded ${picked ? "bg-primary text-on-primary-container" : "bg-surface-container-high hover:bg-primary/20 text-primary"}`}
  >
    <span className="material-symbols-outlined text-sm" aria-hidden>{picked ? "check_box" : "check_box_outline_blank"}</span>
  </button>
);

const ShowMore: React.FC<{ remaining: number; onClick: () => void }> = ({ remaining, onClick }) => {
  if (remaining <= 0) return null;
  const next = Math.min(remaining, GRID_PAGE_SIZE);
  return (
    <div className="flex justify-center mt-4">
      <button
        onClick={onClick}
        className="px-5 py-2 rounded-lg bg-surface-container-high text-foreground text-sm font-semibold border border-outline-variant/10 hover:bg-surface-container-highest transition-colors"
      >
        Show {next} more · {remaining} not shown
      </button>
    </div>
  );
};

export default LibraryShelves;
