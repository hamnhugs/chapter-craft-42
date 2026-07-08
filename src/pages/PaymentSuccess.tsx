import React from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * Payment success is currently a neutral landing page: billing is disabled
 * and every signed-in user has full access. Flip OPEN_ACCESS off in
 * src/lib/openAccess.ts to restore the Stripe verification flow.
 */
const PaymentSuccess: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background px-6 text-center gap-5">
      <span
        className="material-symbols-outlined text-6xl text-primary"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        verified
      </span>
      <h1 className="font-headline text-4xl text-foreground">You're all set</h1>
      <p className="text-on-surface-variant text-sm max-w-sm">
        Everything is open right now — no payment needed. Unlimited neurons,
        Deep Research, and every Pro feature are yours to use.
      </p>
      <Button asChild size="lg" className="mt-2">
        <Link to="/">Start exploring</Link>
      </Button>
    </div>
  );
};

export default PaymentSuccess;
