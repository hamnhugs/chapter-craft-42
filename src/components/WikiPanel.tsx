import React, { useState, useEffect, useCallback } from "react";
import {
  BookOpen, Search, Trash2, Edit3, Save, X, Tag, Brain, AlertTriangle,
  ChevronRight, Loader2, Zap, RefreshCw, ArrowRight, BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import ReactMarkdown from "react-markdown";
import {
  KnowledgeEntry, MemoryGraphEdge, LintResult,
  fetchKnowledgeEntries, fetchMemoryGraph,
  deleteKnowledgeEntry, updateKnowledgeEntry,
  runLint, ingestBook,
} from "@/lib/knowledgeApi";

const ENTRY_TYPE_COLORS: Record<string, string> = {
  concept: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  entity: "bg-green-500/10 text-green-400 border-green-500/30",
  synthesis: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  fact: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  comparison: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  summary: "bg-rose-500/10 text-rose-400 border-rose-500/30",
};

type WikiView = "entries" | "detail" | "lint" | "graph";

const WikiPanel: React.FC = () => {
  const { books, activeBookId } = useApp();
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
  const [lintResult, setLintResult] = useState<LintResult | null>(null);
  const [lintLoading, setLintLoading] = useState(false);
  const [ingestLoading, setIngestLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [e, g] = await Promise.all([fetchKnowledgeEntries(), fetchMemoryGraph()]);
      setEntries(e);
      setGraph(g);
    } catch (err: any) {
      toast.error(err.message || "Failed to load knowledge base");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const filteredEntries = entries.filter((e) => {
    if (filterType !== "all" && e.entry_type !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  const getRelatedEntries = (entryId: string) => {
    const relatedIds = new Set<string>();
    const relationships: { entry: KnowledgeEntry; relationship: string; direction: "from" | "to" }[] = [];
    graph.forEach((edge) => {
      if (edge.source_entry_id === entryId) relatedIds.add(edge.target_entry_id);
      if (edge.target_entry_id === entryId) relatedIds.add(edge.source_entry_id);
    });
    relatedIds.forEach((id) => {
      const entry = entries.find((e) => e.id === id);
      if (entry) {
        const edge = graph.find(g => (g.source_entry_id === entryId && g.target_entry_id === id) || (g.target_entry_id === entryId && g.source_entry_id === id));
        relationships.push({
          entry,
          relationship: edge?.relationship || "relates_to",
          direction: edge?.source_entry_id === entryId ? "to" : "from",
        });
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
    try {
      const result = await runLint();
      setLintResult(result);
      setView("lint");
    } catch (err: any) { toast.error(err.message); } finally { setLintLoading(false); }
  };

  const handleIngest = async (bookId: string) => {
    setIngestLoading(true);
    try {
      const result = await ingestBook(bookId);
      toast.success(`Extracted ${result.entries_created} entries from book`);
      loadData();
    } catch (err: any) { toast.error(err.message); } finally { setIngestLoading(false); }
  };

  const openDetail = (entry: KnowledgeEntry) => {
    setSelectedEntry(entry);
    setView("detail");
    setEditing(false);
  };

  const startEdit = () => {
    if (!selectedEntry) return;
    setEditTitle(selectedEntry.title);
    setEditContent(selectedEntry.content);
    setEditTags(selectedEntry.tags.join(", "));
    setEditing(true);
  };

  const entryTypes = ["all", "concept", "entity", "synthesis", "fact", "comparison", "summary"];

  // === RENDER ===
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-muted/30 px-4 py-3 flex items-center gap-3 flex-wrap">
        <Brain className="w-5 h-5 text-primary" />
        <span className="text-sm font-medium text-foreground">Knowledge Wiki</span>
        <Badge variant="secondary" className="text-xs">{entries.length} entries</Badge>

        <div className="ml-auto flex gap-1.5">
          {view !== "entries" && (
            <Button size="sm" variant="ghost" onClick={() => { setView("entries"); setSelectedEntry(null); }}>
              ← Back
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleLint} disabled={lintLoading || entries.length === 0}>
            {lintLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <BarChart3 className="w-3.5 h-3.5 mr-1" />}
            Health Check
          </Button>
          <Button size="sm" variant="outline" onClick={loadData} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : view === "entries" ? (
          <div className="space-y-4">
            {/* Search & filter */}
            <div className="flex gap-2 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search knowledge..."
                    className="pl-9 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-1 flex-wrap">
                {entryTypes.map((type) => (
                  <Button
                    key={type}
                    size="sm"
                    variant={filterType === type ? "default" : "outline"}
                    onClick={() => setFilterType(type)}
                    className="text-xs capitalize"
                  >
                    {type}
                  </Button>
                ))}
              </div>
            </div>

            {/* Book ingest */}
            {books.length > 0 && (
              <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-foreground">Ingest Book Knowledge</p>
                <div className="flex gap-2 flex-wrap">
                  {books.filter(b => b.chapters.length > 0).map((book) => (
                    <Button
                      key={book.id}
                      size="sm"
                      variant="outline"
                      onClick={() => handleIngest(book.id)}
                      disabled={ingestLoading}
                      className="text-xs"
                    >
                      {ingestLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
                      {book.title}
                    </Button>
                  ))}
                </div>
                {books.filter(b => b.chapters.length === 0).length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Books without chapters: {books.filter(b => b.chapters.length === 0).map(b => b.title).join(", ")}
                    — isolate chapters first to ingest.
                  </p>
                )}
              </div>
            )}

            {/* Entries list */}
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
                <Brain className="w-10 h-10" />
                <p className="text-sm text-center">
                  {entries.length === 0
                    ? "Your knowledge wiki is empty. Chat about your books or use 'Ingest Book Knowledge' to start building it."
                    : "No entries match your search."}
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                {filteredEntries.map((entry) => {
                  const book = books.find((b) => b.id === entry.source_book_id);
                  const relCount = graph.filter(g => g.source_entry_id === entry.id || g.target_entry_id === entry.id).length;
                  return (
                    <button
                      key={entry.id}
                      onClick={() => openDetail(entry)}
                      className="text-left w-full border border-border rounded-lg p-3 hover:bg-muted/50 transition-colors group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-xs px-1.5 py-0.5 rounded border ${ENTRY_TYPE_COLORS[entry.entry_type] || "bg-muted text-muted-foreground"}`}>
                              {entry.entry_type}
                            </span>
                            <h3 className="text-sm font-medium text-foreground truncate">{entry.title}</h3>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">{entry.content.slice(0, 150)}</p>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {entry.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                                {tag}
                              </span>
                            ))}
                            {book && (
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <BookOpen className="w-3 h-3" />{book.title}
                              </span>
                            )}
                            {relCount > 0 && (
                              <span className="text-xs text-muted-foreground">{relCount} link{relCount !== 1 ? "s" : ""}</span>
                            )}
                            <span className="text-xs text-muted-foreground ml-auto">
                              {Math.round(entry.confidence * 100)}% confidence
                            </span>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : view === "detail" && selectedEntry ? (
          <div className="max-w-2xl mx-auto space-y-4">
            {editing ? (
              <>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="text-lg font-medium" />
                <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={8} className="text-sm font-mono" />
                <Input value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="tag1, tag2, tag3" className="text-sm" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveEdit}><Save className="w-3.5 h-3.5 mr-1" />Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X className="w-3.5 h-3.5 mr-1" />Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-xs px-2 py-0.5 rounded border ${ENTRY_TYPE_COLORS[selectedEntry.entry_type] || ""}`}>
                        {selectedEntry.entry_type}
                      </span>
                      <span className="text-xs text-muted-foreground">{Math.round(selectedEntry.confidence * 100)}% confidence</span>
                    </div>
                    <h2 className="text-xl font-semibold text-foreground">{selectedEntry.title}</h2>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={startEdit}><Edit3 className="w-3.5 h-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDelete(selectedEntry.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>

                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{selectedEntry.content}</ReactMarkdown>
                </div>

                {selectedEntry.tags.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap">
                    {selectedEntry.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs"><Tag className="w-3 h-3 mr-1" />{tag}</Badge>
                    ))}
                  </div>
                )}

                {/* Related entries */}
                {(() => {
                  const related = getRelatedEntries(selectedEntry.id);
                  if (related.length === 0) return null;
                  return (
                    <div className="border-t border-border pt-4 mt-4">
                      <h3 className="text-sm font-medium text-foreground mb-2">Connected Knowledge</h3>
                      <div className="grid gap-2">
                        {related.map(({ entry, relationship, direction }) => (
                          <button
                            key={entry.id}
                            onClick={() => openDetail(entry)}
                            className="flex items-center gap-2 p-2 rounded border border-border hover:bg-muted/50 text-left"
                          >
                            <ArrowRight className={`w-3.5 h-3.5 text-muted-foreground ${direction === "from" ? "rotate-180" : ""}`} />
                            <span className="text-xs text-muted-foreground">{relationship.replace("_", " ")}</span>
                            <span className="text-sm text-foreground">{entry.title}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded border ml-auto ${ENTRY_TYPE_COLORS[entry.entry_type] || ""}`}>
                              {entry.entry_type}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <div className="text-xs text-muted-foreground border-t border-border pt-3 mt-4">
                  Created {new Date(selectedEntry.created_at).toLocaleDateString()} · Updated {new Date(selectedEntry.updated_at).toLocaleDateString()}
                  {selectedEntry.source_book_id && (() => {
                    const book = books.find(b => b.id === selectedEntry.source_book_id);
                    return book ? ` · Source: ${book.title}` : null;
                  })()}
                </div>
              </>
            )}
          </div>
        ) : view === "lint" && lintResult ? (
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Health score */}
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-foreground mb-1">{lintResult.health_score}/100</div>
              <p className="text-sm text-muted-foreground">Knowledge Health Score</p>
              <div className="flex justify-center gap-4 mt-3 text-xs text-muted-foreground">
                <span>{lintResult.stats.total_entries} entries</span>
                <span>{lintResult.stats.total_relationships} links</span>
                <span>{lintResult.stats.orphan_count} orphans</span>
                <span>{Math.round((lintResult.stats.avg_confidence || 0) * 100)}% avg confidence</span>
              </div>
            </div>

            {/* Issues */}
            {lintResult.issues.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />Issues ({lintResult.issues.length})
                </h3>
                {lintResult.issues.map((issue, i) => (
                  <div key={i} className={`border rounded-lg p-3 ${issue.severity === "high" ? "border-destructive/50 bg-destructive/5" : issue.severity === "medium" ? "border-amber-500/50 bg-amber-500/5" : "border-border bg-muted/30"}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={issue.severity === "high" ? "destructive" : "secondary"} className="text-xs">{issue.severity}</Badge>
                      <span className="text-xs text-muted-foreground capitalize">{issue.type.replace("_", " ")}</span>
                    </div>
                    <p className="text-sm text-foreground">{issue.description}</p>
                    {issue.suggested_fix && <p className="text-xs text-muted-foreground mt-1">💡 {issue.suggested_fix}</p>}
                  </div>
                ))}
              </div>
            )}

            {/* Suggestions */}
            {lintResult.suggestions.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">Suggestions ({lintResult.suggestions.length})</h3>
                {lintResult.suggestions.map((s, i) => (
                  <div key={i} className="border border-border rounded-lg p-3 bg-primary/5">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="secondary" className="text-xs">{s.priority}</Badge>
                      <span className="text-xs text-muted-foreground capitalize">{s.type.replace("_", " ")}</span>
                    </div>
                    <p className="text-sm text-foreground">{s.description}</p>
                  </div>
                ))}
              </div>
            )}

            {lintResult.issues.length === 0 && lintResult.suggestions.length === 0 && (
              <p className="text-center text-muted-foreground text-sm py-8">Your knowledge base looks healthy! 🎉</p>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">Select a view</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WikiPanel;
