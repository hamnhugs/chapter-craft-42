import React, { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Check, Lock, Plus, Minus, Link2, Pencil } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useApp } from "@/context/AppContext";
import { usePlan } from "@/hooks/usePlan";
import { computeLockedWikiIds, MAX_ACTIVE_NEURONS } from "@/lib/neuronAccess";
import { openPricing } from "@/components/PricingDialog";
import { openChainDialog } from "@/components/ChainDialog";
import { useChains, touchChainUsed, NeuronChain } from "@/lib/chainsApi";
import { isSystemWiki } from "@/lib/wikisApi";

// Global keyboard-driven wiki switcher. Toggle with Cmd+K (Mac) / Ctrl+K (others).
// Listens for keydown anywhere; ignores input/textarea/contenteditable focus
// so it doesn't fight with normal in-field shortcuts.
//
// Selecting a notebook switches Counsel to it (replaces the loaded set),
// except when opened from Counsel's "+" chip ("add" mode), where it is added
// alongside. The +/− button on each row adds/removes a secondary notebook
// without closing the palette, and the saved-sets group activates a set in
// one hit.

const isEditable = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
};

/** Other surfaces (e.g. the chat panel's "+" chip) can open the palette. */
export const OPEN_NEURON_SWITCHER_EVENT = "open-neuron-switcher";

const WikiQuickSwitcher: React.FC = () => {
  const { wikis, activeWikiId, activeWikiIds, setActiveWiki, setActiveNeurons, toggleNeuronInSession, setActiveTab } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { chains } = useChains();
  const [open, setOpen] = useState(false);
  // "add": opened from Counsel's "+" chip — picking a notebook adds it to what
  // Counsel is using instead of replacing it.
  const [mode, setMode] = useState<"switch" | "add">("switch");

  // Locked neurons (free plan) stay visible but can't be loaded — same rule
  // as the BRAIN tab cards and the database itself.
  const lockedIds = useMemo(
    () => computeLockedWikiIds(wikis, isPaid, planLoaded),
    [wikis, isPaid, planLoaded],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isToggle = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (isToggle) {
        // A chat-media fullscreen owns the whole screen (top layer, or the
        // z-[100] overlay fallback) — the palette would open invisibly behind
        // it and steal focus into a hidden input. Stand down until it closes.
        if (
          document.fullscreenElement ||
          (document as any).webkitFullscreenElement ||
          document.documentElement.classList.contains("cc-media-overlay-open")
        ) return;
        // Allow Cmd+K to work even from inputs — it's a global command-palette convention.
        e.preventDefault();
        setMode("switch");
        setOpen((prev) => !prev);
        return;
      }
      // Esc closes — but only if no input is focused, so we don't interfere with form Esc behavior.
      if (e.key === "Escape" && open && !isEditable(document.activeElement)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  useEffect(() => {
    const openHandler = (e: Event) => {
      setMode((e as CustomEvent<{ mode?: "add" }>).detail?.mode === "add" ? "add" : "switch");
      setOpen(true);
    };
    window.addEventListener(OPEN_NEURON_SWITCHER_EVENT, openHandler);
    return () => window.removeEventListener(OPEN_NEURON_SWITCHER_EVENT, openHandler);
  }, []);

  const handleSelect = useCallback(
    async (wikiId: string) => {
      if (lockedIds.has(wikiId)) {
        setOpen(false);
        openPricing("neuron-locked");
        return;
      }
      try {
        await setActiveWiki(wikiId);
        const wiki = wikis.find((w) => w.id === wikiId);
        toast.success(wiki ? `Counsel is now using "${wiki.name}"` : "Counsel switched notebooks");
        setOpen(false);
      } catch (err: any) {
        toast.error(err.message || "Switch failed");
      }
    },
    [setActiveWiki, wikis, lockedIds]
  );

  // Add/remove a secondary neuron without closing the palette, so several
  // can be toggled in one visit (NN/g: multi-select toggles independently).
  const handleToggleInSession = useCallback(
    async (e: React.MouseEvent | null, wikiId: string) => {
      e?.preventDefault();
      e?.stopPropagation();
      if (lockedIds.has(wikiId)) {
        setOpen(false);
        openPricing("neuron-chains");
        return;
      }
      const wiki = wikis.find((w) => w.id === wikiId);
      try {
        const next = await toggleNeuronInSession(wikiId);
        const name = wiki ? `"${wiki.name}"` : "that notebook";
        if (!next.includes(wikiId)) {
          toast.success(`Counsel stopped using ${name}`);
        } else {
          toast.success(`Counsel is also using ${name} (${next.length} of ${MAX_ACTIVE_NEURONS})`);
          if (next.length === 4) {
            toast.info("More isn't always better — beyond 3 loaded notebooks, connections get diluted.", { id: "neuron-dilution-tip" });
          }
        }
      } catch (err: any) {
        toast.error(err.message || "Couldn't change Counsel's notebooks");
      }
    },
    [toggleNeuronInSession, wikis, lockedIds]
  );

  const handleActivateChain = useCallback(
    async (chain: NeuronChain) => {
      // A wiki delete cascades out of chain membership, so re-validate the
      // members against the live wiki list before activating.
      const liveIds = chain.wiki_ids.filter((id) => wikis.some((w) => w.id === id));
      if (liveIds.length === 0) {
        toast.error(`The notebooks in "${chain.name}" have been deleted — edit the set from its pencil in ⌘K.`);
        return;
      }
      if (liveIds.some((id) => lockedIds.has(id))) {
        setOpen(false);
        openPricing("neuron-chains");
        return;
      }
      try {
        await setActiveNeurons(liveIds);
        touchChainUsed(chain.id);
        toast.success(`Counsel is now using the set "${chain.name}" (${liveIds.length} notebook${liveIds.length === 1 ? "" : "s"})`);
        setOpen(false);
      } catch (err: any) {
        toast.error(err.message || "Couldn't switch to that set");
      }
    },
    [setActiveNeurons, lockedIds, wikis]
  );

  // Sort: active first, then most recently loaded, then name. The app's own
  // notebooks stay out of the way unless Counsel is using one.
  const sorted = wikis.filter((w) => !isSystemWiki(w) || activeWikiIds.includes(w.id)).sort((a, b) => {
    if (a.id === activeWikiId) return -1;
    if (b.id === activeWikiId) return 1;
    const aTime = a.last_loaded_at ? new Date(a.last_loaded_at).getTime() : 0;
    const bTime = b.last_loaded_at ? new Date(b.last_loaded_at).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });

  const wikiNameById = useMemo(() => new Map(wikis.map((w) => [w.id, w])), [wikis]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={mode === "add" ? "Add a notebook for Counsel — type to filter…" : "Switch Counsel's notebook — type to filter…"} />
      <CommandList>
        <CommandEmpty>No notebooks match.</CommandEmpty>
        {chains.length > 0 && (
          <CommandGroup heading="Saved sets">
            {chains.map((chain) => (
              <CommandItem
                key={chain.id}
                value={`saved set ${chain.name} ${chain.id}`}
                onSelect={() => handleActivateChain(chain)}
                className="flex items-center gap-3 py-2.5"
              >
                <Link2 className="w-3.5 h-3.5 shrink-0" style={{ color: chain.cover_color }} />
                <div className="flex-1 min-w-0">
                  <span className="font-medium truncate">{chain.name}</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    {chain.wiki_ids.slice(0, MAX_ACTIVE_NEURONS).map((id) => (
                      <span
                        key={id}
                        className="w-2 h-2 rounded-full"
                        style={{ background: wikiNameById.get(id)?.cover_color || "#7C3AED" }}
                        title={wikiNameById.get(id)?.name}
                      />
                    ))}
                    <span className="text-[10px] text-muted-foreground ml-1">
                      {chain.wiki_ids.length} notebooks
                    </span>
                  </div>
                </div>
                {/* Sets are edited here (and from the notebook's "Save as set"). */}
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    openChainDialog({ chain });
                  }}
                  title={`Edit "${chain.name}"`}
                  aria-label={`Edit saved set ${chain.name}`}
                  className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading={mode === "add" ? "Add for Counsel" : "Use with Counsel"}>
          {sorted.map((wiki) => {
            const isPrimary = wiki.id === activeWikiId;
            const isLoaded = activeWikiIds.includes(wiki.id);
            const isLocked = lockedIds.has(wiki.id);
            return (
              <CommandItem
                key={wiki.id}
                value={`${wiki.name} ${wiki.tags.join(" ")} ${wiki.id}`}
                onSelect={() => {
                  if (mode === "add" && !isPrimary) {
                    if (isLoaded) { setOpen(false); return; }
                    void handleToggleInSession(null, wiki.id).then(() => setOpen(false));
                    return;
                  }
                  void handleSelect(wiki.id);
                }}
                className="flex items-center gap-3 py-2.5"
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: wiki.cover_color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{wiki.name}</span>
                  </div>
                  {wiki.description && (
                    <div className="text-xs text-muted-foreground truncate">{wiki.description}</div>
                  )}
                </div>
                {isPrimary && (
                  <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-primary shrink-0">
                    <Check className="w-3 h-3" /> Saves here
                  </span>
                )}
                {!isPrimary && isLoaded && (
                  <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-primary/80 shrink-0">
                    <Check className="w-3 h-3" /> In use
                  </span>
                )}
                {isLocked ? (
                  <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground shrink-0">
                    <Lock className="w-3 h-3" /> Locked
                  </span>
                ) : !isPrimary ? (
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => handleToggleInSession(e, wiki.id)}
                    title={isLoaded ? "Stop using this one" : "Also use this one (keeps the others)"}
                    aria-label={isLoaded ? `Stop using ${wiki.name}` : `Also use ${wiki.name}`}
                    className="shrink-0 p-1 rounded-md border border-outline-variant/30 text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
                  >
                    {isLoaded ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  </button>
                ) : null}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandGroup heading="Navigate">
          {activeWikiIds.length >= 2 && (
            <CommandItem
              value="save loaded notebooks as saved set"
              onSelect={() => {
                setOpen(false);
                openChainDialog({ prefillIds: activeWikiIds });
              }}
            >
              <Link2 className="w-3.5 h-3.5 mr-2" />
              Save these {activeWikiIds.length} notebooks as a set…
            </CommandItem>
          )}
          <CommandItem
            value="all notebooks list library"
            onSelect={() => {
              setActiveTab("wikis");
              setOpen(false);
            }}
          >
            All notebooks →
          </CommandItem>
          <CommandItem
            value="open current notebook notes"
            onSelect={() => {
              setActiveTab("wiki");
              setOpen(false);
            }}
          >
            Open this notebook's notes →
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
};

export default WikiQuickSwitcher;
