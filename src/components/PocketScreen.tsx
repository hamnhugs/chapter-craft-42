import React, { useEffect, useRef, useState } from "react";
import { isTouchPrimary } from "@/lib/focusPolicy";
import BookWorm, { type BookWormHandle } from "@/components/BookWorm";
import type { Mood } from "@/lib/sprite/wormAnimator";

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

/** The creature at pocket brightness. Contour over fill, eyes brightest, and
 *  no contact shadow — it is not standing on anything out here. */
const DIM_WORM: React.CSSProperties = {
  ["--worm-body" as string]: "rgba(126,190,156,0.15)",
  ["--worm-dark" as string]: "rgba(126,190,156,0.40)",
  ["--worm-light" as string]: "rgba(190,230,210,0.20)",
  ["--worm-eye" as string]: "rgba(226,240,232,0.46)",
  ["--worm-spec" as string]: "rgba(240,252,245,0.75)",
  ["--worm-pupil" as string]: "rgba(6,9,7,0.95)",
  ["--worm-brow" as string]: "rgba(150,205,180,0.40)",
  ["--worm-frame" as string]: "rgba(150,205,180,0.38)",
  ["--worm-mouth" as string]: "rgba(6,9,7,0.92)",
  ["--worm-tongue" as string]: "rgba(205,130,150,0.28)",
  ["--worm-shadow" as string]: "transparent",
};

/** The hands-free FSM maps one-to-one onto the worm's moods. */
const MOOD_FOR: Record<string, Mood> = {
  listening: "listen",
  thinking: "think",
  speaking: "speak",
};

interface Props {
  active: boolean; // hands-free on
  state: string;   // hands-free FSM state, for the dim status glyph
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

const PocketScreen: React.FC<Props> = ({ active, state, wormEnabled = true, voiceSource, speakChunk = null, onArmedChange }) => {
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
  useEffect(() => {
    if (speakChunk == null) {
      prevChunk.current = null;
      return;
    }
    if (speakChunk === prevChunk.current) return;
    prevChunk.current = speakChunk;
    wormRef.current?.clause();
  }, [speakChunk]);

  if (!guarding) return null;

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Ignore secondary contacts: a pocket press or a hand closing over the
    // phone lands 2+ pointers within milliseconds, which would otherwise read
    // as a double tap and disarm the guard on exactly the input it exists to
    // swallow. A real double tap is one primary pointer, twice, with a gap.
    if (!e.isPrimary) return;
    const now = Date.now();
    const gap = now - lastTapRef.current;
    if (gap > MIN_TAP_GAP_MS && gap <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      setArmed(false); // the idle effect (deps include `armed`) re-arms after quiet
    } else {
      lastTapRef.current = now;
    }
  };

  const glyph = state === "listening" ? "mic" : state === "thinking" ? "more_horiz" : state === "speaking" ? "graphic_eq" : "record_voice_over";

  return (
    <div
      role="button"
      aria-label="Pocket screen — double-tap to use the screen"
      onPointerDown={onOverlayPointerDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed inset-0 z-[200] bg-black flex flex-col items-center justify-center gap-3 select-none touch-none"
      style={{ opacity: 0.985 }}
    >
      {wormEnabled && (
        // No `onPet`: nothing here opts into hit testing, so every touch —
        // including one that lands squarely on the worm — reaches the double-tap
        // handler above. This screen's escape hatch outranks the easter egg.
        <div className="pointer-events-none" style={DIM_WORM} aria-hidden="true">
          <BookWorm
            ref={wormRef}
            mood={MOOD_FOR[state] ?? "idle"}
            voiceSource={voiceSource}
            size={132}
          />
        </div>
      )}
      <span className="material-symbols-outlined text-3xl" style={{ color: "rgba(148,148,160,0.28)" }}>{glyph}</span>
      <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "rgba(148,148,160,0.22)" }}>
        hands-free · double-tap to wake
      </span>
    </div>
  );
};

export default PocketScreen;
