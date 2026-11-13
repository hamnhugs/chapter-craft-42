import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import ReactMarkdown from "react-markdown";
import { safeUrlTransform, safeMarkdownComponents } from "@/lib/markdownSafety";
import {
  KnowledgeEntry, MemoryGraphEdge, KnowledgeConflict, MemoryMode,
  fetchKnowledgeEntries, fetchMemoryGraph,
  deleteKnowledgeEntry, updateKnowledgeEntry,
  fetchConflicts, updateConflictStatus,
  getMemoryMode, fetchDueReviews,
  ENTRY_LIST_COLUMNS,
} from "@/lib/knowledgeApi";
import { parseLocators, type CardLocator } from "@/lib/cardLocators";
import { fallbackHook } from "@/lib/notesIndex";
import { openPassage, OPEN_NOTE_EVENT, OPEN_NOTE_PENDING_KEY } from "@/lib/openPassage";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, MoreHorizontal, Search, X, ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import GeneratedImage from "@/components/GeneratedImage";
import EntryLocatorPanel from "@/components/EntryLocatorPanel";
import { fetchImagesForEntries, deleteImageAttachment, type ImageAttachmentRow } from "@/lib/imageGen";
import DailyRecall from "@/components/DailyRecall";
import NotebookFormDialog, { deleteNotebookWithConfirm } from "@/components/NotebookFormDialog";
import { dailyRecallDoneToday, locatorBookId, DAILY_RECALL_SIZE } from "@/lib/dailyRecall";

type WikiView = "entries" | "detail" | "conflicts";

// Plain words for the link kinds the nightly tidy-up writes.
const RELATIONSHIP_LABELS: Record<string, string> = {
  relates_to: "Related",
  supports: "Supports",
  contradicts: "Disagrees with",
  extends: "Builds on",
  derived_from: "Comes from",
  mentions: "Mentions",
};
const relationshipLabel = (r: string) => {
  const label = RELATIONSHIP_LABELS[r] ?? r.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

/**
 * One notebook: a header line, search, and note rows. The notebook shown is
 * the one opened from the list (viewedWikiId), else Counsel's primary.
 * Viewing never changes what Counsel has loaded — that lives in Counsel's
 * chip row and ⌘K.
 */
const WikiPanel: React.FC = () => {
  const { books, wikis, activeWikiId, activeWikiIds, setActiveTab, setActiveBook, viewedWikiId, refreshWikis } = useApp();
  const wiki = wikis.find((w) => w.id === (viewedWikiId ?? activeWikiId)) || null;
  const wikiId = wiki?.id ?? null;

  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [graph, setGraph] = useState<MemoryGraphEdge[]>([]);
  const [conflicts, setConflicts] = useState<KnowledgeConflict[]>([]);
  // Notes a conflict names that live outside this notebook (the bell shows
  // conflicts from every notebook).
  const [extraEntries, setExtraEntries] = useState<Record<string, KnowledgeEntry>>({});
  const [conflictsEverywhere, setConflictsEverywhere] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<WikiView>("entries");
  const [selectedEntry, setSelectedEntry] = useState<KnowledgeEntry | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editHook, setEditHook] = useState("");
  const [entryImages, setEntryImages] = useState<ImageAttachmentRow[]>([]);
  const [memoryMode, setMemoryModeState] = useState<MemoryMode>("recording");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  // Where Back from a note should land.
  const [returnView, setReturnView] = useState<"conflicts" | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Only the newest in-flight loadData may commit results (stale-response guard).
  const requestIdRef = useRef(0);

  const loadData = useCallback(async () => {
    if (!wikiId) {
      setEntries([]);
      setGraph([]);
      setLoading(false);
      return;
    }
    const reqId = ++requestIdRef.current;
    setLoading(true);
    try {
      const [es, g, c, mode] = await Promise.all([
        fetchKnowledgeEntries(wikiId),
        fetchMemoryGraph(wikiId).catch(() => [] as MemoryGraphEdge[]),
        fetchConflicts("open", conflictsEverywhere ? null : wikiId).catch(() => [] as KnowledgeConflict[]),
        getMemoryMode().catch(() => "recording" as MemoryMode),
      ]);
      if (reqId !== requestIdRef.current) return;
      setEntries(es);
      setGraph(g);
      setConflicts(c);
      setMemoryModeState(mode);
    } catch (err: any) {
      if (reqId === requestIdRef.current) toast.error(err.message || "Couldn't load your notes");
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [wikiId, conflictsEverywhere, refreshNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadData(); }, [loadData]);

  // Switched to a different notebook while mounted: start at its notes.
  const prevWikiIdRef = useRef(wikiId);
  useEffect(() => {
    if (prevWikiIdRef.current === wikiId) return;
    const switched = prevWikiIdRef.current !== null;
    prevWikiIdRef.current = wikiId;
    if (!switched) return;
    setView((v) => (v === "conflicts" ? v : "entries"));
    setSearchQuery("");
  }, [wikiId]);

  const entryById = useMemo(() => {
    const m = new Map<string, KnowledgeEntry>(Object.entries(extraEntries));
    for (const e of entries) m.set(e.id, e);
    return m;
  }, [entries, extraEntries]);

  // Conflicts from the bell can name notes in other notebooks — fetch those.
  useEffect(() => {
    const missing = Array.from(new Set(conflicts.flatMap((c) => [c.entry_a, c.entry_b])))
      .filter((id) => id && !entryById.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    supabase
      .from("knowledge_entries")
      .select(ENTRY_LIST_COLUMNS as any)
      .in("id", missing)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setExtraEntries((prev) => {
          const next = { ...prev };
          for (const row of data as unknown as KnowledgeEntry[]) next[row.id] = row;
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [conflicts, entryById]);

  // Attached images for the open note (generated via chat — table may not
  // exist until the image-memory migration is applied, so fail quietly).
  useEffect(() => {
    let cancelled = false;
    if (!selectedEntry) { setEntryImages([]); return; }
    fetchImagesForEntries([selectedEntry.id])
      .then((rows) => { if (!cancelled) setEntryImages(rows); })
      .catch(() => { if (!cancelled) setEntryImages([]); });
    return () => { cancelled = true; };
  }, [selectedEntry?.id]);

  // The conflict bell lists conflicts from every notebook, so honor that here.
  // An unsaved note edit is never discarded without asking.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const goToConflicts = () => {
      setEditing(false);
      setConflictsEverywhere(true);
      setView("conflicts");
      setRefreshNonce((n) => n + 1);
    };
    const handler = () => {
      try { sessionStorage.removeItem("open-conflicts-pending"); } catch { /* private mode */ }
      if (editingRef.current) {
        setConfirmRequest({
          title: "Discard your unsaved edit?",
          description: "You have a note edit open. Reviewing conflicts now will discard the unsaved changes.",
          confirmLabel: "Discard and review",
          destructive: true,
          onConfirm: goToConflicts,
        });
      } else {
        goToConflicts();
      }
    };
    // The bell can fire before this panel mounts (navigating from another
    // tab) — consume the pending flag it leaves behind.
    try {
      if (sessionStorage.getItem("open-conflicts-pending")) {
        sessionStorage.removeItem("open-conflicts-pending");
        goToConflicts();
      }
    } catch { /* private mode */ }
    window.addEventListener("open-conflicts", handler);
    return () => window.removeEventListener("open-conflicts", handler);
  }, []);

  // "Used N notes" under a reply, and search results on the list, open a
  // note here (lib/openPassage.ts). Fetched by id, so it opens even when its
  // notebook isn't the one shown.
  useEffect(() => {
    const open = async (entryId: string) => {
      try { sessionStorage.removeItem(OPEN_NOTE_PENDING_KEY); } catch { /* private mode */ }
      const { data, error } = await supabase
        .from("knowledge_entries")
        .select(ENTRY_LIST_COLUMNS as any)
        .eq("id", entryId)
        .maybeSingle();
      if (error || !data) { toast.error("That note no longer exists."); return; }
      setSelectedEntry(data as unknown as KnowledgeEntry);
      setEditing(false);
      setMoreOpen(false);
      setReturnView(null);
      setView("detail");
    };
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ entryId: string }>).detail?.entryId;
      if (id) void open(id);
    };
    try {
      const pending = sessionStorage.getItem(OPEN_NOTE_PENDING_KEY);
      if (pending) void open(pending);
    } catch { /* private mode */ }
    window.addEventListener(OPEN_NOTE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NOTE_EVENT, onOpen);
  }, []);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.title.toLowerCase().includes(q) ||
      (e.hook || "").toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [entries, searchQuery]);

  const getRelatedEntries = (entryId: string) => {
    const related: { entry: KnowledgeEntry; relationship: string }[] = [];
    const seen = new Set<string>();
    for (const edge of graph) {
      const otherId = edge.source_entry_id === entryId ? edge.target_entry_id
        : edge.target_entry_id === entryId ? edge.source_entry_id : null;
      if (!otherId || seen.has(otherId)) continue;
      const entry = entryById.get(otherId);
      if (!entry) continue;
      seen.add(otherId);
      related.push({ entry, relationship: edge.relationship || "relates_to" });
    }
    return related;
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteKnowledgeEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      if (selectedEntry?.id === id) { setSelectedEntry(null); setView("entries"); }
      toast.success("Note forgotten");
    } catch (err: any) { toast.error(err.message); }
  };

  // Every forget goes through a confirmation that names its target —
  // notes are the user's core asset and deletes here are permanent.
  const requestDeleteEntry = (entry: KnowledgeEntry) => {
    setConfirmRequest({
      title: `Forget "${entry.title}"?`,
      description: "Counsel will no longer have this note. This can't be undone.",
      confirmLabel: "Forget note",
      destructive: true,
      onConfirm: () => void handleDelete(entry.id),
    });
  };

  const handleDeleteImage = (img: ImageAttachmentRow) => {
    setConfirmRequest({
      title: "Delete this image?",
      description: "The generated image will be permanently removed. This can't be undone.",
      confirmLabel: "Delete image",
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteImageAttachment(img);
          setEntryImages((prev) => prev.filter((i) => i.id !== img.id));
          toast.success("Image deleted");
        } catch (err: any) {
          toast.error(err.message || "Failed to delete image");
        }
      },
    });
  };

  const handleSaveEdit = async () => {
    if (!selectedEntry) return;
    try {
      const tags = editTags.split(",").map((t) => t.trim()).filter(Boolean);
      const hook = editHook.replace(/\s+/g, " ").trim().slice(0, 160) || null;
      await updateKnowledgeEntry(selectedEntry.id, { title: editTitle, content: editContent, tags, hook });
      setEntries((prev) => prev.map((e) => e.id === selectedEntry.id ? { ...e, title: editTitle, content: editContent, tags, hook } : e));
      setSelectedEntry((prev) => prev ? { ...prev, title: editTitle, content: editContent, tags, hook } : null);
      setEditing(false);
      toast.success("Note saved");
    } catch (err: any) { toast.error(err.message); }
  };

  // Conflicts: keep one note (the other is forgotten), or say both are fine.
  const resolveConflict = async (conflict: KnowledgeConflict, removeEntryId: string | null) => {
    try {
      if (removeEntryId) {
        await deleteKnowledgeEntry(removeEntryId);
        setEntries((prev) => prev.filter((e) => e.id !== removeEntryId));
      }
      await updateConflictStatus(conflict.id, removeEntryId ? "resolved" : "dismissed");
      setConflicts((prev) => prev.filter((c) => c.id !== conflict.id));
      toast.success(removeEntryId ? "Kept one note, forgot the other" : "Marked as fine");
    } catch (err: any) { toast.error(err.message); }
  };

  const requestKeep = (conflict: KnowledgeConflict, keep: KnowledgeEntry, remove: KnowledgeEntry) => {
    setConfirmRequest({
      title: `Keep "${keep.title}"?`,
      description: `"${remove.title}" will be forgotten. This can't be undone.`,
      confirmLabel: "Keep this one",
      destructive: true,
      onConfirm: () => void resolveConflict(conflict, remove.id),
    });
  };

  // Daily recall: three notes a day (DailyRecall.tsx).
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dueCount, setDueCount] = useState(0);
  const [recallDone, setRecallDone] = useState(dailyRecallDoneToday);
  const refreshDueCount = useCallback(() => {
    setRecallDone(dailyRecallDoneToday());
    if (!wikiId) { setDueCount(0); return; }
    fetchDueReviews(wikiId, DAILY_RECALL_SIZE).then((r) => setDueCount(r.length)).catch(() => setDueCount(0));
  }, [wikiId]);
  useEffect(() => { refreshDueCount(); }, [refreshDueCount, refreshNonce]);

  const openDetail = useCallback((entry: KnowledgeEntry, from?: "conflicts" | "preserve") => {
    setSelectedEntry(entry);
    setView("detail");
    setEditing(false);
    setMoreOpen(false);
    if (from !== "preserve") setReturnView(from === "conflicts" ? "conflicts" : null);
  }, []);
  const startEdit = () => {
    if (!selectedEntry) return;
    setEditTitle(selectedEntry.title);
    setEditContent(selectedEntry.content);
    setEditTags(selectedEntry.tags.join(", "));
    setEditHook(selectedEntry.hook || "");
    setEditing(true);
  };

  const handleBack = () => {
    setSelectedEntry(null);
    setEditing(false);
    if (view === "detail" && returnView) {
      setView(returnView);
      setReturnView(null);
      return;
    }
    if (view === "conflicts" && conflictsEverywhere) setConflictsEverywhere(false);
    setView("entries");
  };

  const handleDeleteNotebook = async () => {
    if (!wiki) return;
    if (await deleteNotebookWithConfirm(wiki, entries.length, activeWikiIds)) {
      await refreshWikis();
      setActiveTab("wikis");
    }
  };

  const openPage = (loc: CardLocator) => {
    const bookId = locatorBookId(loc, books);
    if (bookId) openPassage({ setActiveBook, setActiveTab }, bookId, loc.page);
  };

  const openConflictsCount = conflicts.length;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-32 w-full min-w-0">
        {view === "entries" ? (
          <>
            {/* ── One header line ───────────────────────────────────────── */}
            <section className="flex items-center gap-2 mb-3 min-w-0">
              <button
                onClick={() => setActiveTab("wikis")}
                aria-label="All notebooks"
                title="All notebooks"
                className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-foreground hover:bg-surface-container-high"
              >
                <span className="material-symbols-outlined text-xl" aria-hidden>arrow_back</span>
              </button>
              <span
                aria-hidden
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: wiki?.cover_color || "#7C3AED" }}
              />
              <h2 className="min-w-0 truncate font-headline font-bold text-xl sm:text-2xl text-foreground tracking-tight">
                {wiki?.name || "Notebook"}
              </h2>
              <span className="hidden sm:inline shrink-0 text-xs text-on-surface-variant">
                {entries.length} {entries.length === 1 ? "note" : "notes"}
              </span>
              <span className="flex-1" />
              {memoryMode !== "recording" && (
                <span
                  title="Off the record: Counsel still reads your notes but saves nothing new. Turn it off in Counsel."
                  className="hidden sm:inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-500 text-[11px] font-medium"
                >
                  <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  Off the record
                </span>
              )}
              {openConflictsCount > 0 && (
                <button
                  onClick={() => setView("conflicts")}
                  title="Notes that may disagree or repeat each other"
                  className="shrink-0 h-9 flex items-center gap-1 px-2.5 rounded-lg bg-amber-500/10 text-amber-500 border border-amber-500/25 text-sm font-semibold hover:bg-amber-500/15"
                >
                  <span className="material-symbols-outlined text-base" aria-hidden>report</span>
                  {openConflictsCount}
                </button>
              )}
              <Button
                size="sm"
                onClick={() => setReviewOpen(true)}
                disabled={entries.length === 0}
                title="Three notes a day: answer first, then check against the note and its page."
                className="h-9 shrink-0 gap-1"
              >
                <span className="sm:hidden">{recallDone ? "Done" : dueCount > 0 ? `Recall · ${dueCount}` : "Recall"}</span>
                <span className="hidden sm:inline">{recallDone ? "Recall done" : dueCount > 0 ? `Daily recall · ${dueCount}` : "Daily recall"}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Notebook menu"
                    className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-foreground hover:bg-surface-container-high"
                  >
                    <MoreHorizontal className="w-5 h-5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setFormOpen(true)} disabled={!wiki}>Rename or recolor…</DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/memory-guide">How notes work</Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleDeleteNotebook} disabled={!wiki} className="text-destructive focus:text-destructive">
                    Delete notebook…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </section>

            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" aria-hidden />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search this notebook"
                placeholder="Search this notebook"
                className="w-full h-9 bg-surface-container-low border border-outline-variant/20 rounded-lg pl-9 pr-9 text-sm text-foreground placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-on-surface-variant hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {loading && entries.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" aria-hidden />
              </div>
            ) : filteredEntries.length === 0 ? (
              <p className="py-12 text-sm text-center text-on-surface-variant max-w-sm mx-auto">
                {entries.length === 0
                  ? "This notebook is empty. Chat with Counsel about what you're reading to fill it."
                  : "No notes match your search."}
              </p>
            ) : (
              <ul
                aria-busy={loading}
                className="divide-y divide-outline-variant/10 rounded-xl border border-outline-variant/15 bg-surface-container-low overflow-hidden"
              >
                {filteredEntries.map((entry) => {
                  const pageLoc = parseLocators(entry.locators)[0];
                  const pageBookId = pageLoc ? locatorBookId(pageLoc, books) : null;
                  return (
                    <li key={entry.id} className="flex items-center hover:bg-surface-container-high transition-colors">
                      <button
                        onClick={() => openDetail(entry)}
                        className="flex-1 min-w-0 text-left px-4 py-2.5 focus-visible:outline-none focus-visible:bg-surface-container-high"
                      >
                        <span className="block truncate text-sm font-semibold text-foreground">{entry.title}</span>
                        <span className="block truncate text-xs text-on-surface-variant">
                          {entry.hook || fallbackHook(entry.content)}
                        </span>
                      </button>
                      {pageLoc && pageBookId && (
                        <button
                          onClick={() => openPage(pageLoc)}
                          title={`Open ${pageLoc.book_title ? `“${pageLoc.book_title}”` : "the book"} at page ${pageLoc.page}`}
                          className="shrink-0 h-11 px-3 mr-1 rounded-lg text-xs font-semibold text-primary hover:bg-surface-container-highest"
                        >
                          p. {pageLoc.page}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          /* ── Sub-view: one back line ─────────────────────────────────── */
          <div className="flex items-center gap-2 mb-4 min-w-0">
            <button
              onClick={handleBack}
              className="h-9 flex items-center gap-1 pl-1 pr-3 rounded-lg text-sm text-on-surface-variant hover:text-foreground hover:bg-surface-container-high min-w-0"
            >
              <span className="material-symbols-outlined text-xl" aria-hidden>arrow_back</span>
              <span className="truncate">
                {view === "detail" && returnView === "conflicts" ? "Notes to check" : wiki?.name || "Back"}
              </span>
            </button>
          </div>
        )}

        {view === "detail" && selectedEntry ? (
          <article className="space-y-4">
            {editing ? (
              <>
                <Input id="note-edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} aria-label="Note title" className="text-xl font-headline font-bold bg-surface-container-high border-none" />
                <div className="space-y-1">
                  <label htmlFor="note-edit-hook" className="text-xs font-semibold text-on-surface-variant">One-line summary (what Counsel sees first)</label>
                  <Input id="note-edit-hook" value={editHook} maxLength={160} onChange={(e) => setEditHook(e.target.value)} placeholder="Leave empty and the nightly tidy-up writes one" className="text-sm bg-surface-container-high border-none" />
                </div>
                <Textarea id="note-edit-content" value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={10} aria-label="Note text" className="text-sm font-mono bg-surface-container-high border-none" />
                <Input id="note-edit-tags" value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="Tags, comma-separated" aria-label="Note tags" className="text-sm bg-surface-container-high border-none" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </>
            ) : (() => {
              const locs = parseLocators(selectedEntry.locators);
              const firstPage = locs.find((l) => locatorBookId(l, books));
              const related = getRelatedEntries(selectedEntry.id);
              const book = selectedEntry.source_book_id ? books.find((b) => b.id === selectedEntry.source_book_id) : null;
              const who = selectedEntry.author === "user" ? "You saved this" : "Counsel saved this";
              return (
                <>
                  <header className="space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="min-w-0 font-headline font-bold text-2xl md:text-3xl text-foreground">{selectedEntry.title}</h2>
                      <div className="flex shrink-0">
                        <button onClick={startEdit} className="h-9 px-3 rounded-lg text-sm text-on-surface-variant hover:bg-surface-container-high">Edit</button>
                        <button onClick={() => requestDeleteEntry(selectedEntry)} className="h-9 px-3 rounded-lg text-sm text-destructive hover:bg-error-container/20">Forget</button>
                      </div>
                    </div>
                    {firstPage && (
                      <button
                        onClick={() => openPage(firstPage)}
                        className="block text-left text-sm font-semibold text-primary hover:underline"
                      >
                        Open page {firstPage.page}{firstPage.book_title ? ` of “${firstPage.book_title}”` : ""} →
                      </button>
                    )}
                  </header>

                  <div className="prose prose-invert max-w-none">
                    <ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{selectedEntry.content}</ReactMarkdown>
                  </div>

                  <section className="border-t border-outline-variant/10 pt-3">
                    <button
                      onClick={() => setMoreOpen((o) => !o)}
                      aria-expanded={moreOpen}
                      className="flex items-center gap-1 text-sm font-semibold text-on-surface-variant hover:text-foreground"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${moreOpen ? "rotate-180" : ""}`} aria-hidden />
                      More
                      <span className="font-normal">
                        {" "}— where it came from{related.length > 0 ? `, ${related.length} related` : ""}
                        {entryImages.length > 0 ? `, ${entryImages.length} image${entryImages.length === 1 ? "" : "s"}` : ""}
                      </span>
                    </button>

                    {moreOpen && (
                      <div className="mt-4 space-y-6">
                        <div className="space-y-3">
                          <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Why this is here</h3>
                          <p className="text-sm text-on-surface-variant">
                            {who} on {new Date(selectedEntry.created_at).toLocaleDateString()}
                            {book ? `, while you were reading "${book.title}"` : locs.length === 0 ? ", from a chat" : ""}.
                            {" "}Last changed {new Date(selectedEntry.updated_at).toLocaleDateString()}.
                          </p>
                          {locs.length > 0 && (
                            <ul className="space-y-2">
                              {locs.map((l, i) => {
                                const bookId = locatorBookId(l, books);
                                return (
                                  <li key={`${l.chapter_id}:${l.char_start}:${i}`} className="flex items-start gap-3 p-3 rounded-xl bg-surface-container-high">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-xs text-on-surface-variant">
                                        {l.book_title || "Book"}{l.chapter_name ? ` · ${l.chapter_name}` : ""} · p. {l.page}
                                      </div>
                                      <p className="text-sm text-foreground/90 italic line-clamp-2">“{l.quote}”</p>
                                    </div>
                                    {bookId && (
                                      <button onClick={() => openPage(l)} className="shrink-0 text-xs font-semibold text-primary hover:underline">
                                        Open page
                                      </button>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          <EntryLocatorPanel
                            key={selectedEntry.id}
                            entry={selectedEntry}
                            assistOnly
                            onLocatorsChanged={(locators) => {
                              setSelectedEntry((prev) => (prev ? { ...prev, locators } : prev));
                              setEntries((prev) => prev.map((e) => (e.id === selectedEntry.id ? { ...e, locators } : e)));
                            }}
                          />
                        </div>

                        {related.length > 0 && (
                          <div className="space-y-2">
                            <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Related notes</h3>
                            <ul className="divide-y divide-outline-variant/10 rounded-xl border border-outline-variant/15 overflow-hidden">
                              {related.map(({ entry, relationship }) => (
                                <li key={entry.id}>
                                  <button
                                    onClick={() => openDetail(entry, "preserve")}
                                    className="w-full text-left px-4 py-2.5 hover:bg-surface-container-high flex items-baseline gap-2 min-w-0"
                                  >
                                    <span className="shrink-0 text-xs text-on-surface-variant">{relationshipLabel(relationship)}</span>
                                    <span className="truncate text-sm font-medium text-foreground">{entry.title}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {selectedEntry.tags.length > 0 && (
                          <div className="space-y-2">
                            <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Tags</h3>
                            <p className="text-sm text-on-surface-variant">{selectedEntry.tags.join(", ")}</p>
                          </div>
                        )}

                        {entryImages.length > 0 && (
                          <div className="space-y-3">
                            <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Images</h3>
                            <div className="flex flex-wrap gap-4">
                              {entryImages.map((img) => (
                                <div key={img.id} className="relative group/img">
                                  <GeneratedImage
                                    storagePath={img.storage_path}
                                    alt={img.prompt}
                                    caption={`${img.model ? `Generated with ${img.model.split("/").pop()}` : "AI-generated"} · ${new Date(img.created_at).toLocaleDateString()}`}
                                  />
                                  <button
                                    onClick={() => handleDeleteImage(img)}
                                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface-container-highest/80"
                                    aria-label="Delete image"
                                  >
                                    <span className="material-symbols-outlined text-destructive text-base" aria-hidden>delete</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                </>
              );
            })()}
          </article>
        ) : view === "conflicts" ? (
          <div className="space-y-4">
            <h2 className="font-headline font-bold text-xl text-foreground">Notes to check</h2>
            {conflicts.length === 0 ? (
              <p className="py-8 text-sm text-center text-on-surface-variant">Nothing needs your attention.</p>
            ) : conflicts.map((c) => {
              const a = entryById.get(c.entry_a);
              const b = entryById.get(c.entry_b);
              // kind is one of contradicts | refutes | supersedes | overlaps (DB check).
              const headline = c.kind === "overlaps" ? "These notes may say the same thing."
                : c.kind === "supersedes" ? "One of these notes may be out of date."
                : "These notes may disagree.";
              return (
                <div key={c.id} className="p-4 rounded-xl border border-amber-500/25 bg-amber-500/5 space-y-3">
                  <p className="text-sm font-semibold text-foreground">
                    {headline}
                  </p>
                  {c.rationale && <p className="text-sm text-on-surface-variant italic">{c.rationale}</p>}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[{ entry: a, label: "A" }, { entry: b, label: "B" }].map(({ entry, label }) => (
                      <button
                        key={label}
                        onClick={() => entry && openDetail(entry, "conflicts")}
                        disabled={!entry}
                        className="text-left p-3 rounded-lg bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant/10"
                      >
                        <span className="block text-xs text-on-surface-variant mb-0.5">{label}</span>
                        <span className="block text-sm font-semibold text-foreground">{entry?.title || "This note no longer exists"}</span>
                        {entry && (
                          <span className="block text-xs text-on-surface-variant mt-1 line-clamp-3">{entry.hook || fallbackHook(entry.content)}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {a && b && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => requestKeep(c, a, b)}>Keep A</Button>
                        <Button size="sm" variant="outline" onClick={() => requestKeep(c, b, a)}>Keep B</Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void resolveConflict(c, null)}>Both are fine</Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </main>

      {/* One shared confirmation dialog for every destructive action. */}
      <AlertDialog open={confirmRequest !== null} onOpenChange={(open) => { if (!open) setConfirmRequest(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmRequest?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmRequest?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirmRequest?.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={() => {
                const req = confirmRequest;
                setConfirmRequest(null);
                req?.onConfirm();
              }}
            >
              {confirmRequest?.confirmLabel || "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NotebookFormDialog open={formOpen} onOpenChange={setFormOpen} wiki={wiki} onSaved={refreshWikis} />

      {reviewOpen && (
        <DailyRecall
          wikiId={wikiId}
          open
          onClose={() => { setReviewOpen(false); refreshDueCount(); void loadData(); }}
          onReviewed={refreshDueCount}
        />
      )}
    </div>
  );
};

export default WikiPanel;
