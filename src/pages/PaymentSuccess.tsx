import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshPlan, usePlan } from "@/hooks/usePlan";

/**
 * Stripe Checkout success landing. Entitlement is verified server-side: we
 * poll check-subscription (which asks Stripe directly) until the plan flips.
 * Stripe's records can lag the redirect by a few seconds, hence the retries.
 */
const PaymentSuccess: React.FC = () => {
  const { plan } = usePlan();
  const [status, setStatus] = useState<"verifying" | "success" | "pending">("verifying");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const snap = await refreshPlan();
        if (cancelled) return;
        if (snap.subscribed && snap.plan !== "free") {
          setStatus("success");
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
        if (cancelled) return;
      }
      setStatus("pending");
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background px-6 text-center gap-5">
      {status === "verifying" && (
        <>
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <h1 className="font-headline text-3xl text-foreground">Confirming your payment…</h1>
          <p className="text-on-surface-variant text-sm max-w-sm">
            Talking to Stripe to activate your plan. This usually takes a few seconds.
          </p>
        </>
      )}

      {status === "success" && (
        <>
          <span className="material-symbols-outlined text-6xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
            verified
          </span>
          <h1 className="font-headline text-4xl text-foreground">
            Welcome to Bookworm {plan === "lifetime" ? "Lifetime" : "Pro"}
          </h1>
          <p className="text-on-surface-variant text-sm max-w-sm">
            Unlimited neurons and Deep Research are unlocked, and ads are gone.
            {plan === "lifetime" ? " Every future update is yours, forever." : ""}
          </p>
          <Button asChild size="lg" className="mt-2">
            <Link to="/">Start exploring</Link>
          </Button>
        </>
      )}

      {status === "pending" && (
        <>
          <span className="material-symbols-outlined text-6xl text-on-surface-variant">hourglass_top</span>
          <h1 className="font-headline text-3xl text-foreground">Payment still processing</h1>
          <p className="text-on-surface-variant text-sm max-w-sm">
            Stripe hasn't confirmed the payment yet. It will activate automatically — your plan is re-checked every
            time you open the app. If you cancelled checkout, no charge was made.
          </p>
          <div className="flex gap-3 mt-2">
            <Button variant="outline" onClick={() => window.location.reload()}>Check again</Button>
            <Button asChild>
              <Link to="/">Back to Bookworm</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default PaymentSuccess;
