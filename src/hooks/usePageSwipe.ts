import { useEffect, useRef } from "react";
import { classifySwipe, swipeProgress, type SwipeDirection } from "@/lib/readerGestures";

interface Options {
  enabled: boolean;
  onSwipe: (dir: SwipeDirection) => void;
  /** Live drag feedback: direction and 0‥1 progress, or null when cleared. */
  onProgress?: (hint: { dir: SwipeDirection; progress: number } | null) => void;
}

/**
 * Deliberate page-turn swipes on a scroll container (see readerGestures for
 * the rules). Touch events rather than pointer events: pointer streams are
 * cancelled the moment the browser starts a native scroll, and we need to see
 * the whole gesture to tell a pan from a swipe. All listeners are passive, so
 * scrolling and pinch-zoom stay native and smooth.
 */
export function usePageSwipe(el: HTMLElement | null, { enabled, onSwipe, onProgress }: Options) {
  const handlers = useRef({ onSwipe, onProgress });
  handlers.current = { onSwipe, onProgress };

  useEffect(() => {
    if (!el || !enabled) return;
    let g: {
      x: number; y: number; t: number; maxPointers: number;
      scrollLeft: number; scrollTop: number; canPanLeft: boolean; canPanRight: boolean;
      hinting: boolean;
    } | null = null;
    let raf = 0;

    const clearHint = () => {
      cancelAnimationFrame(raf);
      if (g?.hinting) handlers.current.onProgress?.(null);
      if (g) g.hinting = false;
    };

    const onStart = (e: TouchEvent) => {
      // A lone finger (or a gesture whose end we never saw) starts afresh.
      if (g && e.touches.length > 1 && performance.now() - g.t < 1500) {
        // A second finger joined: it's a pinch, never a swipe.
        g.maxPointers = Math.max(g.maxPointers, e.touches.length);
        clearHint();
        return;
      }
      const t = e.touches[0];
      const max = el.scrollWidth - el.clientWidth;
      g = {
        x: t.clientX, y: t.clientY, t: performance.now(), maxPointers: e.touches.length,
        scrollLeft: el.scrollLeft, scrollTop: el.scrollTop,
        canPanLeft: el.scrollLeft > 1, canPanRight: el.scrollLeft < max - 1,
        hinting: false,
      };
    };

    const moved = () => !!g && (Math.abs(el.scrollLeft - g.scrollLeft) > 4 || Math.abs(el.scrollTop - g.scrollTop) > 4);

    const onMove = (e: TouchEvent) => {
      if (!g || !handlers.current.onProgress) return;
      g.maxPointers = Math.max(g.maxPointers, e.touches.length);
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      const dir: SwipeDirection = dx < 0 ? "next" : "prev";
      const blocked = g.maxPointers > 1 || moved() || (dir === "next" ? g.canPanRight : g.canPanLeft);
      const progress = blocked ? 0 : swipeProgress(dx, dy, window.innerWidth);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!g) return;
        if (progress > 0.15) {
          g.hinting = true;
          handlers.current.onProgress?.({ dir, progress });
        } else if (g.hinting) {
          g.hinting = false;
          handlers.current.onProgress?.(null);
        }
      });
    };

    const onEnd = (e: TouchEvent) => {
      if (!g) return;
      // Wait for every finger to lift before judging a multi-touch gesture.
      if (e.touches.length > 0) return;
      const t = e.changedTouches[0];
      const sel = el.ownerDocument.getSelection();
      const dir = classifySwipe({
        dx: t.clientX - g.x,
        dy: t.clientY - g.y,
        durationMs: performance.now() - g.t,
        startX: g.x,
        viewportWidth: window.innerWidth,
        maxPointers: g.maxPointers,
        selecting: !!sel && !sel.isCollapsed && sel.toString().trim().length > 0,
        scrolled: moved(),
        canPanLeft: g.canPanLeft,
        canPanRight: g.canPanRight,
      });
      clearHint();
      g = null;
      if (dir) handlers.current.onSwipe(dir);
    };

    const onCancel = () => {
      clearHint();
      g = null;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      onCancel();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, [el, enabled]);
}
