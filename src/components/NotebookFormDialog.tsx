import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { createWiki, updateWiki, deleteWiki, type Wiki } from "@/lib/wikisApi";
import { emitChainsChanged } from "@/lib/chainsApi";

export const COVER_PALETTE = [
  "#7C3AED", "#2563EB", "#0EA5E9", "#10B981",
  "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6",
];

/** Confirm, then delete a notebook. Refuses one Counsel is using. Resolves
 *  true when it was deleted. */
export async function deleteNotebookWithConfirm(
  wiki: Pick<Wiki, "id" | "name">,
  noteCount: number,
  loadedIds: string[],
): Promise<boolean> {
  if (loadedIds.includes(wiki.id)) {
    toast.error("Counsel is using this notebook. Switch Counsel to another one first, then delete this one.");
    return false;
  }
  if (!confirm(`Delete "${wiki.name}" and all ${noteCount} ${noteCount === 1 ? "note" : "notes"}? This can't be undone.`)) {
    return false;
  }
  try {
    await deleteWiki(wiki.id);
    toast.success("Notebook deleted");
    // Membership rows cascade away — refresh chain lists everywhere (the
    // globally-mounted ⌘K switcher would otherwise hold dangling ids).
    emitChainsChanged();
    return true;
  } catch (err: any) {
    toast.error(err.message || "Delete failed");
    return false;
  }
}

/** Create a notebook (wiki = null) or rename/recolor one. Shared by the
 *  Notebooks list and the open notebook's ⋯ menu. */
const NotebookFormDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wiki: Pick<Wiki, "id" | "name" | "description" | "cover_color"> | null;
  onSaved: () => void | Promise<void>;
}> = ({ open, onOpenChange, wiki, onSaved }) => {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState(COVER_PALETTE[0]);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(wiki?.name ?? "");
    setDesc(wiki?.description ?? "");
    setColor(wiki?.cover_color ?? COVER_PALETTE[Math.floor(Math.random() * COVER_PALETTE.length)]);
  }, [open, wiki]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSubmitting(true);
    try {
      if (wiki) {
        await updateWiki(wiki.id, { name: name.trim(), description: desc, cover_color: color });
        toast.success("Notebook updated");
      } else {
        await createWiki({ name: name.trim(), description: desc, cover_color: color });
        toast.success("Notebook created");
      }
      onOpenChange(false);
      await onSaved();
    } catch (err: any) {
      toast.error(err.message || "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex flex-col gap-3 p-5 sm:p-6 rounded-lg">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="font-headline text-xl sm:text-2xl">
            {wiki ? "Edit notebook" : "New notebook"}
          </DialogTitle>
          <DialogDescription>A notebook keeps notes on one subject.</DialogDescription>
        </DialogHeader>

        {/* Only the form scrolls, so Create/Cancel stay on screen however short the window is. */}
        <div className="space-y-3 sm:space-y-4 py-1 -mx-1 px-1 overflow-y-auto min-h-0">
          <div>
            <label className="text-xs font-semibold text-on-surface-variant mb-1.5 block">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              placeholder="e.g. Dune Lore, Startup Strategy"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-on-surface-variant mb-1.5 block">
              What's it about? <span className="font-normal">(optional)</span>
            </label>
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} className="min-h-[60px]" />
          </div>

          <div>
            <label className="text-xs font-semibold text-on-surface-variant mb-1.5 block">Color</label>
            <div className="flex gap-2 flex-wrap">
              {COVER_PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    color === c ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110" : ""
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : wiki ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NotebookFormDialog;
