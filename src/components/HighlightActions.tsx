import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HighlightHit } from "@/hooks/useReaderHighlights";

interface HighlightActionsProps {
  hit: HighlightHit;
  onClose: () => void;
  onAsk: () => void;
  onSaveCard: () => void;
  onRemove: () => void;
}

const MARGIN = 8;

/** The small menu a tapped highlight opens. Sits below the mark (above when
 *  there's no room), and closes on Esc, an outside tap, scroll or resize. */
const HighlightActions: React.FC<HighlightActionsProps> = ({ hit, onClose, onAsk, onSaveCard, onRemove }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const { rect } = hit;
    const below = rect.bottom + MARGIN;
    const top = below + h <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, rect.top - h - MARGIN);
    const left = Math.min(Math.max(MARGIN, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - MARGIN);
    setPos({ left, top });
  }, [hit]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Registered a tick late so the tap that opened the menu doesn't close it.
    const t = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("scroll", onClose, true);
      window.addEventListener("resize", onClose);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const item =
    "flex items-center gap-1.5 px-3 h-10 rounded-full text-sm font-semibold text-foreground hover:bg-surface-container-highest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-95 transition-all";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Highlight"
      className="fixed z-[70] flex items-center gap-0.5 p-1 rounded-full bg-surface-container-high/95 backdrop-blur-xl shadow-xl border border-outline-variant/30"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      <button type="button" role="menuitem" className={item} onClick={onAsk}>
        <span className="material-symbols-outlined text-lg text-primary" aria-hidden>forum</span>
        Ask in chat
      </button>
      <button type="button" role="menuitem" className={item} onClick={onSaveCard}>
        <span className="material-symbols-outlined text-lg text-primary" aria-hidden>bookmark_add</span>
        Save as card
      </button>
      <button type="button" role="menuitem" className={item} onClick={onRemove} aria-label="Remove highlight">
        <span className="material-symbols-outlined text-lg text-destructive" aria-hidden>ink_eraser</span>
        <span className="max-sm:hidden">Remove</span>
      </button>
    </div>
  );
};

export default HighlightActions;
