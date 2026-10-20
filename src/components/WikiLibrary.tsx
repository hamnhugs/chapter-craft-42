import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, Plus, Search, Lock, MoreHorizontal, X } from "lucide-react";
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
  fetchWikisWithStats,
  isSystemWiki,
} from "@/lib/wikisApi";
import { searchAllNotes, type NoteSearchMatch } from "@/lib/knowledgeApi";
import { OPEN_NOTE_EVENT, OPEN_NOTE_PENDING_KEY } from "@/lib/openPassage";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { FREE_NEURON_LIMIT, computeLockedWikiIds } from "@/lib/neuronAccess";
import NotebookFormDialog, { deleteNotebookWithConfirm } from "@/components/NotebookFormDialog";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const WikiLibrary: React.FC = () => {
  const { activeWikiIds, refreshWikis, openNotebook } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const [wikisWithStats, setWikisWithStats] = useState<WikiWithStats[]>([]);
  const [loading, setLoading] = useState(true);

  // Search across every note
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NoteSearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create / rename dialog. editingWiki null = creating.
  const [formOpen, setFormOpen] = useState(false);
  const [editingWiki, setEditingWiki] = useState<WikiWithStats | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchWikisWithStats();
      setWikisWithStats(list);
    } catch (err: any) {
      toast.error(err.message || "Couldn't load your notebooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The app keeps a couple of notebooks for itself; they're not the user's.
  const visible = useMemo(() => wikisWithStats.filter((w) => !isSystemWiki(w)), [wikisWithStats]);

  // On the free plan, only the oldest neuron stays accessible; the rest are
  // visible but locked (data is kept, never deleted) until the user upgrades.
  const lockedIds = useMemo(
    () => computeLockedWikiIds(wikisWithStats, isPaid, planLoaded),
    [wikisWithStats, isPaid, planLoaded],
  );
  const atLimit = planLoaded && !isPaid && wikisWithStats.length >= FREE_NEURON_LIMIT;

  const handleNewWiki = () => {
    if (atLimit) {
      openPricing("neuron-limit");
      return;
    }
    setEditingWiki(null);
    setFormOpen(true);
  };

  const openEdit = (wiki: WikiWithStats) => {
    setEditingWiki(wiki);
    setFormOpen(true);
  };

  // Opening is view-only: Counsel's loaded notebooks stay as they are.
  const handleOpen = (wiki: WikiWithStats) => {
    if (lockedIds.has(wiki.id)) {
      openPricing("neuron-locked");
      return;
    }
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
    if (await deleteNotebookWithConfirm(wiki, wiki.entry_count, activeWikiIds)) {
      await Promise.all([load(), refreshWikis()]);
    }
  };

  const wikiById = useMemo(() => new Map(wikisWithStats.map((w) => [w.id, w])), [wikisWithStats]);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-32 w-full min-w-0">
        {/* One header row: title · search · new */}
        <section className="flex items-center gap-2 sm:gap-3 mb-3">
          <h2 className="font-headline font-bold text-xl sm:text-2xl text-foreground tracking-tight shrink-0">
            Notebooks
          </h2>
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" aria-hidden />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes"
              aria-label="Search all your notes"
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
          <Button onClick={handleNewWiki} size="sm" className="h-9 gap-1 shrink-0">
            {atLimit ? <Lock className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            New
          </Button>
        </section>

        {searchResults !== null ? (
          <SearchResults results={searchResults} wikiById={wikiById} onOpenNote={handleOpenNote} />
        ) : loading && wikisWithStats.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3 text-center">
            <p className="text-sm max-w-sm">
              A notebook keeps notes on one subject — a book, a project, a question you're chasing.
            </p>
            <Button onClick={handleNewWiki} className="gap-1">
              <Plus className="w-4 h-4" /> New notebook
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-outline-variant/10 rounded-xl border border-outline-variant/15 bg-surface-container-low overflow-hidden">
            {visible.map((wiki) => (
              <NotebookRow
                key={wiki.id}
                wiki={wiki}
                locked={lockedIds.has(wiki.id)}
                onOpen={() => handleOpen(wiki)}
                onEdit={() => openEdit(wiki)}
                onDelete={() => handleDelete(wiki)}
              />
            ))}
          </ul>
        )}
      </main>

      <NotebookFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        wiki={editingWiki}
        onSaved={() => Promise.all([load(), refreshWikis()]).then(() => undefined)}
      />
    </div>
  );
};

// =====================================================
// NotebookRow: ~56px two-line row. Click opens; ⋯ (or right-click) for the rest.
// =====================================================

const NotebookRow: React.FC<{
  wiki: WikiWithStats;
  locked: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ wiki, locked, onOpen, onEdit, onDelete }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li
      className="group flex items-center hover:bg-surface-container-high transition-colors"
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
    >
      <button
        onClick={onOpen}
        title={locked ? "Locked on the free plan — upgrade to open" : undefined}
        className="flex-1 min-w-0 h-14 flex items-center gap-3 pl-4 pr-2 text-left focus-visible:outline-none focus-visible:bg-surface-container-high"
      >
        <span
          aria-hidden
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: wiki.cover_color || "#7C3AED" }}
        />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-semibold ${locked ? "text-on-surface-variant" : "text-foreground"}`}>
            {wiki.name}
          </span>
          <span className="block truncate text-xs text-on-surface-variant">
            {plural(wiki.entry_count, "note")}
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
            className="h-11 w-11 mr-1 shrink-0 flex items-center justify-center rounded-lg text-on-surface-variant/70 hover:text-foreground hover:bg-surface-container-highest"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>Rename or recolor…</DropdownMenuItem>
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
