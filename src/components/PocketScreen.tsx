import React, { useEffect, useRef, useState } from "react";
import { isTouchPrimary } from "@/lib/focusPolicy";
import BookWorm, { type BookWormHandle } from "@/components/BookWorm";
import type { Mood } from "@/lib/sprite/wormAnimator";
import type { PocketCaption } from "@/lib/sprite/pocketCaption";

/**
 * Pocket screen — hands-free touch guard for phones.
 *
 * While hands-free is active on a touch device, the screen must stay awake for
 * the mic (wake lock lives in useHandsFree), which leaves a full-brightness,
 * touch-live display in the user's pocket: battery drain plus phantom taps on
 * real controls. After IDLE_ARM_MS with no touches this overlay arms: a
 * near-black layer (≈off on OLED) that swallows every touch. A deliberate
 * DOUBLE-tap disarms it and returns the normal screen; using the screen keeps
 * it disarmed until the phone goes untouched again.
 *
 * THE BOOKWORM LIVES HERE TOO, and it has to earn its place on a screen whose
 * entire job is to be dark and inert:
 *
 *  - It is DIMMED, not merely shrunk. The palette below is the creature's own,
 *    pulled down to the same register as the status glyph, with the contour
 *    brighter than the fill — the inverse of the daylight scheme, because on
 *    black it is the edge that describes the shape, not the mass. Nearly every
 *    pixel stays off on an OLED, which is the thing this overlay is protecting.
 *  - It CANNOT eat the double tap. No `onPet` is passed, so no shape opts into
 *    hit testing and every touch reaches the overlay's own handler. A worm that
 *    swallowed the one gesture that dismisses this screen would be a trap.
 *  - It STOPS. The animator's motion budget runs out 4.8s after the last event,
 *    so a phone sitting in a pocket with nothing happening is showing a still
 *    image with no frame loop running at all. Motion here is exactly as long as
 *    the conversation is doing something.
 *  - The GLYPH STAYS. The worm is decorative and aria-hidden; the mic/thinking
 *    glyph is the only explicit "is it listening to me" signal on this screen,
 *    and that is not a question to answer in mime.
 */

const IDLE_ARM_MS = 12000;
const DOUBLE_TAP_MS = 350;
const MIN_TAP_GAP_MS = 60; // below this, two "taps" are simultaneous fingers
/** Past this much movement a press is a scroll, not a tap. */
const DRAG_SLOP = 8;
/** Within this of the bottom, a growing reply keeps following. */
const STICK_SLOP = 28;

/**
 * The creature at pocket brightness.
 *
 * OPAQUE, not translucent, and that is the whole point. These started as rgba()
 * at 0.15 alpha, which made the head a piece of tinted glass: the body tube ran
 * visibly straight through the face, because the head is a separate ellipse
 * drawn over it and a see-through fill occludes nothing. The offline render
 * harness never showed it, because that harness composites colours over black
 * to build its SVG — so the thing being looked at was opaque while the thing
 * shipping was not.
 *
 * These are those same colours flattened against this screen's black, which is
 * exact here (the overlay is #000) and costs an OLED nothing: a dark opaque
 * pixel and a dark translucent one over black draw the same power.
 *
 * THE EYES ARE UNLIT PIXELS. The worm is flat now — no contour to brighten,
 * which is what this palette used to lean on — so the body is a dim ember and
 * the eyes and mouth are pure #000 cut out of it: on an OLED they are literally
 * holes in the light. That inverts the usual problem out here. Every other
 * feature on this screen has to spend brightness to be seen; the face costs
 * none, and it is the most legible thing about the creature.
 *
 * The frames and the lens flash go the other way, LIGHTER than the body,
 * because the glasses overhang the head and a black frame over a black screen
 * is no frame. No contact shadow — it is not standing on anything out here.
 */
const DIM_WORM: React.CSSProperties = {
  ["--worm-body" as string]: "#3B2117",
  ["--worm-dark" as string]: "#2C1810",
  ["--worm-eye" as string]: "#6B4536",
  ["--worm-spec" as string]: "#B08A7A",
  ["--worm-pupil" as string]: "#000000",
  ["--worm-brow" as string]: "#000000",
  ["--worm-frame" as string]: "#7C5243",
  ["--worm-mouth" as string]: "#000000",
  ["--worm-tongue" as string]: "#5A3328",
  ["--worm-shadow" as string]: "transparent",
};

/** The hands-free FSM maps one-to-one onto the worm's moods. */
const MOOD_FOR: Record<string, Mood> = {
  listening: "listen",
  thinking: "think",
  speaking: "speak",
};

/**
 * What is being said right now, as a column of text under the worm.
 *
 * It used to be a bubble: a grey rounded box with an accent stripe down one
 * side, in a cold blue-grey that had nothing to do with the clay creature
 * sitting on top of it. On a screen whose background is already pure black a
 * box is a second, slightly-less-black rectangle — it lights a few hundred
 * thousand pixels to draw a container around text that did not need one, and
 * it is what made this look like a chat widget floating in a void rather than
 * a page. The text now sits directly on the black, in a warm ink taken from
 * the worm's own hue, and the only edges are the two fades where it scrolls.
 *
 * It still does not use the app's `.message-bubble-*` classes: they carry
 * per-theme overrides — dexters-lab paints a 3px fully-saturated cyan or
 * magenta edge — and a bright stripe is exactly what this screen exists not
 * to have. Who is speaking is carried the way a page carries it: the reply is
 * set left and brighter, the user's own words right, dimmer, with one hairline.
 *
 * Which line to show is decided in lib/sprite/pocketCaption.ts.
 */
const VOICE: Record<PocketCaption["from"], React.CSSProperties> = {
  // ~6.4:1 on black. Content, so it is the brightest type here — and still a
  // long way under white, because this is a screen that is meant to be off.
  assistant: { color: "#9C8F88", textAlign: "left" },
  user: { color: "#7A706B", textAlign: "right" },
};
/** The user's hairline goes on the TEXT, not on the scroll box: the box is
 *  flex-1, so a border on it ruled the whole height of the screen beside a
 *  two-line question. */
const QUOTE: React.CSSProperties = { borderRight: "1px solid #3B2117", paddingRight: "1rem" };

/** The text dissolves at both ends instead of being cut by a box edge, which
 *  is also what says "this scrolls" before the chevron does. */
const FADE = "linear-gradient(to bottom, transparent 0, #000 1.25rem, #000 calc(100% - 2.25rem), transparent 100%)";

/** The state, in a word. The glyph alone made people decode an icon on a
 *  screen they are glancing at from arm's length. */
const STATE_WORD: Record<string, string> = {
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

/** Chrome ink: the worm's clay, taken down to a whisper. */
const INK_STATE = "#8A6A5C";
const INK_HINT = "#4A3A33";

interface Props {
  active: boolean; // hands-free on
  state: string;   // hands-free FSM state, for the dim status glyph
  /** The line being spoken, heard or asked — shown under the worm. */
  caption?: PocketCaption | null;
  /** The companion's user setting — off means off everywhere. */
  wormEnabled?: boolean;
  /** Live voice, so the worm's mouth moves with what is being spoken. */
  voiceSource?: () => { level: number; wide: number } | null;
  /** Index of the spoken chunk; each change is a clause boundary. */
  speakChunk?: number | null;
  /** Reports the guard arming, so the host can stand its own worm down rather
   *  than animate one nobody can see behind this overlay. */
  onArmedChange?: (armed: boolean) => void;
}

const PocketScreen: React.FC<Props> = ({ active, state, caption = null, wormEnabled = true, voiceSource, speakChunk = null, onArmedChange }) => {
  const [armed, setArmed] = useState(false);
  const idleTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef(0);
  const touch = isTouchPrimary();

  // Idle timer: any pointer activity while disarmed postpones arming.
  // `armed` MUST be in the deps — after a double-tap disarm, React's delegated
  // listeners never see the overlay's own stopPropagation'd pointerdown, so
  // without re-running this effect nothing would ever schedule the next arm
  // and the guard would silently stay off for the rest of the session.
  useEffect(() => {
    if (!active || !touch) {
      setArmed(false);
      return;
    }
    if (armed) return; // already guarding; nothing to schedule
    const rearm = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setArmed(true), IDLE_ARM_MS);
    };
    rearm();
    window.addEventListener("pointerdown", rearm, { passive: true });
    window.addEventListener("scroll", rearm, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", rearm);
      window.removeEventListener("scroll", rearm, { capture: true } as EventListenerOptions);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [active, touch, armed]);

  const guarding = active && touch && armed;

  // Tell the host, so it can drop the transcript's worm instead of animating
  // one that is completely covered by this overlay.
  useEffect(() => {
    onArmedChange?.(guarding);
  }, [guarding, onArmedChange]);

  // Each spoken chunk boundary is a clause boundary — the acknowledgement
  // blink is most of what makes the worm look like it is following along.
  const wormRef = useRef<BookWormHandle>(null);
  const prevChunk = useRef<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ y: number; top: number; moved: number; id: number } | null>(null);
  // Native scrolling is unavailable in here (see onBubbleDown), so nothing about
  // this box says "there is more below" on its own. It has to be told.
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = box.current;
    if (!el) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > STICK_SLOP);
  };
  useEffect(() => {
    if (speakChunk == null) {
      prevChunk.current = null;
      return;
    }
    if (speakChunk === prevChunk.current) return;
    prevChunk.current = speakChunk;
    wormRef.current?.clause();
  }, [speakChunk]);

  // A new line starts at the top; you should read an answer from its beginning.
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
    measure();
  }, [caption?.id]);

  // Stick to the bottom while a reply streams in, but only if the view is
  // already there. Drag up to read back and the following stops on its own,
  // because the view is no longer near the bottom — and resumes if you drag
  // back down. No "did the user take control" flag to get out of sync.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP) {
      el.scrollTop = el.scrollHeight;
    }
    measure();
  }, [caption?.text]);

  if (!guarding) return null;

  // Shared by the overlay and the caption bubble, so a tap on the text still
  // counts toward the double tap that dismisses the guard. The bubble scrolls,
  // so it has to own its own pointer stream — but it must never become a dead
  // zone where the way out stops working.
  const registerTap = (isPrimary: boolean) => {
    // Ignore secondary contacts: a pocket press or a hand closing over the
    // phone lands 2+ pointers within milliseconds, which would otherwise read
    // as a double tap and disarm the guard on exactly the input it exists to
    // swallow. A real double tap is one primary pointer, twice, with a gap.
    if (!isPrimary) return;
    const now = Date.now();
    const gap = now - lastTapRef.current;
    if (gap > MIN_TAP_GAP_MS && gap <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      setArmed(false); // the idle effect (deps include `armed`) re-arms after quiet
    } else {
      lastTapRef.current = now;
    }
  };

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    registerTap(e.isPrimary);
  };

  /**
   * Drag to scroll a long answer, by hand.
   *
   * The overlay is `touch-none` so the guard swallows gestures, and
   * `touch-action` on an ancestor cannot be re-enabled by a descendant — so
   * native scrolling is simply not available in here. Moving scrollTop from
   * pointermove gives the same result without weakening the guard, and lets a
   * short press still register as a tap.
   */
  const onBubbleDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { y: e.clientY, top: box.current?.scrollTop ?? 0, moved: 0, id: e.pointerId };
    try { box.current?.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
  };
  const onBubbleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = box.current;
    if (!d || !el || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dy));
    if (d.moved > DRAG_SLOP) {
      el.scrollTop = d.top - dy;
      measure();
    }
  };
  const onBubbleUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try { box.current?.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    if (!d || d.moved > DRAG_SLOP) return; // that was a scroll, not a tap
    registerTap(e.isPrimary);
  };

  const glyph = state === "listening" ? "mic" : state === "thinking" ? "more_horiz" : state === "speaking" ? "graphic_eq" : "record_voice_over";

  /**
   * Two layouts, because the screen has two jobs.
   *
   * With nothing to read it is a status light: the worm centred, big, with the
   * glyph under it. With a reply up it becomes a reading surface — the worm
   * shrinks to an avatar at the top, the way a name sits above a message, and
   * the text takes the whole middle of the screen. Keeping the reading layout
   * centred around a 132px worm was spending half a phone on decoration while
   * the thing you actually came to read scrolled in a letterbox.
   */
  const reading = !!caption;

  return (
    <div
      role="button"
      aria-label="Pocket screen — double-tap to use the screen"
      onPointerDown={onOverlayPointerDown}
      onContextMenu={(e) => e.preventDefault()}
      className={`fixed inset-0 z-[200] bg-black flex flex-col items-center gap-3 px-5 select-none touch-none ${reading ? "justify-start" : "justify-center"}`}
      style={{
        opacity: 0.985,
        // The overlay covers the notch and the home indicator, so its content
        // has to clear them itself.
        paddingTop: `calc(env(safe-area-inset-top, 0px) + ${reading ? "1rem" : "0px"})`,
        paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 0.75rem)`,
      }}
    >
      {/* Reading: the worm is an avatar at the head of the column, with the
          state beside it, the way a name sits above a message. Waiting: it is
          the whole screen, centred, with the state under it. */}
      <div className={`flex shrink-0 items-center ${reading ? "w-full max-w-[46ch] flex-row gap-1" : "flex-col gap-2"}`}>
        {wormEnabled && (
          // No `onPet`: nothing here opts into hit testing, so every touch —
          // including one that lands squarely on the worm — reaches the double-tap
          // handler above. This screen's escape hatch outranks the easter egg.
          <div className={`pointer-events-none shrink-0 ${reading ? "-ml-3" : ""}`} style={DIM_WORM} aria-hidden="true">
            <BookWorm
              ref={wormRef}
              mood={MOOD_FOR[state] ?? "idle"}
              voiceSource={voiceSource}
              size={reading ? 84 : 132}
            />
          </div>
        )}
        <div className={`flex items-center gap-2 ${reading ? "" : "mt-1"}`}>
          <span className="material-symbols-outlined" style={{ color: INK_STATE, fontSize: reading ? 18 : 20 }}>{glyph}</span>
          <span
            className={`font-medium tracking-wide ${reading ? "text-[15px]" : "text-[17px]"}`}
            style={{ color: INK_STATE }}
          >
            {STATE_WORD[state] ?? "Hands-free"}
          </span>
        </div>
      </div>

      {caption && (
        <div
          ref={box}
          // Keyed on the message, NOT the text: keying on the text replayed the
          // fade on every streamed token, which strobed the whole column.
          key={caption.id}
          aria-hidden="true"
          onPointerDown={onBubbleDown}
          onPointerMove={onBubbleMove}
          onPointerUp={onBubbleUp}
          onPointerCancel={() => { drag.current = null; }}
          className="w-full max-w-[46ch] flex-1 min-h-0 overflow-y-auto overscroll-contain hide-scrollbar pt-5 pb-9 text-[17px] leading-relaxed whitespace-pre-wrap motion-safe:animate-fade-in"
          style={{ ...VOICE[caption.from], maskImage: FADE, WebkitMaskImage: FADE }}
        >
          {caption.from === "user" ? <div style={QUOTE}>{caption.text}</div> : caption.text}
        </div>
      )}

      {/* Drag-scrolling is invisible by default, so when there is more text
          below the fold the screen has to say so. It disappears at the end. */}
      {reading && more && (
        <span
          aria-hidden="true"
          className="material-symbols-outlined shrink-0 -mt-3 text-lg motion-safe:animate-fade-in"
          style={{ color: INK_STATE }}
        >
          keyboard_double_arrow_down
        </span>
      )}

      {/* The way out, said once, at the foot — pinned there when the screen is
          otherwise empty so it never crowds the worm. */}
      <span
        className={`shrink-0 text-[11px] font-medium tracking-[0.18em] uppercase ${reading ? "" : "absolute inset-x-0 text-center"}`}
        style={{ color: INK_HINT, ...(reading ? {} : { bottom: "calc(env(safe-area-inset-bottom, 0px) + 1.5rem)" }) }}
      >
        Double-tap to wake
      </span>
    </div>
  );
};

export default PocketScreen;
