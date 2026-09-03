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
import { bookContextStore, isEmptySelection, selectContextBooks } from "@/lib/chatBooks";
import type { NeuronChoice } from "@/lib/counselFocus";

/**
 * Shown when the user loads something from the Vault — a book, a shelf, or a
 * hand-picked pile. It lets them choose which neuron (knowledge wiki) — or
 * which saved neuron CHAIN — Counsel/the AI should draw on alongside it, and
 * says plainly what the load REPLACES (docs/library-agent.md §1: loading
 * replaces the loaded books; the reader is untouched by a shelf load; a book
 * load can open the book ALONGSIDE the loaded shelf instead).
 *
 * UX shaped by research (see the load-sync research pass):
 *  - The currently-active neuron is PRE-SELECTED as a smart default
 *    (default-effect — Thaler/Sunstein; Johnson & Goldstein 2003), so the
 *    common path is a single confirm rather than a cold choice.
 *  - The dialog is fully SKIPPABLE (Skip button, Esc, X, outside-click). The
 *    load happens regardless of the choice — picking a neuron never blocks
 *    the primary action (NN/g modal guidance; Mark et al. CHI 2008 on the
 *    real cost of forced interruptions).
 *  - The replacement is never a second confirmation: it is stated in the
 *    dialog the user is already in, and undone from the toast that follows
 *    (routine confirmations habituate within days — Vance et al. MISQ 2018).
 *  - Locked neurons (free plan) stay visible but route to the pricing upsell,
 *    mirroring WikiQuickSwitcher and the BRAIN tab.
 */

type Selection = { kind: "wiki"; id: string } | { kind: "chain"; id: string } | null;

const LoadNeuronDialog: React.FC = () => {
  const { pendingLoad, books, shelves, wikis, activeWikiId, activeBookId, resolveLoad } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { chains } = useChains();

  const open = pendingLoad !== null;
  const book = pendingLoad?.kind === "book" ? books.find((b) => b.id === pendingLoad.bookId) : undefined;
  const shelf = pendingLoad?.kind === "shelf" ? shelves.find((f) => f.id === pendingLoad.shelfId) : undefined;
  const pileLabel = pendingLoad?.kind === "books" ? pendingLoad.label : undefined;

  // What this load would replace or leave in place — read from the same
  // store the load writes, so the sentence is about the real state.
  const current = bookContextStore.get();
  const loadedLabel = useMemo(() => {
    if (isEmptySelection(current)) return null;
    if (current.shelfId) {
      const f = shelves.find((s) => s.id === current.shelfId);
      return f ? `shelf “${f.name}”` : "the loaded shelf";
    }
    return `${current.bookIds.length} hand-picked book${current.bookIds.length === 1 ? "" : "s"}`;
  }, [current, shelves]);
  // Book load: is the book already part of what is loaded? Then nothing is
  // replaced and no "alongside" choice is needed.
  const bookIsMember = useMemo(() => {
    if (pendingLoad?.kind !== "book" || isEmptySelection(current)) return false;
    return selectContextBooks(books, current, pendingLoad.bookId).some((b) => b.id === pendingLoad.bookId);
  }, [pendingLoad, current, books]);
  const offerAlongside = pendingLoad?.kind === "book" && loadedLabel !== null && !bookIsMember;
  // Shelf/pile load: the reader's book drops out of Counsel's focus unless it
  // is a member of what is being loaded.
  const readerBook = activeBookId ? books.find((b) => b.id === activeBookId) : undefined;
  const readerStopsBeingDiscussed = useMemo(() => {
    if (!pendingLoad || pendingLoad.kind === "book" || !readerBook) return false;
    const nextSel = pendingLoad.kind === "shelf"
      ? { shelfId: pendingLoad.shelfId, bookIds: [], excludedIds: [] }
      : { shelfId: null, bookIds: pendingLoad.bookIds, excludedIds: [] };
    return !selectContextBooks(books, nextSel, readerBook.id).some((b) => b.id === readerBook.id);
  }, [pendingLoad, readerBook, books]);

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

  // Re-seed the default each time the dialog opens for a new load.
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

  /** The neuron choice the load carries. The current neuron re-selected is a
   *  keep (no redundant round trip); a chain resolves to its live members. */
  const choice = (): NeuronChoice => {
    if (!selected) return { kind: "keep" };
    if (selected.kind === "chain") {
      const chain = chains.find((c) => c.id === selected.id);
      if (!chain) return { kind: "keep" };
      // Deleted neurons cascade out of chains — only pass live members.
      const liveIds = chain.wiki_ids.filter((id) => wikiById.has(id));
      if (liveIds.length === 0) {
        toast.error(`The neurons in "${chain.name}" have been deleted — continuing with your current neuron.`);
        return { kind: "keep" };
      }
      touchChainUsed(chain.id);
      return { kind: "chain", ids: liveIds };
    }
    return selected.id === activeWikiId ? { kind: "keep" } : { kind: "wiki", id: selected.id };
  };

  const handleLoad = () => void resolveLoad(choice());
  const handleAlongside = () => void resolveLoad(choice(), { alongside: true });
  const handleSkip = () => void resolveLoad({ kind: "keep" });

  const subject = book
    ? `“${book.title}”`
    : shelf
      ? `shelf “${shelf.name}”`
      : pileLabel
        ? pileLabel
        : "this";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleSkip(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">
            Load a neuron alongside {subject}?
          </DialogTitle>
          <DialogDescription>
            Pick the knowledge neuron — or a saved chain of neurons — Counsel
            should draw on. Your current neuron is pre-selected — skip to keep it.
          </DialogDescription>
        </DialogHeader>

        {/* What this load replaces — stated, never silent (L1). */}
        {(offerAlongside || readerStopsBeingDiscussed || (pendingLoad?.kind !== "book" && loadedLabel)) && (
          <p
            data-testid="load-replaces"
            className="rounded-md bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant"
          >
            {pendingLoad?.kind === "book" && offerAlongside && (
              <>“Load &amp; open” makes this book Counsel’s focus and unloads {loadedLabel}. “Open alongside” keeps {loadedLabel} loaded and only opens the reader.</>
            )}
            {pendingLoad?.kind !== "book" && loadedLabel && (
              <>This replaces {loadedLabel}. </>
            )}
            {readerStopsBeingDiscussed && readerBook && (
              <>Counsel will stop discussing “{readerBook.title}” (it stays open in the reader).</>
            )}
            {" "}You can undo from the message that follows.
          </p>
        )}

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
          <Button variant="outline" onClick={handleSkip}>
            Skip
          </Button>
          {offerAlongside && (
            <Button variant="secondary" onClick={handleAlongside} disabled={selectedLocked}>
              Open alongside
            </Button>
          )}
          <Button onClick={handleLoad} disabled={!selected || selectedLocked}>
            Load &amp; open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LoadNeuronDialog;
