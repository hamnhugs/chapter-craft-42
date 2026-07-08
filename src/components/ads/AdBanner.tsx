import React, { useEffect, useState } from "react";
import { usePlan } from "@/hooks/usePlan";
import { openPricing } from "@/components/PricingDialog";
import { HOUSE_ADS } from "@/lib/houseAds";
import { OPEN_ACCESS } from "@/lib/openAccess";

const ROTATE_MS = 45_000;

/**
 * Slim display-ad strip for free-tier users. Fixed height (no layout shift),
 * clearly labeled "Ad" (FTC disclosure), static content (WCAG 2.2.2 — nothing
 * auto-moving), rotates creative on an interval. Paid users never see it.
 */
const AdBanner: React.FC = () => {
  const { plan, loaded } = usePlan();
  const [index, setIndex] = useState(() => Math.floor(Math.random() * HOUSE_ADS.length));

  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % HOUSE_ADS.length), ROTATE_MS);
    return () => clearInterval(t);
  }, []);

  if (OPEN_ACCESS) return null;
  if (!loaded || plan !== "free") return null;

  const ad = HOUSE_ADS[index];

  return (
    <div className="w-full h-12 flex items-center gap-3 px-4 border-b border-border/60 bg-surface-container-high/80">
      <span className="px-1.5 py-0.5 rounded border border-outline-variant/40 text-[9px] font-bold uppercase tracking-widest text-on-surface-variant shrink-0">
        Ad
      </span>
      <button
        onClick={() => openPricing("ad")}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left group"
      >
        <span
          className="material-symbols-outlined text-[18px] text-white rounded-md p-1 shrink-0"
          style={{ background: `linear-gradient(135deg, ${ad.gradient[0]}, ${ad.gradient[1]})` }}
          aria-hidden
        >
          {ad.icon}
        </span>
        <span className="truncate text-xs text-foreground">
          <span className="font-bold">{ad.headline}</span>
          <span className="hidden sm:inline text-on-surface-variant"> — {ad.body}</span>
        </span>
        <span className="ml-auto shrink-0 text-xs font-bold text-primary group-hover:underline whitespace-nowrap">
          {ad.cta}
        </span>
      </button>
    </div>
  );
};

export default AdBanner;
