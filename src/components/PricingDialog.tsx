import React, { useState, useSyncExternalStore } from "react";
import { Loader2, Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { usePlan, type PlanTier } from "@/hooks/usePlan";
import { OPEN_ACCESS } from "@/lib/openAccess";

// Module-level open/close store so any component (a locked neuron card, the
// deep-research toggle, an ad) can summon the pricing dialog without prop
// drilling. Mounted once in Index.tsx.
let dialogState: { open: boolean; reason: string | null } = { open: false, reason: null };
const listeners = new Set<() => void>();
function setDialogState(next: typeof dialogState) {
  dialogState = next;
  listeners.forEach((l) => l());
}
const subscribeDialog = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getDialogState = () => dialogState;

export function openPricing(reason?: string) {
  if (OPEN_ACCESS) return;
  setDialogState({ open: true, reason: reason ?? null });
}

const REASON_COPY: Record<string, string> = {
  "neuron-limit": "Free accounts include one neuron. Upgrade to grow your whole brain.",
  "neuron-locked": "This neuron is locked on the free plan. Upgrade to regain access to all of them.",
  "deep-research": "Deep Research is a Pro feature. Upgrade to unlock it.",
  "auto-structure": "Auto-chapterize is a Pro feature. Upgrade and Bookworm will detect chapters in your books automatically.",
  "figure-extraction": "Extracting figures with the built-in AI is a Pro feature. Upgrade, or add your own OpenRouter key in Settings → AI Models & Keys to use it free.",
  "all-neurons": "Letting Counsel read all your neurons at once is a Pro feature. Upgrade to unlock it.",
  ad: "Tired of ads? Upgrade and they're gone forever.",
};

const FEATURES: { label: string; free: string | boolean; pro: string | boolean; lifetime: string | boolean }[] = [
  { label: "Neurons", free: "1", pro: "Unlimited", lifetime: "Unlimited" },
  { label: "Deep Research", free: false, pro: true, lifetime: true },
  { label: "Ad-free", free: false, pro: true, lifetime: true },
  { label: "Bring your own API keys", free: true, pro: true, lifetime: true },
  { label: "All future updates", free: false, pro: "While subscribed", lifetime: "Forever" },
];

const FeatureValue: React.FC<{ value: string | boolean }> = ({ value }) =>
  typeof value === "boolean" ? (
    value ? (
      <Check className="w-4 h-4 text-primary mx-auto" />
    ) : (
      <span className="text-on-surface-variant/50 text-xs">—</span>
    )
  ) : (
    <span className="text-xs font-medium">{value}</span>
  );

/** Small plan indicator for the top app bar: Upgrade CTA for free users, plan badge for paid. */
export const PlanBadgeButton: React.FC = () => {
  const { plan, loaded, isPaid, billingIssue } = usePlan();
  if (OPEN_ACCESS) return null;
  if (!loaded) return null;
  if (!isPaid) {
    return (
      <button
        onClick={() => openPricing()}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary-container text-on-primary-container hover:brightness-110 transition-all text-xs font-body font-bold active:scale-95"
      >
        <Sparkles className="w-3.5 h-3.5" />
        Upgrade
      </button>
    );
  }
  return (
    <button
      onClick={() => openPricing()}
      title="Manage your plan"
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest transition-colors ${
        billingIssue
          ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
          : "bg-accent/10 text-accent hover:bg-accent/20"
      }`}
    >
      {billingIssue ? "Payment issue" : (plan === "lifetime" || plan === "lifetime_admin") ? "Lifetime" : "Pro"}
    </button>
  );
};

const PricingDialog: React.FC = () => {
  const { open, reason } = useSyncExternalStore(subscribeDialog, getDialogState, getDialogState);
  const { plan, isPaid, billingIssue, cancelAtPeriodEnd, subscriptionEnd } = usePlan();
  const [busy, setBusy] = useState<"monthly" | "lifetime" | "portal" | null>(null);
  if (OPEN_ACCESS) return null;

  const startCheckout = async (target: "monthly" | "lifetime") => {
    setBusy(target);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { plan: target },
      });
      if (error || !data?.url) throw new Error(error?.message || data?.error || "Could not start checkout");
      window.open(data.url, "_blank");
    } catch (err: any) {
      toast.error(err.message || "Could not start checkout");
    } finally {
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy("portal");
    try {
      const { data, error } = await supabase.functions.invoke("customer-portal");
      if (error || !data?.url) throw new Error(error?.message || data?.error || "Could not open billing portal");
      window.open(data.url, "_blank");
    } catch (err: any) {
      toast.error(err.message || "Could not open billing portal");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => setDialogState({ open: o, reason: o ? reason : null })}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-3xl">Choose your plan</DialogTitle>
          <DialogDescription>
            {(reason && REASON_COPY[reason]) || "One brain, many neurons. Pick how far you want to take it."}
          </DialogDescription>
        </DialogHeader>

        {billingIssue && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Your last payment failed. Update your card to keep Pro access.
            <Button size="sm" variant="destructive" className="ml-3" onClick={openPortal} disabled={busy === "portal"}>
              {busy === "portal" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Update card"}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 py-2">
          {/* Free */}
          <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-high p-5 flex flex-col gap-3">
            <div className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Free</div>
            <div className="font-headline text-3xl text-foreground">$0</div>
            <p className="text-xs text-on-surface-variant min-h-[32px]">Try Bookworm with one neuron. Ad-supported.</p>
            <Button variant="outline" disabled className="mt-auto">
              {!isPaid ? "Current plan" : "Free"}
            </Button>
          </div>

          {/* Pro monthly */}
          <div className="relative rounded-2xl border-2 border-primary bg-surface-container-high p-5 flex flex-col gap-3 shadow-lg">
            <div className="text-xs font-bold uppercase tracking-widest text-primary">Pro</div>
            <div className="font-headline text-3xl text-foreground">
              $4.99<span className="text-sm text-on-surface-variant font-body"> /month</span>
            </div>
            <p className="text-xs text-on-surface-variant min-h-[32px]">
              Bring your own API keys — only pay for what you use.
            </p>
            {plan === "monthly" ? (
              <Button variant="outline" className="mt-auto gap-2" onClick={openPortal} disabled={busy === "portal"}>
                {busy === "portal" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Manage billing"}
              </Button>
            ) : (
              <Button
                className="mt-auto gap-2"
                onClick={() => startCheckout("monthly")}
                disabled={busy !== null || (plan === "lifetime" || plan === "lifetime_admin")}
              >
                {busy === "monthly" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Upgrade to Pro"}
              </Button>
            )}
            {plan === "monthly" && cancelAtPeriodEnd && subscriptionEnd && (
              <p className="text-[10px] text-on-surface-variant text-center">
                Cancels {new Date(subscriptionEnd).toLocaleDateString()}
              </p>
            )}
          </div>

          {/* Lifetime */}
          <div className="relative rounded-2xl border border-outline-variant/20 bg-surface-container-high p-5 flex flex-col gap-3">
            <span className="absolute -top-2.5 right-4 px-2 py-0.5 rounded-full bg-primary-container text-on-primary-container text-[10px] font-bold uppercase tracking-widest">
              Limited-time offer
            </span>
            <div className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Lifetime</div>
            <div className="font-headline text-3xl text-foreground">
              $197<span className="text-sm text-on-surface-variant font-body"> once</span>
            </div>
            <p className="text-xs text-on-surface-variant min-h-[32px]">
              Everything in Pro, forever — including all future updates.
            </p>
            <Button
              variant={(plan === "lifetime" || plan === "lifetime_admin") ? "outline" : "secondary"}
              className="mt-auto gap-2"
              onClick={() => startCheckout("lifetime")}
              disabled={busy !== null || (plan === "lifetime" || plan === "lifetime_admin")}
            >
              {(plan === "lifetime" || plan === "lifetime_admin") ? (
                <>
                  <Check className="w-4 h-4" /> Your plan
                </>
              ) : busy === "lifetime" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Get Lifetime"
              )}
            </Button>
          </div>
        </div>

        {/* Feature comparison */}
        <div className="rounded-xl border border-outline-variant/15 overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {FEATURES.map((f, i) => (
                <tr key={f.label} className={i % 2 === 0 ? "bg-surface-container-high/60" : ""}>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs font-medium">{f.label}</td>
                  <td className="px-2 py-2.5 text-center"><FeatureValue value={f.free} /></td>
                  <td className="px-2 py-2.5 text-center"><FeatureValue value={f.pro} /></td>
                  <td className="px-2 py-2.5 text-center"><FeatureValue value={f.lifetime} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-on-surface-variant text-center">
          Payments are processed securely by Stripe. Cancel your subscription anytime — you keep access through the
          period you paid for, and your neurons are never deleted.
        </p>
      </DialogContent>
    </Dialog>
  );
};

export default PricingDialog;
