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
import {
  fetchNvidiaCatalog,
  namespacedNvidiaId,
  SHARED_WITH_OPENROUTER,
  type NvidiaModelInfo,
} from "@/lib/nvidiaCatalog";

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
  const { savedModels, nvidiaKeyLast4, addModel, loaded } = useChatSettings();
  const [provider, setProvider] = useState<"openrouter" | "nvidia">("openrouter");
  const [view, setView] = useState<ViewKey>("top");
  const [models, setModels] = useState<ORModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nvModels, setNvModels] = useState<NvidiaModelInfo[] | null>(null);
  const [nvError, setNvError] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // Separate counter: a failed NVIDIA retry must not also blow away a
  // perfectly good OpenRouter list (their fetches share nothing else).
  const [nvReloadKey, setNvReloadKey] = useState(0);

  useEffect(() => {
    if (provider !== "nvidia" || nvModels !== null) return;
    let cancelled = false;
    setNvError(null);
    (async () => {
      try {
        const list = await fetchNvidiaCatalog();
        if (!cancelled) setNvModels(list);
      } catch (err: any) {
        if (!cancelled) setNvError(err.message || "Failed to load NVIDIA models");
      }
    })();
    return () => { cancelled = true; };
  }, [provider, nvModels, nvReloadKey]);

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
            {provider === "nvidia" ? "Served by NVIDIA" : "Served by OpenRouter"}
          </span>
          <h1 className="font-headline font-bold text-4xl sm:text-5xl text-primary tracking-tight">
            Top Models
          </h1>
          <p className="text-on-surface-variant max-w-2xl">
            {provider === "nvidia"
              ? "Models NVIDIA hosts — mostly other companies' open models (Llama, DeepSeek, GPT-OSS, Gemma), free with an NVIDIA key and no balance required. Adding from this tab tags them as NVIDIA so they route correctly."
              : "Ranked by real weekly usage across OpenRouter. Pick a category to see what people actually use for that kind of work, then add any model to your list — it appears in Counsel's model picker instantly."}
          </p>
        </div>

        {/* Provider tabs */}
        <div className="flex items-center gap-2 mb-4">
          {([
            { key: "openrouter" as const, label: "OpenRouter" },
            { key: "nvidia" as const, label: "NVIDIA" },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setProvider(key)}
              className={`px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
                provider === key
                  ? "bg-primary-container text-on-primary-container ring-1 ring-primary/20"
                  : "bg-surface-container-high text-on-surface-variant hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* View chips (OpenRouter rankings only — NVIDIA has no usage data) */}
        {provider === "openrouter" && (
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
        )}

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
          {provider === "openrouter" && (
          <label className="flex items-center gap-2.5 shrink-0 px-3 py-2 rounded-xl bg-surface-container-high cursor-pointer">
            <span className="text-xs font-bold text-on-surface-variant">Free models only</span>
            <Switch checked={freeOnly} onCheckedChange={setFreeOnly} aria-label="Show free models only" />
          </label>
          )}
        </div>

        {/* NVIDIA list */}
        {provider === "nvidia" ? (
          nvError ? (
            <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3">
              <span className="material-symbols-outlined text-5xl opacity-40">cloud_off</span>
              <p className="text-sm text-center max-w-md">{nvError}</p>
              <Button variant="outline" onClick={() => { setNvModels(null); setNvReloadKey((k) => k + 1); }}>Retry</Button>
            </div>
          ) : nvModels === null ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-on-surface-variant" />
            </div>
          ) : (
            <div className="space-y-3">
              {!nvidiaKeyLast4 && (
                <div className="p-3.5 rounded-xl bg-primary-container/10 border border-primary/20 text-sm text-on-surface-variant">
                  Browsing works without a key, but chatting needs one — free at{" "}
                  <a href="https://build.nvidia.com/settings/api-keys" target="_blank" rel="noreferrer" className="text-primary underline">build.nvidia.com</a>,
                  then paste it in Settings → AI Models &amp; Keys.
                </div>
              )}
              {nvModels
                .filter((m) => {
                  const q = query.trim().toLowerCase();
                  return !q || `${m.localId} ${m.label}`.toLowerCase().includes(q);
                })
                .map((m) => {
                  const nsId = namespacedNvidiaId(m.localId);
                  const saved = savedModels.includes(nsId);
                  return (
                    <div
                      key={m.localId}
                      className="flex items-start gap-3 sm:gap-4 p-4 rounded-xl bg-surface-container-high border border-outline-variant/10"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-foreground leading-tight">{m.label}</h3>
                          <span className="px-1.5 py-0.5 rounded bg-primary-container/25 text-primary text-[9px] font-bold uppercase tracking-widest">
                            NVIDIA
                          </span>
                          {m.featured && (
                            <span className="px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant text-[9px] font-bold uppercase tracking-widest">
                              Featured
                            </span>
                          )}
                          {SHARED_WITH_OPENROUTER.has(m.localId) && (
                            <span
                              title="OpenRouter lists a model with this exact name too — adding it here binds it to NVIDIA."
                              className="px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant text-[9px] font-bold uppercase tracking-widest"
                            >
                              Also on OpenRouter
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-on-surface-variant truncate">{m.localId}</div>
                        {m.note && (
                          <p className="text-xs text-on-surface-variant mt-1.5 line-clamp-2">{m.note}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          {m.contextLength ? <span title="Context window">{formatContext(m.contextLength)} ctx</span> : <span title="Context window unknown">— ctx</span>}
                          {m.caps.tools && (<><span className="text-outline-variant">•</span><span title="Supports the app's tools (memory, books, images)">tools</span></>)}
                          {m.caps.vision && (<><span className="text-outline-variant">•</span><span title="Understands attached images">vision</span></>)}
                          {m.caps.reasoning && (<><span className="text-outline-variant">•</span><span title="Shows its thinking">reasoning</span></>)}
                          <span className="text-outline-variant">•</span>
                          <span title="Free with an NVIDIA key; usage is rate-limited rather than billed">free · rate-limited</span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={saved ? "outline" : "default"}
                        disabled={saved || !loaded}
                        onClick={() => addModel(nsId)}
                        className="shrink-0 gap-1.5 mt-1"
                      >
                        {saved ? (<><Check className="w-3.5 h-3.5" /> Added</>) : (<><Plus className="w-3.5 h-3.5" /> Add to my list</>)}
                      </Button>
                    </div>
                  );
                })}
            </div>
          )
        ) : error ? (
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
          {provider === "nvidia"
            ? "NVIDIA models are free with a build.nvidia.com key — no balance, no card. Usage is governed by rate limits that vary by model and traffic. Chat, voice and vision work on NVIDIA; image/video generation stays on OpenRouter."
            : "Rankings come straight from OpenRouter's public usage data and refresh hourly. Prices are set by OpenRouter and billed to your own account — Bookworm never marks them up. OpenRouter also requires a lifetime top-up (about $10) before its :free models will run."}
        </p>
      </main>
    </div>
  );
};

export default ModelExplorer;
