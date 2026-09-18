import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/useAuth";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { turnPromptStore, type TurnPromptSelection } from "@/lib/promptRouting";
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

const PromptSwitcher: React.FC<{ onManage: () => void }> = ({ onManage }) => {
  const { user } = useAuth();
  const { presets } = usePromptPresets();

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

  const choose = (next: TurnPromptSelection) => turnPromptStore.set(next);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
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
          return (
            <DropdownMenuItem key={p.id} onClick={() => choose({ mode: "pinned", presetId: p.id })}>
              <span className="material-symbols-outlined text-base mr-2">
                {isPinned ? "check" : "radio_button_unchecked"}
              </span>
              <span className="flex-1 truncate">{p.name}</span>
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
