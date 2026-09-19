import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { poseWorm, REST_PARAMS, VIEW_H, VIEW_W, type Ink, type Shape } from "@/lib/sprite/wormGeometry";
import { WormAnimator, type Mood } from "@/lib/sprite/wormAnimator";

/**
 * The BookWorm — a small creature that lives at the bottom of Counsel and
 * reacts to the conversation.
 *
 * The app is called BookWorm and has never had one. This is it.
 *
 * WHY THIS COMPONENT LOOKS THE WAY IT DOES. It renders its SVG exactly once
 * and then never re-renders. Every frame writes attributes straight onto the
 * element refs instead of going through React, which is possible only because
 * `poseWorm` guarantees a fixed-length, stably-ordered shape list: element N is
 * the same element, of the same kind, for the life of the component. Running
 * the reconciler over 35 nodes sixty times a second would be a measurable share
 * of the frame budget on the mid-range Android this ships to, and would put
 * React's work on the critical path of a decoration.
 *
 * THE LOOP STOPS. `requestAnimationFrame` is not scheduled continuously. The
 * animator reports `isSettled()` once its motion budget is spent and every
 * spring has arrived — about 4.8 seconds after the last conversational event —
 * and the loop shuts down until something wakes it. That is required by WCAG
 * 2.2 SC 2.2.2 (see the long note in wormAnimator.ts), but it is also just
 * correct: an idle tab should not be burning a frame callback to animate a worm
 * nobody is looking at, and the cheapest frame is the one never scheduled.
 *
 * It is `aria-hidden` and `pointer-events: none`. It is decoration with no
 * information of its own — every state it reflects is already conveyed in text
 * elsewhere in the composer — so it must cost a screen-reader user nothing, and
 * it must never eat a tap meant for the transcript behind it.
 */

/** The creature's own colours, deliberately NOT theme tokens.
 *
 *  A mascot needs a stable identity across the four themes this app ships
 *  (one of which, fruit-stripe, is a light paper theme), which is also why the
 *  body carries a dark contour: the silhouette has to survive both a near-black
 *  and a near-white background.
 *
 *  They are muted on purpose. Zhang (2000) found that irrelevant animation
 *  degrades information-seeking performance, that *brightly coloured* animation
 *  degrades it more than dull, and that the penalty is worst on easy tasks —
 *  which is most chat reading. An earlier pass used a saturated mint; this is
 *  the same hue pulled down to something that reads as present rather than as
 *  a notification. Exposed as custom properties so a theme can override them.
 */
const INK: Record<Ink, string> = {
  body: "var(--worm-body, #7CBF9C)",
  bodyDark: "var(--worm-dark, #33604B)",
  bodyLight: "var(--worm-light, #B4DCC4)",
  ring: "var(--worm-dark, #33604B)",
  eyeWhite: "var(--worm-eye, #FBFDFB)",
  pupil: "var(--worm-pupil, #1A241E)",
  spec: "var(--worm-eye, #FBFDFB)",
  mouth: "var(--worm-mouth, #2B1A22)",
  tongue: "var(--worm-tongue, #D98099)",
  brow: "var(--worm-pupil, #1A241E)",
  glass: "var(--worm-eye, #FBFDFB)",
  frame: "var(--worm-pupil, #1A241E)",
  shadow: "var(--worm-dark, #33604B)",
};

export interface BookWormHandle {
  /** A clause of speech or streamed text just ended. */
  clause(): void;
  /** A new message or turn landed — a bigger discourse boundary. */
  topicChange(): void;
  /** A squash-and-stretch accent. */
  pop(strength?: number): void;
  nod(strength?: number): void;
  /** Flash the glasses: a thought landing. */
  glint(): void;
  /** Live voice, 0..1 loudness and -1..1 vowel spread. */
  voice(level: number, wide?: number): void;
}

export interface BookWormProps {
  mood: Mood;
  /**
   * Pulled once per frame while the mood is "speak". Returning null means the
   * voice cannot be analysed — the browser speechSynthesis path — and the
   * caller should have substituted a synthetic envelope.
   *
   * This is a prop rather than a hook call inside the component because the
   * audio has to be sampled INSIDE the animation frame. Reading it in React
   * and passing it down as state would add a render and a frame of latency to
   * the one signal in this whole feature that cannot afford either.
   */
  voiceSource?: () => { level: number; wide: number } | null;
  /** Rendered width in CSS pixels. Height follows the viewBox. */
  size?: number;
  className?: string;
}

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function readReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
}

const BookWorm = React.forwardRef<BookWormHandle, BookWormProps>(function BookWorm(
  { mood, voiceSource, size = 64, className },
  ref,
) {
  const nodes = useRef<(SVGElement | null)[]>([]);
  const anim = useRef<WormAnimator | null>(null);
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const visible = useRef(true);
  const host = useRef<SVGSVGElement | null>(null);
  const moodRef = useRef(mood);
  const voiceRef = useRef(voiceSource);
  voiceRef.current = voiceSource;

  if (!anim.current) anim.current = new WormAnimator({ mood, reduced: readReduced() });

  /** Write one pose onto the live DOM. Only the attributes that actually vary
   *  are touched; fills and strokes are set once at mount and never again. */
  const paint = useCallback((shapes: Shape[]) => {
    for (let i = 0; i < shapes.length; i++) {
      const el = nodes.current[i];
      if (!el) continue;
      const s = shapes[i];
      if (s.op != null) el.setAttribute("opacity", String(s.op));
      if (s.k === "path") {
        el.setAttribute("d", s.d);
        if (s.sw != null) el.setAttribute("stroke-width", String(s.sw));
      } else if (s.k === "circle") {
        el.setAttribute("cx", String(s.cx));
        el.setAttribute("cy", String(s.cy));
        el.setAttribute("r", String(s.r));
      } else {
        el.setAttribute("cx", String(s.cx));
        el.setAttribute("cy", String(s.cy));
        el.setAttribute("rx", String(s.rx));
        el.setAttribute("ry", String(s.ry));
        if (s.rot != null) el.setAttribute("transform", `rotate(${s.rot} ${s.cx} ${s.cy})`);
      }
    }
  }, []);

  const stop = useCallback(() => {
    if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  /** Start the loop if it is not already running. Every imperative beat and
   *  every mood change goes through here; nothing else schedules a frame. */
  const kick = useCallback(() => {
    if (raf.current != null || !visible.current) return;
    last.current = 0;
    const frame = (t: number) => {
      const dt = last.current ? t - last.current : 16.67;
      last.current = t;
      const a = anim.current;
      if (!a) return;
      // Sampled here, in the frame, immediately before the pose is built —
      // the shortest possible path from waveform to mouth.
      if (moodRef.current === "speak") {
        const v = voiceRef.current?.();
        if (v) a.setVoice(v.level, v.wide);
      }
      paint(poseWorm(a.step(dt)).shapes);
      // The whole point: stop scheduling once there is nothing left to show.
      if (a.isSettled()) {
        raf.current = null;
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }, [paint]);

  useImperativeHandle(
    ref,
    (): BookWormHandle => ({
      clause: () => {
        anim.current?.clause();
        kick();
      },
      topicChange: () => {
        anim.current?.topicChange();
        kick();
      },
      pop: (s) => {
        anim.current?.pop(s);
        kick();
      },
      nod: (s) => {
        anim.current?.nod(s);
        kick();
      },
      glint: () => {
        anim.current?.glint();
        kick();
      },
      voice: (level, wide) => {
        anim.current?.setVoice(level, wide);
        if (level > 0.02) kick();
      },
    }),
    [kick],
  );

  useEffect(() => {
    moodRef.current = mood;
    anim.current?.setMood(mood);
    kick();
  }, [mood, kick]);

  // Paint the first frame synchronously, so the very first thing drawn is the
  // worm in its actual mood rather than a flash of the rest pose.
  useLayoutEffect(() => {
    const a = anim.current;
    if (a) paint(poseWorm(a.step(16.67)).shapes);
  }, [paint]);

  // prefers-reduced-motion is watched, not merely read. The media query only
  // affects CSS by itself; anything driven from JS has to listen for the change
  // and stop what is already in flight.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(REDUCE_QUERY);
    } catch {
      return;
    }
    const onChange = () => {
      anim.current?.setReduced(mq.matches);
      kick();
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [kick]);

  // Nothing animates while the tab is hidden or the worm is scrolled out of
  // view. rAF is already throttled in a background tab, but an IntersectionObserver
  // also covers the case where Counsel is mounted behind another tab of the app.
  useEffect(() => {
    const onVis = () => {
      visible.current = !document.hidden;
      if (document.hidden) stop();
      else kick();
    };
    document.addEventListener("visibilitychange", onVis);

    let io: IntersectionObserver | null = null;
    const el = host.current;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        const on = entries.some((e) => e.isIntersecting);
        visible.current = on && !document.hidden;
        if (!visible.current) stop();
        else kick();
      });
      io.observe(el);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, [kick, stop]);

  useEffect(() => stop, [stop]);

  /** Rendered once. After this the component never re-renders: `mood` changes
   *  go to the animator, not to React. */
  const initial = useMemo(() => poseWorm(REST_PARAMS).shapes, []);

  return (
    <svg
      ref={host}
      width={size}
      height={Math.round((size * VIEW_H) / VIEW_W)}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ pointerEvents: "none", overflow: "visible" }}
    >
      {initial.map((s, i) => {
        const common = {
          key: s.key,
          ref: (el: SVGElement | null) => {
            nodes.current[i] = el;
          },
          fill: s.fill ? INK[s.fill] : "none",
          ...(s.stroke ? { stroke: INK[s.stroke] } : {}),
          ...(s.sw != null ? { strokeWidth: s.sw } : {}),
          ...(s.op != null ? { opacity: s.op } : {}),
          ...(s.cap ? { strokeLinecap: "round" as const, strokeLinejoin: "round" as const } : {}),
        };
        if (s.k === "path") return <path {...common} d={s.d} />;
        if (s.k === "circle") return <circle {...common} cx={s.cx} cy={s.cy} r={s.r} />;
        return (
          <ellipse
            {...common}
            cx={s.cx}
            cy={s.cy}
            rx={s.rx}
            ry={s.ry}
            {...(s.rot != null ? { transform: `rotate(${s.rot} ${s.cx} ${s.cy})` } : {})}
          />
        );
      })}
    </svg>
  );
});

export default BookWorm;
