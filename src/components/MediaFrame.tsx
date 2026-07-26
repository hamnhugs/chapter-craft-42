import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// ── Chat media sizing ─────────────────────────────────────────────────────
// One home for "how big is this media in the transcript". Two models:
//
// MediaFrame — a resizable, expandable box for content that fills its frame
// (the 3D splat viewer). Drag the corner grip to resize (pointer events, so
// mouse, touch and pen all work); the expand button goes fullscreen.
// Fullscreen tries the native Fullscreen API first: the element is promoted
// to the top layer WITHOUT moving in the DOM, which matters here because
// remounting the viewer would tear down its WebGL context and re-download
// the splat. Where the API is missing or rejects — iPhone Safari before
// iOS ~17.4, in-app webviews, an embedding iframe without allow="fullscreen"
// — a position:fixed overlay does the same job visually. The transcript's
// ancestor chain has no transforms/filters, so fixed positioning fills the
// real viewport.
//
// useMediaHeightTier — S/M/L/XL max-height steps for media that sizes
// itself (images, <video> with native controls), where boxing it into a
// fixed frame would letterbox. A window event keeps every visible instance
// of the same kind in step, and both models persist per kind in
// localStorage so the size you set is the size the next one opens at.

export type MediaKind = "image" | "video" | "splat";

export interface FrameSize { w: number; h: number }

export const SPLAT_FRAME_DEFAULT: FrameSize = { w: 384, h: 256 };
export const SPLAT_FRAME_MIN: FrameSize = { w: 240, h: 180 };

const FRAME_KEY = (kind: MediaKind) => `cc.mediaFrameSize.${kind}`;
const TIER_KEY = (kind: MediaKind) => `cc.mediaHeightTier.${kind}`;
const TIER_EVENT = "cc:media-tier-change";

const clampSize = (s: FrameSize, min: FrameSize): FrameSize => {
  const maxH = Math.max(320, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.75));
  return {
    w: Math.round(Math.min(Math.max(s.w, min.w), 1400)),
    h: Math.round(Math.min(Math.max(s.h, min.h), maxH)),
  };
};

const loadFrameSize = (kind: MediaKind, fallback: FrameSize, min: FrameSize): FrameSize => {
  try {
    const raw = localStorage.getItem(FRAME_KEY(kind));
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    if (typeof p?.w === "number" && typeof p?.h === "number") return clampSize(p, min);
  } catch { /* unreadable or blocked storage — use the default */ }
  return fallback;
};

/** The size a MediaFrame of this kind will actually open at (persisted or
 *  default) — for placeholders that shouldn't jump when the frame mounts. */
export const getPersistedFrameSize = (
  kind: MediaKind, fallback: FrameSize, min: FrameSize = { w: 240, h: 180 },
): FrameSize => loadFrameSize(kind, fallback, min);

const fullscreenElement = (): Element | null => {
  const d = document as any;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
};

/** Leave native fullscreen if any element holds it. Safe to call blind. */
export const exitAnyFullscreen = (): void => {
  if (!fullscreenElement()) return;
  const d = document as any;
  try {
    const r = (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(document);
    if (r && typeof r.catch === "function") r.catch(() => { /* already gone */ });
  } catch { /* noop */ }
};

// ── S/M/L/XL height tiers ─────────────────────────────────────────────────

const TIERS = [
  { label: "S", maxHeight: 224 },
  { label: "M", maxHeight: 320 }, // matches the old hardcoded max-h-80
  { label: "L", maxHeight: 480 },
  { label: "XL", maxHeight: 672 },
];

export const useMediaHeightTier = (kind: MediaKind) => {
  const [idx, setIdx] = useState<number>(() => {
    try {
      const i = TIERS.findIndex((t) => t.label === localStorage.getItem(TIER_KEY(kind)));
      return i >= 0 ? i : 1;
    } catch { return 1; }
  });
  const idxRef = useRef(idx);
  useEffect(() => { idxRef.current = idx; }, [idx]);

  // Keep every visible media of this kind in step when any one of them cycles.
  useEffect(() => {
    const onTier = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.kind !== kind || typeof detail.idx !== "number") return;
      setIdx((cur) => (detail.idx >= 0 && detail.idx < TIERS.length && detail.idx !== cur ? detail.idx : cur));
    };
    window.addEventListener(TIER_EVENT, onTier);
    return () => window.removeEventListener(TIER_EVENT, onTier);
  }, [kind]);

  const cycle = useCallback(() => {
    const next = (idxRef.current + 1) % TIERS.length;
    try { localStorage.setItem(TIER_KEY(kind), TIERS[next].label); } catch { /* noop */ }
    setIdx(next);
    window.dispatchEvent(new CustomEvent(TIER_EVENT, { detail: { kind, idx: next } }));
  }, [kind]);

  return { maxHeight: TIERS[idx].maxHeight, tierLabel: TIERS[idx].label, cycle };
};

// ── Resizable, expandable frame ───────────────────────────────────────────

interface MediaFrameProps {
  kind: MediaKind;
  /** Short human name of the content, for accessible button labels. */
  label: string;
  defaultSize: FrameSize;
  minSize?: FrameSize;
  /** Static chrome for the frame (border, rounding, background). */
  className?: string;
  /** Extra controls rendered top-right (the splat viewer's reset/close). */
  controlsTopRight?: React.ReactNode;
  /** Fires whenever fullscreen state changes (either mechanism). */
  onExpandedChange?: (expanded: boolean) => void;
  children: React.ReactNode;
}

const MediaFrame: React.FC<MediaFrameProps> = ({
  kind, label, defaultSize, minSize = { w: 240, h: 180 },
  className, controlsTopRight, onExpandedChange, children,
}) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<FrameSize>(() => loadFrameSize(kind, defaultSize, minSize));
  const [expanded, setExpanded] = useState(false);
  const [cssFallback, setCssFallback] = useState(false);
  const cssFallbackRef = useRef(false);
  // True while WE hold native fullscreen — distinguishes "our element left
  // fullscreen" from unrelated fullscreenchange events (e.g. a chat video).
  const nativeActiveRef = useRef(false);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onExpandedChangeRef = useRef(onExpandedChange);
  useEffect(() => { onExpandedChangeRef.current = onExpandedChange; });

  // Every expanded/fallback flip goes through here. The parent is notified
  // SYNCHRONOUSLY (not via effect): gesture handlers read the value from a
  // ref, and a one-commit lag would mis-arbitrate the first pointer or wheel
  // event landing right after fullscreen engages.
  const applyExpanded = useCallback((next: boolean, fallback: boolean) => {
    cssFallbackRef.current = fallback;
    setCssFallback(fallback);
    setExpanded(next);
    onExpandedChangeRef.current?.(next);
  }, []);

  const expand = useCallback(() => {
    if (expanded) return;
    // A prior attempt's confirm timer must never outlive its own click —
    // orphaned, it could fire after the user already entered AND exited,
    // re-opening the overlay uninvited.
    if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
    const el = frameRef.current as any;
    if (!el) return;
    const doc = document as any;
    const nativeAllowed = (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled) !== false;
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (nativeAllowed && req) {
      try {
        const r = req({ navigationUI: "hide" });
        if (r && typeof r.then === "function") {
          (r as Promise<void>)
            .then(() => applyExpanded(true, false))
            .catch(() => applyExpanded(true, true));
        } else {
          // The prefixed API is synchronous and can silently do nothing —
          // confirm via the change event, else fall back to the overlay.
          pendingRef.current = setTimeout(() => {
            pendingRef.current = null;
            if (!fullscreenElement()) applyExpanded(true, true);
          }, 300);
        }
        return;
      } catch { /* fall through to the overlay */ }
    }
    applyExpanded(true, true);
  }, [expanded, applyExpanded]);

  const collapse = useCallback(() => {
    if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
    if (fullscreenElement() === frameRef.current) { exitAnyFullscreen(); return; } // change event finishes
    applyExpanded(false, false);
  }, [applyExpanded]);

  // Track native fullscreen entered/left — including Esc, the system back
  // gesture, and swipe-to-exit, which never go through our buttons.
  useEffect(() => {
    const onChange = () => {
      const fsEl = fullscreenElement();
      if (fsEl === frameRef.current) {
        nativeActiveRef.current = true;
        if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
        applyExpanded(true, false);
      } else if (nativeActiveRef.current) {
        nativeActiveRef.current = false;
        if (!cssFallbackRef.current) applyExpanded(false, false);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [applyExpanded]);

  // The CSS overlay has no browser-managed Esc — provide it. Capture phase so
  // it wins over the content's own Escape handling (the splat viewer's Esc
  // closes 3D entirely; while expanded, Esc should only collapse).
  useEffect(() => {
    if (!(expanded && cssFallback)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      applyExpanded(false, false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [expanded, cssFallback, applyExpanded]);

  // While the overlay is up: lock background scroll, and mark the document so
  // CSS can neutralize ancestor containing-block triggers (aurora's glass
  // bubbles use backdrop-filter — see index.css) and the ⌘K palette can stand
  // down. Layout effect: the marker must land before the overlay's first
  // paint, or aurora shows one bubble-confined frame.
  useLayoutEffect(() => {
    if (!(expanded && cssFallback)) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.documentElement.classList.add("cc-media-overlay-open");
    return () => {
      document.documentElement.style.overflow = prev;
      document.documentElement.classList.remove("cc-media-overlay-open");
    };
  }, [expanded, cssFallback]);

  // Unmounted while fullscreen (viewer slot stolen, chat cleared): browsers
  // exit on element removal, but not all — release explicitly.
  useEffect(() => () => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
    if (nativeActiveRef.current) exitAnyFullscreen();
  }, []);

  // ── Corner drag-resize ──────────────────────────────────────────────────
  const persistSize = (s: FrameSize) => {
    try { localStorage.setItem(FRAME_KEY(kind), JSON.stringify(s)); } catch { /* noop */ }
  };
  const dragRef = useRef<{ id: number; startX: number; startY: number; base: FrameSize } | null>(null);

  const onHandleDown = (e: React.PointerEvent) => {
    if (expanded) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, base: size };
    e.preventDefault();
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    setSize(clampSize({ w: d.base.w + (e.clientX - d.startX), h: d.base.h + (e.clientY - d.startY) }, minSize));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    persistSize(size);
  };
  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    let { w, h } = size;
    switch (e.key) {
      case "ArrowRight": w += step; break;
      case "ArrowLeft": w -= step; break;
      case "ArrowDown": h += step; break;
      case "ArrowUp": h -= step; break;
      default: return;
    }
    e.preventDefault();
    const next = clampSize({ w, h }, minSize);
    setSize(next);
    persistSize(next);
  };
  const resetSize = () => { setSize(defaultSize); persistSize(defaultSize); };

  const fs = expanded;
  const safeTop = "calc(0.5rem + env(safe-area-inset-top))";

  return (
    <div
      ref={frameRef}
      // The chat bubble saves its text to notes on a 500ms still touch —
      // holding a 3D model steady or starting a corner drag must not do that.
      onTouchStart={(e) => e.stopPropagation()}
      className={`relative ${className || ""} ${fs
        ? (cssFallback
          ? "fixed inset-0 z-[100] w-auto h-auto max-w-none rounded-none border-0 bg-black overscroll-contain"
          : "w-full h-full max-w-none rounded-none border-0 bg-black")
        : "max-w-full"}`}
      style={fs ? undefined : { width: size.w, height: size.h }}
    >
      {children}

      {/* Expand / collapse — top-left; the content's own controls keep top-right */}
      <div
        className="absolute z-10 flex items-center gap-1"
        style={fs ? { top: safeTop, left: "calc(0.5rem + env(safe-area-inset-left))" } : { top: "0.5rem", left: "0.5rem" }}
      >
        <button
          onClick={fs ? collapse : expand}
          title={fs ? "Exit full screen" : "Full screen"}
          aria-label={fs ? "Exit full screen" : `View ${label.slice(0, 60)} full screen`}
          className="grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white/90 hover:bg-black/80 backdrop-blur-sm transition-colors"
        >
          <span className="material-symbols-outlined text-[15px]">{fs ? "fullscreen_exit" : "fullscreen"}</span>
        </button>
      </div>

      {controlsTopRight && (
        <div
          className="absolute z-10 flex items-center gap-1"
          style={fs ? { top: safeTop, right: "calc(0.5rem + env(safe-area-inset-right))" } : { top: "0.5rem", right: "0.5rem" }}
        >
          {controlsTopRight}
        </div>
      )}

      {!fs && (
        <button
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={onHandleKey}
          onDoubleClick={resetSize}
          aria-label="Resize — drag the corner, or use arrow keys (double-click resets)"
          title="Drag to resize · double-click to reset"
          className="absolute bottom-0 right-0 z-10 grid h-9 w-9 cursor-nwse-resize touch-none select-none place-items-end p-2 text-white/60 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-tl-lg"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="pointer-events-none">
            <path d="M11 1 1 11 M11 5.5 5.5 11 M11 10 10 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      )}
    </div>
  );
};

export default MediaFrame;
