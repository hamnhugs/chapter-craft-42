import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Check, Plus, ArrowLeft, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  fetchCatalog,
  isFreeModel,
  pricePerMillion,
  formatContext,
  OR_CATEGORIES,
  type ORModel,
} from "@/lib/openrouterCatalog";

// Ranked live from OpenRouter's public API — the same usage data behind
// openrouter.ai/rankings. "Top overall" / categories return the weekly-usage
// leaders, so the page stays current with zero manual curation.

type ViewKey = "top" | "newest" | (typeof OR_CATEGORIES)[number];

const CATEGORY_LABELS: Record<string, string> = {
  "marketing/seo": "SEO",
};

const labelFor = (key: string) =>
  CATEGORY_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);

const ModelExplorer: React.FC = () => {
  const { savedModels, addModel, loaded } = useChatSettings();
  const [view, setView] = useState<ViewKey>("top");
  const [models, setModels] = useState<ORModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setError(null);
    (async () => {
      try {
        const list = await fetchCatalog(
          view === "top"
            ? { sort: "top-weekly" }
            : view === "newest"
              ? { sort: "newest" }
              : { category: view, sort: "top-weekly" },
        );
        if (!cancelled) setModels(list.slice(0, 50));
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load models");
      }
    })();
    return () => { cancelled = true; };
  }, [view, reloadKey]);

  const visible = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (freeOnly && !isFreeModel(m)) return false;
      if (q && !`${m.id} ${m.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [models, freeOnly, query]);

  const handleAdd = (m: ORModel) => {
    addModel(m.id);
  };

  return (
    <div className="min-h-screen bg-background overflow-y-auto">
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 pb-24">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm font-body text-on-surface-variant hover:text-primary transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Bookworm
        </Link>

        <div className="space-y-2 mb-8">
          <span className="px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded text-[10px] font-bold tracking-widest uppercase">
            Live from OpenRouter
          </span>
          <h1 className="font-headline font-bold text-4xl sm:text-5xl text-primary tracking-tight">
            Top Models
          </h1>
          <p className="text-on-surface-variant max-w-2xl">
            Ranked by real weekly usage across OpenRouter. Pick a category to see what people actually use
            for that kind of work, then add any model to your list — it appears in Counsel's model picker instantly.
          </p>
        </div>

        {/* View chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 hide-scrollbar mb-3">
          {([
            { key: "top" as ViewKey, label: "Top overall" },
            { key: "newest" as ViewKey, label: "Newest" },
            ...OR_CATEGORIES.map((c) => ({ key: c as ViewKey, label: labelFor(c) })),
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-bold transition-colors ${
                view === key
                  ? "bg-primary-container text-on-primary-container ring-1 ring-primary/20"
                  : "bg-surface-container-high text-on-surface-variant hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name…"
              className="w-full bg-surface-container-high border-none rounded-xl py-2.5 pl-10 pr-4 text-sm focus:ring-1 focus:ring-primary/40 placeholder:text-on-surface-variant/50"
            />
          </div>
          <label className="flex items-center gap-2.5 shrink-0 px-3 py-2 rounded-xl bg-surface-container-high cursor-pointer">
            <span className="text-xs font-bold text-on-surface-variant">Free models only</span>
            <Switch checked={freeOnly} onCheckedChange={setFreeOnly} aria-label="Show free models only" />
          </label>
        </div>

        {/* List */}
        {error ? (
          <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
            <span className="material-symbols-outlined text-5xl opacity-40">cloud_off</span>
            <p className="text-sm">{error}</p>
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>Retry</Button>
          </div>
        ) : models === null ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
          </div>
        ) : visible.length === 0 ? (
          <p className="text-center text-sm text-on-surface-variant py-16">
            No models match{freeOnly ? " — try turning off the free-only filter" : ""}.
          </p>
        ) : (
          <div className="space-y-3">
            {visible.map((m, idx) => {
              const saved = savedModels.includes(m.id);
              const free = isFreeModel(m);
              return (
                <div
                  key={m.id}
                  className="flex items-start gap-3 sm:gap-4 p-4 rounded-xl bg-surface-container-high border border-outline-variant/10"
                >
                  <span className="shrink-0 w-7 text-center font-headline font-bold text-lg text-on-surface-variant/60">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-foreground leading-tight">{m.name}</h3>
                      {free && (
                        <span className="px-1.5 py-0.5 rounded bg-primary-container/25 text-primary text-[9px] font-bold uppercase tracking-widest">
                          Free
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-on-surface-variant truncate">{m.id}</div>
                    {m.description && (
                      <p className="text-xs text-on-surface-variant mt-1.5 line-clamp-2">{m.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                      <span title="Context window">{formatContext(m.context_length)} ctx</span>
                      <span className="text-outline-variant">•</span>
                      <span title="Price per million input / output tokens">
                        {free ? "Free to use" : `${pricePerMillion(m.pricing.prompt)} in / ${pricePerMillion(m.pricing.completion)} out per 1M`}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={saved ? "outline" : "default"}
                    disabled={saved || !loaded}
                    onClick={() => handleAdd(m)}
                    className="shrink-0 gap-1.5 mt-1"
                  >
                    {saved ? (
                      <>
                        <Check className="w-3.5 h-3.5" /> Added
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5" /> Add to my list
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-on-surface-variant text-center mt-8">
          Rankings come straight from OpenRouter's public usage data and refresh hourly. Prices are set by
          OpenRouter and billed to your own account — Bookworm never marks them up.
        </p>
      </main>
    </div>
  );
};

export default ModelExplorer;
