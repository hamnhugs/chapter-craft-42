import React from "react";
import { createPortal } from "react-dom";
import type { HandsFreeState } from "@/hooks/useHandsFree";

// Hands-free stays on when you leave Counsel (voice can drive every tab), so
// the other tabs need to show that the mic is live — and a way to stop it
// without saying "bookworm go to sleep". Portaled to <body>: Counsel itself
// is hidden (display: none) while another tab is showing.

interface Props {
  state: HandsFreeState;
  interim: string;
  /** Last voice command's spoken confirmation, shown briefly. */
  note: string | null;
  onStop: () => void;
  onOpenCounsel: () => void;
}

const LABEL: Record<HandsFreeState, string> = {
  idle: "Hands-free",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const HandsFreeDock: React.FC<Props> = ({ state, interim, note, onStop, onOpenCounsel }) =>
  createPortal(
    <div
      className="fixed right-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] md:bottom-4 z-[80] max-w-[min(22rem,calc(100vw-1.5rem))]"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1 pl-1 pr-1 py-1 rounded-full bg-surface-container-high/95 backdrop-blur-xl shadow-2xl border border-primary/40 ring-1 ring-primary/30">
        <button
          type="button"
          onClick={onOpenCounsel}
          className="flex items-center gap-2 min-w-0 pl-2 pr-1 h-9 rounded-full hover:bg-surface-container-highest transition-colors"
          title="Open Counsel"
          aria-label={`Hands-free ${LABEL[state].toLowerCase()} — open Counsel`}
        >
          <span
            className={`material-symbols-outlined text-xl text-primary ${state === "listening" ? "animate-pulse" : ""}`}
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden
          >
            {state === "thinking" ? "more_horiz" : "graphic_eq"}
          </span>
          <span className="truncate text-sm font-label font-semibold text-foreground">
            {interim ? `“${interim}”` : note || LABEL[state]}
          </span>
        </button>
        <button
          type="button"
          onClick={onStop}
          className="grid place-items-center w-9 h-9 shrink-0 rounded-full text-on-surface-variant hover:text-destructive hover:bg-surface-container-highest transition-colors"
          title="Stop hands-free (or say “bookworm go to sleep”)"
          aria-label="Stop hands-free"
        >
          <span className="material-symbols-outlined text-xl" aria-hidden>mic_off</span>
        </button>
      </div>
    </div>,
    document.body,
  );

export default HandsFreeDock;
