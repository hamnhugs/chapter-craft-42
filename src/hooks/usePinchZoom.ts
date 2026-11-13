import { useEffect, useRef } from "react";

interface Options {
  enabled: boolean;
  /** The element that is scaled for the live preview (the page). */
  targetRef: React.RefObject<HTMLElement>;
  getScale: () => number;
  min: number;
  max: number;
  onZoom: (scale: number) => void;
}

const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

/**
 * Two-finger pinch on the reading surface zooms the page, not the whole app.
 * While the fingers are down the page is scaled with a CSS transform (cheap);
 * on release the real zoom is set once and the point that was under the
 * fingers is scrolled back under them as the page re-renders at its new size.
 * The scroller needs `touch-action: pan-x pan-y` so the browser doesn't also
 * pinch-zoom the viewport.
 */
export function usePinchZoom(el: HTMLElement | null, { enabled, targetRef, getScale, min, max, onZoom }: Options) {
  const latest = useRef({ getScale, onZoom, min, max });
  latest.current = { getScale, onZoom, min, max };

  useEffect(() => {
    if (!el || !enabled) return;
    let g: { d0: number; s0: number; next: number; cx: number; cy: number } | null = null;
    let ro: ResizeObserver | null = null;
    let roTimer = 0;

    const clear = () => {
      const target = targetRef.current;
      if (target) {
        target.style.transform = "";
        target.style.transformOrigin = "";
      }
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      g = {
        d0: Math.max(1, dist(e.touches)),
        s0: latest.current.getScale() || 1,
        next: latest.current.getScale() || 1,
        cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        cy: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    };

    const onMove = (e: TouchEvent) => {
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      const { min: lo, max: hi } = latest.current;
      g.next = Math.max(lo, Math.min(hi, g.s0 * (dist(e.touches) / g.d0)));
      const target = targetRef.current;
      if (!target) return;
      const r = target.getBoundingClientRect();
      // Origin under the fingers, measured in the untransformed box.
      const k = g.next / g.s0;
      const current = target.style.transform ? r.width / target.offsetWidth : 1;
      const ox = (g.cx - r.left) / current;
      const oy = (g.cy - r.top) / current;
      if (!target.style.transformOrigin) target.style.transformOrigin = `${ox}px ${oy}px`;
      target.style.transform = `scale(${k})`;
    };

    const onEnd = (e: TouchEvent) => {
      if (!g || e.touches.length >= 2) return;
      const done = g;
      g = null;
      const target = targetRef.current;
      const before = target?.getBoundingClientRect();
      clear();
      const next = Math.round(done.next * 100) / 100;
      if (Math.abs(next - done.s0) < 0.02 || !target || !before) return;
      // Where the pinch centre sat inside the (visually scaled) page, 0‥1.
      const relX = before.width ? (done.cx - before.left) / before.width : 0.5;
      const relY = before.height ? (done.cy - before.top) / before.height : 0.5;
      latest.current.onZoom(next);
      // The page re-renders asynchronously: keep that point under the fingers
      // each time its box changes, for a short while.
      ro?.disconnect();
      window.clearTimeout(roTimer);
      if (typeof ResizeObserver === "undefined") return;
      ro = new ResizeObserver(() => {
        const r = target.getBoundingClientRect();
        el.scrollLeft += r.left + relX * r.width - done.cx;
        el.scrollTop += r.top + relY * r.height - done.cy;
      });
      ro.observe(target);
      roTimer = window.setTimeout(() => { ro?.disconnect(); ro = null; }, 1500);
    };

    const onCancel = () => { g = null; clear(); };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      onCancel();
      ro?.disconnect();
      window.clearTimeout(roTimer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, [el, enabled, targetRef]);
}
