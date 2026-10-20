import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  KnowledgeEntry, MemoryGraphEdge, LintResult, KnowledgeConflict,
  SleepCycleReport, MemoryMode, SleepRun,
  fetchKnowledgeEntries, fetchKnowledgeEntriesForSet,
  fetchMemoryGraph, fetchMemoryGraphForSet,
  deleteKnowledgeEntry, updateKnowledgeEntry,
  runLint,
  fetchConflicts, fetchConflictsForSet, updateConflictStatus,
  getMemoryMode, setMemoryMode, triggerSleepCycle, fetchDueReviews,
  fetchSleepRuns, undoSleepRun,
} from "@/lib/knowledgeApi";
import { parseLocators } from "@/lib/cardLocators";
import { fallbackHook } from "@/lib/notesIndex";
import { openPassage, OPEN_NOTE_EVENT, OPEN_NOTE_PENDING_KEY } from "@/lib/openPassage";
import { supabase } from "@/integrations/supabase/client";
import { ENTRY_LIST_COLUMNS } from "@/lib/knowledgeApi";
import { Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import GeneratedImage from "@/components/GeneratedImage";
import EntryLocatorPanel from "@/components/EntryLocatorPanel";
import { fetchImagesForEntries, deleteImageAttachment, type ImageAttachmentRow } from "@/lib/imageGen";
import { requestSettingsSection } from "@/lib/settingsNav";
import { useReflexEnabled } from "@/lib/reflex";
import DailyRecall from "@/components/DailyRecall";
import { dailyRecallDoneToday, locatorBookId, DAILY_RECALL_SIZE } from "@/lib/dailyRecall";

type WikiView = "entries" | "detail" | "lint" | "conflicts" | "runs";
type EntriesView = "map" | "list";
// Scope mirrors the app's real model: the loaded neuron set (what Counsel
// reads), optionally focused to one loaded neuron, or "everything ever".
type ScopeKind = "loaded" | "all";

// Lazy: shares the three.js chunk with the Vault graph; only fetched when
// someone switches the notes to the map view (the list is the default).
const EntryNeuronGraph = React.lazy(() => import("@/components/EntryNeuronGraph"));

const ENTRIES_VIEW_KEY = "notebook_notes_view";
const healthCacheKey = (targetId: string | null) => `neuron_health:${targetId || "all"}`;

const ENTRY_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "concept", label: "Concepts" },
  { value: "entity", label: "Entities" },
  { value: "synthesis", label: "Syntheses" },
  { value: "fact", label: "Facts" },
  { value: "comparison", label: "Comparisons" },
  { value: "summary", label: "Summaries" },
];

const VIEW_TITLES: Record<Exclude<WikiView, "entries">, string> = {
  detail: "Note",
  lint: "Health check",
  conflicts: "Conflicts",
  runs: "Recent tidy-ups",
};

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

const WikiPanel: React.FC = () => {
  const { books, activeWikiId, activeWikiIds, activeWikis, wikis, setActiveTab, setActiveBook } = useApp();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [wikiByEntry, setWikiByEntry] = useState<Record<string, string>>({});
  const [graph, setGraph] = useState<MemoryGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<WikiView>("entries");
  const [selectedEntry, setSelectedEntry] = useState<KnowledgeEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editHook, setEditHook] = useState("");
  const [entryImages, setEntryImages] = useState<ImageAttachmentRow[]>([]);
  const [lintResult, setLintResult] = useState<LintResult | null>(null);
  const [lintLoading, setLintLoading] = useState(false);
  const [conflicts, setConflicts] = useState<KnowledgeConflict[]>([]);
  const [memoryMode, setMemoryModeState] = useState<MemoryMode>("recording");
  const [memoryModeLoading, setMemoryModeLoading] = useState(false);
  const [sleepCycleRunning, setSleepCycleRunning] = useState(false);
  const [sleepCycleReport, setSleepCycleReport] = useState<SleepCycleReport | null>(null);
  const [sleepRuns, setSleepRuns] = useState<SleepRun[]>([]);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [healthScore, setHealthScore] = useState<number | null>(null);
  // The neuron the visible lint report was actually run against — kept with
  // the report so a mid-flight target switch can't mislabel results.
  const [lintTarget, setLintTarget] = useState<{ id: string | null; name: string } | null>(null);
  // Where Back from the detail view should land (conflicts/lint drill-ins).
  const [returnView, setReturnView] = useState<"conflicts" | "lint" | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [scopeKind, setScopeKind] = useState<ScopeKind>("loaded");
  // A tapped chip narrows the loaded scope to one neuron; tap again to widen.
  const [focusId, setFocusId] = useState<string | null>(null);

  // Only the newest in-flight loadData may commit results (stale-response guard).
  const requestIdRef = useRef(0);
  // Bumped on every successful mode toggle so a slower loadData snapshot
  // can't revert the chip to a stale server reading.
  const modeVersionRef = useRef(0);

  // Notes render as a list; the map is one tap away for people who like it.
  const [entriesView, setEntriesView] = useState<EntriesView>(() => {
    try { return localStorage.getItem(ENTRIES_VIEW_KEY) === "map" ? "map" : "list"; } catch { return "list"; }
  });
  useEffect(() => { try { localStorage.setItem(ENTRIES_VIEW_KEY, entriesView); } catch { /* cosmetic */ } }, [entriesView]);

  const activeWiki = wikis.find((w) => w.id === activeWikiId) || null;
  const loadedIds = useMemo(
    () => (activeWikiIds.length ? activeWikiIds : activeWikiId ? [activeWikiId] : []),
    [activeWikiIds, activeWikiId],
  );
  const loadedWikis = useMemo(
    () => loadedIds.map((id) => wikis.find((w) => w.id === id)).filter(Boolean) as typeof wikis,
    [loadedIds, wikis],
  );
  const loadedKey = loadedIds.join(",");

  // If the focused neuron gets unloaded elsewhere (⌘K, chat chips), widen back.
  useEffect(() => {
    if (focusId && !loadedIds.includes(focusId)) setFocusId(null);
  }, [focusId, loadedIds]);

  // The ids every read in this tab is scoped to. Null means "everything ever".
  // A focusId is only honored while its neuron is still loaded — during the
  // one render before the heal effect lands, fall back to the loaded set so a
  // transient state never fetches an unloaded neuron.
  const scopeIds: string[] | null = useMemo(() => {
    if (scopeKind === "all") return null;
    if (focusId && loadedIds.includes(focusId)) return [focusId];
    return loadedIds.length ? loadedIds : null;
  }, [scopeKind, focusId, loadedIds]);

  const focusedWiki = focusId ? wikis.find((w) => w.id === focusId) || null : null;
  // Maintenance actions (lint / consolidate / reindex) always run on ONE
  // explicit target — the focused neuron, else the primary — or on everything
  // with an explicit confirmation. Never silently account-wide.
  const maintenanceTargetId = scopeKind === "all" ? null : (focusId || activeWikiId);
  // Named from the id (not the scope kind) so label and target can't disagree.
  const maintenanceTargetName =
    maintenanceTargetId === null
      ? "all notebooks"
      : (focusedWiki?.name || activeWiki?.name || "this notebook");
  const maintenanceTargetRef = useRef({ id: maintenanceTargetId, name: maintenanceTargetName });
  maintenanceTargetRef.current = { id: maintenanceTargetId, name: maintenanceTargetName };

  const loadData = useCallback(async () => {
    // Loaded scope with no ids yet = AppContext hasn't hydrated. Wait for it
    // instead of silently issuing the heaviest possible account-wide queries.
    if (scopeKind === "loaded" && loadedIds.length === 0) {
      setLoading(true);
      return;
    }
    const reqId = ++requestIdRef.current;
    const modeV = modeVersionRef.current;
    setLoading(true);
    try {
      const ids = scopeIds;
      const [entriesRes, g, c, mode] = await Promise.all([
        ids
          ? ids.length === 1
            ? fetchKnowledgeEntries(ids[0]).then((es) => ({
                entries: es,
                wikiByEntry: Object.fromEntries(es.map((e) => [e.id, ids[0]])),
                failedWikiIds: [] as string[],
              }))
            : fetchKnowledgeEntriesForSet(ids)
          : fetchKnowledgeEntries(null).then((es) => ({
              // Everything scope: attribute entries via their own wiki_id so
              // "which notebook is this in?" is answerable here too.
              entries: es,
              wikiByEntry: Object.fromEntries(
                es.flatMap((e) => ((e as any).wiki_id ? [[e.id, (e as any).wiki_id as string]] : [])),
              ) as Record<string, string>,
              failedWikiIds: [] as string[],
            })),
        ids ? (ids.length === 1 ? fetchMemoryGraph(ids[0]) : fetchMemoryGraphForSet(ids)) : fetchMemoryGraph(null),
        (ids
          ? ids.length === 1
            ? fetchConflicts(undefined, ids[0])
            : fetchConflictsForSet(ids)
          : fetchConflicts(undefined, null)
        ).catch(() => [] as KnowledgeConflict[]),
        getMemoryMode().catch(() => "recording" as MemoryMode),
      ]);
      if (reqId !== requestIdRef.current) return; // a newer scope's fetch owns the UI now
      setEntries(entriesRes.entries);
      setWikiByEntry(entriesRes.wikiByEntry);
      setGraph(g);
      setConflicts(c);
      if (modeV === modeVersionRef.current) setMemoryModeState(mode);
      if (entriesRes.failedWikiIds.length > 0) {
        toast.warning(
          `Couldn't load ${entriesRes.failedWikiIds.length} of your open notebooks — showing the rest.`,
          { id: "neuron-partial-load" },
        );
      }
    } catch (err: any) {
      if (reqId === requestIdRef.current) toast.error(err.message || "Couldn't load your notes");
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKind, focusId, loadedKey, refreshNonce]);

  useEffect(() => { loadData(); }, [loadData]);

  // Cached health score for the current maintenance target (refreshed on each
  // Health check run). Purely informational — framed as care, not a grade.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(healthCacheKey(maintenanceTargetId));
      setHealthScore(raw ? (JSON.parse(raw).score ?? null) : null);
    } catch {
      setHealthScore(null);
    }
  }, [maintenanceTargetId]);

  // Attached images for the open entry (generated via chat — table may not
  // exist until the image-memory migration is applied, so fail quietly).
  useEffect(() => {
    let cancelled = false;
    if (!selectedEntry) { setEntryImages([]); return; }
    fetchImagesForEntries([selectedEntry.id])
      .then((rows) => { if (!cancelled) setEntryImages(rows); })
      .catch(() => { if (!cancelled) setEntryImages([]); });
    return () => { cancelled = true; };
  }, [selectedEntry?.id]);

  // Human-in-the-loop: the global conflict bell advertises conflicts across
  // ALL neurons, so honor that by widening scope before showing the list —
  // otherwise "3 conflicts" could land on an empty primary-scoped view. The
  // nonce forces a refetch even when scope state doesn't change, and an
  // unsaved entry edit is never discarded without asking.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const goToConflicts = () => {
      setEditing(false);
      setScopeKind("all");
      setFocusId(null);
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

  // "Used N notes" under a reply opens that note here (lib/openPassage.ts).
  // Fetched by id, so it opens even when its notebook isn't the open one.
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

  // Scoped sub-views hold a snapshot fetched at click time; if the loaded set
  // or scope changes underneath them, fall back to entries rather than
  // labeling stale data with the new scope's identity.
  const scopeSignature = `${scopeKind}|${focusId ?? ""}|${loadedKey}`;
  const prevScopeSigRef = useRef(scopeSignature);
  useEffect(() => {
    if (prevScopeSigRef.current === scopeSignature) return;
    prevScopeSigRef.current = scopeSignature;
    setView((v) => (v === "runs" ? "entries" : v));
  }, [scopeSignature]);

  const applyMemoryMode = async (next: MemoryMode) => {
    setMemoryModeLoading(true);
    try {
      await setMemoryMode(next);
      modeVersionRef.current += 1; // in-flight loadData snapshots are now stale
      setMemoryModeState(next);
      toast.success(
        next === "recording"
          ? "Saving notes again — Counsel keeps notes as you chat."
          : "Off the record — Counsel can still read your notes, but won't save new ones.",
      );
    } catch (err: any) {
      toast.error(err.message || "Couldn't change that setting");
    } finally {
      setMemoryModeLoading(false);
    }
  };

  // Off the record is one tap either way, and it is never hidden: the pill
  // below and Counsel's header both show it while it's on.
  const handleToggleMemoryMode = () => {
    void applyMemoryMode(memoryMode === "recording" ? "retrieval" : "recording");
  };

  const runSleepCycle = async () => {
    setSleepCycleRunning(true);
    setSleepCycleReport(null);
    try {
      const report = await triggerSleepCycle(maintenanceTargetId);
      setSleepCycleReport(report);
      // Say what it actually changed — the two things a person would notice.
      const p = report.phases;
      const bits = [
        p.consolidate.edges_created > 0 ? `linked ${p.consolidate.edges_created} related ${p.consolidate.edges_created === 1 ? "note" : "notes"}` : null,
        p.hooks && p.hooks.written > 0 ? `wrote ${p.hooks.written} one-line ${p.hooks.written === 1 ? "summary" : "summaries"}` : null,
      ].filter(Boolean);
      toast.success(
        `Tidied ${maintenanceTargetName}${bits.length ? " — " + bits.join(", ") : " — nothing needed tidying"}`,
        report.run_id ? { action: { label: "Undo", onClick: () => void handleUndoRun(report.run_id!) } } : undefined,
      );
      await loadData();
    } catch (err: any) {
      toast.error(err.message || "Tidy-up failed");
    } finally {
      setSleepCycleRunning(false);
    }
  };

  const handleSleepCycle = () => {
    if (maintenanceTargetId === null) {
      setConfirmRequest({
        title: "Tidy every notebook?",
        description:
          "You're looking at Everything, so this links and tidies notes across all your notebooks at once. It can take a while, and you can undo it afterwards.",
        confirmLabel: "Tidy all",
        onConfirm: runSleepCycle,
      });
    } else {
      void runSleepCycle();
    }
  };

  const handleLoadRuns = async () => {
    try {
      setSleepRuns(await fetchSleepRuns(10));
      setView("runs");
    } catch (err: any) {
      toast.error(err.message || "Couldn't load recent tidy-ups");
    }
  };

  async function handleUndoRun(runId: string) {
    try {
      const ok = await undoSleepRun(runId);
      if (!ok) { toast.error("That tidy-up was already undone."); return; }
      toast.success("Tidy-up undone");
      setSleepRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, undone_at: new Date().toISOString() } : r)));
      await loadData();
    } catch (err: any) {
      toast.error(err.message || "Undo failed");
    }
  }

  // Memoized: the mind map keys its graphData on this array's identity, so an
  // unstable reference would tear down and re-layout the whole 3D scene on
  // every unrelated render (same convention as Library/WikiLibrary).
  const filteredEntries = useMemo(() => entries.filter((e) => {
    if (filterType !== "all" && e.entry_type !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  }), [entries, filterType, searchQuery]);

  const newThisWeek = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return entries.filter((e) => new Date(e.created_at).getTime() > cutoff).length;
  }, [entries]);

  // Maintenance runs on ONE neuron (the focused one, else the primary), so its
  // enablement must follow that neuron's entries — not the whole union, which
  // would offer a "health check" of 50 visible entries that scans an empty
  // primary. First-wins attribution slightly undercounts shared entries; fine.
  const targetEntryCount = useMemo(() => {
    if (maintenanceTargetId === null) return entries.length;
    if (scopeIds && scopeIds.length === 1) return entries.length;
    return entries.filter((e) => wikiByEntry[e.id] === maintenanceTargetId).length;
  }, [entries, wikiByEntry, maintenanceTargetId, scopeIds]);

  const wikiNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of wikis) m[w.id] = w.name;
    return m;
  }, [wikis]);

  // Tooltip/card attribution for any multi-neuron scope — the merged loaded
  // set AND "Everything", where knowing an entry's home neuron matters most.
  // (Node color stays type-coded.)
  const neuronNameByEntry = useMemo(() => {
    if (scopeIds && scopeIds.length < 2) return undefined;
    const m: Record<string, string> = {};
    for (const [entryId, wikiId] of Object.entries(wikiByEntry)) {
      const name = wikiNameById[wikiId];
      if (name) m[entryId] = name;
    }
    return m;
  }, [scopeIds, wikiByEntry, wikiNameById]);

  const getRelatedEntries = (entryId: string) => {
    const relationships: { entry: KnowledgeEntry; relationship: string; direction: "from" | "to" }[] = [];
    const relatedIds = new Set<string>();
    graph.forEach((edge) => {
      if (edge.source_entry_id === entryId) relatedIds.add(edge.target_entry_id);
      if (edge.target_entry_id === entryId) relatedIds.add(edge.source_entry_id);
    });
    relatedIds.forEach((id) => {
      const entry = entries.find((e) => e.id === id);
      if (entry) {
        const edge = graph.find(g => (g.source_entry_id === entryId && g.target_entry_id === id) || (g.target_entry_id === entryId && g.source_entry_id === id));
        relationships.push({ entry, relationship: edge?.relationship || "relates_to", direction: edge?.source_entry_id === entryId ? "to" : "from" });
      }
    });
    return relationships;
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

  const runHealthCheck = async () => {
    // Capture the target now — the user can refocus chips or switch scope
    // while the edge function runs, and the report must stay attributed to
    // the neuron it was actually run against.
    const target = { id: maintenanceTargetId, name: maintenanceTargetName };
    setLintLoading(true);
    try {
      const result = await runLint(target.id);
      setLintResult(result);
      setLintTarget(target);
      if (maintenanceTargetRef.current.id === target.id) setHealthScore(result.health_score);
      try {
        localStorage.setItem(healthCacheKey(target.id), JSON.stringify({ score: result.health_score, at: Date.now() }));
      } catch { /* cache is cosmetic */ }
      setView("lint");
    } catch (err: any) { toast.error(err.message); }
    finally { setLintLoading(false); }
  };

  const handleHealthCheck = () => {
    if (maintenanceTargetId === null) {
      setConfirmRequest({
        title: "Check every notebook?",
        description: "You're looking at Everything, so this checks all your notebooks at once and can take a while.",
        confirmLabel: "Run check",
        onConfirm: runHealthCheck,
      });
    } else {
      void runHealthCheck();
    }
  };

  const handleConflictStatus = async (id: string, status: KnowledgeConflict["status"]) => {
    try {
      await updateConflictStatus(id, status);
      setConflicts((prev) => prev.map((c) => c.id === id ? { ...c, status } : c));
    } catch (err: any) { toast.error(err.message); }
  };

  const handleResolveByDelete = async (conflictId: string, deleteEntryId: string) => {
    try {
      await deleteKnowledgeEntry(deleteEntryId);
      await updateConflictStatus(conflictId, "resolved");
      setEntries((prev) => prev.filter((e) => e.id !== deleteEntryId));
      setConflicts((prev) => prev.map((c) => c.id === conflictId ? { ...c, status: "resolved" } : c));
      toast.success("Conflict resolved — note deleted");
    } catch (err: any) { toast.error(err.message); }
  };

  // "Keep this one" — the action lives on the card it keeps, and the entry
  // being deleted is named before anything happens.
  const requestKeepEntry = (conflict: KnowledgeConflict, keep: KnowledgeEntry, remove: KnowledgeEntry) => {
    setConfirmRequest({
      title: `Keep "${keep.title}"?`,
      description: `"${remove.title}" will be permanently deleted and this conflict marked resolved. This can't be undone.`,
      confirmLabel: `Delete "${remove.title.length > 40 ? remove.title.slice(0, 40) + "…" : remove.title}"`,
      destructive: true,
      onConfirm: () => void handleResolveByDelete(conflict.id, remove.id),
    });
  };

  const openConflictsCount = conflicts.filter(c => c.status === "open").length;
  const reflexOn = useReflexEnabled();
  // Reflex cue: entries that are part of an OPEN conflict get a marker on their card.
  const conflictEntryIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of conflicts) {
      if (c.status === "open") { if (c.entry_a) s.add(c.entry_a); if (c.entry_b) s.add(c.entry_b); }
    }
    return s;
  }, [conflicts]);

  // Daily recall: three notes a day (DailyRecall.tsx).
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dueCount, setDueCount] = useState(0);
  const [recallDone, setRecallDone] = useState(dailyRecallDoneToday);
  const refreshDueCount = useCallback(() => {
    setRecallDone(dailyRecallDoneToday());
    fetchDueReviews(maintenanceTargetId, DAILY_RECALL_SIZE).then((r) => setDueCount(r.length)).catch(() => setDueCount(0));
  }, [maintenanceTargetId]);
  useEffect(() => { refreshDueCount(); }, [refreshDueCount, refreshNonce]);

  // `from` records where Back should return to; "preserve" keeps the current
  // origin across related-entry hops inside the detail view.
  const openDetail = useCallback((entry: KnowledgeEntry, from?: "conflicts" | "lint" | "preserve") => {
    setSelectedEntry(entry);
    setView("detail");
    setEditing(false);
    if (from !== "preserve") setReturnView(from === "conflicts" || from === "lint" ? from : null);
  }, []);
  const startEdit = () => {
    if (!selectedEntry) return;
    setEditTitle(selectedEntry.title);
    setEditContent(selectedEntry.content);
    setEditTags(selectedEntry.tags.join(", "));
    setEditHook(selectedEntry.hook || "");
    setEditing(true);
  };

  const backToEntries = () => { setView("entries"); setSelectedEntry(null); setReturnView(null); };
  // Back from an entry opened inside Conflicts / the Health report returns to
  // that report (still in state) instead of dumping the user at the grid.
  const handleBack = () => {
    if (view === "detail" && returnView && (returnView !== "lint" || lintResult)) {
      setSelectedEntry(null);
      setEditing(false);
      setView(returnView);
      setReturnView(null);
      return;
    }
    backToEntries();
  };

  const titleName = scopeKind === "all"
    ? "All notebooks"
    : (focusedWiki?.name || activeWiki?.name || "Notebook");
  const titleColor = scopeKind === "all" ? null : (focusedWiki?.cover_color || activeWiki?.cover_color || "#7C3AED");
  // Scoped to the notebook being displayed — a focused notebook with no
  // description must not borrow the primary's.
  const description = scopeKind === "all"
    ? null
    : ((focusId ? focusedWiki?.description : activeWiki?.description)?.trim() || null);
  const primaryName = activeWiki?.name || "your notebook";
  const healthTone = healthScore == null ? null : healthScore >= 80 ? "good" : healthScore >= 50 ? "warn" : "bad";

  const lintFindEntries = (titles: string[] | undefined) =>
    (titles || []).flatMap((title) => {
      const e = entries.find(
        (en) =>
          en.title.toLowerCase() === title.toLowerCase() ||
          en.title.toLowerCase().includes(title.toLowerCase()) ||
          title.toLowerCase().includes(en.title.toLowerCase()),
      );
      return e ? [e] : [];
    });

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-7xl mx-auto px-6 py-6 pb-32 w-full">
        {/* ── Header: identity (left) · status & care (right) ─────────────── */}
        <section className={view === "entries"
          ? "grid grid-cols-1 md:grid-cols-[1.618fr_1fr] items-start gap-4 md:gap-6 mb-4"
          : "mb-4"}>
          <div className="min-w-0 space-y-1">
            <button
              onClick={() => setActiveTab("wikis")}
              className="inline-flex items-center gap-1 text-xs font-semibold text-on-surface-variant hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden>arrow_back</span>
              All notebooks
            </button>
            <div className="flex items-center gap-3 min-w-0">
              {titleColor && (
                <span
                  aria-hidden
                  className="inline-block w-3 h-3 rounded-full border border-outline-variant/30 shrink-0"
                  style={{ backgroundColor: titleColor }}
                />
              )}
              <h2 className="font-headline font-bold text-3xl md:text-4xl text-foreground tracking-tight truncate">
                {titleName}
              </h2>
            </div>
            <p className="text-xs text-on-surface-variant">
              {entries.length} {entries.length === 1 ? "note" : "notes"}
              {newThisWeek > 0 && (
                <span className="text-primary font-semibold"> · +{newThisWeek} this week</span>
              )}
              {scopeKind === "loaded" && loadedWikis.length > 1 && !focusId && (
                <span> · across {loadedWikis.length} open notebooks</span>
              )}
            </p>
            {description && view === "entries" && (
              <p className="text-sm text-on-surface-variant/80 truncate max-w-[65ch]">{description}</p>
            )}
          </div>

          {view === "entries" && (
            <div className="flex items-center md:justify-end gap-2 flex-wrap">
              {/* Daily recall — the tab's one accent-colored control. */}
              <button
                onClick={() => setReviewOpen(true)}
                disabled={entries.length === 0}
                title="Three notes a day: answer first, then check against the note and its page."
                className="flex items-center gap-2 pl-2.5 pr-4 py-1.5 rounded-full bg-primary-container text-on-primary-container text-sm font-bold active:scale-95 transition-transform disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-xl" aria-hidden>{recallDone ? "task_alt" : "psychology_alt"}</span>
                <span>{recallDone ? "Recall done today" : dueCount > 0 ? `Daily recall · ${dueCount}` : "Daily recall"}</span>
              </button>

              {/* Conflicts are status: visible only when something needs you. */}
              {openConflictsCount > 0 && (
                <button
                  onClick={() => setView("conflicts")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/25 text-sm font-semibold hover:bg-amber-500/15 transition-colors"
                >
                  <span className="material-symbols-outlined text-base" aria-hidden>report</span>
                  {openConflictsCount} {openConflictsCount === 1 ? "conflict" : "conflicts"}
                </button>
              )}

              {/* Everything rare lives in one plain-language menu. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Notebook menu"
                    title="More"
                    className="p-2 rounded-full bg-surface-container-high hover:bg-surface-container-highest transition-colors"
                  >
                    <span className="material-symbols-outlined block" aria-hidden>more_horiz</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel className="text-xs text-on-surface-variant font-normal">
                    {maintenanceTargetName}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleSleepCycle} disabled={sleepCycleRunning || targetEntryCount === 0}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>auto_fix_high</span>
                    <span className="flex flex-col">
                      <span>Tidy up now</span>
                      <span className="text-xs text-on-surface-variant">Links related notes and writes missing one-line summaries. Also runs by itself once a day.</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleLoadRuns}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>history</span>
                    <span className="flex flex-col">
                      <span>Recent tidy-ups</span>
                      <span className="text-xs text-on-surface-variant">See what changed, and undo it</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleHealthCheck} disabled={lintLoading || targetEntryCount === 0}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>health_and_safety</span>
                    <span className="flex flex-col">
                      <span>Health check{healthScore != null ? ` · last ${healthScore}/100` : ""}</span>
                      <span className="text-xs text-on-surface-variant">Finds duplicates, gaps and notes that disagree</span>
                    </span>
                  </DropdownMenuItem>
                  {openConflictsCount === 0 && conflicts.length > 0 && (
                    <DropdownMenuItem onClick={() => setView("conflicts")}>
                      <span className="material-symbols-outlined text-base mr-1" aria-hidden>report</span>
                      <span className="flex flex-col">
                        <span>Conflict history</span>
                        <span className="text-xs text-on-surface-variant">Past disagreements, all resolved</span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={loadData} disabled={loading}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>refresh</span>
                    Refresh
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/memory-guide">
                      <span className="material-symbols-outlined text-base mr-1" aria-hidden>help</span>
                      How notes work
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </section>

        {/* ── Loaded-set chips + scope: what's loaded IS the scope ─────────── */}
        {view === "entries" && (
          <section className="space-y-2 mb-6">
            <div className="flex items-center gap-2 flex-wrap">
              {scopeKind === "loaded" && loadedWikis.map((w, i) => {
                const focused = focusId === w.id;
                const dimmed = focusId !== null && !focused;
                return (
                  <button
                    key={w.id}
                    onClick={() => setFocusId(focused ? null : w.id)}
                    aria-pressed={focused}
                    title={
                      (i === 0 ? `${w.name} — new notes are saved here. ` : `${w.name}. `) +
                      (focused ? "Click to show all open notebooks again." : "Click to show just this notebook.")
                    }
                    className={`inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border text-xs font-semibold max-w-[180px] transition-colors ${
                      focused
                        ? "bg-primary/15 text-primary border-primary/40 ring-1 ring-primary/20"
                        : dimmed
                          ? "bg-surface-container border-outline-variant/15 text-on-surface-variant/60"
                          : "bg-surface-container-high border-outline-variant/20 text-foreground hover:bg-surface-container-highest"
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: w.cover_color || "#7C3AED" }}
                      aria-hidden
                    />
                    <span className="truncate">{w.name}</span>
                    {i === 0 && loadedWikis.length > 1 && (
                      <span role="img" aria-label="new notes go here" title="New notes are saved here" className="text-primary">★</span>
                    )}
                  </button>
                );
              })}
              {scopeKind === "loaded" && (
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent("open-neuron-switcher"))}
                  title="Open another notebook alongside this one (⌘K)"
                  className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full border border-dashed border-outline-variant/40 text-xs text-on-surface-variant hover:border-primary/50 hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-sm" aria-hidden>add</span>
                  Add notebook
                </button>
              )}
              {scopeKind === "loaded" && loadedWikis.length >= 2 && (
                <button
                  onClick={() => import("@/components/ChainDialog").then((m) => m.openChainDialog({ prefillIds: loadedIds }))}
                  title="Save these notebooks as a set you can open together"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-outline-variant/40 text-xs text-on-surface-variant hover:border-primary/50 hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-sm" aria-hidden>bookmark_add</span>
                  Save as set
                </button>
              )}

              <div
                role="group"
                aria-label="Data scope"
                className="ml-auto inline-flex items-center rounded-full border border-outline-variant/30 bg-surface-container-low overflow-hidden text-xs font-semibold"
              >
                <button
                  type="button"
                  onClick={() => { setScopeKind("loaded"); setFocusId(null); }}
                  aria-pressed={scopeKind === "loaded"}
                  disabled={loadedIds.length === 0}
                  title="Show the notebooks Counsel is using right now"
                  className={`px-3 py-1.5 transition-colors ${scopeKind === "loaded" ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"} disabled:opacity-40`}
                >
                  {loadedWikis.length > 1 ? `Open (${loadedWikis.length})` : "This notebook"}
                </button>
                <button
                  type="button"
                  onClick={() => { setScopeKind("all"); setFocusId(null); }}
                  aria-pressed={scopeKind === "all"}
                  title="Every notebook you have, open or not"
                  className={`px-3 py-1.5 transition-colors ${scopeKind === "all" ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"}`}
                >
                  Everything
                </button>
              </div>
            </div>

            {/* Off the record is persistent, glanceable state — never a mystery button. */}
            <button
              onClick={handleToggleMemoryMode}
              disabled={memoryModeLoading}
              aria-pressed={memoryMode === "recording"}
              title={
                memoryMode === "recording"
                  ? `Counsel saves notes to "${primaryName}" as you chat. Click to go off the record.`
                  : "Off the record: Counsel still reads your notes but saves nothing new. Click to start saving again."
              }
              className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium transition-colors disabled:opacity-50 ${
                memoryMode === "recording"
                  ? "border-outline-variant/25 bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-500 hover:bg-amber-500/15"
              }`}
            >
              {memoryModeLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className={`w-2 h-2 rounded-full ${memoryMode === "recording" ? "bg-primary motion-safe:animate-breathe" : "bg-amber-500"}`}
                />
              )}
              {memoryMode === "recording"
                ? `Saving notes to ${primaryName}`
                : "Off the record — nothing new is saved"}
            </button>
          </section>
        )}

        {/* ── Sub-view wayfinding: one compact bar, no button-row reflow ───── */}
        {view !== "entries" && (
          <div className="flex items-center gap-3 mb-6 flex-wrap motion-safe:animate-fade-in">
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-high text-sm hover:bg-surface-container-highest transition-colors"
            >
              <span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>
              {view === "detail" && returnView ? `Back to ${VIEW_TITLES[returnView].toLowerCase()}` : "Back"}
            </button>
            <h3 className="font-headline font-bold text-xl text-foreground">
              {VIEW_TITLES[view as Exclude<WikiView, "entries">]}
            </h3>
            {view === "conflicts" && (
              <span className="text-xs text-on-surface-variant">{openConflictsCount} open · {conflicts.length} total</span>
            )}
            {view === "runs" && <span className="text-xs text-on-surface-variant">last {sleepRuns.length}</span>}
            {/* The paused state must never be invisible, even mid-triage. */}
            {memoryMode !== "recording" && (
              <span className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-500 text-[11px] font-medium">
                <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                Off the record
              </span>
            )}
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" aria-hidden />
          </div>
        ) : view === "entries" ? (
          <div className="relative" aria-busy={loading}>
            {/* Scope/neuron switches keep old data mounted; dim it so nobody
                acts on the scope they just left. */}
            {loading && (
              <div className="absolute inset-0 z-10 rounded-2xl bg-background/60 flex items-center justify-center">
                <Loader2 className="w-7 h-7 animate-spin text-on-surface-variant" aria-hidden />
              </div>
            )}

            {/* Search */}
            <div className="mb-4 relative">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant" aria-hidden>search</span>
              <input
                value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search notes"
                className="w-full bg-surface-container-low border-none rounded-2xl py-3.5 pl-12 pr-6 focus:ring-1 focus:ring-primary/40 placeholder:text-on-surface-variant/50 text-foreground text-base transition-all shadow-inner"
                placeholder="Search this notebook…"
              />
            </div>

            {/* Filter pills + map/list view toggle */}
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1 min-w-0">
                <div className="flex items-center gap-2 overflow-x-auto pb-1 hide-scrollbar" role="group" aria-label="Filter by kind of note">
                  {ENTRY_TYPE_FILTERS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setFilterType(value)}
                      aria-pressed={filterType === value}
                      className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                        filterType === value
                          ? "bg-secondary-container text-on-secondary-container ring-1 ring-primary/20"
                          : "hover:bg-surface-container-high text-on-surface-variant"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* Fade edge: hints that the pill row scrolls (scrollbar is hidden). */}
                <div aria-hidden className="absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-background to-transparent pointer-events-none" />
              </div>
              <div
                role="group"
                aria-label="Notes view"
                className="flex items-center gap-1 rounded-full border border-outline-variant/20 bg-surface-container-low p-1 shrink-0 self-start"
                onMouseEnter={() => { void import("@/components/EntryNeuronGraph"); }}
              >
                {([
                  ["list", "view_list", "List"],
                  ["map", "hub", "Map"],
                ] as const).map(([id, icon, label]) => (
                  <button
                    key={id}
                    onClick={() => setEntriesView(id)}
                    aria-pressed={entriesView === id}
                    title={label}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${
                      entriesView === id
                        ? "bg-primary/15 text-primary"
                        : "text-on-surface-variant hover:text-foreground"
                    }`}
                  >
                    <span
                      className="material-symbols-outlined text-base"
                      style={entriesView === id ? { fontVariationSettings: "'FILL' 1" } : undefined}
                      aria-hidden
                    >
                      {icon}
                    </span>
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Notes — list (default) or map */}
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
                <span className="material-symbols-outlined text-5xl" aria-hidden>menu_book</span>
                <p className="text-sm text-center">
                  {entries.length === 0
                    ? scopeKind === "all"
                      ? "No notes yet. Chat with Counsel about what you're reading and notes appear here."
                      : loadedWikis.length > 1 && !focusId
                        ? "These notebooks are empty. Chat with Counsel about what you're reading to fill them."
                        : "This notebook is empty. Chat with Counsel about what you're reading to fill it."
                    : "No notes match your search."}
                </p>
              </div>
            ) : entriesView === "map" ? (
              <React.Suspense
                key="map"
                fallback={
                  <div className="flex items-center justify-center h-[62vh] min-h-[440px]">
                    <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" aria-hidden />
                  </div>
                }
              >
                <EntryNeuronGraph
                  entries={filteredEntries}
                  edges={graph}
                  conflicts={conflicts}
                  onOpen={openDetail}
                  neuronNameByEntry={neuronNameByEntry}
                />
              </React.Suspense>
            ) : (
              <div key="list" className="space-y-4 motion-safe:animate-fade-in">
                {filteredEntries.map((entry) => {
                  const relCount = graph.filter(g => g.source_entry_id === entry.id || g.target_entry_id === entry.id).length;
                  const sourceWiki = neuronNameByEntry?.[entry.id];
                  const sourceColor = sourceWiki ? wikis.find((w) => w.id === wikiByEntry[entry.id])?.cover_color : null;
                  const inConflict = reflexOn && conflictEntryIds.has(entry.id);
                  const pageLoc = parseLocators(entry.locators)[0];
                  return (
                    <button
                      key={entry.id} onClick={() => openDetail(entry)}
                      className={`group w-full text-left rounded-xl p-6 hover:shadow-2xl transition-all duration-300 border-l-4 bg-surface-container-high ${inConflict ? "border-amber-500/60 hover:border-amber-500" : "border-transparent hover:border-primary-container"}`}
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap text-[11px] font-semibold text-on-surface-variant">
                            <span className="capitalize text-primary">{entry.entry_type}</span>
                            {pageLoc && (
                              <>
                                <span aria-hidden className="text-outline-variant">·</span>
                                <span className="inline-flex items-center gap-0.5 min-w-0 max-w-[220px] truncate">
                                  <span className="material-symbols-outlined text-[13px]" aria-hidden>bookmark</span>
                                  {pageLoc.book_title ? `${pageLoc.book_title}, ` : ""}p. {pageLoc.page}
                                </span>
                              </>
                            )}
                            {relCount > 0 && (
                              <>
                                <span aria-hidden className="text-outline-variant">·</span>
                                <span>{relCount} {relCount === 1 ? "link" : "links"}</span>
                              </>
                            )}
                            {sourceWiki && (
                              <>
                                <span aria-hidden className="text-outline-variant">·</span>
                                <span className="inline-flex items-center gap-1">
                                  {sourceColor && (
                                    <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sourceColor }} />
                                  )}
                                  {sourceWiki}
                                </span>
                              </>
                            )}
                            {inConflict && (
                              <>
                                <span aria-hidden className="text-outline-variant">·</span>
                                <span className="inline-flex items-center gap-1 text-amber-500 font-semibold bg-amber-500/10 px-1.5 py-0.5 rounded">
                                  <span className="material-symbols-outlined text-[13px]" aria-hidden>report</span>
                                  in conflict
                                </span>
                              </>
                            )}
                          </div>
                          <h4 className="font-headline font-bold text-xl md:text-2xl text-foreground group-hover:text-primary transition-colors">{entry.title}</h4>
                        </div>
                        <span className="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden>chevron_right</span>
                      </div>

                      <p className="text-on-surface-variant mb-3 line-clamp-2 leading-relaxed text-sm">{entry.hook || fallbackHook(entry.content)}</p>
                      <div className="flex flex-wrap gap-2">
                        {entry.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="bg-surface-container-highest px-2.5 py-0.5 rounded text-[11px] font-semibold text-secondary">{tag}</span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : view === "detail" && selectedEntry ? (
          <div className="max-w-3xl mx-auto space-y-6">
            {editing ? (
              <>
                <Input id="note-edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} aria-label="Note title" className="text-2xl font-headline font-bold bg-surface-container-high border-none" />
                <div className="space-y-1">
                  <label htmlFor="note-edit-hook" className="text-xs font-semibold text-on-surface-variant">One-line summary (what Counsel sees first)</label>
                  <Input id="note-edit-hook" value={editHook} maxLength={160} onChange={(e) => setEditHook(e.target.value)} placeholder="Leave empty and the nightly tidy-up writes one" className="text-sm bg-surface-container-high border-none" />
                </div>
                <Textarea id="note-edit-content" value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={10} aria-label="Note text" className="text-sm font-mono bg-surface-container-high border-none" />
                <Input id="note-edit-tags" value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="tag1, tag2, tag3" aria-label="Note tags" className="text-sm bg-surface-container-high border-none" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-2 text-[11px] font-semibold text-on-surface-variant">
                      <span className="capitalize text-primary">{selectedEntry.entry_type}</span>
                    </div>
                    <h2 className="font-headline font-bold text-3xl md:text-4xl text-foreground">{selectedEntry.title}</h2>
                    {selectedEntry.hook && (
                      <p className="text-base text-on-surface-variant mt-2">{selectedEntry.hook}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={startEdit} className="flex items-center gap-1 px-3 py-1.5 hover:bg-surface-container-high rounded-lg transition-colors text-sm text-on-surface-variant">
                      <span className="material-symbols-outlined text-base" aria-hidden>edit</span>
                      Edit
                    </button>
                    <button onClick={() => requestDeleteEntry(selectedEntry)} className="flex items-center gap-1 px-3 py-1.5 hover:bg-error-container/20 rounded-lg transition-colors text-sm text-destructive">
                      <span className="material-symbols-outlined text-base" aria-hidden>delete</span>
                      Forget
                    </button>
                  </div>
                </div>
                <div className="prose prose-lg prose-invert max-w-none"><ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{selectedEntry.content}</ReactMarkdown></div>
                <EntryLocatorPanel
                  key={selectedEntry.id}
                  entry={selectedEntry}
                  onLocatorsChanged={(locators) => {
                    setSelectedEntry((prev) => (prev ? { ...prev, locators } : prev));
                    setEntries((prev) => prev.map((e) => (e.id === selectedEntry.id ? { ...e, locators } : e)));
                  }}
                />
                {entryImages.length > 0 && (
                  <div className="border-t border-outline-variant/10 pt-6">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-4">Attached Images</h3>
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
                            className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface-container-highest/80 opacity-0 group-hover/img:opacity-100 transition-opacity"
                            aria-label="Delete image"
                          >
                            <span className="material-symbols-outlined text-destructive text-base" aria-hidden>delete</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedEntry.tags.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {selectedEntry.tags.map((tag) => (
                      <span key={tag} className="bg-surface-container-highest px-2.5 py-0.5 rounded text-[11px] font-semibold text-secondary">{tag}</span>
                    ))}
                  </div>
                )}
                {(() => {
                  const related = getRelatedEntries(selectedEntry.id);
                  if (related.length === 0) return null;
                  return (
                    <div className="border-t border-outline-variant/10 pt-6">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-4">Related notes</h3>
                      <div className="space-y-2">
                        {related.map(({ entry, relationship }) => (
                          <button key={entry.id} onClick={() => openDetail(entry, "preserve")} className="w-full text-left p-4 rounded-xl bg-surface-container-high hover:bg-surface-container-highest transition-all flex items-center gap-3">
                            <span className="material-symbols-outlined text-on-surface-variant text-sm" aria-hidden>link</span>
                            <span className="text-xs text-on-surface-variant">{relationship.replace("_", " ")}</span>
                            <span className="text-sm font-medium text-foreground">{entry.title}</span>
                            <span className="text-[11px] font-semibold capitalize text-primary ml-auto">{entry.entry_type}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {(() => {
                  // "Why is this here?" — where the note came from, in words,
                  // with every page one tap away.
                  const locs = parseLocators(selectedEntry.locators);
                  const book = selectedEntry.source_book_id ? books.find((b) => b.id === selectedEntry.source_book_id) : null;
                  const when = new Date(selectedEntry.created_at).toLocaleDateString();
                  const who = selectedEntry.author === "user" ? "You saved this" : "Counsel saved this";
                  return (
                    <div className="border-t border-outline-variant/10 pt-6 space-y-3">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Why this is here</h3>
                      <p className="text-sm text-on-surface-variant">
                        {who} on {when}
                        {book ? `, while you were reading "${book.title}"` : locs.length === 0 ? ", from a chat" : ""}.
                        {" "}Last changed {new Date(selectedEntry.updated_at).toLocaleDateString()}.
                      </p>
                      {locs.length > 0 && (
                        <ul className="space-y-2">
                          {locs.map((l, i) => {
                            const bookId = locatorBookId(l, books);
                            return (
                              <li key={`${l.chapter_id}:${l.char_start}:${i}`} className="flex items-start gap-3 p-3 rounded-xl bg-surface-container-high">
                                <span className="material-symbols-outlined text-primary text-base mt-0.5" aria-hidden>bookmark</span>
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs text-on-surface-variant">
                                    {l.book_title || "Book"}{l.chapter_name ? ` · ${l.chapter_name}` : ""} · p. {l.page}
                                  </div>
                                  <p className="text-sm text-foreground/90 italic line-clamp-2">“{l.quote}”</p>
                                </div>
                                {bookId && (
                                  <button
                                    onClick={() => openPassage({ setActiveBook, setActiveTab }, bookId, l.page)}
                                    className="shrink-0 text-xs font-semibold text-primary hover:underline"
                                  >
                                    Open page
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        ) : view === "lint" && lintResult ? (
          <div className="max-w-3xl mx-auto space-y-6">
            {/* Health score */}
            <div className="bg-surface-container-high rounded-xl p-8 text-center relative overflow-hidden">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/5 rounded-full blur-2xl" aria-hidden />
              <div className="text-5xl font-bold font-headline text-primary mb-2">{lintResult.health_score}/100</div>
              <p className="text-on-surface-variant">Health check · {lintTarget?.name || maintenanceTargetName}</p>
              {lintTarget && lintTarget.id !== maintenanceTargetId && (
                <p className="text-xs text-amber-500 mt-1">
                  This report is for {lintTarget.name} — you're now viewing a different scope. Re-run for fresh results.
                </p>
              )}
              <div className="w-full max-w-xs mx-auto h-3 bg-surface-container-highest rounded-full mt-4 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-primary-fixed-dim rounded-full" style={{ width: `${lintResult.health_score}%` }} />
              </div>
              <div className="flex justify-center gap-6 mt-4 text-xs text-on-surface-variant">
                <span>{lintResult.stats.total_entries} notes</span>
                <span>{lintResult.stats.total_relationships} links</span>
                <span>{lintResult.stats.orphan_count} unconnected</span>
              </div>
              <div className="mt-4">
                <Button size="sm" variant="outline" onClick={handleHealthCheck} disabled={lintLoading}>
                  {lintLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden /> : <span className="material-symbols-outlined text-sm mr-1" aria-hidden>refresh</span>}
                  Re-run
                </Button>
              </div>
            </div>

            {lintResult.issues.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Issues ({lintResult.issues.length})</h3>
                {lintResult.issues.map((issue, i) => {
                  // Affected entries resolve by title against the CURRENT
                  // scope's entries — only safe while the report's target is
                  // still what's on screen; otherwise hide the entry actions.
                  const targetCurrent = !lintTarget || lintTarget.id === maintenanceTargetId;
                  const affected = targetCurrent ? lintFindEntries(issue.affected_entries) : [];
                  return (
                    <div key={i} className={`p-4 rounded-xl ${issue.severity === "high" ? "bg-error-container/20 border-l-4 border-destructive" : "bg-surface-container-highest/50"}`}>
                      <div className="flex items-start gap-3">
                        <span className="material-symbols-outlined text-destructive mt-0.5" aria-hidden>warning</span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1.5">
                            <Badge variant="outline" className="text-[11px] capitalize">{issue.type.replace("_", " ")}</Badge>
                            <span className={`text-[11px] font-semibold capitalize ${issue.severity === "high" ? "text-destructive" : "text-on-surface-variant"}`}>{issue.severity}</span>
                          </div>
                          <p className="text-sm font-bold text-foreground">{issue.description}</p>
                          {issue.suggested_fix && <p className="text-xs text-on-surface-variant mt-1">💡 {issue.suggested_fix}</p>}
                          {affected.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                              {affected.map((entry) => (
                                <button
                                  key={entry.id}
                                  onClick={() => openDetail(entry, "lint")}
                                  className="text-xs px-2.5 py-1.5 bg-surface-container-high rounded-lg border border-outline-variant/20 hover:bg-surface-container-highest transition-all flex items-center gap-1.5 font-medium"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: "12px" }} aria-hidden>open_in_new</span>
                                  {entry.title}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2 mt-3 flex-wrap">
                            {issue.type === "orphan" && (
                              <Button size="sm" variant="outline" onClick={handleSleepCycle} disabled={sleepCycleRunning}>
                                {sleepCycleRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden /> : <span className="material-symbols-outlined text-sm mr-1" aria-hidden>auto_fix_high</span>}
                                Fix: tidy up
                              </Button>
                            )}
                            {(issue.type === "duplicate" || issue.type === "stale") && affected.map((entry) => (
                              <Button key={entry.id} size="sm" variant="destructive" onClick={() => requestDeleteEntry(entry)}>
                                <span className="material-symbols-outlined text-sm mr-1" aria-hidden>delete</span>
                                Delete "{entry.title.length > 30 ? entry.title.slice(0, 30) + "…" : entry.title}"
                              </Button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {lintResult.suggestions.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Suggestions ({lintResult.suggestions.length})</h3>
                {lintResult.suggestions.map((s, i) => (
                  <div key={i} className="p-4 rounded-xl bg-surface-container-high">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <Badge variant="secondary" className="text-xs mb-2">{s.priority}</Badge>
                        <p className="text-sm text-foreground">{s.description}</p>
                      </div>
                      {(s.type === "add_relationship" || s.type === "merge_entries") && (
                        <Button size="sm" variant="outline" onClick={handleSleepCycle} disabled={sleepCycleRunning} className="shrink-0">
                          {sleepCycleRunning ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <span className="material-symbols-outlined text-sm" aria-hidden>auto_fix_high</span>}
                          Tidy up
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {lintResult.issues.length === 0 && lintResult.suggestions.length === 0 && (
              <p className="text-center text-on-surface-variant py-8">Your notes look healthy.</p>
            )}
          </div>
        ) : view === "conflicts" ? (
          <div className="max-w-3xl mx-auto space-y-4">
            {conflicts.length === 0 ? (
              <p className="text-center text-on-surface-variant py-8">No conflicts detected. 🎉</p>
            ) : conflicts.map((c) => {
              const a = entries.find(e => e.id === c.entry_a);
              const b = entries.find(e => e.id === c.entry_b);
              const isDuplicate = c.kind === "duplicate" || c.kind === "overlap";
              return (
                <div key={c.id} className={`p-5 rounded-xl border-l-4 ${c.status === "open" ? "bg-error-container/20 border-destructive" : "bg-surface-container-high border-outline-variant/30 opacity-70"}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <Badge variant="destructive" className="text-[11px]">{c.kind}</Badge>
                    <Badge variant="secondary" className="text-[11px]">{c.status}</Badge>
                    <span className="ml-auto text-[11px] text-on-surface-variant">{new Date(c.created_at).toLocaleDateString()}</span>
                  </div>

                  {c.rationale && <p className="text-sm text-on-surface-variant mb-3 italic">"{c.rationale}"</p>}

                  {/* Side-by-side comparison; the keep-action lives on the card it keeps. */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                    {[{ entry: a, other: b, id: c.entry_a }, { entry: b, other: a, id: c.entry_b }].map(({ entry, other, id }) => (
                      <div key={id} className="bg-surface-container-high rounded-lg overflow-hidden border border-outline-variant/10 flex flex-col">
                        <div className="px-3 pt-3 pb-2 flex-1">
                          <p className="font-bold text-sm text-foreground leading-snug">{entry?.title || "Note no longer exists"}</p>
                          {entry && (
                            <p className="text-xs text-on-surface-variant mt-1.5 line-clamp-3 leading-relaxed">{entry.content.slice(0, 180)}</p>
                          )}
                        </div>
                        {entry && (
                          <div className="border-t border-outline-variant/10 flex">
                            <button
                              onClick={() => openDetail(entry, "conflicts")}
                              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/5 transition-colors"
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: "12px" }} aria-hidden>open_in_new</span>
                              Open
                            </button>
                            {c.status === "open" && isDuplicate && other && (
                              <button
                                onClick={() => requestKeepEntry(c, entry, other)}
                                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10 border-l border-outline-variant/10 transition-colors"
                                title={`Keep "${entry.title}" and delete "${other.title}"`}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: "12px" }} aria-hidden>check_circle</span>
                                Keep this one
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {c.status === "open" && (
                    <div className="flex gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => handleConflictStatus(c.id, "acknowledged")}>Acknowledge</Button>
                      <Button size="sm" variant="outline" onClick={() => handleConflictStatus(c.id, "resolved")}>Mark Resolved</Button>
                      <Button size="sm" variant="ghost" onClick={() => handleConflictStatus(c.id, "dismissed")}>Dismiss</Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : view === "runs" ? (
          <div className="max-w-3xl mx-auto space-y-3">
            <p className="text-sm text-on-surface-variant">
              Each tidy-up links related notes and writes missing one-line summaries. Undo removes exactly what that tidy-up added.
            </p>
            {sleepRuns.length === 0 ? (
              <p className="text-on-surface-variant text-sm italic py-6">No tidy-ups have changed anything yet.</p>
            ) : sleepRuns.map((run) => (
              <div key={run.id} className="p-4 rounded-xl bg-surface-container-high flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">
                    {[
                      run.edge_ids.length > 0 ? `Linked ${run.edge_ids.length} ${run.edge_ids.length === 1 ? "pair" : "pairs"} of notes` : null,
                      run.hook_entry_ids.length > 0 ? `wrote ${run.hook_entry_ids.length} ${run.hook_entry_ids.length === 1 ? "summary" : "summaries"}` : null,
                    ].filter(Boolean).join(", ")}
                  </p>
                  <p className="text-xs text-on-surface-variant">
                    {new Date(run.created_at).toLocaleString()}
                    {run.wiki_id ? ` · ${wikiNameById[run.wiki_id] || "a notebook"}` : " · all notebooks"}
                  </p>
                </div>
                {run.undone_at ? (
                  <span className="text-xs text-on-surface-variant">Undone</span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void handleUndoRun(run.id)}>Undo</Button>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </main>

      {/* One shared confirmation dialog for every destructive / wide-scope action. */}
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

      {reviewOpen && (
        <DailyRecall
          wikiId={maintenanceTargetId}
          open
          onClose={() => { setReviewOpen(false); refreshDueCount(); void loadData(); }}
          onReviewed={refreshDueCount}
        />
      )}
    </div>
  );
};

export default WikiPanel;
