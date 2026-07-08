import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { OPEN_ACCESS } from "@/lib/openAccess";

// Single source of truth for plan + admin + locked-neuron set.
// One server RPC (my_entitlements) returns everything atomically so the UI
// can never race itself into a "free flicker" for an admin account.

export type PlanTier = "free" | "monthly" | "lifetime" | "lifetime_admin";

export interface Entitlements {
  isAdmin: boolean;
  plan: PlanTier;
  subscribed: boolean;
  isPaid: boolean;
  billingIssue: boolean;
  subscriptionEnd: string | null;
  cancelAtPeriodEnd: boolean;
  lockedWikiIds: Set<string>;
  loaded: boolean;
}

const defaults: Entitlements = {
  isAdmin: false,
  plan: "free",
  subscribed: false,
  isPaid: false,
  billingIssue: false,
  subscriptionEnd: null,
  cancelAtPeriodEnd: false,
  lockedWikiIds: new Set<string>(),
  loaded: false,
};

let snapshot: Entitlements = defaults;
let loadedForUser: string | null | undefined = undefined;
const listeners = new Set<() => void>();

function publish(next: Entitlements) {
  snapshot = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => snapshot;

export async function refreshEntitlements(): Promise<Entitlements> {
  if (OPEN_ACCESS) {
    publish({
      isAdmin: false,
      plan: "lifetime",
      subscribed: true,
      isPaid: true,
      billingIssue: false,
      subscriptionEnd: null,
      cancelAtPeriodEnd: false,
      lockedWikiIds: new Set<string>(),
      loaded: true,
    });
    return snapshot;
  }
  try {
    const { data, error } = await supabase.rpc("my_entitlements" as any);
    if (!error && data) {
      const d = data as any;
      publish({
        isAdmin: !!d.is_admin,
        plan: (d.plan as PlanTier) || "free",
        subscribed: !!d.subscribed,
        isPaid: !!d.is_paid,
        billingIssue: !!d.billing_issue,
        subscriptionEnd: d.subscription_end ?? null,
        cancelAtPeriodEnd: !!d.cancel_at_period_end,
        lockedWikiIds: new Set<string>(Array.isArray(d.locked_wiki_ids) ? d.locked_wiki_ids : []),
        loaded: true,
      });
      // For non-admin paid users, periodically re-derive from Stripe so renewals/
      // cancellations propagate. Admins never need this round trip.
      if (!d.is_admin) {
        void supabase.functions.invoke("check-subscription").catch(() => {});
      }
    } else {
      publish({ ...snapshot, loaded: true });
    }
  } catch {
    publish({ ...snapshot, loaded: true });
  }
  return snapshot;
}

function ensureLoaded(userId: string | null) {
  if (loadedForUser === userId) return;
  loadedForUser = userId;
  if (!userId) {
    publish({ ...defaults, loaded: true });
    return;
  }
  publish({ ...defaults });
  void refreshEntitlements();
}

export function useEntitlements(): Entitlements & { refresh: typeof refreshEntitlements } {
  const { user } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { ensureLoaded(user?.id ?? null); }, [user?.id]);
  return { ...snap, refresh: refreshEntitlements };
}
