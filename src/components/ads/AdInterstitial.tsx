import React, { useEffect, useRef, useState } from "react";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { HOUSE_ADS } from "@/lib/houseAds";
import { Button } from "@/components/ui/button";
import { OPEN_ACCESS } from "@/lib/openAccess";

const INTERVAL_MS = 5 * 60_000; // one interstitial per 5 minutes of foreground use
const SKIP_DELAY_S = 5;

/**
 * Full-screen promo interstitial for free-tier users, shown after 5 minutes of
 * active (tab-visible) use. Compliance-minded by design: house creative only
 * (no third-party ad scripts), zero audio (WCAG 1.4.2), skippable after 5s
 * with Esc support, reduced-motion friendly, timer pauses while the tab is
 * hidden. Paid users never see it.
 */
const AdInterstitial: React.FC = () => {
  const { plan, loaded } = usePlan();
  const [open, setOpen] = useState(false);
  const [skipIn, setSkipIn] = useState(SKIP_DELAY_S);
  const [adIndex, setAdIndex] = useState(0);
  const elapsedRef = useRef(0);
  const skipRef = useRef<HTMLButtonElement | null>(null);

  const isFree = loaded && plan === "free";

  // Accumulate foreground time; fire when the interval elapses.
  useEffect(() => {
    if (!isFree) return;
    const tick = setInterval(() => {
      if (document.visibilityState !== "visible" || open) return;
      elapsedRef.current += 1000;
      if (elapsedRef.current >= INTERVAL_MS) {
        elapsedRef.current = 0;
        setAdIndex((i) => (i + 1) % HOUSE_ADS.length);
        setSkipIn(SKIP_DELAY_S);
        setOpen(true);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [isFree, open]);

  // Skip countdown while open.
  useEffect(() => {
    if (!open || skipIn <= 0) return;
    const t = setTimeout(() => setSkipIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [open, skipIn]);

  // Esc closes once skippable; focus lands on the skip button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && skipIn <= 0) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, skipIn]);

  useEffect(() => {
    if (open && skipIn <= 0) skipRef.current?.focus();
  }, [open, skipIn]);

  if (!isFree || !open) return null;

  const ad = HOUSE_ADS[adIndex];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sponsored message"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
    >
      <div className="relative w-full max-w-md rounded-3xl overflow-hidden bg-surface-container-high shadow-2xl">
        <div
          className="h-44 flex items-center justify-center motion-safe:animate-pulse"
          style={{ background: `linear-gradient(135deg, ${ad.gradient[0]}, ${ad.gradient[1]})` }}
        >
          <span className="material-symbols-outlined text-white text-7xl" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>
            {ad.icon}
          </span>
        </div>
        <span className="absolute top-3 left-3 px-1.5 py-0.5 rounded bg-black/40 text-white text-[9px] font-bold uppercase tracking-widest">
          Ad
        </span>

        <div className="p-6 space-y-3 text-center">
          <h2 className="font-headline font-bold text-2xl text-foreground">{ad.headline}</h2>
          <p className="text-sm text-on-surface-variant">{ad.body}</p>
          <div className="flex flex-col gap-2 pt-2">
            <Button
              size="lg"
              onClick={() => {
                setOpen(false);
                openPricing("ad");
              }}
            >
              {ad.cta}
            </Button>
            <Button
              ref={skipRef}
              variant="ghost"
              disabled={skipIn > 0}
              onClick={() => setOpen(false)}
              className="text-on-surface-variant min-h-[44px]"
            >
              {skipIn > 0 ? `Skip in ${skipIn}…` : "Skip ad"}
            </Button>
          </div>
          <p className="text-[10px] text-on-surface-variant/70">Pro and Lifetime plans are ad-free.</p>
        </div>
      </div>
    </div>
  );
};

export default AdInterstitial;
