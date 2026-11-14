import React from "react";
import BookWorm, { type BookWormHandle } from "@/components/BookWorm";
import type { Mood } from "@/lib/sprite/wormAnimator";

/**
 * Bookworm with a speech bubble — the one voice of onboarding. The setup
 * helper, the getting-started list and the tab tours all speak through this,
 * so a new user meets one character instead of three kinds of popup.
 *
 * The worm is the same sprite that lives in Counsel (BookWorm.tsx): it stops
 * animating once it has settled and honours reduced motion on its own.
 */
const WormSays = React.forwardRef<
  BookWormHandle,
  {
    mood?: Mood;
    /** Worm width in CSS pixels. */
    size?: number;
    className?: string;
    bubbleClassName?: string;
    children: React.ReactNode;
  }
>(function WormSays({ mood = "idle", size = 56, className = "", bubbleClassName = "", children }, ref) {
  return (
    <div className={`flex items-end gap-2.5 ${className}`}>
      <BookWorm ref={ref} mood={mood} size={size} className="shrink-0 h-auto" />
      <div className={`cc-worm-bubble relative min-w-0 flex-1 rounded-2xl rounded-bl-md border border-outline-variant/30 bg-surface-container-high px-3.5 py-3 ${bubbleClassName}`}>
        {children}
      </div>
    </div>
  );
});

export default WormSays;
