import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import WormSays from "@/components/onboarding/WormSays";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { useChatSettings } from "@/hooks/useChatSettings";
import { openSetupWizard } from "@/components/SetupWizard";
import {
  buildChecklist,
  checklistVisible,
  dismissChecklist,
  nextChecklistItem,
  noteProgress,
  useOnboarding,
  type ChecklistId,
} from "@/lib/onboarding";

/**
 * The getting-started list: four steps, in the top bar until they are done.
 *
 * It answers "what do I do now?" on every tab without taking any room: a
 * small ring that fills as steps complete, opened by the user when they want
 * it (tours people start themselves are finished two to three times as often
 * as ones that start on their own — Chameleon's benchmark). Steps tick
 * themselves off from what the user has really done; each one is a button
 * that goes to the place where it happens.
 */
const GettingStarted: React.FC = () => {
  const ob = useOnboarding();
  const { books, setActiveTab, activeWikiId, openNotebook } = useApp();
  const { apiKey, nvidiaKeyLast4 } = useChatSettings();
  const { messages } = useChat();
  const [open, setOpen] = useState(false);

  const asked = messages.some((m) => m.role === "user");
  useEffect(() => {
    if (asked) noteProgress("askedCounsel");
  }, [asked]);

  const items = useMemo(
    () => buildChecklist({
      hasAiKey: !!apiKey || !!nvidiaKeyLast4,
      bookCount: books.length,
      askedCounsel: !!ob?.askedCounsel || asked,
      openedNotebook: !!ob?.openedNotebook,
    }),
    [apiKey, nvidiaKeyLast4, books.length, ob?.askedCounsel, ob?.openedNotebook, asked],
  );

  if (!checklistVisible(ob)) return null;

  const done = items.filter((i) => i.done).length;
  const upNext = nextChecklistItem(items);
  const go = (id: ChecklistId) => {
    if (id === "ai") openSetupWizard(1);
    else if (id === "book") setActiveTab("library");
    else if (id === "ask") setActiveTab("chat");
    else if (activeWikiId) openNotebook(activeWikiId);
    else setActiveTab("wikis");
  };

  // The ring: circumference of r=10 is 62.83.
  const C = 2 * Math.PI * 10;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Getting started: ${done} of ${items.length} done`}
          title="Getting started"
          data-tour="getting-started"
          className="flex items-center gap-1.5 rounded-full py-1 pl-1 pr-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 active:scale-95 md:pr-2.5"
        >
          <span className="relative flex h-8 w-8 items-center justify-center">
            <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
              <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2.5" className="stroke-outline-variant/40" />
              <circle
                cx="12" cy="12" r="10" fill="none" strokeWidth="2.5" strokeLinecap="round"
                className="stroke-accent transition-[stroke-dashoffset] duration-500"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - done / items.length)}
              />
            </svg>
            <span className="relative text-[10px] font-bold tabular-nums text-foreground">
              {upNext ? `${done}/${items.length}` : <Check className="h-3.5 w-3.5 text-accent" />}
            </span>
          </span>
          <span className="hidden md:inline">Get started</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[19rem] max-w-[calc(100vw-1.5rem)] p-2">
        <WormSays mood={upNext ? "idle" : "cheer"} size={46} className="mb-2 px-1 pt-1">
          <p className="text-[13px] leading-snug text-foreground">
            {upNext
              ? done === 0
                ? "Four steps and you're reading with me."
                : `${items.length - done} to go. Next: ${upNext.label.toLowerCase()}.`
              : "That's the whole loop. You're all set!"}
          </p>
        </WormSays>
        {items.map((item, i) => {
          const isNext = item.id === upNext?.id;
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => go(item.id)}
              className={`flex items-center gap-3 rounded-lg px-2 py-2 ${isNext ? "bg-primary/10" : ""}`}
            >
              <span
                aria-hidden
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                  item.done ? "bg-accent text-background" : isNext ? "border-2 border-primary text-primary" : "border border-outline-variant/60 text-on-surface-variant"
                }`}
              >
                {item.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold ${item.done ? "text-on-surface-variant line-through decoration-on-surface-variant/40" : "text-foreground"}`}>
                  {item.label}
                </span>
                {!item.done && <span className="block text-xs text-on-surface-variant">{item.hint}</span>}
                {item.done && <span className="sr-only">Done</span>}
              </span>
              {isNext && <ChevronRight className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={dismissChecklist} className="justify-center rounded-lg text-xs text-on-surface-variant">
          {upNext ? "Hide this list" : "Done — put this away"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default GettingStarted;
