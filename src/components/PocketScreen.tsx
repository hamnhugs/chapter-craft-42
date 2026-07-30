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
  useEffect(() => {
    if (!active || !touch) {
      setArmed(false);
      return;
    }
    const rearm = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setArmed(true), IDLE_ARM_MS);
    };
    const onActivity = () => {
      // Taps on the armed overlay are handled there — this listener only runs
      // meaningfully while disarmed (the overlay swallows events when armed).
      rearm();
    };
    rearm();
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("scroll", onActivity, { capture: true } as EventListenerOptions);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [active, touch]);

  if (!active || !touch || !armed) return null;

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTapRef.current <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      setArmed(false); // the idle effect re-arms after IDLE_ARM_MS of quiet
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
