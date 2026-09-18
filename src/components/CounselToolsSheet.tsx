import React from "react";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Loader2 } from "lucide-react";
import PromptSwitcher from "@/components/PromptSwitcher";

/**
 * Counsel's tool sheet — every control that used to live in the composer's
 * horizontally-scrolling chip row.
 *
 * WHY THE ROW HAD TO GO. Thirteen chips in a `overflow-x-auto` scroller sat
 * directly under the send button: a horizontal scroller adjacent to the
 * highest-consequence control on the screen. Every flick to reach "Clear" or
 * "Notes" was a gesture starting on top of a live toggle, and one of those
 * toggles (the prompt switcher) opened on the DOWN event, so it fired before
 * the finger had moved — see PromptSwitcher's own note, and WCAG 2.2 SC 2.5.2.
 *
 * The replacement is the pattern every major assistant converged on during
 * 2025–26: one affordance opens a sheet holding everything, and the composer
 * itself shows only what is currently ON, as chips that wrap rather than
 * scroll. Nothing is hidden that was not already one tap away — the row was a
 * scroller, so most of it was off-screen anyway — and the default state of the
 * composer is now quiet.
 *
 * Grouping is by what the control DOES to the next message (NN/g: group by
 * function, label literally, no branded names), not by how often it is used:
 *   Context — what the assistant can read
 *   Modes   — how it answers
 *   Session — what happens to this conversation
 */

export interface CounselToolsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** Context */
  readingLabel: string;
  onOpenResearchSettings: () => void;
  contextBookCount: number;
  onOpenBooks: () => void;
  workspaceCount: number;
  workspaceOpen: boolean;
  onToggleWorkspace: () => void;
  notesOpen: boolean;
  onToggleNotes: () => void;

  /** Modes */
  deepResearch: boolean;
  deepResearchAllowed: boolean;
  onToggleDeepResearch: () => void;
  autoReadReplies: boolean;
  onToggleReadAloud: () => void;
  handsFreeSupported: boolean;
  handsFreeActive: boolean;
  onToggleHandsFree: () => void;
  webSearchAvailable: boolean;
  webSearchBusy: boolean;
  webSearchDisabled: boolean;
  onWebSearch: () => void;

  /** Prompt + session */
  onManagePrompts: () => void;
  onOpenSettings: () => void;
  canClear: boolean;
  onClear: () => void;
}

/** One row in the sheet. A 48px-tall target — Material 3's figure, and above
 *  both the WCAG 2.2 AA floor (24px) and Apple's 44pt. The old chips were
 *  40px tall and 10px of uppercase text wide. */
const Row: React.FC<{
  icon: React.ReactNode;
  label: string;
  detail?: string;
  state?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = ({ icon, label, detail, state, active, disabled, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={active}
    className={`w-full min-h-[48px] flex items-center gap-3 px-4 text-left transition-colors rounded-xl disabled:opacity-40 ${
      active ? "text-primary-container" : "text-on-surface-variant"
    } hover:bg-surface-container-high active:bg-surface-container-highest`}
    style={{ touchAction: "manipulation" }}
  >
    <span className="shrink-0 w-6 flex items-center justify-center" aria-hidden>{icon}</span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-medium text-foreground truncate">{label}</span>
      {detail && <span className="block text-xs text-on-surface-variant truncate">{detail}</span>}
    </span>
    {state && (
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest">{state}</span>
    )}
  </button>
);

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="py-2">
    <p className="px-4 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{title}</p>
    {children}
  </div>
);

const sym = (name: string, filled?: boolean) => (
  <span
    className="material-symbols-outlined text-xl"
    style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
  >
    {name}
  </span>
);

const CounselToolsSheet: React.FC<CounselToolsSheetProps> = (p) => {
  /** Close the sheet, then run the action — a sheet left open over a dialog or
   *  a settings tab is a second thing to dismiss. Toggles keep it open so the
   *  new state is visible where it was changed. */
  const andClose = (fn: () => void) => () => { p.onOpenChange(false); fn(); };

  return (
    <Sheet open={p.open} onOpenChange={p.onOpenChange}>
      <SheetContent
        side="bottom"
        // Android rule, same as ToolStatusPanel: nothing here takes focus
        // programmatically, or the soft keyboard pops over the sheet.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[85vh] overflow-y-auto overflow-x-hidden rounded-t-2xl bg-surface-container-low border-outline-variant/20 p-0 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
      >
        <div className="px-4 pt-4 pb-2 border-b border-outline-variant/10">
          <SheetTitle className="flex items-center gap-2 text-sm font-headline font-bold text-foreground">
            <span className="material-symbols-outlined text-primary-container text-xl" aria-hidden>tune</span>
            Tools
          </SheetTitle>
          <SheetDescription className="text-xs mt-1 text-on-surface-variant">
            What Counsel can read, how it answers, and what happens to this conversation.
          </SheetDescription>
        </div>

        <Group title="Context">
          <Row
            icon={sym("neurology")}
            label="Neurons"
            detail={p.readingLabel}
            onClick={andClose(p.onOpenResearchSettings)}
          />
          <Row
            icon={sym("auto_stories", p.contextBookCount > 0)}
            label="Books"
            detail={p.contextBookCount > 0 ? `${p.contextBookCount} loaded as context` : "Load books or a shelf as context"}
            active={p.contextBookCount > 0}
            onClick={andClose(p.onOpenBooks)}
          />
          <Row
            icon={sym("folder_open", p.workspaceOpen)}
            label="Files"
            detail={p.workspaceCount > 0 ? `${p.workspaceCount} in the workspace` : "Saved files & research"}
            state={p.workspaceOpen ? "OPEN" : undefined}
            active={p.workspaceOpen}
            onClick={andClose(p.onToggleWorkspace)}
          />
          <Row
            icon={sym("sticky_note_2", p.notesOpen)}
            label="Notes"
            state={p.notesOpen ? "OPEN" : undefined}
            active={p.notesOpen}
            onClick={andClose(p.onToggleNotes)}
          />
        </Group>

        <Group title="Modes">
          <Row
            icon={sym(p.deepResearchAllowed ? "science" : "lock", p.deepResearch && p.deepResearchAllowed)}
            label="Deep Research"
            detail={p.deepResearchAllowed ? "Longer, source-backed answers" : "A Pro feature"}
            state={p.deepResearchAllowed ? (p.deepResearch ? "ON" : "OFF") : undefined}
            active={p.deepResearch && p.deepResearchAllowed}
            onClick={p.onToggleDeepResearch}
          />
          <Row
            icon={sym(p.autoReadReplies ? "volume_up" : "volume_off", p.autoReadReplies)}
            label="Read Aloud"
            detail="Speak replies as they arrive"
            state={p.autoReadReplies ? "ON" : "OFF"}
            active={p.autoReadReplies}
            onClick={p.onToggleReadAloud}
          />
          {p.handsFreeSupported && (
            <Row
              icon={sym(p.handsFreeActive ? "graphic_eq" : "record_voice_over", p.handsFreeActive)}
              label="Hands-free"
              detail="Just talk — no tapping"
              state={p.handsFreeActive ? "ON" : "OFF"}
              active={p.handsFreeActive}
              onClick={p.onToggleHandsFree}
            />
          )}
          {p.webSearchAvailable && (
            <Row
              icon={p.webSearchBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : sym("travel_explore")}
              label="Web Search"
              detail="Search the web for what you have typed"
              disabled={p.webSearchDisabled}
              onClick={andClose(p.onWebSearch)}
            />
          )}
        </Group>

        <Group title="Prompt">
          {/* The switcher keeps its own chip rendering — it is the one control
              whose LABEL is the state, so a Row would say it twice. */}
          <div className="px-4 min-h-[48px] flex items-center">
            <PromptSwitcher onManage={andClose(p.onManagePrompts)} />
          </div>
        </Group>

        <Group title="Session">
          <Row icon={sym("tune")} label="Settings" onClick={andClose(p.onOpenSettings)} />
          {p.canClear && (
            <Row icon={sym("delete")} label="Clear conversation" onClick={andClose(p.onClear)} />
          )}
        </Group>
      </SheetContent>
    </Sheet>
  );
};

export default CounselToolsSheet;
