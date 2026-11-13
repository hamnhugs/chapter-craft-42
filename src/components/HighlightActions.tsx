import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ReaderAction {
  icon: string;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

interface HighlightActionsProps {
  /** Viewport rect of the text the menu belongs to. */
  rect: DOMRect;
  actions: ReaderAction[];
  label: string;
  onClose: () => void;
  /**
   * Belongs to a live text selection: it stays while the selection does (the
   * owner moves it on scroll and removes it when the selection goes), and it
   * never takes focus or the selection away.
   */
  forSelection?: boolean;
}

const MARGIN = 8;

/** The one small menu for marked text — a live selection or a saved
 *  highlight. Sits below the text (above when there's no room: on Android
 *  the system's own Copy/Share bar is above a selection). */
const HighlightActions: React.FC<HighlightActionsProps> = ({ rect, actions, label, onClose, forSelection = false }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = rect.bottom + MARGIN;
    const fitsBelow = below + h <= window.innerHeight - MARGIN;
    const top = fitsBelow ? Math.max(MARGIN, below) : Math.max(MARGIN, Math.min(window.innerHeight - h - MARGIN, rect.top - h - MARGIN));
    const left = Math.min(Math.max(MARGIN, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - MARGIN);
    setPos({ left, top });
  }, [rect, actions.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    if (forSelection) return () => window.removeEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Registered a tick late so the tap that opened the menu doesn't close it.
    const t = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("scroll", onClose, true);
      window.addEventListener("resize", onClose);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, forSelection]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-reader-menu
      className="fixed z-[70] flex items-stretch gap-0.5 p-1 rounded-2xl bg-surface-container-high/95 backdrop-blur-xl shadow-xl border border-outline-variant/30"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      // Pressing the menu must not collapse the selection it acts on.
      onMouseDown={forSelection ? (e) => e.preventDefault() : undefined}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          onClick={a.onClick}
          className="flex flex-col items-center justify-center gap-0.5 min-w-[4.25rem] h-14 px-2 rounded-xl text-foreground hover:bg-surface-container-highest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-95 transition-all"
        >
          <span className={`material-symbols-outlined text-xl ${a.destructive ? "text-destructive" : "text-primary"}`} aria-hidden>{a.icon}</span>
          <span className="text-[11px] leading-none font-semibold whitespace-nowrap">{a.label}</span>
        </button>
      ))}
    </div>
  );
};

export default HighlightActions;
