import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/useAuth";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { turnPromptStore, type TurnPromptSelection } from "@/lib/promptRouting";
import { usePromptBindings } from "@/hooks/usePromptBindings";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The Counsel prompt switcher — change which saved prompt is steering the
 * assistant without leaving the conversation.
 *
 * The chip is a CLAIM about the next turn, so it is derived from exactly the
 * inputs `resolveTurnPrompt` uses at send time: the session selection, the
 * saved default, and the preset's scope. A prompt that is active but scoped to
 * Voice only is shown as "not used here" rather than as the active prompt —
 * a switcher that reports a prompt the request will not carry is the classic
 * way this feature lies, and the per-reply receipt exists to catch the rest.
 *
 * The pin lives in `turnPromptStore` (session-scoped), NOT in component state:
 * hands-free sends bypass the composer entirely, and a pin the spoken path
 * could not see would silently stop applying the moment the user started
 * talking.
 */

const PromptSwitcher: React.FC<{
  onManage: () => void;
  /**
   * Render nothing unless a saved prompt actually shapes the next reply.
   *
   * The composer's status strip states what is acting on the next message, so
   * a chip reading "Auto" — the default, true for most users forever — is a
   * line of permanent furniture that reports nothing. In the tool sheet the
   * switcher is always rendered, because there it IS the control.
   */
  onlyWhenApplied?: boolean;
}> = ({ onManage, onlyWhenApplied }) => {
  const { user } = useAuth();
  const { presets } = usePromptPresets();
  const { applyBindings, describeBindings } = usePromptBindings();

  // In an effect, never during render: init() notifies subscribers, and a
  // store notification raised while React is rendering schedules an update
  // from inside a render pass. Same shape as bookContextStore's callers.
  useEffect(() => { turnPromptStore.init(user?.id ?? null); }, [user?.id]);
  const selection = useSyncExternalStore(
    useCallback((cb) => turnPromptStore.subscribe(cb), []),
    () => turnPromptStore.get(),
    () => turnPromptStore.get(),
  );

  // Counsel is the chat lane. A voice-only preset never rides here.
  const inLane = (p: { scope: string }) => p.scope === "both" || p.scope === "chat";

  const pinned = selection.mode === "pinned" ? presets.find((p) => p.id === selection.presetId) || null : null;
  const active = presets.find((p) => p.is_active) || null;
  const effective = selection.mode === "plain" ? null : pinned || active;
  const applies = !!effective && inLane(effective) && !!effective.body.trim();

  const label = selection.mode === "plain"
    ? "Plain"
    : !effective
      ? "Auto"
      : applies
        ? effective.name
        : `${effective.name} · not used here`;

  const title = selection.mode === "plain"
    ? "No saved prompt is being applied in this conversation"
    : !effective
      ? "No saved prompt is active — using your Settings instructions"
      : applies
        ? `"${effective.name}" is shaping replies${pinned ? " (pinned for this conversation)" : " (your default)"}`
        : `"${effective.name}" is set to Voice only, so it is not applied in Counsel`;

  const choose = async (next: TurnPromptSelection) => {
    turnPromptStore.set(next);
    if (next.mode !== "pinned") return;
    // The context a prompt carries is loaded HERE, on the tap — a deliberate,
    // announced action — and never on a later turn behind the user's back.
    const p = presets.find((x) => x.id === next.presetId);
    if (!p) return;
    const changed = await applyBindings(p);
    if (changed) toast.success(`${p.name} — ${changed}`);
  };

  // OPEN ON TAP, NOT ON TOUCH-DOWN. Radix's DropdownMenuTrigger calls
  // `onOpenToggle()` from `onPointerDown` (react-dropdown-menu dist, the
  // trigger's composed pointerdown handler). This chip lives in Counsel's
  // horizontally-scrolling tool row, so on a phone the finger that lands here
  // to FLICK THE ROW SIDEWAYS has already opened the prompt menu before it has
  // moved a pixel — and changing which prompt is steering the conversation is
  // not a harmless thing to do by accident.
  //
  // `preventDefault()` on pointerdown suppresses Radix's toggle (their
  // `composeEventHandlers` skips the internal handler once the event is
  // default-prevented), and the menu is driven from `onClick` instead. That
  // hands the scroll-vs-tap decision to the browser, which already declines to
  // fire `click` when the gesture turned into a scroll — the behaviour WCAG
  // 2.2 SC 2.5.2 (Pointer Cancellation) is asking for. Keyboard activation is
  // untouched: Radix opens on Enter/Space from its own `onKeyDown`.
  const [open, setOpen] = useState(false);

  // After every hook — an early return above `useState` would change the hook
  // count between renders as `applies` flips.
  if (onlyWhenApplied && !applies) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          title={title}
          aria-label={`Prompt: ${label}`}
          className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors max-w-[170px] ${
            applies ? "text-primary-container" : "text-on-surface-variant hover:text-primary"
          }`}
        >
          <span
            className="material-symbols-outlined text-sm"
            style={applies ? { fontVariationSettings: "'FILL' 1" } : {}}
            aria-hidden
          >
            psychology
          </span>
          <span className="truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px] max-h-[60vh] overflow-y-auto">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-on-surface-variant">
          Prompt
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => choose({ mode: "auto" })}>
          <span className="material-symbols-outlined text-base mr-2">
            {selection.mode === "auto" ? "check" : "auto_mode"}
          </span>
          <span className="flex-1">Auto</span>
          {active && <span className="text-[10px] text-on-surface-variant ml-2 truncate max-w-[80px]">{active.name}</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose({ mode: "plain" })}>
          <span className="material-symbols-outlined text-base mr-2">
            {selection.mode === "plain" ? "check" : "block"}
          </span>
          Plain — no prompt
        </DropdownMenuItem>

        {presets.length > 0 && <DropdownMenuSeparator />}
        {presets.map((p) => {
          const isPinned = selection.mode === "pinned" && selection.presetId === p.id;
          const usable = inLane(p);
          const binds = describeBindings(p);
          return (
            <DropdownMenuItem key={p.id} onClick={() => choose({ mode: "pinned", presetId: p.id })}>
              <span className="material-symbols-outlined text-base mr-2">
                {isPinned ? "check" : "radio_button_unchecked"}
              </span>
              <span className="flex-1 truncate">{p.name}</span>
              {/* What the switch will change, BEFORE it is tapped. */}
              {binds && <span className="text-[10px] text-on-surface-variant ml-2 shrink-0 truncate max-w-[110px]">{binds}</span>}
              {!usable && <span className="text-[10px] text-amber-500 ml-2 shrink-0">voice only</span>}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onManage}>
          <span className="material-symbols-outlined text-base mr-2">tune</span> Manage prompts…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default PromptSwitcher;
