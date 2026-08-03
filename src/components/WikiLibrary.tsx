import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Loader2, Plus, Check, Search, Sparkles, ArrowRight, HelpCircle, Lock, Image as ImageIcon, Link2, Pencil, Fingerprint } from "lucide-react";
import ImagesPanel from "@/components/ImagesPanel";
import MasterAssetsPanel from "@/components/MasterAssetsPanel";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/context/AppContext";
import {
  WikiWithStats,
  fetchWikisWithStats,
  createWiki,
  updateWiki,
  deleteWiki,
} from "@/lib/wikisApi";
import { searchKnowledge, SemanticSearchMatch, embedEntries, fetchKnowledgeEntries } from "@/lib/knowledgeApi";
import { supabase } from "@/integrations/supabase/client";
import SuggestionsTab from "@/components/SuggestionsTab";
import { usePlan } from "@/hooks/usePlan";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { openPricing } from "@/components/PricingDialog";
import { FREE_NEURON_LIMIT, MAX_ACTIVE_NEURONS, computeLockedWikiIds } from "@/lib/neuronAccess";
import { openChainDialog } from "@/components/ChainDialog";
import { useChains, touchChainUsed, emitChainsChanged, NeuronChain, CHAINS_MIGRATION_MESSAGE } from "@/lib/chainsApi";
import {
  AdminWikiRow,
  AdminWikiEntry,
  adminListAllWikis,
  adminListWikiEntries,
} from "@/lib/announcementsApi";

// Lazy: shares the three.js chunk with the Vault graph; only fetched when the
// user opens the mind-map view.
const NeuronGraph = React.lazy(() => import("@/components/NeuronGraph"));

type ViewMode = "compact" | "gallery" | "mindmap";

const COVER_PALETTE = [
  "#7C3AED", "#2563EB", "#0EA5E9", "#10B981",
  "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6",
];

const formatRelative = (iso: string | null) => {
  if (!iso) return "Never loaded";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

// Admin "Everyone" scope never locks anything — the admin RPC re-checks
// is_admin() server-side, so this set exists only to satisfy NeuronGraph.
const EMPTY_LOCKED = new Set<string>();

// Chains sub-tab: saved neuron chains — named sets that load together.
const ChainsSection: React.FC<{
  wikis: WikiWithStats[];
  activeWikiIds: string[];
  lockedIds: Set<string>;
  onActivate: (chain: NeuronChain) => void;
}> = ({ wikis, activeWikiIds, lockedIds, onActivate }) => {
  const { chains, loaded, migrationMissing } = useChains();
  const wikiById = useMemo(() => new Map(wikis.map((w) => [w.id, w])), [wikis]);

  const isCurrentSet = (chain: NeuronChain) =>
    chain.wiki_ids.length === activeWikiIds.length &&
    chain.wiki_ids.every((id, i) => activeWikiIds[i] === id);

  if (!loaded) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  if (migrationMissing) {
    return (
      <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 p-8 text-center max-w-xl mx-auto">
        <Link2 className="w-8 h-8 mx-auto mb-3 text-on-surface-variant" />
        <p className="text-sm text-on-surface-variant">{CHAINS_MIGRATION_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-on-surface-variant max-w-lg">
          A chain loads several related neurons together in one click — comparing
          connected topics builds stronger memory than studying them alone.
        </p>
        <button
          onClick={() => openChainDialog({ prefillIds: activeWikiIds.length >= 2 ? activeWikiIds : undefined })}
          className="flex items-center gap-1.5 bg-primary-container text-on-primary-container px-3 py-1.5 rounded-lg font-bold text-sm active:scale-95 transition-transform shadow-md shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>NEW CHAIN</span>
        </button>
      </div>

      {chains.length === 0 ? (
        <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 p-10 text-center max-w-xl mx-auto">
          <Link2 className="w-8 h-8 mx-auto mb-3 text-on-surface-variant" />
          <h3 className="font-headline font-bold text-xl text-primary mb-2">Save your first chain</h3>
          <p className="text-sm text-on-surface-variant mb-5">
            Group the neurons you use together — like "Traffic Signs" + "Road
            Rules" — so you can load them in one click and let Counsel connect
            ideas across them.
          </p>
          <Button onClick={() => openChainDialog({ prefillIds: activeWikiIds.length >= 2 ? activeWikiIds : undefined })}>
            <Plus className="w-4 h-4 mr-1" /> New chain
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {chains.map((chain) => {
            const members = chain.wiki_ids.map((id) => wikiById.get(id)).filter(Boolean) as WikiWithStats[];
            const hasLocked = chain.wiki_ids.some((id) => lockedIds.has(id));
            const current = isCurrentSet(chain);
            return (
              <div
                key={chain.id}
                className="bg-surface-container-high rounded-xl overflow-hidden border border-outline-variant/10 flex flex-col"
              >
                <div
                  className="h-14 relative"
                  style={{ background: `linear-gradient(135deg, ${chain.cover_color}, ${chain.cover_color}88)` }}
                >
                  {current && (
                    <span className="absolute top-2 right-2 inline-flex items-center gap-1 bg-background/90 backdrop-blur-sm rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
                      <Check className="w-3 h-3" /> Active
                    </span>
                  )}
                </div>
                <div className="p-4 flex-1 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Link2 className="w-4 h-4 shrink-0" style={{ color: chain.cover_color }} />
                    <h3 className="font-headline font-bold text-lg text-foreground truncate">{chain.name}</h3>
                  </div>
                  {chain.description && (
                    <p className="text-xs text-on-surface-variant line-clamp-2">{chain.description}</p>
                  )}
                  <div className="flex flex-col gap-1 mt-1">
                    {chain.wiki_ids.slice(0, MAX_ACTIVE_NEURONS).map((id, i) => {
                      const w = wikiById.get(id);
                      return (
                        <div key={id} className="flex items-center gap-2 text-xs">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: w?.cover_color || "#7C3AED" }}
                          />
                          <span className={`truncate ${w ? "text-foreground" : "text-on-surface-variant line-through"}`}>
                            {w?.name || "deleted neuron"}
                          </span>
                          {i === 0 && (
                            <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant shrink-0">
                              primary
                            </span>
                          )}
                          {lockedIds.has(id) && <Lock className="w-3 h-3 text-on-surface-variant shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[10px] text-on-surface-variant mt-auto pt-2">
                    {members.length} neuron{members.length === 1 ? "" : "s"} · {chain.last_used_at ? `used ${formatRelative(chain.last_used_at)}` : "never used"}
                  </div>
                </div>
                <div className="px-4 pb-4 flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={current || members.length === 0}
                    title={members.length === 0 ? "All neurons in this chain have been deleted" : undefined}
                    onClick={() => onActivate(chain)}
                  >
                    {current ? (
                      <>
                        <Check className="w-3.5 h-3.5 mr-1" /> Loaded
                      </>
                    ) : hasLocked ? (
                      <>
                        <Lock className="w-3.5 h-3.5 mr-1" /> Activate
                      </>
                    ) : (
                      "Activate"
                    )}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openChainDialog({ chain })} title="Edit chain">
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const WikiLibrary: React.FC = () => {
  const { activeWikiId, activeWikiIds, setActiveWiki, setActiveNeurons, refreshWikis, setActiveTab } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { user } = useAuth();
  const { isAdmin } = useIsAdmin();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [wikisWithStats, setWikisWithStats] = useState<WikiWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("gallery");
  const [imagesOpen, setImagesOpen] = useState(false);
  const [mastersOpen, setMastersOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<WikiWithStats | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activeView, setActiveView] = useState<"wikis" | "chains" | "suggestions">("wikis");
  const [pendingCount, setPendingCount] = useState(0);

  // Cross-wiki semantic search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SemanticSearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [backfilling, setBackfilling] = useState(false);

  // Source books for the currently-selected wiki (loaded on open)
  const [selectedSourceBooks, setSelectedSourceBooks] = useState<{ id: string; title: string; count: number }[]>([]);

  // Create / edit form state
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formColor, setFormColor] = useState(COVER_PALETTE[0]);
  const [formTags, setFormTags] = useState("");
  const [formIsMeta, setFormIsMeta] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Load pending suggestion count for badge (reroutes + wiki proposals).
  const loadPendingCount = useCallback(async () => {
    try {
      const [{ count: rCount }, { count: pCount }, { count: hCount }] = await Promise.all([
        supabase.from("reroute_suggestions").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("wiki_proposals").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("wiki_health_alerts").select("id", { count: "exact", head: true }).eq("status", "pending"),
      ]);
      setPendingCount((rCount ?? 0) + (pCount ?? 0) + (hCount ?? 0));

    } catch {
      setPendingCount(0);
    }
  }, []);

  useEffect(() => { loadPendingCount(); }, [loadPendingCount, activeView]);

  // Cleanup feature removed — the chat handles deletion through its memory tools.


  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchWikisWithStats();
      setWikisWithStats(list);
    } catch (err: any) {
      toast.error(err.message || "Failed to load neurons");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    wikisWithStats.forEach((w) => w.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [wikisWithStats]);

  const filtered = useMemo(() => {
    if (!tagFilter) return wikisWithStats;
    return wikisWithStats.filter((w) => w.tags.includes(tagFilter));
  }, [wikisWithStats, tagFilter]);

  // On the free plan, only the oldest neuron stays accessible; the rest are
  // visible but locked (data is kept, never deleted) until the user upgrades.
  const lockedIds = useMemo(
    () => computeLockedWikiIds(wikisWithStats, isPaid, planLoaded),
    [wikisWithStats, isPaid, planLoaded],
  );

  const handleNewWiki = () => {
    if (planLoaded && !isPaid && wikisWithStats.length >= FREE_NEURON_LIMIT) {
      openPricing("neuron-limit");
      return;
    }
    openCreate();
  };

  const handleCardClick = (wiki: WikiWithStats) => {
    if (lockedIds.has(wiki.id)) {
      openPricing("neuron-locked");
      return;
    }
    setSelected(wiki);
  };

  const openCreate = () => {
    setFormName("");
    setFormDesc("");
    setFormColor(COVER_PALETTE[Math.floor(Math.random() * COVER_PALETTE.length)]);
    setFormTags("");
    setFormIsMeta(false);
    setEditing(false);
    setCreateOpen(true);
  };

  const openEdit = (wiki: WikiWithStats) => {
    setFormName(wiki.name);
    setFormDesc(wiki.description);
    setFormColor(wiki.cover_color);
    setFormTags(wiki.tags.join(", "));
    setFormIsMeta(wiki.is_meta);
    setEditing(true);
    setCreateOpen(true);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      toast.error("Name is required");
      return;
    }
    setSubmitting(true);
    try {
      const tags = formTags.split(",").map((t) => t.trim()).filter(Boolean);
      if (editing && selected) {
        await updateWiki(selected.id, {
          name: formName.trim(),
          description: formDesc,
          cover_color: formColor,
          tags,
          is_meta: formIsMeta,
        });
        toast.success("Neuron updated");
      } else {
        await createWiki({
          name: formName.trim(),
          description: formDesc,
          cover_color: formColor,
          tags,
          is_meta: formIsMeta,
        });
        toast.success("Neuron created");
      }
      setCreateOpen(false);
      setSelected(null);
      await Promise.all([load(), refreshWikis()]);
    } catch (err: any) {
      toast.error(err.message || "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  // When a wiki is selected, hydrate its source-book breakdown.
  useEffect(() => {
    if (!selected) {
      setSelectedSourceBooks([]);
      return;
    }
    (async () => {
      try {
        const entries = await fetchKnowledgeEntries(selected.id);
        const counts = new Map<string, number>();
        for (const e of entries) {
          if (e.source_book_id) {
            counts.set(e.source_book_id, (counts.get(e.source_book_id) || 0) + 1);
          }
        }
        if (counts.size === 0) {
          setSelectedSourceBooks([]);
          return;
        }
        const { data: books } = await supabase
          .from("books")
          .select("id, title")
          .in("id", Array.from(counts.keys()));
        setSelectedSourceBooks(
          (books || []).map((b: any) => ({
            id: b.id,
            title: b.title,
            count: counts.get(b.id) || 0,
          })).sort((a, b) => b.count - a.count)
        );
      } catch (err) {
        console.error("Failed to load source books:", err);
        setSelectedSourceBooks([]);
      }
    })();
  }, [selected]);

  const handleBackfill = async () => {
    setBackfilling(true);
    try {
      const result = await embedEntries({ backfill: true, limit: 200 });
      if (result.attempted === 0) {
        toast.success("All entries are already embedded ✨");
      } else {
        toast.success(`Embedded ${result.embedded} of ${result.attempted} entries`);
      }
      // If the user had a query open, re-run it
      if (searchQuery.trim().length >= 3) {
        const results = await searchKnowledge({ query: searchQuery.trim(), limit: 20, threshold: 0.25 });
        setSearchResults(results);
      }
    } catch (err: any) {
      toast.error(err.message || "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  };

  // Debounced semantic search across all wikis.
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
        const results = await searchKnowledge({ query: q, limit: 20, threshold: 0.25 });
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

  const handleLoad = async (wiki: WikiWithStats) => {
    try {
      await setActiveWiki(wiki.id);
      toast.success(`Loaded "${wiki.name}"`);
      setSelected(null);
      setActiveTab("wiki");
    } catch (err: any) {
      toast.error(err.message || "Failed to load neuron");
    }
  };

  const handleActivateChain = async (chain: NeuronChain) => {
    // Wiki deletes cascade out of chain membership — validate against the
    // live list so a shrunken/emptied chain can't false-succeed.
    const liveIds = chain.wiki_ids.filter((id) => wikisWithStats.some((w) => w.id === id));
    if (liveIds.length === 0) {
      toast.error(`The neurons in "${chain.name}" have been deleted — edit or delete the chain.`);
      return;
    }
    if (liveIds.some((id) => lockedIds.has(id))) {
      openPricing("neuron-chains");
      return;
    }
    try {
      await setActiveNeurons(liveIds);
      touchChainUsed(chain.id);
      toast.success(`Activated chain "${chain.name}" — ${liveIds.length} neuron${liveIds.length === 1 ? "" : "s"} loaded`);
      setActiveTab("chat");
    } catch (err: any) {
      toast.error(err.message || "Chain activation failed");
    }
  };

  const handleDelete = async (wiki: WikiWithStats) => {
    if (activeWikiIds.includes(wiki.id) || wiki.id === activeWikiId) {
      toast.error("Cannot delete a loaded neuron. Load another one first.");
      return;
    }
    if (!confirm(`Delete "${wiki.name}" and all ${wiki.entry_count} of its entries? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteWiki(wiki.id);
      toast.success("Neuron deleted");
      setSelected(null);
      // Membership rows cascade away — refresh chain lists everywhere (the
      // globally-mounted ⌘K switcher would otherwise hold dangling ids).
      emitChainsChanged();
      await Promise.all([load(), refreshWikis()]);
    } catch (err: any) {
      toast.error(err.message || "Delete failed");
    }
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      <main className="max-w-7xl mx-auto px-6 py-12 pb-32 w-full">
        {/* Header */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div className="space-y-2">
            <div className="flex items-center gap-3 mb-1">
              <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
                Neuron Library
              </span>
              <span className="text-on-surface-variant text-sm font-medium">
                {wikisWithStats.length} {wikisWithStats.length === 1 ? "neuron" : "neurons"}
              </span>
            </div>
            <h2 className="font-headline font-bold text-5xl md:text-6xl text-primary tracking-tight">
              Select a Neuron&nbsp;
            </h2>
            <p className="text-on-surface-variant max-w-xl text-lg italic font-headline">
              "Many minds, one library. Choose where to think."
            </p>
            <Link
              to="/memory-guide"
              className="group inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/30 text-sm font-body font-semibold text-accent hover:bg-accent/20 hover:scale-105 transition-all motion-safe:animate-pulse-glow"
            >
              <HelpCircle className="w-4 h-4 motion-safe:animate-icon-wiggle" />
              How the memory system works
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          <div className="flex gap-3 items-center">
            {/* Admin-only scope toggle: my neurons vs every account's neurons */}
            {isAdmin && (
              <div className="flex bg-surface-container-high rounded-xl p-1 border border-outline-variant/10">
                {(["mine", "all"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                      scope === s
                        ? "bg-primary-container text-on-primary-container"
                        : "text-on-surface-variant"
                    }`}
                    title={s === "mine" ? "Your neurons" : "All users' neurons (admin)"}
                  >
                    {s === "mine" ? "Mine" : "Everyone"}
                  </button>
                ))}
              </div>
            )}

            {/* View mode toggle */}
            <div className="flex bg-surface-container-high rounded-xl p-1 border border-outline-variant/10">
              <button
                onClick={() => setViewMode("compact")}
                className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  viewMode === "compact"
                    ? "bg-primary-container text-on-primary-container"
                    : "text-on-surface-variant"
                }`}
                title="Compact grid"
              >
                <span className="material-symbols-outlined text-sm">grid_view</span>
              </button>
              <button
                onClick={() => setViewMode("gallery")}
                className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  viewMode === "gallery"
                    ? "bg-primary-container text-on-primary-container"
                    : "text-on-surface-variant"
                }`}
                title="Gallery view"
              >
                <span className="material-symbols-outlined text-sm">view_module</span>
              </button>
              <button
                onClick={() => setViewMode("mindmap")}
                className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  viewMode === "mindmap"
                    ? "bg-primary-container text-on-primary-container"
                    : "text-on-surface-variant"
                }`}
                title="Mind map view"
              >
                <span className="material-symbols-outlined text-sm">neurology</span>
              </button>
            </div>

            {/* Masters sit next to Images: both are generated-asset browsers,
                so they share one home and one button idiom. */}
            <button
              onClick={() => setMastersOpen(true)}
              className="flex items-center gap-1.5 bg-surface-container-high text-on-surface px-3 py-1.5 rounded-lg font-bold text-sm active:scale-95 transition-transform border border-outline-variant/20 hover:bg-surface-container-highest"
              title="Browse and edit locked master assets"
            >
              <Fingerprint className="w-4 h-4" />
              <span>MASTERS</span>
            </button>

            <button
              onClick={() => setImagesOpen(true)}
              className="flex items-center gap-1.5 bg-surface-container-high text-on-surface px-3 py-1.5 rounded-lg font-bold text-sm active:scale-95 transition-transform border border-outline-variant/20 hover:bg-surface-container-highest"
              title="View and manage all generated images"
            >
              <ImageIcon className="w-4 h-4" />
              <span>IMAGES</span>
            </button>

            <button
              onClick={handleNewWiki}
              className="flex items-center gap-1.5 bg-primary-container text-on-primary-container px-3 py-1.5 rounded-lg font-bold text-sm active:scale-95 transition-transform shadow-md"
            >
              {planLoaded && !isPaid && wikisWithStats.length >= FREE_NEURON_LIMIT ? (
                <Lock className="w-4 h-4" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              <span>NEW NEURON</span>
            </button>
            <ImagesPanel open={imagesOpen} onOpenChange={setImagesOpen} />
          </div>
        </section>


        {/* Tab switcher: Wikis | Suggestions */}
        <div className="mb-6 flex items-center gap-2 border-b border-outline-variant/20">
          <button
            onClick={() => setActiveView("wikis")}
            className={`px-4 py-3 text-sm font-bold transition-colors relative ${
              activeView === "wikis"
                ? "text-primary"
                : "text-on-surface-variant hover:text-foreground"
            }`}
          >
            Neurons
            {activeView === "wikis" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
            )}
          </button>
          <button
            onClick={() => setActiveView("chains")}
            className={`px-4 py-3 text-sm font-bold transition-colors relative flex items-center gap-2 ${
              activeView === "chains"
                ? "text-primary"
                : "text-on-surface-variant hover:text-foreground"
            }`}
          >
            Chains
            {activeView === "chains" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
            )}
          </button>
          <button
            onClick={() => setActiveView("suggestions")}
            className={`px-4 py-3 text-sm font-bold transition-colors relative flex items-center gap-2 ${
              activeView === "suggestions"
                ? "text-primary"
                : "text-on-surface-variant hover:text-foreground"
            }`}
          >
            Suggestions
            {pendingCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-primary-container text-on-primary-container text-[10px] font-bold min-w-[20px] text-center">
                {pendingCount}
              </span>
            )}
            {activeView === "suggestions" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
            )}
          </button>
        </div>

        {activeView === "suggestions" ? (
          <SuggestionsTab onChanged={loadPendingCount} />
        ) : activeView === "chains" ? (
          <ChainsSection
            wikis={wikisWithStats}
            activeWikiIds={activeWikiIds}
            lockedIds={lockedIds}
            onActivate={handleActivateChain}
          />
        ) : isAdmin && scope === "all" ? (
          <AdminAllNeurons
            viewMode={viewMode}
            ownUserId={user?.id || ""}
            activeWikiId={activeWikiId}
            onOwnSelect={handleCardClick}
          />
        ) : (
          <>
            {/* Cross-wiki semantic search */}
            <div className="mb-6 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-on-surface-variant" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search across all neurons (semantic — try a question or topic)…"
                className="w-full bg-surface-container-low border-none rounded-xl py-4 pl-12 pr-12 focus:ring-1 focus:ring-primary/40 placeholder:text-on-surface-variant/50 text-foreground text-base transition-all shadow-inner"
              />
              {searching && (
                <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-on-surface-variant animate-spin" />
              )}
              {!searching && searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-foreground"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              )}
            </div>

            {/* Search results */}
            {searchResults !== null && (
              <SearchResults
                results={searchResults}
                wikis={wikisWithStats}
                activeWikiId={activeWikiId}
                onJumpToWiki={async (wikiId) => {
                  await setActiveWiki(wikiId);
                  setSearchQuery("");
                  setActiveTab("wiki");
                }}
                onBackfill={handleBackfill}
                backfilling={backfilling}
              />
            )}

            {/* Tag filter pills */}
            {searchResults === null && allTags.length > 0 && (
              <div className="flex items-center gap-3 mb-6 overflow-x-auto pb-2 hide-scrollbar">
                <button
                  onClick={() => setTagFilter(null)}
                  className={`px-4 py-2 rounded-full text-xs font-bold transition-colors capitalize ${
                    tagFilter === null
                      ? "bg-secondary-container text-on-secondary-container ring-1 ring-primary/20"
                      : "hover:bg-surface-container-high text-on-surface-variant"
                  }`}
                >
                  All
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setTagFilter(tag)}
                    className={`px-4 py-2 rounded-full text-xs font-bold transition-colors ${
                      tagFilter === tag
                        ? "bg-secondary-container text-on-secondary-container ring-1 ring-primary/20"
                        : "hover:bg-surface-container-high text-on-surface-variant"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {/* Content */}
            {searchResults === null && (
              loading && wikisWithStats.length === 0 ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
                  <span className="material-symbols-outlined text-5xl">menu_book</span>
                  <p className="text-sm text-center">
                    {wikisWithStats.length === 0
                      ? "You have no neurons yet. Create one to get started."
                      : "No neurons match this tag."}
                  </p>
                </div>
              ) : viewMode === "mindmap" ? (
                <React.Suspense
                  fallback={
                    <div className="flex items-center justify-center h-[60vh] min-h-[420px]">
                      <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
                    </div>
                  }
                >
                  <NeuronGraph
                    wikis={filtered}
                    lockedIds={lockedIds}
                    activeWikiId={activeWikiId}
                    onSelect={handleCardClick}
                  />
                </React.Suspense>
              ) : viewMode === "compact" ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {filtered.map((wiki) => (
                    <WikiCardCompact
                      key={wiki.id}
                      wiki={wiki}
                      isActive={wiki.id === activeWikiId}
                      locked={lockedIds.has(wiki.id)}
                      onClick={() => handleCardClick(wiki)}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filtered.map((wiki) => (
                    <WikiCardGallery
                      key={wiki.id}
                      wiki={wiki}
                      isActive={wiki.id === activeWikiId}
                      locked={lockedIds.has(wiki.id)}
                      onClick={() => handleCardClick(wiki)}
                    />
                  ))}
                </div>
              )
            )}
          </>
        )}
      </main>


      {/* Info / load dialog */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <div
                className="h-20 -mx-6 -mt-6 mb-2 rounded-t-lg"
                style={{ background: `linear-gradient(135deg, ${selected.cover_color}, ${selected.cover_color}88)` }}
              />
              <DialogHeader>
                <DialogTitle className="text-2xl font-headline flex items-center gap-2">
                  {selected.name}
                  {selected.id === activeWikiId && (
                    <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 bg-primary-container text-on-primary-container rounded">
                      Active
                    </span>
                  )}
                </DialogTitle>
                {selected.description && (
                  <DialogDescription className="pt-2">{selected.description}</DialogDescription>
                )}
              </DialogHeader>

              <div className="grid grid-cols-3 gap-3 my-4">
                <Stat label="Entries" value={selected.entry_count.toString()} />
                <Stat label="Last loaded" value={formatRelative(selected.last_loaded_at)} />
                <Stat label="Created" value={new Date(selected.created_at).toLocaleDateString()} />
              </div>

              {selected.tags.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                  {selected.tags.map((tag) => (
                    <span
                      key={tag}
                      className="bg-surface-container-highest px-3 py-1 rounded text-[10px] font-bold text-secondary uppercase tracking-wider"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {selectedSourceBooks.length > 0 && (
                <div className="space-y-2 my-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Source books
                  </div>
                  <div className="flex flex-col gap-1">
                    {selectedSourceBooks.slice(0, 5).map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-surface-container-high text-xs"
                      >
                        <span className="truncate flex-1">{b.title}</span>
                        <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          {b.count}
                        </span>
                      </div>
                    ))}
                    {selectedSourceBooks.length > 5 && (
                      <div className="text-[10px] text-on-surface-variant text-center pt-1">
                        + {selectedSourceBooks.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selected.is_meta && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-primary-container/15 border border-primary/20 text-xs my-2">
                  <Sparkles className="w-4 h-4 text-primary shrink-0" />
                  <span className="text-on-surface-variant">
                    Meta neuron — collects pointers to your other neurons.
                  </span>
                </div>
              )}

              <DialogFooter className="gap-2 sm:gap-0 flex-col sm:flex-row">
                <Button
                  variant="ghost"
                  onClick={() => handleDelete(selected)}
                  disabled={selected.id === activeWikiId}
                  className="text-destructive hover:text-destructive sm:mr-auto"
                >
                  Delete
                </Button>
                <Button variant="outline" onClick={() => openEdit(selected)}>
                  Edit
                </Button>
                <Button
                  onClick={() => handleLoad(selected)}
                  disabled={selected.id === activeWikiId}
                  className="gap-2"
                >
                  {selected.id === activeWikiId ? (
                    <>
                      <Check className="w-4 h-4" /> Loaded
                    </>
                  ) : (
                    "Load Neuron"
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create / edit dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl">
              {editing ? "Edit neuron" : "New neuron"}
            </DialogTitle>
            <DialogDescription>
              A neuron is an isolated pocket of knowledge. Each one keeps its own entries, tags, and AI context.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
                Name
              </label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Dune Lore, Startup Strategy"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
                Description
              </label>
              <Textarea
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="What lives in this neuron?"
                rows={3}
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
                Cover color
              </label>
              <div className="flex gap-2 flex-wrap">
                {COVER_PALETTE.map((color) => (
                  <button
                    key={color}
                    onClick={() => setFormColor(color)}
                    className={`w-8 h-8 rounded-lg transition-transform ${
                      formColor === color ? "ring-2 ring-primary scale-110" : ""
                    }`}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
                Tags (comma-separated)
              </label>
              <Input
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="fiction, research, personal"
              />
            </div>

            <div className="flex items-start justify-between gap-4 p-3 rounded-lg bg-surface-container-high border border-outline-variant/10">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <Sparkles className="w-4 h-4 text-primary" /> Meta neuron
                </div>
                <div className="text-xs text-on-surface-variant mt-1">
                  Use this neuron to collect pointers to your other neurons — a hub or index.
                </div>
              </div>
              <Switch checked={formIsMeta} onCheckedChange={setFormIsMeta} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-surface-container-high rounded-lg p-3 text-center">
    <div className="text-xs text-on-surface-variant uppercase tracking-widest font-bold mb-1">
      {label}
    </div>
    <div className="text-sm font-headline text-foreground">{value}</div>
  </div>
);

const WikiCardCompact: React.FC<{
  wiki: WikiWithStats;
  isActive: boolean;
  locked?: boolean;
  onClick: () => void;
}> = ({ wiki, isActive, locked, onClick }) => (
  <button
    onClick={onClick}
    title={locked ? "Locked on the free plan — upgrade to access" : undefined}
    className={`group relative aspect-square rounded-xl overflow-hidden text-left transition-transform active:scale-95 hover:shadow-2xl ${
      isActive ? "ring-2 ring-primary" : ""
    }`}
    style={{ background: `linear-gradient(135deg, ${wiki.cover_color}, ${wiki.cover_color}99)` }}
  >
    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
    {locked && (
      <div className="absolute inset-0 z-10 bg-black/55 backdrop-blur-[2px] flex flex-col items-center justify-center gap-1.5">
        <Lock className="w-5 h-5 text-white/90" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-white/90">Upgrade to unlock</span>
      </div>
    )}
    {isActive && (
      <div className="absolute top-2 right-2 bg-background/90 rounded-full p-1">
        <Check className="w-3 h-3 text-primary" />
      </div>
    )}
    {wiki.is_meta && (
      <div className="absolute top-2 left-2 bg-background/90 backdrop-blur-sm rounded px-1.5 py-0.5 flex items-center gap-1">
        <Sparkles className="w-2.5 h-2.5 text-primary" />
        <span className="text-[8px] font-bold uppercase tracking-widest text-primary">Meta</span>
      </div>
    )}
    <div className="absolute bottom-0 left-0 right-0 p-3">
      <div className="font-headline font-bold text-white text-sm leading-tight line-clamp-2">
        {wiki.name}
      </div>
      <div className="text-[10px] text-white/80 uppercase tracking-wider mt-1">
        {wiki.entry_count} {wiki.entry_count === 1 ? "entry" : "entries"}
      </div>
    </div>
  </button>
);

const WikiCardGallery: React.FC<{
  wiki: WikiWithStats;
  isActive: boolean;
  locked?: boolean;
  onClick: () => void;
}> = ({ wiki, isActive, locked, onClick }) => (
  <button
    onClick={onClick}
    title={locked ? "Locked on the free plan — upgrade to access" : undefined}
    className={`group relative bg-surface-container-high rounded-xl overflow-hidden text-left transition-all hover:shadow-2xl active:scale-[0.99] ${
      isActive ? "ring-2 ring-primary" : "border border-outline-variant/10"
    }`}
  >
    {locked && (
      <div className="absolute inset-0 z-10 bg-background/70 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2">
        <Lock className="w-6 h-6 text-on-surface-variant" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
          Upgrade to unlock
        </span>
      </div>
    )}
    <div
      className="h-24 relative"
      style={{ background: `linear-gradient(135deg, ${wiki.cover_color}, ${wiki.cover_color}88)` }}
    >
      {wiki.is_meta && (
        <div className="absolute top-3 left-3 bg-background/90 backdrop-blur-sm rounded px-2 py-1 flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-primary" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Meta</span>
        </div>
      )}
      {isActive && (
        <div className="absolute top-3 right-3 bg-background/90 backdrop-blur-sm rounded-full px-3 py-1 flex items-center gap-1">
          <Check className="w-3 h-3 text-primary" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Active</span>
        </div>
      )}
    </div>
    <div className="p-5 space-y-3">
      <div>
        <h3 className="font-headline font-bold text-xl text-foreground group-hover:text-primary transition-colors line-clamp-1">
          {wiki.name}
        </h3>
        {wiki.description && (
          <p className="text-sm text-on-surface-variant mt-1 line-clamp-2">{wiki.description}</p>
        )}
      </div>

      <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
        <span>{wiki.entry_count} {wiki.entry_count === 1 ? "entry" : "entries"}</span>
        <span className="text-outline-variant">•</span>
        <span>{formatRelative(wiki.last_loaded_at)}</span>
      </div>

      {wiki.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {wiki.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="bg-surface-container-highest px-2 py-0.5 rounded text-[10px] font-bold text-secondary uppercase tracking-wider"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  </button>
);

// =====================================================
// AdminAllNeurons: admin-only "Everyone" scope — every account's neurons,
// grouped by owner. Reads go through SECURITY DEFINER RPCs that re-check
// is_admin() server-side; opening another user's entries is audit-logged.
// =====================================================

const AdminAllNeurons: React.FC<{
  viewMode: ViewMode;
  ownUserId: string;
  activeWikiId: string | null;
  onOwnSelect: (wiki: WikiWithStats) => void;
}> = ({ viewMode, ownUserId, activeWikiId, onOwnSelect }) => {
  const [rows, setRows] = useState<AdminWikiRow[] | null>(null);
  const [foreign, setForeign] = useState<AdminWikiRow | null>(null);
  const [entries, setEntries] = useState<AdminWikiEntry[] | null>(null);

  useEffect(() => {
    adminListAllWikis()
      .then(setRows)
      .catch((err: any) => {
        toast.error(err.message || "Failed to load all neurons — is the migration applied?");
        setRows([]);
      });
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, AdminWikiRow[]>();
    for (const w of rows || []) {
      if (!map.has(w.owner_email)) map.set(w.owner_email, []);
      map.get(w.owner_email)!.push(w);
    }
    return Array.from(map.entries());
  }, [rows]);

  const handleSelect = (w: AdminWikiRow) => {
    if (w.user_id === ownUserId) {
      onOwnSelect(w as unknown as WikiWithStats);
      return;
    }
    setForeign(w);
    setEntries(null);
    adminListWikiEntries(w.id, 50)
      .then(setEntries)
      .catch((err: any) => {
        toast.error(err.message || "Failed to load entries");
        setEntries([]);
      });
  };

  if (!rows) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-on-surface-variant">
        Admin view — neurons from every account. Opening another user's neuron records an entry
        in the audit log; access user content only for support, moderation, or security purposes.
      </p>

      {viewMode === "mindmap" ? (
        <React.Suspense
          fallback={
            <div className="flex items-center justify-center h-[60vh] min-h-[420px]">
              <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
            </div>
          }
        >
          <NeuronGraph
            wikis={rows as unknown as WikiWithStats[]}
            lockedIds={EMPTY_LOCKED}
            activeWikiId={activeWikiId}
            onSelect={(w) => handleSelect(w as unknown as AdminWikiRow)}
          />
        </React.Suspense>
      ) : (
        grouped.map(([email, list]) => (
          <div key={email}>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-sm font-bold text-foreground">{email}</span>
              <span className="text-xs text-on-surface-variant">
                {list.length} neuron{list.length === 1 ? "" : "s"} ·{" "}
                {list.reduce((s, w) => s + w.entry_count, 0)} entries
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {list.map((w) => (
                <WikiCardCompact
                  key={w.id}
                  wiki={w as unknown as WikiWithStats}
                  isActive={w.id === activeWikiId}
                  onClick={() => handleSelect(w)}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {/* Foreign neuron preview (audit-logged server-side) */}
      <Dialog open={!!foreign} onOpenChange={(o) => !o && setForeign(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {foreign && (
            <>
              <div
                className="h-16 -mx-6 -mt-6 mb-2 rounded-t-lg"
                style={{ background: `linear-gradient(135deg, ${foreign.cover_color}, ${foreign.cover_color}88)` }}
              />
              <DialogHeader>
                <DialogTitle className="text-2xl font-headline">{foreign.name}</DialogTitle>
                <DialogDescription>
                  {foreign.owner_email} · {foreign.entry_count} entries · created{" "}
                  {new Date(foreign.created_at).toLocaleDateString()}. This access was recorded in
                  the audit log.
                </DialogDescription>
              </DialogHeader>
              {!entries ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
                </div>
              ) : entries.length === 0 ? (
                <p className="text-sm text-on-surface-variant py-4">This neuron has no entries.</p>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {entries.map((e) => (
                    <div key={e.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-bold text-sm text-foreground">{e.title}</div>
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          {e.entry_type}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface-variant line-clamp-3 mt-1 whitespace-pre-wrap">
                        {e.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

// =====================================================
// SearchResults: groups semantic matches by wiki and offers "Load this wiki" CTA per group.
// =====================================================

const SearchResults: React.FC<{
  results: SemanticSearchMatch[];
  wikis: WikiWithStats[];
  activeWikiId: string | null;
  onJumpToWiki: (wikiId: string) => Promise<void>;
  onBackfill: () => Promise<void>;
  backfilling: boolean;
}> = ({ results, wikis, activeWikiId, onJumpToWiki, onBackfill, backfilling }) => {
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant gap-4">
        <Search className="w-10 h-10" />
        <div className="text-center max-w-sm space-y-2">
          <p className="text-sm">No matches yet.</p>
          <p className="text-xs">
            If you just added entries — or imported them before semantic search existed — they may not be embedded yet.
          </p>
        </div>
        <Button onClick={onBackfill} disabled={backfilling} variant="secondary" className="gap-2">
          {backfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Embed entries
        </Button>
      </div>
    );
  }

  // Group by wiki id
  const groups = new Map<string, SemanticSearchMatch[]>();
  for (const m of results) {
    const key = m.wiki_id || "_unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return (
    <div className="space-y-6">
      <div className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
        {results.length} match{results.length === 1 ? "" : "es"} across {groups.size} neuron{groups.size === 1 ? "" : "s"}
      </div>
      {Array.from(groups.entries()).map(([wikiId, matches]) => {
        const wiki = wikis.find((w) => w.id === wikiId);
        const isActive = wikiId === activeWikiId;
        const color = matches[0].wiki_color || wiki?.cover_color || "#7C3AED";
        const name = matches[0].wiki_name || wiki?.name || "Unassigned";
        return (
          <div key={wikiId} className="bg-surface-container-high rounded-xl border border-outline-variant/10 overflow-hidden">
            <div
              className="flex items-center justify-between px-5 py-3"
              style={{ background: `linear-gradient(90deg, ${color}22, transparent)` }}
            >
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full" style={{ background: color }} />
                <div>
                  <div className="font-headline font-bold text-lg text-foreground">{name}</div>
                  <div className="text-xs text-on-surface-variant">
                    {matches.length} match{matches.length === 1 ? "" : "es"}
                  </div>
                </div>
              </div>
              {wiki && wikiId !== "_unassigned" && (
                <Button
                  size="sm"
                  variant={isActive ? "ghost" : "default"}
                  onClick={() => onJumpToWiki(wikiId)}
                  className="gap-1"
                  disabled={isActive}
                >
                  {isActive ? "Active" : (<>Load <ArrowRight className="w-3 h-3" /></>)}
                </Button>
              )}
            </div>
            <div className="divide-y divide-outline-variant/10">
              {matches.map((m) => (
                <div key={m.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div className="font-bold text-foreground line-clamp-1">{m.title}</div>
                    <div className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-primary">
                      {Math.round(m.similarity * 100)}% match
                    </div>
                  </div>
                  <div className="text-sm text-on-surface-variant line-clamp-2">{m.content}</div>
                  {m.tags.length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {m.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="bg-surface-container-highest px-2 py-0.5 rounded text-[10px] font-bold text-secondary uppercase tracking-wider">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default WikiLibrary;
