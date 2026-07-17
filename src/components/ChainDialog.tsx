import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { useApp } from "@/context/AppContext";
import { usePlan } from "@/hooks/usePlan";
import { computeLockedWikiIds, MAX_ACTIVE_NEURONS } from "@/lib/neuronAccess";
import { openPricing } from "@/components/PricingDialog";
import {
  NeuronChain,
  createChain,
  updateChain,
  deleteChain,
  emitChainsChanged,
  isChainsMigrationMissing,
  CHAINS_MIGRATION_MESSAGE,
} from "@/lib/chainsApi";

// Create/edit dialog for neuron chains — named sets of neurons that load
// together. Opened from anywhere via the module-level openChainDialog()
// store (same pattern as PricingDialog): the BRAIN tab's Chains section, the
// ⌘K switcher, and the chat panel's "save these as a chain" affordance all
// share this one dialog, mounted once in Index.tsx.

const COVER_PALETTE = [
  "#7C3AED", "#2563EB", "#0EA5E9", "#10B981",
  "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6",
];

export interface ChainDialogRequest {
  /** Edit this chain (create mode when absent). */
  chain?: NeuronChain;
  /** Pre-selected member ids for create mode (e.g. the currently loaded set). */
  prefillIds?: string[];
}

let pendingRequest: ChainDialogRequest | null = null;
const openListeners = new Set<() => void>();

export function openChainDialog(req: ChainDialogRequest = {}) {
  pendingRequest = req;
  openListeners.forEach((l) => l());
}

const ChainDialog: React.FC = () => {
  const { wikis } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NeuronChain | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState(COVER_PALETTE[0]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const handler = () => {
      const req = pendingRequest || {};
      pendingRequest = null;
      setEditing(req.chain || null);
      setName(req.chain?.name || "");
      setDesc(req.chain?.description || "");
      setColor(req.chain?.cover_color || COVER_PALETTE[Math.floor(Math.random() * COVER_PALETTE.length)]);
      setSelectedIds(req.chain?.wiki_ids || req.prefillIds || []);
      setOpen(true);
    };
    openListeners.add(handler);
    return () => { openListeners.delete(handler); };
  }, []);

  const lockedIds = useMemo(
    () => computeLockedWikiIds(wikis, isPaid, planLoaded),
    [wikis, isPaid, planLoaded],
  );

  // Same familiar ordering as the ⌘K switcher / LoadNeuronDialog.
  const sortedWikis = useMemo(() => {
    return [...wikis].sort((a, b) => {
      const at = a.last_loaded_at ? new Date(a.last_loaded_at).getTime() : 0;
      const bt = b.last_loaded_at ? new Date(b.last_loaded_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name);
    });
  }, [wikis]);

  const toggleMember = (wikiId: string) => {
    if (lockedIds.has(wikiId)) {
      openPricing("neuron-chains");
      return;
    }
    setSelectedIds((prev) => {
      if (prev.includes(wikiId)) return prev.filter((id) => id !== wikiId);
      if (prev.length >= MAX_ACTIVE_NEURONS) {
        toast.info(`A chain can hold up to ${MAX_ACTIVE_NEURONS} neurons — 2–3 related ones work best.`);
        return prev;
      }
      return [...prev, wikiId];
    });
  };

  const canSave = name.trim().length > 0 && selectedIds.length >= 2 && !submitting;

  const handleSave = async () => {
    if (!canSave) return;
    setSubmitting(true);
    try {
      if (editing) {
        await updateChain(editing.id, { name: name.trim(), description: desc.trim(), cover_color: color }, selectedIds);
        toast.success(`Chain "${name.trim()}" updated`);
      } else {
        await createChain({ name: name.trim(), description: desc.trim(), cover_color: color, wikiIds: selectedIds });
        toast.success(`Chain "${name.trim()}" saved — activate it from the BRAIN tab or ⌘K`);
      }
      emitChainsChanged();
      setOpen(false);
    } catch (err: any) {
      toast.error(isChainsMigrationMissing(err) ? CHAINS_MIGRATION_MESSAGE : err.message || "Failed to save chain");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    if (!confirm(`Delete the chain "${editing.name}"? The neurons inside it are not affected.`)) return;
    setDeleting(true);
    try {
      await deleteChain(editing.id);
      toast.success("Chain deleted");
      emitChainsChanged();
      setOpen(false);
    } catch (err: any) {
      toast.error(err.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">
            {editing ? "Edit chain" : "New neuron chain"}
          </DialogTitle>
          <DialogDescription>
            A chain is a named set of neurons that load together in one click.
            Pick 2–{MAX_ACTIVE_NEURONS} related neurons — the first becomes the
            primary, where new knowledge is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "Driving Test Prep"'
              maxLength={80}
            />
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
              Description <span className="normal-case font-normal">(optional)</span>
            </label>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="What do you study with this chain?"
              rows={2}
              maxLength={280}
            />
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
              Color
            </label>
            <div className="flex gap-2">
              {COVER_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-lg transition-transform ${color === c ? "ring-2 ring-primary scale-110" : ""}`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2 block">
              Neurons ({selectedIds.length}/{MAX_ACTIVE_NEURONS} — click to add in order)
            </label>
            <div className="max-h-[36vh] overflow-auto -mx-1 px-1 py-1 space-y-1">
              {sortedWikis.map((wiki) => {
                const idx = selectedIds.indexOf(wiki.id);
                const isSel = idx >= 0;
                const isLocked = lockedIds.has(wiki.id);
                return (
                  <button
                    key={wiki.id}
                    type="button"
                    onClick={() => toggleMember(wiki.id)}
                    aria-pressed={isSel}
                    className={`w-full flex items-center gap-3 py-2 px-3 rounded-lg text-left transition-colors border ${
                      isSel ? "border-primary/50 bg-primary/10" : "border-transparent hover:bg-muted/50"
                    } ${isLocked ? "opacity-60" : ""}`}
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ background: wiki.cover_color || "#7C3AED" }}
                      aria-hidden
                    />
                    <span className="flex-1 min-w-0 font-medium truncate">{wiki.name}</span>
                    {isSel && (
                      <span className="text-[10px] font-bold uppercase tracking-widest text-primary shrink-0">
                        {idx === 0 ? "1 · Primary" : idx + 1}
                      </span>
                    )}
                  </button>
                );
              })}
              {sortedWikis.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No neurons yet — create some in the BRAIN tab first.
                </p>
              )}
            </div>
            {selectedIds.length === 1 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Pick at least one more — a chain needs 2+ neurons.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {editing && (
            <Button
              variant="ghost"
              className="text-destructive sm:mr-auto"
              onClick={handleDelete}
              disabled={deleting || submitting}
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete"}
            </Button>
          )}
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : editing ? "Save changes" : "Save chain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ChainDialog;
