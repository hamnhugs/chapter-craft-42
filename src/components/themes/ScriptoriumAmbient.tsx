import React, { useEffect, useRef } from "react";
import "@/styles/themes/scriptorium.css";

/**
 * Scriptorium's light — the part of the theme that is not on any element.
 *
 * Every other theme stops at the edge of its surfaces. This one also lights
 * the room they are in, as a layer over the whole app:
 *
 *  - By day, sun through a lancet window lies across the page and crosses it
 *    between sunrise and sunset (--scr-sun), going amber at each end of the
 *    day (--scr-golden). Both come from the theme's clock via ThemeContext.
 *  - By night there is one candle, and the reader is carrying it: the room
 *    is brightest around the pointer (or the last place a finger touched, or
 *    the field being typed in) and falls away into the dark beyond it.
 *  - In either light, gold leaf answers. Every gilded surface in
 *    scriptorium.css paints its highlight at (--scr-x, --scr-y) in viewport
 *    space, so the glint slides across a button as the light passes it, the
 *    way leaf does when you tilt the page.
 *
 * Nothing here can be clicked, focused or read: aria-hidden, pointer-events
 * none. No blend modes — every layer is plain alpha, so the page beneath is
 * never promoted into an isolated group and scrolling costs what it did.
 *
 * Cost: the light eases toward the pointer on rAF and the loop stops as soon
 * as it arrives, so a still pointer costs nothing. The pool and the dark are
 * moved with transforms (compositor only). The two custom properties are
 * written onto the gilded elements themselves, NOT onto :root: an inherited
 * property changing on the root restyles every element in the document, and
 * measured on the Library that was 19ms a frame — the whole frame budget, on
 * a glint. Written to the few elements the glint can actually reach it is a
 * fraction of a millisecond. Under
 * prefers-reduced-motion the light does not follow at all — it stays where a
 * lamp would, upper centre.
 */

/** Everything scriptorium.css gilds (it paints --scr-glint, or a child or pseudo-element of it does). */
const GILDED = [
  "button.bg-primary", ".cc-btn3d:not([data-tone])",
  "[data-wordmark]", "[data-app-header] > div > .material-symbols-outlined.text-accent",
  "[role='switch']", "[role='progressbar']",
  "[data-mobile-nav] button[aria-current='page']",
].join(",");
/** How long a list of gilded elements is trusted before the page is asked again. */
const GILDED_TTL = 400;
/** A little past the radius of --scr-glint in scriptorium.css (190px). */
const GLINT_REACH = 220;

const ScriptoriumAmbient: React.FC = () => {
  const pool = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const rest = () => ({ x: window.innerWidth * 0.5, y: window.innerHeight * 0.3 });
    let at = rest();
    let to = rest();
    let frame = 0;
    let gilded: { el: HTMLElement; box: DOMRect; lit: boolean }[] = [];
    let gildedAt = -Infinity;
    const touched = new Set<HTMLElement>();

    const paint = () => {
      const now = performance.now();
      if (now - gildedAt > GILDED_TTL) {
        // Rects are read here, all together and before any write, so the
        // per-frame loop below never asks for layout.
        const was = new Map(gilded.map((g) => [g.el, g.lit]));
        gilded = Array.from(document.querySelectorAll<HTMLElement>(GILDED), (el) => ({
          el, box: el.getBoundingClientRect(), lit: was.get(el) ?? true,
        }));
        gildedAt = now;
      }
      const x = `${at.x.toFixed(1)}px`;
      const y = `${at.y.toFixed(1)}px`;
      for (const g of gilded) {
        // Gold the glint cannot reach is left alone — but told once more as
        // the light leaves, so it is not left holding a stale highlight.
        const dx = Math.max(g.box.left - at.x, 0, at.x - g.box.right);
        const dy = Math.max(g.box.top - at.y, 0, at.y - g.box.bottom);
        const near = dx * dx + dy * dy < GLINT_REACH * GLINT_REACH;
        if (!near && !g.lit) continue;
        g.lit = near;
        g.el.style.setProperty("--scr-x", x);
        g.el.style.setProperty("--scr-y", y);
        touched.add(g.el);
      }
      if (pool.current) pool.current.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
    };
    const step = () => {
      // A flame carried across a room lags the hand that carries it.
      at = { x: at.x + (to.x - at.x) * 0.16, y: at.y + (to.y - at.y) * 0.16 };
      const arrived = Math.abs(to.x - at.x) < 0.4 && Math.abs(to.y - at.y) < 0.4;
      if (arrived) at = to;
      paint();
      frame = arrived ? 0 : requestAnimationFrame(step);
    };
    const move = (e: PointerEvent) => {
      to = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(step);
    };
    const glide = (x: number, y: number) => {
      to = { x, y };
      if (!frame) frame = requestAnimationFrame(step);
    };
    // The light goes where the reading is: to the field being written in,
    // and back to its sconce when the pointer leaves the window, so a mouse
    // parked off to one side never leaves the page in the dark.
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.matches?.("input, textarea, [contenteditable='true']")) return;
      const r = el.getBoundingClientRect();
      glide(r.left + Math.min(r.width / 2, 260), r.top + r.height / 2);
    };
    const leave = () => { const r = rest(); glide(r.x, r.y); };
    const resize = () => { at = to = rest(); paint(); };
    // Gold that arrives while the light is standing still (a menu opening, a
    // tab being gilded) is told where the light is once it has mounted.
    let late = 0;
    const settle = () => {
      window.clearTimeout(late);
      late = window.setTimeout(() => { gildedAt = -Infinity; paint(); }, 260);
    };

    paint();
    window.addEventListener("click", settle, { passive: true });
    if (!still) {
      window.addEventListener("pointermove", move, { passive: true });
      window.addEventListener("pointerdown", move, { passive: true });
      window.addEventListener("focusin", focus);
      document.documentElement.addEventListener("pointerleave", leave);
    }
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", move);
      window.removeEventListener("focusin", focus);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", resize);
      window.removeEventListener("click", settle);
      window.clearTimeout(late);
      for (const el of touched) {
        el.style.removeProperty("--scr-x");
        el.style.removeProperty("--scr-y");
      }
    };
  }, []);

  return (
    <div className="scr-ambient" aria-hidden="true">
      <div className="scr-window"><i /><span /><span /></div>
      <div className="scr-golden" />
      <div className="scr-pool" ref={pool}>
        <div className="scr-pool-dark" />
        <div className="scr-pool-glow" />
      </div>
      <div className="scr-grain" />
    </div>
  );
};

export default ScriptoriumAmbient;
