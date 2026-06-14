import React, { useEffect, useMemo, useState } from "react";
import { Check, Sparkles, Lock } from "lucide-react";
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

/**
 * Shown when the user loads a book from the Vault. It lets them choose which
 * neuron (knowledge wiki) Counsel/the AI should draw on while reading, and
 * loads it alongside the book.
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
const LoadNeuronDialog: React.FC = () => {
  const { pendingBookLoadId, books, wikis, activeWikiId, resolveBookLoad } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();

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

  const [selected, setSelected] = useState<string | null>(activeWikiId);

  // Re-seed the default each time the dialog opens for a new book.
  useEffect(() => {
    if (open) setSelected(activeWikiId);
  }, [open, activeWikiId]);

  const choose = (id: string) => {
    if (lockedIds.has(id)) {
      openPricing("neuron-locked");
      return;
    }
    setSelected(id);
  };

  const selectedLocked = !!selected && lockedIds.has(selected);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resolveBookLoad(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">
            Load a neuron alongside{book ? ` “${book.title}”` : " this book"}?
          </DialogTitle>
          <DialogDescription>
            Pick the knowledge neuron Counsel should draw on while you read. Your
            current neuron is pre-selected — skip to keep it.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-auto -mx-1 px-1 py-1 space-y-1">
          {sorted.map((wiki) => {
            const isLocked = lockedIds.has(wiki.id);
            const isSel = selected === wiki.id;
            return (
              <button
                key={wiki.id}
                type="button"
                onClick={() => choose(wiki.id)}
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
          <Button
            onClick={() => resolveBookLoad(selected)}
            disabled={!selected || selectedLocked}
          >
            Load &amp; open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LoadNeuronDialog;
