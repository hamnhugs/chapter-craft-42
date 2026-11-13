import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { claimPurchases, formatCoins } from "@/lib/coins";
import { refreshPlan } from "@/hooks/usePlan";

/**
 * Where Stripe sends people back to.
 *
 * Two kinds of purchase land here. A coin pack is credited by asking the
 * server to re-check what has been paid for (claim-coins — safe to repeat, a
 * purchase is only ever credited once); a plan is picked up by refreshing
 * entitlements. Neither depends on this page being reached: the Store runs
 * the same check every time it opens, so closing the tab early loses nothing.
 */
const PaymentSuccess: React.FC = () => {
  const [credited, setCredited] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const coins = await claimPurchases();
      void refreshPlan();
      if (!cancelled) setCredited(coins);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background px-6 text-center gap-5">
      <span
        className="material-symbols-outlined text-6xl text-primary"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        verified
      </span>
      <h1 className="font-headline text-4xl text-foreground">You're all set</h1>
      <p className="text-on-surface-variant text-sm max-w-sm" aria-live="polite">
        {credited === null
          ? "Checking your purchase…"
          : credited > 0
            ? `${formatCoins(credited)} coins have been added to your wallet.`
            : "Thanks! Anything you bought is on your account — coins show in the Store, plans in Settings."}
      </p>
      <Button asChild size="lg" className="mt-2">
        <Link to="/">Back to Bookworm</Link>
      </Button>
    </div>
  );
};

export default PaymentSuccess;
