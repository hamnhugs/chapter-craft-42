import React, { useEffect, useMemo, useState } from "react";
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
import { isSystemWiki, supabaseNotebooks, type NotebookStore, type Wiki } from "@/lib/wikisApi";
import { emitChainsChanged } from "@/lib/chainsApi";
import { allRows, buildNotebookTree, parentIdOf, whyCannotNest, withParent } from "@/lib/notebookTree";

export const COVER_PALETTE = [
  "#7C3AED", "#2563EB", "#0EA5E9", "#10B981",
  "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6",
];

type Listed = Pick<Wiki, "id" | "name" | "tags">;

/** Confirm, then delete a notebook. Refuses one Counsel is using. Resolves
 *  true when it was deleted.
 *
 *  Notebooks inside it are never deleted with it: they move up to where the
 *  deleted notebook was. Pass `notebooks` (every notebook) so they can be found. */
export async function deleteNotebookWithConfirm(
  wiki: Listed,
  noteCount: number,
  loadedIds: string[],
  opts: { notebooks?: Listed[]; store?: NotebookStore } = {},
): Promise<boolean> {
  const store = opts.store ?? supabaseNotebooks;
  if (loadedIds.includes(wiki.id)) {
    toast.error("Counsel is using this notebook. Switch Counsel to another one — or to Just chat — then delete this one.");
    return false;
  }
  const inside = (opts.notebooks || []).filter((w) => parentIdOf(w) === wiki.id);
  const kept = inside.length
    ? `\n\nThe ${inside.length === 1 ? "notebook" : `${inside.length} notebooks`} inside it will be kept and moved up a level.`
    : "";
  if (!confirm(`Delete "${wiki.name}" and all ${noteCount} ${noteCount === 1 ? "note" : "notes"}? This can't be undone.${kept}`)) {
    return false;
  }
  try {
    // Move the contents out first: if this fails nothing has been deleted.
    const newParent = parentIdOf(wiki);
    await Promise.all(inside.map((w) => store.update(w.id, { tags: withParent(w.tags, newParent) })));
    await store.remove(wiki.id);
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

/** Create a notebook (wiki = null) or rename / recolor / move one. Shared by
 *  the Notebooks list and the open notebook's ⋯ menu.
 *
 *  `notebooks` is every notebook the user has; with it the dialog offers
 *  "Keep it inside", which is how a notebook is nested or moved. `parentId`
 *  preselects that for a new notebook ("New notebook inside"). */
const NotebookFormDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wiki: Pick<Wiki, "id" | "name" | "description" | "cover_color" | "tags"> | null;
  onSaved: () => void | Promise<void>;
  notebooks?: Listed[];
  parentId?: string | null;
  store?: NotebookStore;
}> = ({ open, onOpenChange, wiki, onSaved, notebooks, parentId = null, store = supabaseNotebooks }) => {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState(COVER_PALETTE[0]);
  const [parent, setParent] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(wiki?.name ?? "");
    setDesc(wiki?.description ?? "");
    setColor(wiki?.cover_color ?? COVER_PALETTE[Math.floor(Math.random() * COVER_PALETTE.length)]);
    setParent(wiki ? parentIdOf(wiki) : parentId);
  }, [open, wiki, parentId]);

  // Every notebook this one could sit inside, in tree order. The ones it
  // can't (itself, its own contents, anything too deep) are listed but
  // disabled, so the tree still reads as the tree.
  const tree = useMemo(() => buildNotebookTree((notebooks || []).filter((w) => !isSystemWiki(w))), [notebooks]);
  const places = useMemo(
    () => allRows(tree)
      .filter((n) => n.wiki.id !== wiki?.id)
      .map((n) => ({ id: n.wiki.id, name: n.wiki.name, depth: n.depth, blocked: whyCannotNest(tree, wiki?.id ?? null, n.wiki.id) })),
    [tree, wiki?.id],
  );
  // A parent that has since been deleted reads as the top level.
  const parentValue = parent && tree.byId.has(parent) ? parent : "";

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    const blocked = whyCannotNest(tree, wiki?.id ?? null, parentValue || null);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    setSubmitting(true);
    try {
      if (wiki) {
        await store.update(wiki.id, {
          name: name.trim(),
          description: desc,
          cover_color: color,
          // Only when nesting is on offer here — otherwise leave tags alone.
          ...(notebooks ? { tags: withParent(wiki.tags, parentValue || null) } : {}),
        });
        toast.success("Notebook updated");
      } else {
        await store.create({ name: name.trim(), description: desc, cover_color: color, tags: withParent([], parentValue || null) });
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

          {places.length > 0 && (
            <div>
              <label htmlFor="notebook-parent" className="text-xs font-semibold text-on-surface-variant mb-1.5 block">
                Keep it inside
              </label>
              <select
                id="notebook-parent"
                value={parentValue}
                onChange={(e) => setParent(e.target.value || null)}
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Nothing — top level</option>
                {places.map((p) => (
                  <option key={p.id} value={p.id} disabled={!!p.blocked}>
                    {"   ".repeat(p.depth - 1)}{p.depth > 1 ? "› " : ""}{p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

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
