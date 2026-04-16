import React, { useState, useEffect, useCallback } from "react";
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
import { Loader2 } from "lucide-react";

type WikiView = "entries" | "detail" | "lint";

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
    try { const result = await runLint(); setLintResult(result); setView("lint"); }
    catch (err: any) { toast.error(err.message); }
    finally { setLintLoading(false); }
  };

  const handleIngest = async (bookId: string) => {
    setIngestLoading(true);
    try { const result = await ingestBook(bookId); toast.success(`Extracted ${result.entries_created} entries`); loadData(); }
    catch (err: any) { toast.error(err.message); }
    finally { setIngestLoading(false); }
  };

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
          <div className="space-y-2">
            <div className="flex items-center gap-3 mb-1">
              <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">Knowledge Base</span>
              <span className="text-on-surface-variant text-sm font-medium">{entries.length} entries indexed</span>
            </div>
            <h2 className="font-headline font-bold text-5xl md:text-6xl text-primary tracking-tight">Knowledge Wiki</h2>
            <p className="text-on-surface-variant max-w-xl text-lg italic font-headline">"The sum of all acquired insights, meticulously categorized."</p>
          </div>
          <div className="flex gap-3">
            {view !== "entries" && (
              <button onClick={() => { setView("entries"); setSelectedEntry(null); }} className="flex items-center gap-2 px-4 py-3 bg-surface-container-high text-foreground rounded-xl text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
                <span className="material-symbols-outlined text-sm">arrow_back</span> Back
              </button>
            )}
            <button onClick={handleLint} disabled={lintLoading || entries.length === 0} className="flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-bold active:scale-95 transition-transform shadow-lg disabled:opacity-50">
              {lintLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="material-symbols-outlined text-xl">health_and_safety</span>}
              <span>Health Check</span>
            </button>
            <button onClick={loadData} disabled={loading} className="p-3 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
              <span className={`material-symbols-outlined ${loading ? "animate-spin" : ""}`}>refresh</span>
            </button>
          </div>
        </section>

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
            </div>

            {lintResult.issues.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">Issues ({lintResult.issues.length})</h3>
                {lintResult.issues.map((issue, i) => (
                  <div key={i} className={`flex items-start gap-4 p-4 rounded-xl ${issue.severity === "high" ? "bg-error-container/20 border-l-4 border-destructive" : "bg-surface-container-highest/50"}`}>
                    <span className="material-symbols-outlined text-destructive">warning</span>
                    <div>
                      <p className="text-sm font-bold text-foreground">{issue.description}</p>
                      {issue.suggested_fix && <p className="text-xs text-on-surface-variant mt-1">💡 {issue.suggested_fix}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {lintResult.suggestions.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-bold uppercase tracking-widest text-on-surface-variant">Suggestions ({lintResult.suggestions.length})</h3>
                {lintResult.suggestions.map((s, i) => (
                  <div key={i} className="p-4 rounded-xl bg-surface-container-high border border-outline-variant/10">
                    <Badge variant="secondary" className="text-xs mb-2">{s.priority}</Badge>
                    <p className="text-sm text-foreground">{s.description}</p>
                  </div>
                ))}
              </div>
            )}

            {lintResult.issues.length === 0 && lintResult.suggestions.length === 0 && (
              <p className="text-center text-on-surface-variant py-8">Your knowledge base looks healthy! 🎉</p>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
};

export default WikiPanel;
