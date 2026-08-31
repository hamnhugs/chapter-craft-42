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
  EpisodicLogEntry, SleepCycleReport, MemoryMode,
  fetchKnowledgeEntries, fetchKnowledgeEntriesForSet,
  fetchMemoryGraph, fetchMemoryGraphForSet,
  deleteKnowledgeEntry, updateKnowledgeEntry,
  runLint,
  fetchConflicts, fetchConflictsForSet, updateConflictStatus, reindexEmbeddings,
  fetchEpisodicLog, fetchEpisodicLogForSet, getMemoryMode, setMemoryMode, triggerSleepCycle, fetchDueReviews,
  fetchConsolidationQueue, fetchConsolidationQueueForSet, ConsolidationQueueItem,
} from "@/lib/knowledgeApi";
import { Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import GeneratedImage from "@/components/GeneratedImage";
import EntryLocatorPanel from "@/components/EntryLocatorPanel";
import { fetchImagesForEntries, deleteImageAttachment, type ImageAttachmentRow } from "@/lib/imageGen";
import { requestSettingsSection } from "@/lib/settingsNav";
import { useReflexEnabled } from "@/lib/reflex";
import MemoryReview from "@/components/MemoryReview";

type WikiView = "entries" | "detail" | "lint" | "conflicts" | "episodic" | "queue";
type EntriesView = "map" | "list";
// Scope mirrors the app's real model: the loaded neuron set (what Counsel
// reads), optionally focused to one loaded neuron, or "everything ever".
type ScopeKind = "loaded" | "all";

// Lazy: shares the three.js chunk with the Vault/BRAIN graphs; only fetched
// when the mind-map view renders (it's the default entries view).
const EntryNeuronGraph = React.lazy(() => import("@/components/EntryNeuronGraph"));

const ENTRIES_VIEW_KEY = "neuron_entries_view";
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

const QUEUE_REASON_LABELS: Record<ConsolidationQueueItem["reason"], string> = {
  conflict_staged: "Flagged conflict",
  orphan: "Waiting to be connected",
  new_entry: "Waiting to be filed",
};

const VIEW_TITLES: Record<Exclude<WikiView, "entries">, string> = {
  detail: "Entry",
  lint: "Health report",
  conflicts: "Conflicts",
  episodic: "Chat history",
  queue: "Pending tidy-ups",
};

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

const WikiPanel: React.FC = () => {
  const { books, activeWikiId, activeWikiIds, activeWikis, wikis, setActiveTab } = useApp();
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
  const [entryImages, setEntryImages] = useState<ImageAttachmentRow[]>([]);
  const [lintResult, setLintResult] = useState<LintResult | null>(null);
  const [lintLoading, setLintLoading] = useState(false);
  const [conflicts, setConflicts] = useState<KnowledgeConflict[]>([]);
  const [reindexing, setReindexing] = useState(false);
  const [memoryMode, setMemoryModeState] = useState<MemoryMode>("recording");
  const [memoryModeLoading, setMemoryModeLoading] = useState(false);
  const [sleepCycleRunning, setSleepCycleRunning] = useState(false);
  const [sleepCycleReport, setSleepCycleReport] = useState<SleepCycleReport | null>(null);
  const [episodicLog, setEpisodicLog] = useState<EpisodicLogEntry[]>([]);
  const [queueItems, setQueueItems] = useState<ConsolidationQueueItem[]>([]);
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

  // Entries render as a neuron mind map by default; list stays one tap away.
  const [entriesView, setEntriesView] = useState<EntriesView>(() =>
    localStorage.getItem(ENTRIES_VIEW_KEY) === "list" ? "list" : "map",
  );
  useEffect(() => { localStorage.setItem(ENTRIES_VIEW_KEY, entriesView); }, [entriesView]);

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
      ? "all neurons"
      : (focusedWiki?.name || activeWiki?.name || "this neuron");
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
              // "which neuron is this in?" is answerable here too.
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
          `Couldn't load ${entriesRes.failedWikiIds.length} of your loaded neurons — showing the rest.`,
          { id: "neuron-partial-load" },
        );
      }
    } catch (err: any) {
      if (reqId === requestIdRef.current) toast.error(err.message || "Failed to load knowledge base");
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
          description: "You have an entry edit open. Reviewing conflicts now will discard the unsaved changes.",
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

  // Scoped sub-views hold a snapshot fetched at click time; if the loaded set
  // or scope changes underneath them, fall back to entries rather than
  // labeling stale data with the new scope's identity.
  const scopeSignature = `${scopeKind}|${focusId ?? ""}|${loadedKey}`;
  const prevScopeSigRef = useRef(scopeSignature);
  useEffect(() => {
    if (prevScopeSigRef.current === scopeSignature) return;
    prevScopeSigRef.current = scopeSignature;
    setView((v) => (v === "episodic" || v === "queue" ? "entries" : v));
  }, [scopeSignature]);

  const applyMemoryMode = async (next: MemoryMode) => {
    setMemoryModeLoading(true);
    try {
      await setMemoryMode(next);
      modeVersionRef.current += 1; // in-flight loadData snapshots are now stale
      setMemoryModeState(next);
      toast.success(
        next === "recording"
          ? "Memory on — Counsel saves new knowledge as you chat."
          : "Memory paused for all neurons — Counsel can read, but won't save anything new.",
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to switch mode");
    } finally {
      setMemoryModeLoading(false);
    }
  };

  // Pausing is an account-wide mutation, so it gets the same named
  // confirmation as other wide-scope actions; resuming stays one tap.
  const handleToggleMemoryMode = () => {
    if (memoryMode === "recording") {
      setConfirmRequest({
        title: "Pause memory for all neurons?",
        description: `Counsel will stop saving new knowledge from your chats — across every neuron, not just "${activeWiki?.name || "your primary"}". You can resume anytime.`,
        confirmLabel: "Pause saving",
        onConfirm: () => void applyMemoryMode("retrieval"),
      });
    } else {
      void applyMemoryMode("recording");
    }
  };

  const runSleepCycle = async () => {
    setSleepCycleRunning(true);
    setSleepCycleReport(null);
    try {
      const report = await triggerSleepCycle(maintenanceTargetId);
      setSleepCycleReport(report);
      // Say what it actually did across all three real phases: ACT-R re-ranking
      // (strengthen/fade), edge consolidation (connect), and orphan pruning.
      const p = report.phases;
      const bits = [
        p.rerank.updated > 0 ? `refreshed ${p.rerank.updated} ${p.rerank.updated === 1 ? "memory" : "memories"}` : null,
        p.consolidate.edges_created > 0 ? `connected ${p.consolidate.edges_created} ${p.consolidate.edges_created === 1 ? "idea" : "ideas"}` : null,
        p.semanticize && p.semanticize.created > 0 ? `distilled ${p.semanticize.created} ${p.semanticize.created === 1 ? "insight" : "insights"}` : null,
        p.prune.orphans.length > 0 ? `flagged ${p.prune.orphans.length} for review` : null,
      ].filter(Boolean);
      toast.success(
        `Consolidated ${maintenanceTargetName}${bits.length ? " — " + bits.join(", ") : " — nothing new to tidy"}`,
      );
      await loadData();
    } catch (err: any) {
      toast.error(err.message || "Consolidation failed");
    } finally {
      setSleepCycleRunning(false);
    }
  };

  const handleSleepCycle = () => {
    if (maintenanceTargetId === null) {
      setConfirmRequest({
        title: "Consolidate every neuron?",
        description:
          "You're scoped to Everything, so this connects and tidies entries across all your neurons at once. It writes changes and can take a while.",
        confirmLabel: "Consolidate all",
        onConfirm: runSleepCycle,
      });
    } else {
      void runSleepCycle();
    }
  };

  const handleLoadEpisodic = async () => {
    try {
      const log = scopeIds
        ? scopeIds.length === 1
          ? await fetchEpisodicLog(30, scopeIds[0])
          : await fetchEpisodicLogForSet(scopeIds, 30)
        : await fetchEpisodicLog(30, null);
      setEpisodicLog(log);
      setView("episodic");
    } catch (err: any) {
      toast.error(err.message || "Failed to load chat history");
    }
  };

  const handleLoadQueue = async () => {
    try {
      const items = scopeIds
        ? scopeIds.length === 1
          ? await fetchConsolidationQueue(false, scopeIds[0])
          : await fetchConsolidationQueueForSet(scopeIds, false)
        : await fetchConsolidationQueue(false, null);
      setQueueItems(items);
      setView("queue");
    } catch (err: any) {
      toast.error(err.message || "Failed to load pending tidy-ups");
    }
  };

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

  // Reveal the ACT-R vibrancy the memory engine already tracks. The mind map
  // must keep filteredEntries' stable identity (see above), so only the LIST is
  // re-sorted by strength when the user asks.
  const [sortByStrength, setSortByStrength] = useState<null | "fading" | "core">(null);
  const sortedEntries = useMemo(() => {
    if (!sortByStrength) return filteredEntries;
    const dir = sortByStrength === "fading" ? 1 : -1;
    return [...filteredEntries].sort((a, b) => dir * ((a.vibrancy ?? 1) - (b.vibrancy ?? 1)));
  }, [filteredEntries, sortByStrength]);
  const vitality = useMemo(() => {
    let core = 0, fading = 0;
    for (const e of filteredEntries) {
      const v = e.vibrancy ?? 1;
      if (v >= 0.7) core++;
      else if (v < 0.35) fading++;
    }
    return { core, fading };
  }, [filteredEntries]);

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
      toast.success("Entry deleted");
    } catch (err: any) { toast.error(err.message); }
  };

  // Every entry deletion goes through a confirmation that names its target —
  // entries are the user's core asset and deletes here are permanent.
  const requestDeleteEntry = (entry: KnowledgeEntry) => {
    setConfirmRequest({
      title: `Delete "${entry.title}"?`,
      description: "This entry will be permanently removed from your neuron. This can't be undone.",
      confirmLabel: "Delete entry",
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
      await updateKnowledgeEntry(selectedEntry.id, { title: editTitle, content: editContent, tags });
      setEntries((prev) => prev.map((e) => e.id === selectedEntry.id ? { ...e, title: editTitle, content: editContent, tags } : e));
      setSelectedEntry((prev) => prev ? { ...prev, title: editTitle, content: editContent, tags } : null);
      setEditing(false);
      toast.success("Entry updated");
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
        title: "Check every neuron?",
        description: "You're scoped to Everything, so this scans all your neurons at once and can take a while.",
        confirmLabel: "Run check",
        onConfirm: runHealthCheck,
      });
    } else {
      void runHealthCheck();
    }
  };

  const runReindex = async () => {
    setReindexing(true);
    try {
      const res = await reindexEmbeddings(true, maintenanceTargetId);
      if (!res || res.total === 0) {
        toast.success("Search is already up to date.");
      } else if (res.updated === 0 && res.failed > 0) {
        toast.error(`Couldn't rebuild search — the embedding service is unavailable (${res.failed} entries).`);
      } else if (res.failed > 0) {
        toast.warning(`Search rebuilt for ${res.updated} of ${res.total} entries · ${res.failed} failed.`);
      } else {
        toast.success(`Search rebuilt — ${res.updated} of ${res.total} entries refreshed.`);
      }
    } catch (err: any) { toast.error(err.message || "Search rebuild failed"); }
    finally { setReindexing(false); }
  };

  const handleReindex = () => {
    if (maintenanceTargetId === null) {
      setConfirmRequest({
        title: "Rebuild search for every neuron?",
        description: "You're scoped to Everything, so this refreshes search embeddings across all your neurons and can take a while.",
        confirmLabel: "Rebuild all",
        onConfirm: runReindex,
      });
    } else {
      void runReindex();
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
      toast.success("Conflict resolved — entry deleted");
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

  // Spaced retrieval-practice: how many memories are due for review right now.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dueCount, setDueCount] = useState(0);
  const refreshDueCount = useCallback(() => {
    fetchDueReviews(maintenanceTargetId, 50).then((r) => setDueCount(r.length)).catch(() => setDueCount(0));
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
    ? "All neurons"
    : (focusedWiki?.name || activeWiki?.name || "Knowledge Neuron");
  const titleColor = scopeKind === "all" ? null : (focusedWiki?.cover_color || activeWiki?.cover_color || "#7C3AED");
  // Scoped to the neuron being displayed — a focused neuron with no
  // description must not borrow the primary's.
  const description = scopeKind === "all"
    ? null
    : ((focusId ? focusedWiki?.description : activeWiki?.description)?.trim() || null);
  const primaryName = activeWiki?.name || "your neuron";
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
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
              {newThisWeek > 0 && (
                <span className="text-primary font-semibold"> · +{newThisWeek} this week</span>
              )}
              {scopeKind === "loaded" && loadedWikis.length > 1 && !focusId && (
                <span> · across {loadedWikis.length} loaded neurons</span>
              )}
            </p>
            {description && view === "entries" && (
              <p className="text-sm text-on-surface-variant/80 truncate max-w-[65ch]">{description}</p>
            )}
          </div>

          {view === "entries" && (
            <div className="flex items-center md:justify-end gap-2 flex-wrap">
              {/* Health — informational status, the tab's one accent-colored control. */}
              <button
                onClick={handleHealthCheck}
                disabled={lintLoading || targetEntryCount === 0}
                title={`Knowledge health — ${maintenanceTargetName}. Click to run a fresh check.`}
                className="flex items-center gap-2 pl-1.5 pr-4 py-1.5 rounded-full bg-primary-container text-on-primary-container text-sm font-bold active:scale-95 transition-transform disabled:opacity-50"
              >
                {lintLoading ? (
                  <Loader2 className="w-6 h-6 animate-spin p-1" aria-hidden />
                ) : healthScore != null ? (
                  <span
                    aria-hidden
                    className="relative inline-flex w-6 h-6 rounded-full items-center justify-center"
                    style={{
                      background: `conic-gradient(${
                        healthTone === "good" ? "hsl(var(--primary))" : healthTone === "warn" ? "#f59e0b" : "hsl(var(--destructive))"
                      } ${healthScore * 3.6}deg, hsl(var(--surface-container-highest)) 0deg)`,
                    }}
                  >
                    <span className="w-[18px] h-[18px] rounded-full bg-surface-container-high" />
                  </span>
                ) : (
                  <span className="material-symbols-outlined text-xl p-0.5" aria-hidden>health_and_safety</span>
                )}
                <span className="truncate max-w-[240px]">
                  {lintLoading
                    ? "Checking…"
                    : healthScore == null
                      ? "Health check"
                      : (healthTone === "good"
                          ? `Healthy · ${healthScore}`
                          : healthTone === "warn"
                            ? `Needs care · ${healthScore}`
                            : `Unwell · ${healthScore}`) +
                        // The score belongs to ONE neuron; say which when the
                        // header stats above show a multi-neuron union.
                        (scopeKind === "loaded" && loadedWikis.length > 1 && !focusId
                          ? ` — ${activeWiki?.name ?? "primary"}`
                          : "")}
                </span>
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

              {/* Everything rare lives in one plain-language care menu. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Neuron care menu"
                    title="Neuron care"
                    className="p-2 rounded-full bg-surface-container-high hover:bg-surface-container-highest transition-colors"
                  >
                    <span className="material-symbols-outlined block" aria-hidden>more_horiz</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel className="text-xs text-on-surface-variant font-normal">
                    Care · {maintenanceTargetName}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleSleepCycle} disabled={sleepCycleRunning || targetEntryCount === 0}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>bedtime</span>
                    <span className="flex flex-col">
                      <span>Consolidate knowledge</span>
                      <span className="text-xs text-on-surface-variant">Connect &amp; tidy entries (Sleep Cycle — auto-runs daily while you use the app)</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setReviewOpen(true)}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>fitness_center</span>
                    <span className="flex flex-col">
                      <span>Review memories{dueCount > 0 ? ` (${dueCount})` : ""}</span>
                      <span className="text-xs text-on-surface-variant">Active recall for memories starting to fade (spaced practice)</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleReindex} disabled={reindexing || (scopeKind === "loaded" && !maintenanceTargetId)}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>memory</span>
                    <span className="flex flex-col">
                      <span>Rebuild search</span>
                      <span className="text-xs text-on-surface-variant">Refresh the index behind semantic search</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-on-surface-variant font-normal">Look around</DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleLoadEpisodic}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>history</span>
                    <span className="flex flex-col">
                      <span>Chat history</span>
                      <span className="text-xs text-on-surface-variant">Summaries of what Counsel remembers</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleLoadQueue}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>pending_actions</span>
                    <span className="flex flex-col">
                      <span>Pending tidy-ups</span>
                      <span className="text-xs text-on-surface-variant">Entries waiting for the next consolidation</span>
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
                    Refresh data
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/wiki-controls-guide">
                      <span className="material-symbols-outlined text-base mr-1" aria-hidden>help</span>
                      What do these controls do?
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { requestSettingsSection("memory"); setActiveTab("settings"); }}>
                    <span className="material-symbols-outlined text-base mr-1" aria-hidden>settings</span>
                    Neuron settings
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
                      (i === 0 ? `${w.name} — primary (new knowledge saves here). ` : `${w.name}. `) +
                      (focused ? "Click to show all loaded neurons again." : "Click to focus just this neuron.")
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
                      <span role="img" aria-label="primary" title="Primary — new knowledge saves here" className="text-primary">★</span>
                    )}
                  </button>
                );
              })}
              {scopeKind === "loaded" && (
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent("open-neuron-switcher"))}
                  title="Load another neuron alongside (⌘K)"
                  className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full border border-dashed border-outline-variant/40 text-xs text-on-surface-variant hover:border-primary/50 hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-sm" aria-hidden>add</span>
                  Load
                </button>
              )}
              {scopeKind === "loaded" && loadedWikis.length >= 2 && (
                <button
                  onClick={() => import("@/components/ChainDialog").then((m) => m.openChainDialog({ prefillIds: loadedIds }))}
                  title="Save these neurons as a chain"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-outline-variant/40 text-xs text-on-surface-variant hover:border-primary/50 hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-sm" aria-hidden>link</span>
                  Save chain
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
                  title="Show the neurons Counsel is reading right now"
                  className={`px-3 py-1.5 transition-colors ${scopeKind === "loaded" ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"} disabled:opacity-40`}
                >
                  {loadedWikis.length > 1 ? `Loaded (${loadedWikis.length})` : "This neuron"}
                </button>
                <button
                  type="button"
                  onClick={() => { setScopeKind("all"); setFocusId(null); }}
                  aria-pressed={scopeKind === "all"}
                  title="Every neuron you've ever created, loaded or not"
                  className={`px-3 py-1.5 transition-colors ${scopeKind === "all" ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container-high"}`}
                >
                  Everything
                </button>
              </div>
            </div>

            {/* Memory mode is persistent, glanceable state — never a mystery button. */}
            <button
              onClick={handleToggleMemoryMode}
              disabled={memoryModeLoading}
              aria-pressed={memoryMode === "recording"}
              title={
                memoryMode === "recording"
                  ? `Counsel saves new knowledge to "${primaryName}" as you chat. Applies across all neurons — click to pause.`
                  : "Saving is paused for all neurons. Counsel can still read and answer — click to resume."
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
                ? `Memory on — saving to ${primaryName}`
                : "Memory paused — nothing is being saved"}
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
            {view === "episodic" && (
              <span className="text-xs text-on-surface-variant">
                {episodicLog.length} {episodicLog.length === 1 ? "session" : "sessions"}
              </span>
            )}
            {view === "queue" && <span className="text-xs text-on-surface-variant">{queueItems.length} waiting</span>}
            {/* The paused state must never be invisible, even mid-triage. */}
            {memoryMode !== "recording" && (
              <span className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-500 text-[11px] font-medium">
                <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                Memory paused
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
                aria-label="Search entries"
                className="w-full bg-surface-container-low border-none rounded-2xl py-3.5 pl-12 pr-6 focus:ring-1 focus:ring-primary/40 placeholder:text-on-surface-variant/50 text-foreground text-base transition-all shadow-inner"
                placeholder="Search concepts, entities, or relations…"
              />
            </div>

            {/* Filter pills + map/list view toggle */}
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1 min-w-0">
                <div className="flex items-center gap-2 overflow-x-auto pb-1 hide-scrollbar" role="group" aria-label="Filter by entry type">
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
                aria-label="Entries view"
                className="flex items-center gap-1 rounded-full border border-outline-variant/20 bg-surface-container-low p-1 shrink-0 self-start"
                onMouseEnter={() => { void import("@/components/EntryNeuronGraph"); }}
              >
                {([
                  ["map", "hub", "Mind map"],
                  ["list", "view_list", "List"],
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

            {/* Entries — neuron mind map (default) or card list */}
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
                <span className="material-symbols-outlined text-5xl" aria-hidden>menu_book</span>
                <p className="text-sm text-center">
                  {entries.length === 0
                    ? scopeKind === "all"
                      ? "No entries in any neuron yet. Chat about your books to start growing them."
                      : loadedWikis.length > 1 && !focusId
                        ? "These neurons are empty. Chat about your books to grow them."
                        : "This neuron is empty. Chat about your books to grow it."
                    : "No entries match your search."}
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
                {(vitality.core > 0 || vitality.fading > 0) && (
                  <div className="flex items-center gap-2 text-[11px] text-on-surface-variant mb-1 flex-wrap">
                    <span className="inline-flex items-center gap-1" title="Memory strength (ACT-R vibrancy): recalling a memory makes it vivid; unused ones gently fade over weeks.">
                      <span className="material-symbols-outlined text-[13px]" aria-hidden>bolt</span>
                      Memory vitality
                    </span>
                    {vitality.core > 0 && (
                      <button
                        onClick={() => setSortByStrength((s) => (s === "core" ? null : "core"))}
                        aria-pressed={sortByStrength === "core"}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full transition-colors ${sortByStrength === "core" ? "bg-primary/15 text-primary" : "hover:bg-surface-container-high"}`}
                      >
                        <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-primary" />
                        {vitality.core} core
                      </button>
                    )}
                    {vitality.fading > 0 && (
                      <button
                        onClick={() => setSortByStrength((s) => (s === "fading" ? null : "fading"))}
                        aria-pressed={sortByStrength === "fading"}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full transition-colors ${sortByStrength === "fading" ? "bg-primary/15 text-primary" : "hover:bg-surface-container-high"}`}
                      >
                        <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-primary/40" />
                        {vitality.fading} fading
                      </button>
                    )}
                    {sortByStrength && (
                      <button onClick={() => setSortByStrength(null)} className="text-primary hover:underline">clear</button>
                    )}
                  </div>
                )}
                {sortedEntries.map((entry) => {
                  const relCount = graph.filter(g => g.source_entry_id === entry.id || g.target_entry_id === entry.id).length;
                  const sourceWiki = neuronNameByEntry?.[entry.id];
                  const sourceColor = sourceWiki ? wikis.find((w) => w.id === wikiByEntry[entry.id])?.cover_color : null;
                  const inConflict = reflexOn && conflictEntryIds.has(entry.id);
                  return (
                    <button
                      key={entry.id} onClick={() => openDetail(entry)}
                      className={`group w-full text-left rounded-xl p-6 hover:shadow-2xl transition-all duration-300 border-l-4 bg-surface-container-high ${inConflict ? "border-amber-500/60 hover:border-amber-500" : "border-transparent hover:border-primary-container"}`}
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap text-[11px] font-semibold text-on-surface-variant">
                            <span className="capitalize text-primary">{entry.entry_type}</span>
                            <span aria-hidden className="text-outline-variant">·</span>
                            <span>{Math.round(entry.confidence * 100)}% confidence</span>
                            {typeof entry.vibrancy === "number" && entry.vibrancy < 0.999 && (
                              <>
                                <span aria-hidden className="text-outline-variant">·</span>
                                <span
                                  className="inline-flex items-center gap-1"
                                  title={`Memory strength ${Math.round(entry.vibrancy * 100)}% — ${entry.vibrancy >= 0.7 ? "core: anchors related memories" : entry.vibrancy < 0.35 ? "fading: rarely recalled lately" : "active"}. Recalling it makes it more vivid; unused memories gently fade.`}
                                >
                                  <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-primary" style={{ opacity: 0.2 + 0.8 * entry.vibrancy }} />
                                  {entry.vibrancy < 0.35
                                    ? <span className="text-on-surface-variant/70">fading</span>
                                    : entry.vibrancy >= 0.7 ? "core" : null}
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

                      <p className="text-on-surface-variant mb-3 line-clamp-2 leading-relaxed text-sm">{entry.content.slice(0, 200)}</p>
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
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} aria-label="Entry title" className="text-2xl font-headline font-bold bg-surface-container-high border-none" />
                <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={10} aria-label="Entry content" className="text-sm font-mono bg-surface-container-high border-none" />
                <Input value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="tag1, tag2, tag3" aria-label="Entry tags" className="text-sm bg-surface-container-high border-none" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-2 text-[11px] font-semibold text-on-surface-variant">
                      <span className="capitalize text-primary">{selectedEntry.entry_type}</span>
                      <span aria-hidden className="text-outline-variant">·</span>
                      <span>{Math.round(selectedEntry.confidence * 100)}% confidence</span>
                    </div>
                    <h2 className="font-headline font-bold text-3xl md:text-4xl text-foreground">{selectedEntry.title}</h2>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={startEdit} aria-label="Edit entry" className="p-2 hover:bg-surface-container-high rounded-lg transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>edit</span>
                    </button>
                    <button onClick={() => requestDeleteEntry(selectedEntry)} aria-label="Delete entry" className="p-2 hover:bg-error-container/20 rounded-lg transition-colors">
                      <span className="material-symbols-outlined text-destructive" aria-hidden>delete</span>
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
                      <h3 className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-4">Connected Knowledge</h3>
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
                <div className="text-xs text-on-surface-variant/60 border-t border-outline-variant/10 pt-4">
                  {(() => {
                    const book = selectedEntry.source_book_id ? books.find(b => b.id === selectedEntry.source_book_id) : null;
                    const when = new Date(selectedEntry.created_at).toLocaleDateString();
                    return book
                      ? `Remembered from "${book.title}" on ${when}`
                      : `Remembered from a chat on ${when}`;
                  })()}
                  {" · "}Updated {new Date(selectedEntry.updated_at).toLocaleDateString()}
                </div>
              </>
            )}
          </div>
        ) : view === "lint" && lintResult ? (
          <div className="max-w-3xl mx-auto space-y-6">
            {/* Health score */}
            <div className="bg-surface-container-high rounded-xl p-8 text-center relative overflow-hidden">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/5 rounded-full blur-2xl" aria-hidden />
              <div className="text-5xl font-bold font-headline text-primary mb-2">{lintResult.health_score}/100</div>
              <p className="text-on-surface-variant">Knowledge health · {lintTarget?.name || maintenanceTargetName}</p>
              {lintTarget && lintTarget.id !== maintenanceTargetId && (
                <p className="text-xs text-amber-500 mt-1">
                  This report is for {lintTarget.name} — you're now viewing a different scope. Re-run for fresh results.
                </p>
              )}
              <div className="w-full max-w-xs mx-auto h-3 bg-surface-container-highest rounded-full mt-4 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-primary-fixed-dim rounded-full" style={{ width: `${lintResult.health_score}%` }} />
              </div>
              <div className="flex justify-center gap-6 mt-4 text-xs text-on-surface-variant">
                <span>{lintResult.stats.total_entries} entries</span>
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
                                {sleepCycleRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden /> : <span className="material-symbols-outlined text-sm mr-1" aria-hidden>bedtime</span>}
                                Fix: consolidate
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
                          {sleepCycleRunning ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <span className="material-symbols-outlined text-sm" aria-hidden>bedtime</span>}
                          Consolidate
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {lintResult.issues.length === 0 && lintResult.suggestions.length === 0 && (
              <p className="text-center text-on-surface-variant py-8">Your knowledge base looks healthy! 🎉</p>
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
                          <p className="font-bold text-sm text-foreground leading-snug">{entry?.title || "Entry no longer exists"}</p>
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
        ) : view === "episodic" ? (
          <div className="space-y-4">
            {episodicLog.length === 0 ? (
              <p className="text-on-surface-variant text-sm italic">No chat sessions recorded yet. Save a chat to your neuron to start the history.</p>
            ) : episodicLog.map((ep) => (
              <div key={ep.id} className="p-4 rounded-xl bg-surface-container-high">
                <div className="flex items-center gap-3 mb-2 text-xs text-on-surface-variant">
                  <span>{new Date(ep.created_at).toLocaleString()}</span>
                  <span className="ml-auto">{ep.entry_count} {ep.entry_count === 1 ? "entry" : "entries"} saved</span>
                </div>
                {ep.summary && <p className="text-sm text-foreground mb-2">{ep.summary}</p>}
                {ep.key_facts.length > 0 && (
                  <ul className="text-xs text-on-surface-variant space-y-0.5 list-disc list-inside">
                    {ep.key_facts.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>

        ) : view === "queue" ? (
          <div className="space-y-4">
            {sleepCycleReport && (
              <div className="p-4 rounded-xl bg-secondary-container/20 border border-secondary-container/30 text-sm space-y-1">
                <p className="font-semibold text-foreground">Last consolidation</p>
                <p className="text-on-surface-variant">
                  Connected {sleepCycleReport.phases.consolidate.edges_created} ideas · refreshed {sleepCycleReport.phases.rerank.updated} memories ·
                  {" "}{sleepCycleReport.phases.prune.orphans.length} entries queued for review
                </p>
              </div>
            )}
            {queueItems.length === 0 ? (
              <p className="text-on-surface-variant text-sm italic">Nothing waiting. New entries and flagged conflicts will queue here for the next consolidation.</p>
            ) : queueItems.map((item) => {
              const entryTitle =
                (item.entry_id && entries.find((e) => e.id === item.entry_id)?.title) ||
                ((item.pending_data as any)?.title as string | undefined) ||
                "New entry";
              return (
                <div key={item.id} className="p-4 rounded-xl bg-surface-container-high flex items-start gap-4">
                  <span className={`mt-0.5 text-[11px] font-semibold px-2 py-1 rounded-full whitespace-nowrap ${
                    item.reason === "conflict_staged" ? "bg-destructive/15 text-destructive"
                    : item.reason === "orphan" ? "bg-amber-500/15 text-amber-500"
                    : "bg-secondary-container/40 text-on-secondary-container"
                  }`}>
                    {QUEUE_REASON_LABELS[item.reason] || item.reason.replace("_", " ")}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{entryTitle}</p>
                    <p className="text-xs text-on-surface-variant">{new Date(item.created_at).toLocaleString()}</p>
                  </div>
                  <span className={`text-[11px] font-semibold ${item.processed_at ? "text-green-400" : "text-on-surface-variant"}`}>
                    {item.processed_at ? "done" : "waiting"}
                  </span>
                </div>
              );
            })}
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
        <MemoryReview
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
