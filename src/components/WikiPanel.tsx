import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import ReactMarkdown from "react-markdown";
import {
  KnowledgeEntry, MemoryGraphEdge, LintResult, KnowledgeConflict,
  EpisodicLogEntry, SleepCycleReport, MemoryMode,
  fetchKnowledgeEntries, fetchMemoryGraph,
  deleteKnowledgeEntry, updateKnowledgeEntry,
  runLint, ingestBook,
  fetchConflicts, updateConflictStatus, reindexEmbeddings,
  fetchEpisodicLog, getMemoryMode, setMemoryMode, triggerSleepCycle,
  fetchConsolidationQueue, ConsolidationQueueItem,
} from "@/lib/knowledgeApi";
import { Loader2, HelpCircle, ArrowRight } from "lucide-react";
import GeneratedImage from "@/components/GeneratedImage";
import { fetchImagesForEntries, deleteImageAttachment, type ImageAttachmentRow } from "@/lib/imageGen";
import { Link } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useChatSettings } from "@/hooks/useChatSettings";

type WikiView = "entries" | "detail" | "lint" | "conflicts" | "episodic" | "queue";

const WikiPanel: React.FC = () => {
  const { books, activeBookId, activeWikiId, wikis, setActiveWiki } = useApp();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
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
  const [ingestLoading, setIngestLoading] = useState(false);
  const [conflicts, setConflicts] = useState<KnowledgeConflict[]>([]);
  const [reindexing, setReindexing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryMode, setMemoryModeState] = useState<MemoryMode>("recording");
  const [memoryModeLoading, setMemoryModeLoading] = useState(false);
  const [sleepCycleRunning, setSleepCycleRunning] = useState(false);
  const [sleepCycleReport, setSleepCycleReport] = useState<SleepCycleReport | null>(null);
  const [episodicLog, setEpisodicLog] = useState<EpisodicLogEntry[]>([]);
  const [queueItems, setQueueItems] = useState<ConsolidationQueueItem[]>([]);
  // Scope toggle: when "wiki", every panel / action is bound to the active wiki.
  // When "all", we keep the legacy global view (cross-wiki graph, conflicts, etc.).
  const [scope, setScope] = useState<"wiki" | "all">("wiki");
  const { savedModels, wikiModel, setWikiModel, apiKey: openrouterKey } = useChatSettings();

  const activeWiki = wikis.find((w) => w.id === activeWikiId) || null;
  // The id we pass to scoped APIs. Null means "all wikis" / global.
  const scopeWikiId: string | null = scope === "wiki" ? activeWikiId : null;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [e, g, c, mode] = await Promise.all([
        fetchKnowledgeEntries(scopeWikiId),
        fetchMemoryGraph(scopeWikiId),
        fetchConflicts(undefined, scopeWikiId).catch(() => []),
        getMemoryMode().catch(() => "recording" as MemoryMode),
      ]);
      setEntries(e);
      setGraph(g);
      setConflicts(c);
      setMemoryModeState(mode);
    } catch (err: any) {
      toast.error(err.message || "Failed to load knowledge base");
    } finally {
      setLoading(false);
    }
  }, [scopeWikiId]);

  useEffect(() => { loadData(); }, [loadData]);

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

  const handleDeleteImage = async (img: ImageAttachmentRow) => {
    if (!confirm("Delete this image? This can't be undone.")) return;
    try {
      await deleteImageAttachment(img);
      setEntryImages((prev) => prev.filter((i) => i.id !== img.id));
      toast.success("Image deleted");
    } catch (err: any) {
      toast.error(err.message || "Failed to delete image");
    }
  };

  // Human-in-the-loop: respond to "Review" clicks from the global ConflictNotifier
  useEffect(() => {
    const handler = () => {
      setView("conflicts");
      loadData();
    };
    window.addEventListener("open-conflicts", handler);
    return () => window.removeEventListener("open-conflicts", handler);
  }, [loadData]);

  const handleToggleMemoryMode = async () => {
    const next: MemoryMode = memoryMode === "recording" ? "retrieval" : "recording";
    setMemoryModeLoading(true);
    try {
      await setMemoryMode(next);
      setMemoryModeState(next);
      toast.success(next === "recording" ? "Recording Mode: writes enabled" : "Retrieval Mode: writes disabled");
    } catch (err: any) {
      toast.error(err.message || "Failed to switch mode");
    } finally {
      setMemoryModeLoading(false);
    }
  };

  const handleSleepCycle = async () => {
    setSleepCycleRunning(true);
    setSleepCycleReport(null);
    try {
      const report = await triggerSleepCycle(scopeWikiId);
      setSleepCycleReport(report);
      toast.success(`Sleep Cycle complete — ${report.phases.consolidate.edges_created} edges created, ${report.phases.prune.orphans.length} orphans queued`);
      await loadData();
    } catch (err: any) {
      toast.error(err.message || "Sleep Cycle failed");
    } finally {
      setSleepCycleRunning(false);
    }
  };

  const handleLoadEpisodic = async () => {
    try {
      const log = await fetchEpisodicLog(30, scopeWikiId);
      setEpisodicLog(log);
      setView("episodic");
    } catch (err: any) {
      toast.error(err.message || "Failed to load episodic log");
    }
  };

  const handleLoadQueue = async () => {
    try {
      const items = await fetchConsolidationQueue(false, scopeWikiId);
      setQueueItems(items);
      setView("queue");
    } catch (err: any) {
      toast.error(err.message || "Failed to load consolidation queue");
    }
  };

  const filteredEntries = entries.filter((e) => {
    if (filterType !== "all" && e.entry_type !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

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

  const handleLint = async () => {
    setLintLoading(true);
    try { const result = await runLint(scopeWikiId); setLintResult(result); setView("lint"); }
    catch (err: any) { toast.error(err.message); }
    finally { setLintLoading(false); }
  };

  const handleIngest = async (bookId: string) => {
    setIngestLoading(true);
    try {
      const result = await ingestBook(bookId, activeWikiId);
      toast.success(`Extracted ${result.entries_created} entries${result.splits ? `, split ${result.splits}` : ""}${result.conflicts ? `, ${result.conflicts} conflict(s) flagged` : ""}`);
      loadData();
    }
    catch (err: any) { toast.error(err.message); }
    finally { setIngestLoading(false); }
  };

  const handleReindex = async () => {
    setReindexing(true);
    try {
      const res = await reindexEmbeddings(true, scopeWikiId);
      if (!res || res.total === 0) {
        toast.success("All entries already have embeddings.");
      } else if (res.updated === 0 && res.failed > 0) {
        toast.error(`Reindex failed — embedding service unavailable (${res.failed} entries).`);
      } else if (res.failed > 0) {
        toast.warning(`Embedded ${res.updated}/${res.total} entries · ${res.failed} failed.`);
      } else {
        toast.success(`Embedded ${res.updated}/${res.total} entries.`);
      }
    } catch (err: any) { toast.error(err.message || "Reindex failed"); }
    finally { setReindexing(false); }
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

  const openConflicts = () => setView("conflicts");
  const openConflictsCount = conflicts.filter(c => c.status === "open").length;

  const openDetail = (entry: KnowledgeEntry) => { setSelectedEntry(entry); setView("detail"); setEditing(false); };
  const startEdit = () => {
    if (!selectedEntry) return;
    setEditTitle(selectedEntry.title);
    setEditContent(selectedEntry.content);
    setEditTags(selectedEntry.tags.join(", "));
    setEditing(true);
  };

  const entryTypes = ["all", "concept", "entity", "synthesis", "fact", "comparison", "summary"];

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-7xl mx-auto px-6 py-12 pb-32 w-full">
        {/* Header */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
                {scope === "wiki" ? "ACTIVE NEURON" : "ALL NEURONS"}
              </span>
              <span className="text-on-surface-variant text-sm font-medium">
                {entries.length} entries{scope === "wiki" && activeWiki ? " in scope" : " indexed"}
              </span>
              {/* Scope toggle: "This wiki" vs "All wikis" */}
              <div className="inline-flex items-center rounded-full border border-outline-variant/30 bg-surface-container-low overflow-hidden text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setScope("wiki")}
                  disabled={!activeWikiId}
                  className={`px-3 py-1 transition-colors ${scope === "wiki" ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant hover:bg-surface-container-high"} disabled:opacity-40`}
                  title="Show only data from the currently loaded wiki"
                >
                  This Neuron
                </button>
                <button
                  type="button"
                  onClick={() => setScope("all")}
                  className={`px-3 py-1 transition-colors ${scope === "all" ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant hover:bg-surface-container-high"}`}
                  title="Show everything across all your wikis"
                >
                  All Neurons
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {activeWiki && (
                <span
                  aria-hidden
                  className="inline-block w-3.5 h-3.5 rounded-full border border-outline-variant/30 shrink-0"
                  style={{ backgroundColor: activeWiki.cover_color || "#7C3AED" }}
                />
              )}
              <h2 className="font-headline font-bold text-5xl md:text-6xl text-primary tracking-tight truncate">
                {scope === "all" ? "Knowledge Wiki" : (activeWiki?.name || "Knowledge Wiki")}
              </h2>
              {/* In-tab wiki switcher */}
              {wikis.length > 1 && (
                <Select
                  value={activeWikiId || ""}
                  onValueChange={async (v) => {
                    if (!v || v === activeWikiId) return;
                    try {
                      await setActiveWiki(v);
                      toast.success("Wiki loaded");
                    } catch (err: any) {
                      toast.error(err.message || "Failed to switch wiki");
                    }
                  }}
                >
                  <SelectTrigger className="w-[200px] h-9 text-xs">
                    <SelectValue placeholder="Switch wiki…" />
                  </SelectTrigger>
                  <SelectContent>
                    {wikis.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <p className="text-on-surface-variant max-w-xl text-lg italic font-headline">
              {scope === "all"
                ? `"The sum of all acquired insights, meticulously categorized."`
                : (activeWiki?.description?.trim() || `"The sum of all acquired insights, meticulously categorized."`)}
            </p>
            <Link
              to="/wiki-controls-guide"
              className="group inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/30 text-sm font-body font-semibold text-accent hover:bg-accent/20 hover:scale-105 transition-all motion-safe:animate-pulse-glow"
            >
              <HelpCircle className="w-4 h-4 motion-safe:animate-icon-wiggle" />
              What do these controls do?
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
          <div className="flex gap-3 flex-wrap">
            {view !== "entries" && (
              <button onClick={() => { setView("entries"); setSelectedEntry(null); }} className="flex items-center gap-2 px-4 py-3 bg-surface-container-high text-foreground rounded-xl text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
                <span className="material-symbols-outlined text-sm">arrow_back</span> Back
              </button>
            )}
            <button onClick={openConflicts} disabled={conflicts.length === 0} className="relative flex items-center gap-2 px-4 py-3 bg-surface-container-high text-foreground rounded-xl text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all disabled:opacity-50">
              <span className="material-symbols-outlined text-sm">report</span>
              Conflicts
              {openConflictsCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">{openConflictsCount}</span>
              )}
            </button>
            {/* Memory Mode toggle */}
            <button
              onClick={handleToggleMemoryMode}
              disabled={memoryModeLoading}
              title={memoryMode === "recording" ? "Switch to Retrieval Mode (disables writes)" : "Switch to Recording Mode (enables writes)"}
              className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm border font-semibold transition-all disabled:opacity-50 ${
                memoryMode === "recording"
                  ? "bg-primary-container text-on-primary-container border-primary-container/30"
                  : "bg-surface-container-highest text-on-surface-variant border-outline-variant/20"
              }`}
            >
              {memoryModeLoading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <span className="material-symbols-outlined text-sm">{memoryMode === "recording" ? "edit" : "visibility"}</span>
              }
              {memoryMode === "recording" ? "Recording" : "Retrieval"}
            </button>
            {/* Sleep Cycle */}
            <button
              onClick={handleSleepCycle}
              disabled={sleepCycleRunning || entries.length === 0}
              title="Run Sleep Cycle: re-rank vibrancy, consolidate edges, prune orphans"
              className="flex items-center gap-2 px-4 py-3 bg-secondary-container text-on-secondary-container rounded-xl text-sm border border-outline-variant/10 hover:bg-secondary-container/80 transition-all disabled:opacity-50"
            >
              {sleepCycleRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="material-symbols-outlined text-sm">bedtime</span>}
              Sleep Cycle
            </button>
            {/* Episodic Log + Queue */}
            <button onClick={handleLoadEpisodic} className="flex items-center gap-2 px-4 py-3 bg-surface-container-high text-foreground rounded-xl text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
              <span className="material-symbols-outlined text-sm">history</span> Episodes
            </button>
            <button onClick={handleLoadQueue} className="flex items-center gap-2 px-4 py-3 bg-surface-container-high text-foreground rounded-xl text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
              <span className="material-symbols-outlined text-sm">pending_actions</span> Queue
            </button>
            <button onClick={handleReindex} disabled={reindexing} className="flex items-center gap-2 px-4 py-3 bg-surface-container-high text-foreground rounded-xl text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all disabled:opacity-50">
              {reindexing ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="material-symbols-outlined text-sm">memory</span>}
              Reindex
            </button>
            <button onClick={handleLint} disabled={lintLoading || entries.length === 0} className="flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-bold active:scale-95 transition-transform shadow-lg disabled:opacity-50">
              {lintLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="material-symbols-outlined text-xl">health_and_safety</span>}
              <span>Health Check</span>
            </button>
            <button onClick={loadData} disabled={loading} className="p-3 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
              <span className={`material-symbols-outlined ${loading ? "animate-spin" : ""}`}>refresh</span>
            </button>
            <button onClick={() => setSettingsOpen(true)} className="p-3 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-container-highest transition-all" title="Wiki settings">
              <span className="material-symbols-outlined">settings</span>
            </button>
          </div>
        </section>

        <div className="mb-6 -mt-6 text-xs text-on-surface-variant">
          Wiki model: <span className="font-mono text-foreground">{wikiModel || "Default (Gemini Flash)"}</span>
        </div>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Wiki Settings</DialogTitle>
              <DialogDescription>
                Choose which model powers wiki ingest, extract, and health checks.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Model</label>
                <Select
                  value={wikiModel || "__default__"}
                  onValueChange={(v) => setWikiModel(v === "__default__" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Default (Gemini Flash)</SelectItem>
                    {savedModels.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-on-surface-variant">
                  Models come from your saved list in Chat Settings. Custom models use OpenRouter and require your API key there.
                </p>
                {wikiModel && !openrouterKey && (
                  <p className="text-xs text-destructive">
                    No OpenRouter API key found. Add one in Chat Settings, or wiki ops will fall back to the default model.
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setSettingsOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
          </div>
        ) : view === "entries" ? (
          <>
            {/* Search */}
            <div className="mb-8 relative">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
              <input
                value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-surface-container-low border-none rounded-xl py-5 pl-14 pr-6 focus:ring-1 focus:ring-primary/40 placeholder:text-on-surface-variant/50 text-foreground text-lg transition-all shadow-inner"
                placeholder="Search concepts, entities, or relations..."
              />
            </div>

            {/* Filter pills */}
            <div className="flex items-center gap-3 mb-6 overflow-x-auto pb-2 hide-scrollbar">
              {entryTypes.map((type) => (
                <button
                  key={type}
                  onClick={() => setFilterType(type)}
                  className={`px-4 py-2 rounded-full text-xs font-bold transition-colors capitalize ${
                    filterType === type
                      ? "bg-secondary-container text-on-secondary-container ring-1 ring-primary/20"
                      : "hover:bg-surface-container-high text-on-surface-variant"
                  }`}
                >
                  {type === "all" ? "All Entries" : type}
                </button>
              ))}
            </div>

            {/* Book ingest */}
            {books.filter(b => b.chapters.length > 0).length > 0 && (
              <div className="bg-surface-container-low rounded-xl p-4 mb-6 border border-outline-variant/5">
                <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-3">Ingest Book Knowledge</p>
                <div className="flex gap-2 flex-wrap">
                  {books.filter(b => b.chapters.length > 0).map((book) => (
                    <button key={book.id} onClick={() => handleIngest(book.id)} disabled={ingestLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-sm text-foreground border border-outline-variant/10 hover:bg-surface-container-highest transition-all disabled:opacity-50">
                      {ingestLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="material-symbols-outlined text-sm">bolt</span>}
                      {book.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Entry cards */}
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
                <span className="material-symbols-outlined text-5xl">menu_book</span>
                <p className="text-sm text-center">
                  {entries.length === 0 ? "Your wiki is empty. Chat about your books or ingest chapters." : "No entries match your search."}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredEntries.map((entry) => {
                  const relCount = graph.filter(g => g.source_entry_id === entry.id || g.target_entry_id === entry.id).length;
                  return (
                    <button
                      key={entry.id} onClick={() => openDetail(entry)}
                      className="group w-full text-left bg-surface-container-high rounded-xl p-8 hover:shadow-2xl transition-all duration-300 border-l-2 border-transparent hover:border-primary-container"
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[10px] font-bold uppercase text-primary tracking-widest">Type: {entry.entry_type}</span>
                            <span className="text-outline-variant">•</span>
                            <span className="text-[10px] font-bold uppercase text-secondary tracking-widest">Confidence: {Math.round(entry.confidence * 100)}%</span>
                            {relCount > 0 && (
                              <>
                                <span className="text-outline-variant">•</span>
                                <span className="text-[10px] font-bold uppercase text-on-surface-variant tracking-widest">{relCount} links</span>
                              </>
                            )}
                          </div>
                          <h4 className="font-headline font-bold text-2xl md:text-3xl text-foreground group-hover:text-primary transition-colors">{entry.title}</h4>
                        </div>
                        <span className="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">chevron_right</span>
                      </div>
                      <p className="text-on-surface-variant mb-4 line-clamp-2 leading-relaxed">{entry.content.slice(0, 200)}</p>
                      <div className="flex flex-wrap gap-2">
                        {entry.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="bg-surface-container-highest px-3 py-1 rounded text-[10px] font-bold text-secondary uppercase tracking-wider">{tag}</span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : view === "detail" && selectedEntry ? (
          <div className="max-w-3xl mx-auto space-y-6">
            {editing ? (
              <>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="text-2xl font-headline font-bold bg-surface-container-high border-none" />
                <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={10} className="text-sm font-mono bg-surface-container-high border-none" />
                <Input value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="tag1, tag2, tag3" className="text-sm bg-surface-container-high border-none" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveEdit}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-[10px] font-bold uppercase text-primary tracking-widest">Type: {selectedEntry.entry_type}</span>
                      <span className="text-outline-variant">•</span>
                      <span className="text-[10px] font-bold uppercase text-secondary tracking-widest">{Math.round(selectedEntry.confidence * 100)}% confidence</span>
                    </div>
                    <h2 className="font-headline font-bold text-4xl text-foreground">{selectedEntry.title}</h2>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={startEdit} className="p-2 hover:bg-surface-container-high rounded-lg transition-colors">
                      <span className="material-symbols-outlined text-on-surface-variant">edit</span>
                    </button>
                    <button onClick={() => handleDelete(selectedEntry.id)} className="p-2 hover:bg-error-container/20 rounded-lg transition-colors">
                      <span className="material-symbols-outlined text-destructive">delete</span>
                    </button>
                  </div>
                </div>
                <div className="prose prose-lg prose-invert max-w-none"><ReactMarkdown>{selectedEntry.content}</ReactMarkdown></div>
                {entryImages.length > 0 && (
                  <div className="border-t border-outline-variant/10 pt-6">
                    <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant mb-4">Attached Images</h3>
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
                            <span className="material-symbols-outlined text-destructive text-base">delete</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedEntry.tags.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {selectedEntry.tags.map((tag) => (
                      <span key={tag} className="bg-surface-container-highest px-3 py-1 rounded text-[10px] font-bold text-secondary uppercase tracking-wider">{tag}</span>
                    ))}
                  </div>
                )}
                {(() => {
                  const related = getRelatedEntries(selectedEntry.id);
                  if (related.length === 0) return null;
                  return (
                    <div className="border-t border-outline-variant/10 pt-6">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant mb-4">Connected Knowledge</h3>
                      <div className="space-y-2">
                        {related.map(({ entry, relationship }) => (
                          <button key={entry.id} onClick={() => openDetail(entry)} className="w-full text-left p-4 rounded-xl bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant/10 transition-all flex items-center gap-3">
                            <span className="material-symbols-outlined text-on-surface-variant text-sm">link</span>
                            <span className="text-xs text-on-surface-variant">{relationship.replace("_", " ")}</span>
                            <span className="text-sm font-medium text-foreground">{entry.title}</span>
                            <span className="text-[10px] font-bold uppercase text-primary tracking-widest ml-auto">{entry.entry_type}</span>
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
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary/5 rounded-full blur-2xl" />
              <div className="text-5xl font-bold font-headline text-primary mb-2">{lintResult.health_score}/100</div>
              <p className="text-on-surface-variant">Knowledge Health Score</p>
              <div className="w-full max-w-xs mx-auto h-3 bg-surface-container-highest rounded-full mt-4 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-primary-fixed-dim rounded-full" style={{ width: `${lintResult.health_score}%` }} />
              </div>
              <div className="flex justify-center gap-6 mt-4 text-xs text-on-surface-variant">
                <span>{lintResult.stats.total_entries} entries</span>
                <span>{lintResult.stats.total_relationships} links</span>
                <span>{lintResult.stats.orphan_count} orphans</span>
              </div>
              <div className="mt-4">
                <Button size="sm" variant="outline" onClick={handleLint} disabled={lintLoading}>
                  {lintLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <span className="material-symbols-outlined text-sm mr-1">refresh</span>}
                  Re-run
                </Button>
              </div>
            </div>

            {lintResult.issues.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">Issues ({lintResult.issues.length})</h3>
                {lintResult.issues.map((issue, i) => {
                  const affected = (issue.affected_entries || []).flatMap((title) => {
                    const e = entries.find(
                      (en) =>
                        en.title.toLowerCase() === title.toLowerCase() ||
                        en.title.toLowerCase().includes(title.toLowerCase()) ||
                        title.toLowerCase().includes(en.title.toLowerCase()),
                    );
                    return e ? [e] : [];
                  });
                  return (
                    <div key={i} className={`p-4 rounded-xl ${issue.severity === "high" ? "bg-error-container/20 border-l-4 border-destructive" : "bg-surface-container-highest/50"}`}>
                      <div className="flex items-start gap-3">
                        <span className="material-symbols-outlined text-destructive mt-0.5">warning</span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1.5">
                            <Badge variant="outline" className="text-[10px] uppercase">{issue.type.replace("_", " ")}</Badge>
                            <span className={`text-[10px] font-bold uppercase ${issue.severity === "high" ? "text-destructive" : "text-on-surface-variant"}`}>{issue.severity}</span>
                          </div>
                          <p className="text-sm font-bold text-foreground">{issue.description}</p>
                          {issue.suggested_fix && <p className="text-xs text-on-surface-variant mt-1">💡 {issue.suggested_fix}</p>}
                          {affected.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                              {affected.map((entry) => (
                                <button
                                  key={entry.id}
                                  onClick={() => openDetail(entry)}
                                  className="text-xs px-2.5 py-1.5 bg-surface-container-high rounded-lg border border-outline-variant/20 hover:bg-surface-container-highest transition-all flex items-center gap-1.5 font-medium"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>open_in_new</span>
                                  {entry.title}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2 mt-3 flex-wrap">
                            {issue.type === "orphan" && (
                              <Button size="sm" variant="outline" onClick={handleSleepCycle} disabled={sleepCycleRunning}>
                                {sleepCycleRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <span className="material-symbols-outlined text-sm mr-1">bedtime</span>}
                                Fix: Sleep Cycle
                              </Button>
                            )}
                            {issue.type === "duplicate" && affected.length >= 2 && (
                              <Button size="sm" variant="destructive" onClick={() => handleDelete(affected[affected.length - 1].id)}>
                                <span className="material-symbols-outlined text-sm mr-1">delete</span>
                                Delete Duplicate
                              </Button>
                            )}
                            {issue.type === "stale" && affected.map((entry) => (
                              <Button key={entry.id} size="sm" variant="destructive" onClick={() => handleDelete(entry.id)}>
                                <span className="material-symbols-outlined text-sm mr-1">delete</span>
                                Delete "{entry.title}"
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
                <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">Suggestions ({lintResult.suggestions.length})</h3>
                {lintResult.suggestions.map((s, i) => (
                  <div key={i} className="p-4 rounded-xl bg-surface-container-high border border-outline-variant/10">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <Badge variant="secondary" className="text-xs mb-2">{s.priority}</Badge>
                        <p className="text-sm text-foreground">{s.description}</p>
                      </div>
                      {(s.type === "add_relationship" || s.type === "merge_entries") && (
                        <Button size="sm" variant="outline" onClick={handleSleepCycle} disabled={sleepCycleRunning} className="shrink-0">
                          {sleepCycleRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="material-symbols-outlined text-sm">bedtime</span>}
                          Sleep Cycle
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
            <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">
              Conflicts ({conflicts.length}) — open: {openConflictsCount}
            </h3>
            {conflicts.length === 0 ? (
              <p className="text-center text-on-surface-variant py-8">No conflicts detected. 🎉</p>
            ) : conflicts.map((c) => {
              const a = entries.find(e => e.id === c.entry_a);
              const b = entries.find(e => e.id === c.entry_b);
              const isDuplicate = c.kind === "duplicate" || c.kind === "overlap";
              return (
                <div key={c.id} className={`p-5 rounded-xl border-l-4 ${c.status === "open" ? "bg-error-container/20 border-destructive" : "bg-surface-container-high border-outline-variant/30 opacity-70"}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <Badge variant="destructive" className="text-[10px]">{c.kind}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{c.status}</Badge>
                    <span className="ml-auto text-[10px] text-on-surface-variant">{new Date(c.created_at).toLocaleDateString()}</span>
                  </div>

                  {c.rationale && <p className="text-sm text-on-surface-variant mb-3 italic">"{c.rationale}"</p>}

                  {/* Side-by-side entry comparison with inline previews */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                    {[{ label: "Entry A", entry: a, id: c.entry_a }, { label: "Entry B", entry: b, id: c.entry_b }].map(({ label, entry, id }) => (
                      <div key={id} className="bg-surface-container-high rounded-lg overflow-hidden border border-outline-variant/10">
                        <div className="px-3 pt-3 pb-2">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1">{label}</p>
                          <p className="font-bold text-sm text-foreground leading-snug">{entry?.title || id.slice(0, 8)}</p>
                          {entry && (
                            <p className="text-xs text-on-surface-variant mt-1.5 line-clamp-3 leading-relaxed">{entry.content.slice(0, 180)}</p>
                          )}
                        </div>
                        {entry && (
                          <button
                            onClick={() => openDetail(entry)}
                            className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/5 border-t border-outline-variant/10 transition-colors"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>open_in_new</span>
                            Open &amp; Edit
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Resolution actions */}
                  {c.status === "open" && (
                    <div className="space-y-2">
                      {isDuplicate && a && b && (
                        <div className="flex gap-2 flex-wrap">
                          <Button size="sm" variant="destructive" onClick={() => handleResolveByDelete(c.id, b.id)}>
                            <span className="material-symbols-outlined text-sm mr-1">delete</span>
                            Keep A, Delete B
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => handleResolveByDelete(c.id, a.id)}>
                            <span className="material-symbols-outlined text-sm mr-1">delete</span>
                            Keep B, Delete A
                          </Button>
                        </div>
                      )}
                      <div className="flex gap-2 flex-wrap">
                        <Button size="sm" variant="outline" onClick={() => handleConflictStatus(c.id, "acknowledged")}>Acknowledge</Button>
                        <Button size="sm" variant="outline" onClick={() => handleConflictStatus(c.id, "resolved")}>Mark Resolved</Button>
                        <Button size="sm" variant="ghost" onClick={() => handleConflictStatus(c.id, "dismissed")}>Dismiss</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : view === "episodic" ? (
          <div className="space-y-4">
            <h3 className="font-headline font-bold text-2xl text-foreground mb-2">
              Episodic Memory Log
              <span className="ml-3 text-sm font-normal text-on-surface-variant">Layer 2 — {episodicLog.length} sessions</span>
            </h3>
            {episodicLog.length === 0 ? (
              <p className="text-on-surface-variant text-sm italic">No session episodes recorded yet. Save a chat to Wiki to begin building the episodic log.</p>
            ) : episodicLog.map((ep) => (
              <div key={ep.id} className="p-4 rounded-xl bg-surface-container-high border border-outline-variant/10">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Session</span>
                  <code className="text-xs text-primary">{ep.session_id}</code>
                  <span className="ml-auto text-xs text-on-surface-variant">{new Date(ep.created_at).toLocaleString()}</span>
                  <span className="text-xs text-on-surface-variant">{ep.entry_count} entries</span>
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
            <h3 className="font-headline font-bold text-2xl text-foreground mb-2">
              Consolidation Queue
              <span className="ml-3 text-sm font-normal text-on-surface-variant">Layer 5 — {queueItems.length} pending</span>
            </h3>
            {sleepCycleReport && (
              <div className="p-4 rounded-xl bg-secondary-container/20 border border-secondary-container/30 text-sm space-y-1">
                <p className="font-semibold text-foreground">Last Sleep Cycle — {sleepCycleReport.elapsed_ms}ms</p>
                <p className="text-on-surface-variant">Re-ranked: {sleepCycleReport.phases.rerank.updated} nodes · Edges created: {sleepCycleReport.phases.consolidate.edges_created} · Conflicts inserted: {sleepCycleReport.phases.consolidate.conflicts_inserted} · Orphans queued: {sleepCycleReport.phases.prune.orphans.length}</p>
              </div>
            )}
            {queueItems.length === 0 ? (
              <p className="text-on-surface-variant text-sm italic">Queue is empty. The Sleep Cycle will populate it as new entries and conflicts arrive.</p>
            ) : queueItems.map((item) => (
              <div key={item.id} className="p-4 rounded-xl bg-surface-container-high border border-outline-variant/10 flex items-start gap-4">
                <span className={`mt-0.5 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ${
                  item.reason === "conflict_staged" ? "bg-destructive/15 text-destructive"
                  : item.reason === "orphan" ? "bg-amber-500/15 text-amber-600"
                  : "bg-secondary-container/40 text-on-secondary-container"
                }`}>
                  {item.reason.replace("_", " ")}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-on-surface-variant truncate">
                    {item.entry_id || (item.pending_data as any)?.title || "pending"}
                  </p>
                  <p className="text-xs text-on-surface-variant">Priority {item.priority} · {new Date(item.created_at).toLocaleString()}</p>
                </div>
                <span className={`text-[10px] font-semibold ${item.processed_at ? "text-green-600" : "text-on-surface-variant"}`}>
                  {item.processed_at ? "done" : "pending"}
                </span>
              </div>
            ))}
          </div>

        ) : null}
      </main>
    </div>
  );
};

export default WikiPanel;
