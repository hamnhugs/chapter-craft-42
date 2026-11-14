import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ChevronRight, Loader2, Plus, Search, Lock, MoreHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useApp } from "@/context/AppContext";
import {
  WikiWithStats,
  isSystemWiki,
  supabaseNotebooks,
  type NotebookStore,
} from "@/lib/wikisApi";
import { searchAllNotes, type NoteSearchMatch } from "@/lib/knowledgeApi";
import { OPEN_NOTE_EVENT, OPEN_NOTE_PENDING_KEY } from "@/lib/openPassage";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { FREE_NEURON_LIMIT, computeLockedWikiIds } from "@/lib/neuronAccess";
import NotebookFormDialog, { deleteNotebookWithConfirm } from "@/components/NotebookFormDialog";
import WormSays from "@/components/onboarding/WormSays";
import {
  MAX_NOTEBOOK_DEPTH,
  buildNotebookTree,
  matchNotebooks,
  pathLabel,
  visibleRows,
  type NotebookNode,
} from "@/lib/notebookTree";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What this browser remembers about the list: which notebooks are folded
// shut, and which were opened last. Neither is worth a database column.
const COLLAPSED_KEY = "cc_notebooks_collapsed";
const RECENT_KEY = "cc_notebooks_recent";
const RECENT_SHOWN = 4;
/** "Jump back in" only earns its row once the list is long enough to scroll. */
const RECENT_MIN_NOTEBOOKS = 6;

function readIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeIds(key: string, ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* private mode: lasts the session */ }
}

/**
 * The Notebooks list.
 *
 * A TREE, SORTED BY NAME. Notebooks can sit inside notebooks (three levels at
 * most), and every level is in name order, so a notebook is always where it
 * was last time — a list ordered by "most recent" reshuffles itself every
 * time it is used, which is the one thing a list you navigate by position
 * must not do. Recency gets its own row instead ("Jump back in"), and the
 * search box finds a notebook by name from the first letter.
 */
const WikiLibrary: React.FC<{ store?: NotebookStore }> = ({ store = supabaseNotebooks }) => {
  const { activeWikiIds, refreshWikis, openNotebook } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const [wikisWithStats, setWikisWithStats] = useState<WikiWithStats[]>([]);
  const [loading, setLoading] = useState(true);

  // Search across every notebook and every note
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NoteSearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create / edit dialog. editingWiki null = creating (inside newParentId, if set).
  const [formOpen, setFormOpen] = useState(false);
  const [editingWiki, setEditingWiki] = useState<WikiWithStats | null>(null);
  const [newParentId, setNewParentId] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readIds(COLLAPSED_KEY)));
  const [recentIds, setRecentIds] = useState<string[]>(() => readIds(RECENT_KEY));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await store.list();
      setWikisWithStats(list);
    } catch (err: any) {
      toast.error(err.message || "Couldn't load your notebooks");
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    load();
  }, [load]);

  // The app keeps a couple of notebooks for itself; they're not the user's.
  const visible = useMemo(() => wikisWithStats.filter((w) => !isSystemWiki(w)), [wikisWithStats]);
  const tree = useMemo(() => buildNotebookTree(visible), [visible]);
  const rows = useMemo(() => visibleRows(tree, collapsed), [tree, collapsed]);
  const hasNesting = tree.roots.length < visible.length;
  const parentIds = useMemo(() => visible.filter((w) => tree.byId.get(w.id)!.children.length > 0).map((w) => w.id), [visible, tree]);
  const allCollapsed = parentIds.length > 0 && parentIds.every((id) => collapsed.has(id));

  // Plan limits belong to the real account, not to the lab's in-memory notebooks.
  const gated = store === supabaseNotebooks;
  // On the free plan, only the oldest neuron stays accessible; the rest are
  // visible but locked (data is kept, never deleted) until the user upgrades.
  const lockedIds = useMemo(
    () => (gated ? computeLockedWikiIds(wikisWithStats, isPaid, planLoaded) : new Set<string>()),
    [wikisWithStats, isPaid, planLoaded, gated],
  );
  const atLimit = gated && planLoaded && !isPaid && wikisWithStats.length >= FREE_NEURON_LIMIT;

  const handleNewWiki = (parentId: string | null = null) => {
    if (atLimit) {
      openPricing("neuron-limit");
      return;
    }
    setEditingWiki(null);
    setNewParentId(parentId);
    setFormOpen(true);
  };

  const openEdit = (wiki: WikiWithStats) => {
    setEditingWiki(wiki);
    setFormOpen(true);
  };

  const setFolded = (next: Set<string>) => {
    setCollapsed(next);
    writeIds(COLLAPSED_KEY, [...next]);
  };
  const toggleFold = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
  };

  // Opening is view-only: Counsel's loaded notebooks stay as they are.
  const handleOpen = (wiki: WikiWithStats) => {
    if (lockedIds.has(wiki.id)) {
      openPricing("neuron-locked");
      return;
    }
    const next = [wiki.id, ...recentIds.filter((id) => id !== wiki.id)].slice(0, 12);
    setRecentIds(next);
    writeIds(RECENT_KEY, next);
    openNotebook(wiki.id);
  };

  const handleOpenNote = (match: NoteSearchMatch) => {
    try { sessionStorage.setItem(OPEN_NOTE_PENDING_KEY, match.id); } catch { /* the event still works */ }
    if (match.wiki_id) openNotebook(match.wiki_id);
    setTimeout(() => {
      try { window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, { detail: { entryId: match.id } })); } catch { /* non-browser */ }
    }, 0);
  };

  // Debounced search across every note.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (q.length < 3) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchAllNotes(q, 20);
        setSearchResults(results);
      } catch (err: any) {
        toast.error(err.message || "Search failed");
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  const handleDelete = async (wiki: WikiWithStats) => {
    if (await deleteNotebookWithConfirm(wiki, wiki.entry_count, activeWikiIds, { notebooks: visible, store })) {
      await Promise.all([load(), refreshWikis()]);
    }
  };

  const wikiById = useMemo(() => new Map(wikisWithStats.map((w) => [w.id, w])), [wikisWithStats]);

  const query = searchQuery.trim();
  const nameMatches = useMemo(() => matchNotebooks(tree, query), [tree, query]);
  const recent = useMemo(
    () => (visible.length >= RECENT_MIN_NOTEBOOKS
      ? recentIds.map((id) => tree.byId.get(id)?.wiki).filter((w): w is WikiWithStats => !!w).slice(0, RECENT_SHOWN)
      : []),
    [recentIds, tree, visible.length],
  );

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-32 w-full min-w-0">
        {/* One header row: title · search · new */}
        <section className="flex items-center gap-2 sm:gap-3 mb-3">
          <h2 className="font-headline font-bold text-xl sm:text-2xl text-foreground tracking-tight shrink-0">
            Notebooks
          </h2>
          <div data-tour="notebook-search" className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" aria-hidden />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find a notebook or a note"
              aria-label="Search your notebooks and all your notes"
              className="w-full h-9 bg-surface-container-low border border-outline-variant/20 rounded-lg pl-9 pr-9 text-sm text-foreground placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            {searching ? (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant animate-spin" aria-hidden />
            ) : searchQuery ? (
              <button
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-on-surface-variant hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
          <Button data-tour="new-notebook" onClick={() => handleNewWiki()} size="sm" className="h-9 gap-1 shrink-0">
            {atLimit ? <Lock className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            New
          </Button>
        </section>

        {query ? (
          <>
            {nameMatches.length > 0 && (
              <>
                <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">Notebooks</h3>
                <ul className="mb-4 divide-y divide-outline-variant/10 rounded-xl border border-outline-variant/15 bg-surface-container-low overflow-hidden">
                  {nameMatches.map((n) => (
                    <li key={n.wiki.id}>
                      <button
                        onClick={() => handleOpen(n.wiki)}
                        className="w-full h-12 flex items-center gap-3 px-4 text-left hover:bg-surface-container-high focus-visible:outline-none focus-visible:bg-surface-container-high"
                      >
                        <span aria-hidden className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: n.wiki.cover_color || "#7C3AED" }} />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {n.parent && <span className="text-on-surface-variant">{pathLabel(tree, n.parent.wiki.id)} › </span>}
                          <span className="font-semibold text-foreground">{n.wiki.name}</span>
                        </span>
                        {lockedIds.has(n.wiki.id) && <Lock className="w-4 h-4 text-on-surface-variant shrink-0" aria-label="Locked" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {searchResults !== null ? (
              <>
                {nameMatches.length > 0 && searchResults.length > 0 && (
                  <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">Notes</h3>
                )}
                {(searchResults.length > 0 || nameMatches.length === 0) && (
                  <SearchResults results={searchResults} wikiById={wikiById} onOpenNote={handleOpenNote} />
                )}
              </>
            ) : query.length < 3 ? (
              <p className="py-6 text-xs text-center text-on-surface-variant">
                {nameMatches.length === 0 ? "No notebook by that name. " : ""}Type three letters or more to search inside your notes too.
              </p>
            ) : null}
          </>
        ) : loading && wikisWithStats.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
          </div>
        ) : visible.length === 0 ? (
          <div className="mx-auto max-w-sm py-12 space-y-4">
            <WormSays mood="idle" size={60}>
              <p className="text-sm text-foreground">
                A notebook keeps notes on one subject — a book, a project, a question you're chasing.
              </p>
            </WormSays>
            <Button onClick={() => handleNewWiki()} className="w-full gap-1">
              <Plus className="w-4 h-4" /> New notebook
            </Button>
          </div>
        ) : (
          <>
            {recent.length > 1 && (
              <section aria-label="Jump back in" className="mb-3">
                <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">Jump back in</h3>
                <div className="flex gap-2 overflow-x-auto hide-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0">
                  {recent.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => handleOpen(w)}
                      className="shrink-0 max-w-[11rem] h-10 flex items-center gap-2 pl-3 pr-3.5 rounded-full border border-outline-variant/20 bg-surface-container-low hover:bg-surface-container-high text-sm font-semibold text-foreground"
                    >
                      <span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: w.cover_color || "#7C3AED" }} />
                      <span className="truncate">{w.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <div className="mb-1.5 flex items-center justify-between gap-2 min-h-6">
              <span className="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">
                {recent.length > 1 ? `All notebooks · ${visible.length}` : plural(visible.length, "notebook")}
              </span>
              {parentIds.length > 0 && (
                <button
                  onClick={() => setFolded(allCollapsed ? new Set() : new Set(parentIds))}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </button>
              )}
            </div>

            <ul className="divide-y divide-outline-variant/10 rounded-xl border border-outline-variant/15 bg-surface-container-low overflow-hidden">
              {rows.map((node, i) => (
                <NotebookRow
                  key={node.wiki.id}
                  node={node}
                  hasNesting={hasNesting}
                  folded={collapsed.has(node.wiki.id)}
                  locked={lockedIds.has(node.wiki.id)}
                  inCounsel={activeWikiIds.includes(node.wiki.id)}
                  tourTarget={i === 0}
                  onToggle={() => toggleFold(node.wiki.id)}
                  onOpen={() => handleOpen(node.wiki)}
                  onNewInside={() => handleNewWiki(node.wiki.id)}
                  onEdit={() => openEdit(node.wiki)}
                  onDelete={() => handleDelete(node.wiki)}
                />
              ))}
            </ul>
          </>
        )}
      </main>

      <NotebookFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        wiki={editingWiki}
        parentId={newParentId}
        notebooks={visible}
        store={store}
        onSaved={() => {
          // A notebook made inside a folded one would otherwise be created out of sight.
          if (!editingWiki && newParentId && collapsed.has(newParentId)) toggleFold(newParentId);
          return Promise.all([load(), refreshWikis()]).then(() => undefined);
        }}
      />
    </div>
  );
};

// =====================================================
// NotebookRow: one 56px row of the tree. The name opens the notebook; the
// arrow folds what is inside it; ⋯ (or right-click) for the rest.
// =====================================================

const INDENT = 22;

const NotebookRow: React.FC<{
  node: NotebookNode<WikiWithStats>;
  /** Whether any notebook is nested: only then do rows reserve room for the arrow. */
  hasNesting: boolean;
  folded: boolean;
  locked: boolean;
  inCounsel: boolean;
  tourTarget: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onNewInside: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ node, hasNesting, folded, locked, inCounsel, tourTarget, onToggle, onOpen, onNewInside, onEdit, onDelete }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const { wiki, depth, children } = node;
  const canNestInside = depth < MAX_NOTEBOOK_DEPTH;
  return (
    <li
      className="group relative flex items-center hover:bg-surface-container-high transition-colors"
      style={{ paddingLeft: (depth - 1) * INDENT }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
    >
      {/* One hairline per level above this one, so depth reads at a glance. */}
      {Array.from({ length: depth - 1 }, (_, i) => (
        <span key={i} aria-hidden className="absolute inset-y-0 w-px bg-outline-variant/25" style={{ left: 22 + i * INDENT }} />
      ))}
      {children.length > 0 ? (
        <button
          onClick={onToggle}
          aria-expanded={!folded}
          aria-label={`${folded ? "Show" : "Hide"} the ${plural(children.length, "notebook")} inside ${wiki.name}`}
          className="h-14 w-11 shrink-0 flex items-center justify-center text-on-surface-variant hover:text-foreground"
        >
          <ChevronRight className={`w-4 h-4 transition-transform ${folded ? "" : "rotate-90"}`} />
        </button>
      ) : hasNesting ? (
        <span aria-hidden className="w-11 shrink-0" />
      ) : null}
      <button
        onClick={onOpen}
        onKeyDown={(e) => {
          if (!children.length) return;
          if ((e.key === "ArrowRight" && folded) || (e.key === "ArrowLeft" && !folded)) { e.preventDefault(); onToggle(); }
        }}
        title={locked ? "Locked on the free plan — upgrade to open" : undefined}
        className={`flex-1 min-w-0 h-14 flex items-center gap-3 pr-2 text-left focus-visible:outline-none focus-visible:bg-surface-container-high ${hasNesting ? "" : "pl-4"}`}
      >
        <span
          aria-hidden
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: wiki.cover_color || "#7C3AED" }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">
            <span className={`truncate text-sm font-semibold ${locked ? "text-on-surface-variant" : "text-foreground"}`}>
              {wiki.name}
            </span>
            {inCounsel && (
              <span
                title="Counsel is using this notebook"
                className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-accent"
              >
                Counsel
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-on-surface-variant">
            {node.parent && <span className="sr-only">Inside {node.parent.wiki.name}. </span>}
            {plural(wiki.entry_count, "note")}
            {children.length > 0 && <> · {plural(children.length, "notebook")} inside</>}
            {wiki.due_count > 0 && !locked && (
              <span className="text-primary font-medium"> · {wiki.due_count} to review</span>
            )}
          </span>
        </span>
        {locked && <Lock className="w-4 h-4 text-on-surface-variant shrink-0" aria-label="Locked" />}
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`More for ${wiki.name}`}
            data-tour={tourTarget ? "notebook-row-menu" : undefined}
            className="h-11 w-11 mr-1 shrink-0 flex items-center justify-center rounded-lg text-on-surface-variant/70 hover:text-foreground hover:bg-surface-container-highest"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={onNewInside}
            disabled={!canNestInside}
            title={canNestInside ? undefined : `Notebooks nest ${MAX_NOTEBOOK_DEPTH} levels deep at most`}
          >
            New notebook inside…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onEdit}>Rename, recolor or move…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
};

// =====================================================
// SearchResults: one row per matching note; click opens the note.
// =====================================================

const SearchResults: React.FC<{
  results: NoteSearchMatch[];
  wikiById: Map<string, WikiWithStats>;
  onOpenNote: (match: NoteSearchMatch) => void;
}> = ({ results, wikiById, onOpenNote }) => {
  const shown = results.filter((m) => {
    const w = m.wiki_id ? wikiById.get(m.wiki_id) : undefined;
    return !w || !isSystemWiki(w);
  });
  if (shown.length === 0) {
    return (
      <p className="py-12 text-sm text-center text-on-surface-variant max-w-sm mx-auto">
        No notes match. Try other words, or ask Counsel — it can also search inside your books.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-outline-variant/10 rounded-xl border border-outline-variant/15 bg-surface-container-low overflow-hidden">
      {shown.map((m) => {
        const wiki = m.wiki_id ? wikiById.get(m.wiki_id) : undefined;
        return (
          <li key={m.id}>
            <button
              onClick={() => onOpenNote(m)}
              className="w-full text-left px-4 py-2.5 hover:bg-surface-container-high transition-colors focus-visible:outline-none focus-visible:bg-surface-container-high"
            >
              <span className="block truncate text-sm font-semibold text-foreground">{m.title}</span>
              <span className="block truncate text-xs text-on-surface-variant">
                {wiki && (
                  <>
                    <span
                      aria-hidden
                      className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                      style={{ backgroundColor: wiki.cover_color || "#7C3AED" }}
                    />
                    {wiki.name} ·{" "}
                  </>
                )}
                {m.hook || m.content}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};

export default WikiLibrary;
