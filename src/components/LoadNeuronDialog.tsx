import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Sparkles, Lock, Link2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApp } from "@/context/AppContext";
import { usePlan } from "@/hooks/usePlan";
import { computeLockedWikiIds } from "@/lib/neuronAccess";
import { openPricing } from "@/components/PricingDialog";
import { useChains, touchChainUsed } from "@/lib/chainsApi";

/**
 * Shown when the user loads a book from the Vault. It lets them choose which
 * neuron (knowledge wiki) — or which saved neuron CHAIN — Counsel/the AI
 * should draw on while reading, and loads it alongside the book.
 *
 * UX shaped by research (see the load-sync research pass):
 *  - The currently-active neuron is PRE-SELECTED as a smart default
 *    (default-effect — Thaler/Sunstein; Johnson & Goldstein 2003), so the
 *    common path is a single confirm rather than a cold choice.
 *  - The dialog is fully SKIPPABLE (Skip button, Esc, X, outside-click). The
 *    book opens regardless of the choice — picking a neuron never blocks the
 *    primary "open" action (NN/g modal guidance; Mark et al. CHI 2008 on the
 *    real cost of forced interruptions).
 *  - Locked neurons (free plan) stay visible but route to the pricing upsell,
 *    mirroring WikiQuickSwitcher and the BRAIN tab.
 */

type Selection = { kind: "wiki"; id: string } | { kind: "chain"; id: string } | null;

const LoadNeuronDialog: React.FC = () => {
  const { pendingBookLoadId, books, wikis, activeWikiId, resolveBookLoad } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { chains } = useChains();

  const open = pendingBookLoadId !== null;
  const book = books.find((b) => b.id === pendingBookLoadId);

  const lockedIds = useMemo(
    () => computeLockedWikiIds(wikis, isPaid, planLoaded),
    [wikis, isPaid, planLoaded],
  );

  // Active first, then most recently loaded, then alphabetical — same order as
  // the Cmd+K switcher so the list feels familiar.
  const sorted = useMemo(() => {
    return [...wikis].sort((a, b) => {
      if (a.id === activeWikiId) return -1;
      if (b.id === activeWikiId) return 1;
      const at = a.last_loaded_at ? new Date(a.last_loaded_at).getTime() : 0;
      const bt = b.last_loaded_at ? new Date(b.last_loaded_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name);
    });
  }, [wikis, activeWikiId]);

  const wikiById = useMemo(() => new Map(wikis.map((w) => [w.id, w])), [wikis]);

  const [selected, setSelected] = useState<Selection>(activeWikiId ? { kind: "wiki", id: activeWikiId } : null);

  // Re-seed the default each time the dialog opens for a new book.
  useEffect(() => {
    if (open) setSelected(activeWikiId ? { kind: "wiki", id: activeWikiId } : null);
  }, [open, activeWikiId]);

  const chooseWiki = (id: string) => {
    if (lockedIds.has(id)) {
      openPricing("neuron-locked");
      return;
    }
    setSelected({ kind: "wiki", id });
  };

  const chooseChain = (id: string) => {
    const chain = chains.find((c) => c.id === id);
    if (chain && chain.wiki_ids.some((wid) => lockedIds.has(wid))) {
      openPricing("neuron-chains");
      return;
    }
    setSelected({ kind: "chain", id });
  };

  const selectedLocked =
    !!selected &&
    (selected.kind === "wiki"
      ? lockedIds.has(selected.id)
      : (chains.find((c) => c.id === selected.id)?.wiki_ids || []).some((wid) => lockedIds.has(wid)));

  const handleLoad = () => {
    if (!selected) return;
    if (selected.kind === "chain") {
      const chain = chains.find((c) => c.id === selected.id);
      if (chain) {
        // Deleted neurons cascade out of chains — only pass live members.
        const liveIds = chain.wiki_ids.filter((id) => wikiById.has(id));
        if (liveIds.length === 0) {
          toast.error(`The neurons in "${chain.name}" have been deleted — opening the book with your current neuron.`);
          resolveBookLoad(null);
          return;
        }
        touchChainUsed(chain.id);
        resolveBookLoad(null, liveIds);
        return;
      }
    }
    resolveBookLoad(selected.kind === "wiki" ? selected.id : null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resolveBookLoad(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">
            Load a neuron alongside{book ? ` “${book.title}”` : " this book"}?
          </DialogTitle>
          <DialogDescription>
            Pick the knowledge neuron — or a saved chain of neurons — Counsel
            should draw on while you read. Your current neuron is pre-selected —
            skip to keep it.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-auto -mx-1 px-1 py-1 space-y-1">
          {chains.length > 0 && (
            <>
              <div className="px-3 pt-1 pb-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Chains
              </div>
              {chains.map((chain) => {
                const isSel = selected?.kind === "chain" && selected.id === chain.id;
                const isLocked = chain.wiki_ids.some((wid) => lockedIds.has(wid));
                return (
                  <button
                    key={chain.id}
                    type="button"
                    onClick={() => chooseChain(chain.id)}
                    aria-pressed={isSel}
                    className={`w-full flex items-center gap-3 py-2.5 px-3 rounded-lg text-left transition-colors border ${
                      isSel ? "border-primary/50 bg-primary/10" : "border-transparent hover:bg-muted/50"
                    } ${isLocked ? "opacity-60" : ""}`}
                  >
                    <Link2 className="w-3.5 h-3.5 shrink-0" style={{ color: chain.cover_color }} />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium truncate block">{chain.name}</span>
                      <div className="flex items-center gap-1 mt-0.5">
                        {chain.wiki_ids.map((wid) => (
                          <span
                            key={wid}
                            className="w-2 h-2 rounded-full"
                            style={{ background: wikiById.get(wid)?.cover_color || "#7C3AED" }}
                          />
                        ))}
                        <span className="text-[10px] text-muted-foreground ml-1">
                          {chain.wiki_ids.length} neurons load together
                        </span>
                      </div>
                    </div>
                    {isLocked ? (
                      <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground shrink-0">
                        <Lock className="w-3 h-3" /> Locked
                      </span>
                    ) : isSel ? (
                      <Check className="w-4 h-4 text-primary shrink-0" />
                    ) : null}
                  </button>
                );
              })}
              <div className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Neurons
              </div>
            </>
          )}
          {sorted.map((wiki) => {
            const isLocked = lockedIds.has(wiki.id);
            const isSel = selected?.kind === "wiki" && selected.id === wiki.id;
            return (
              <button
                key={wiki.id}
                type="button"
                onClick={() => chooseWiki(wiki.id)}
                aria-pressed={isSel}
                className={`w-full flex items-center gap-3 py-2.5 px-3 rounded-lg text-left transition-colors border ${
                  isSel
                    ? "border-primary/50 bg-primary/10"
                    : "border-transparent hover:bg-muted/50"
                } ${isLocked ? "opacity-60" : ""}`}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: wiki.cover_color || "#7C3AED" }}
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{wiki.name}</span>
                    {wiki.is_meta && (
                      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-primary">
                        <Sparkles className="w-2.5 h-2.5" /> Meta
                      </span>
                    )}
                    {wiki.id === activeWikiId && (
                      <span className="text-[9px] font-bold uppercase tracking-widest text-on-surface-variant">
                        current
                      </span>
                    )}
                  </div>
                  {wiki.description && (
                    <div className="text-xs text-muted-foreground truncate">{wiki.description}</div>
                  )}
                </div>
                {isLocked ? (
                  <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground shrink-0">
                    <Lock className="w-3 h-3" /> Locked
                  </span>
                ) : isSel ? (
                  <Check className="w-4 h-4 text-primary shrink-0" />
                ) : null}
              </button>
            );
          })}
          {sorted.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No neurons yet — open the book and create one in the BRAIN tab.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => resolveBookLoad(null)}>
            Skip
          </Button>
          <Button onClick={handleLoad} disabled={!selected || selectedLocked}>
            Load &amp; open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LoadNeuronDialog;
