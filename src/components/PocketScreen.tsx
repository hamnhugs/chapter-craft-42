import React, { useEffect, useRef, useState } from "react";
import { isTouchPrimary } from "@/lib/focusPolicy";

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
 */

const IDLE_ARM_MS = 12000;
const DOUBLE_TAP_MS = 350;
const MIN_TAP_GAP_MS = 60; // below this, two "taps" are simultaneous fingers

interface Props {
  active: boolean; // hands-free on
  state: string;   // hands-free FSM state, for the dim status glyph
}

const PocketScreen: React.FC<Props> = ({ active, state }) => {
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

  if (!active || !touch || !armed) return null;

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
      <span className="material-symbols-outlined text-3xl" style={{ color: "rgba(148,148,160,0.28)" }}>{glyph}</span>
      <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "rgba(148,148,160,0.22)" }}>
        hands-free · double-tap to wake
      </span>
    </div>
  );
};

export default PocketScreen;
