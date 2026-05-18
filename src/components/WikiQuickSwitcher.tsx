import React, { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Check, Sparkles } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useApp } from "@/context/AppContext";

// Global keyboard-driven wiki switcher. Toggle with Cmd+K (Mac) / Ctrl+K (others).
// Listens for keydown anywhere; ignores input/textarea/contenteditable focus
// so it doesn't fight with normal in-field shortcuts.

const isEditable = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
};

const WikiQuickSwitcher: React.FC = () => {
  const { wikis, activeWikiId, setActiveWiki, setActiveTab } = useApp();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isToggle = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (isToggle) {
        // Allow Cmd+K to work even from inputs — it's a global command-palette convention.
        e.preventDefault();
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

  const handleSelect = useCallback(
    async (wikiId: string) => {
      try {
        await setActiveWiki(wikiId);
        const wiki = wikis.find((w) => w.id === wikiId);
        toast.success(`Loaded "${wiki?.name || "wiki"}"`);
        setOpen(false);
      } catch (err: any) {
        toast.error(err.message || "Switch failed");
      }
    },
    [setActiveWiki, wikis]
  );

  // Sort: active first, then most recently loaded, then name
  const sorted = [...wikis].sort((a, b) => {
    if (a.id === activeWikiId) return -1;
    if (b.id === activeWikiId) return 1;
    const aTime = a.last_loaded_at ? new Date(a.last_loaded_at).getTime() : 0;
    const bTime = b.last_loaded_at ? new Date(b.last_loaded_at).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Switch wiki — type to filter…" />
      <CommandList>
        <CommandEmpty>No wikis match.</CommandEmpty>
        <CommandGroup heading="Wikis">
          {sorted.map((wiki) => (
            <CommandItem
              key={wiki.id}
              value={`${wiki.name} ${wiki.tags.join(" ")}`}
              onSelect={() => handleSelect(wiki.id)}
              className="flex items-center gap-3 py-2.5"
            >
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ background: wiki.cover_color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{wiki.name}</span>
                  {wiki.is_meta && (
                    <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-primary">
                      <Sparkles className="w-2.5 h-2.5" /> Meta
                    </span>
                  )}
                </div>
                {wiki.description && (
                  <div className="text-xs text-muted-foreground truncate">{wiki.description}</div>
                )}
              </div>
              {wiki.id === activeWikiId && (
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-primary shrink-0">
                  <Check className="w-3 h-3" /> Active
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Navigate">
          <CommandItem
            value="open wiki library wikis page"
            onSelect={() => {
              setActiveTab("wikis");
              setOpen(false);
            }}
          >
            Open Wiki Library →
          </CommandItem>
          <CommandItem
            value="open current wiki entries"
            onSelect={() => {
              setActiveTab("wiki");
              setOpen(false);
            }}
          >
            Open active wiki entries →
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
};

export default WikiQuickSwitcher;
