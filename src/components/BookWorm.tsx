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
 *  (one of which, fruit-stripe, is a light paper theme). The first worm solved
 *  that with a dark contour round a mint body. This one solves it with the
 *  choice of colour alone: a warm clay at mid luminance sits about as far from
 *  paper as it does from near-black, so the silhouette survives both with
 *  nothing drawn round it — and losing the outline is most of what moved it
 *  from clip-art to something that looks designed.
 *
 *  FLAT, AND ONLY TWO TONES OF ONE HUE. No gradient, no rim light, no specular,
 *  no eye-whites. The second tone exists to separate the beads the way
 *  overlapping cut paper would; everything else on the face is a single ink.
 *
 *  Zhang (2000) found that irrelevant animation degrades information-seeking
 *  performance and that *brightly coloured* animation degrades it more than
 *  dull — so this is a terracotta, not an orange. Exposed as custom properties
 *  so a theme can override them.
 */
const INK: Record<Ink, string> = {
  body: "var(--worm-body, #DD7C58)",
  bodyAlt: "var(--worm-dark, #C9683F)",
  pupil: "var(--worm-pupil, #2B1B15)",
  mouth: "var(--worm-mouth, #2B1B15)",
  tongue: "var(--worm-tongue, #F4A58C)",
  glass: "var(--worm-eye, #FFF6EE)",
  // These four share a value by default but get their own escape hatch,
  // because on a black ground the defaults collapse: a near-black frame
  // vanishes wherever it overhangs the head, a lens flash the colour of paper
  // is the brightest thing on a screen meant to be off, and a contact shadow is
  // a smudge under a creature that is not standing on anything. The pocket
  // screen overrides exactly these.
  spec: "var(--worm-spec, var(--worm-eye, #FFF6EE))",
  brow: "var(--worm-brow, var(--worm-pupil, #2B1B15))",
  frame: "var(--worm-frame, var(--worm-pupil, #2B1B15))",
  // Neutral, not a tone of the body: a tinted shadow under a flat shape reads as
  // a glow. At 0.2 it is a soft ground on paper and simply absent on black.
  shadow: "var(--worm-shadow, #000000)",
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
  /** Someone touched it. */
  pet(): void;
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
  /** Called when the worm is tapped, so the host can reset its own idle clock
   *  (a petted worm should stop being asleep). The reaction itself is handled
   *  in here — it is animation, not application state. */
  onPet?: () => void;
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
  { mood, voiceSource, onPet, size = 64, className },
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
      pet: () => {
        anim.current?.pet();
        kick();
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

  /**
   * Tap to pet.
   *
   * ON POINTER-UP, WITH A MOVEMENT THRESHOLD — never on pointer-down. This
   * repo has already paid for that lesson once: the composer's prompt switcher
   * opened on the DOWN event and fired before the finger had travelled, which
   * is a documented defect with its own test. The worm sits at the bottom-right
   * of the transcript, which is exactly where a thumb lands to start a scroll,
   * so firing on down would pet it on every flick.
   */
  const down = useRef<{ x: number; y: number; t: number } | null>(null);

  const onDown = useCallback((e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }, []);

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      const d = down.current;
      down.current = null;
      if (!d) return;
      // A drag, a scroll or a long press is not a tap.
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
      if (e.timeStamp - d.t > 700) return;
      anim.current?.pet();
      kick();
      onPet?.();
    },
    [kick, onPet],
  );

  /**
   * Only the worm's own ink is tappable.
   *
   * The <svg> and its wrapper are `pointer-events: none`, and the fills that
   * make up its silhouette — body, beads, head — opt back in — a descendant may re-enable hit testing under a `none`
   * ancestor. So the target is the creature's actual silhouette, not its
   * bounding box: a tap one pixel outside the body goes straight through to the
   * message bubble behind it, and so does a tap on the eyes or glasses, which
   * stay `none` and let the hit fall through to the head beneath.
   *
   * This does leave a target under the 24x24 of SC 2.5.8, and that is a
   * deliberate trade rather than an oversight: petting is a pure easter egg
   * that conveys nothing and does nothing, while the only way to enlarge it is
   * to start swallowing taps meant for the transcript — which is the worse harm
   * of the two, and would fall on everybody rather than on a hidden extra.
   */
  const hit = useMemo(
    () =>
      onPet === undefined
        ? undefined
        : ({
            style: { pointerEvents: "auto" as const, cursor: "pointer", touchAction: "manipulation" as const },
            onPointerDown: onDown,
            onPointerUp: onUp,
            onPointerCancel: () => {
              down.current = null;
            },
          } as const),
    [onPet, onDown, onUp],
  );

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
          ...(hit && (s.key === "body" || s.key === "head" || s.key.startsWith("bead")) ? hit : {}),
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
