import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useIsAdmin";

export type PlanTier = "free" | "monthly" | "lifetime";

export interface PlanSnapshot {
  plan: PlanTier;
  subscribed: boolean;
  subscriptionEnd: string | null;
  billingIssue: boolean;
  cancelAtPeriodEnd: boolean;
  loaded: boolean;
}

const defaults: PlanSnapshot = {
  plan: "free",
  subscribed: false,
  subscriptionEnd: null,
  billingIssue: false,
  cancelAtPeriodEnd: false,
  loaded: false,
};

// Module-level shared store (same idiom as useChatSettings / workspaceStore):
// one snapshot in memory, every component sees the same plan state.
let snapshot: PlanSnapshot = defaults;
let loadedForUser: string | null | undefined = undefined;
const listeners = new Set<() => void>();

function publish(next: Partial<PlanSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getSnapshot = () => snapshot;

/**
 * Authoritative refresh: asks the check-subscription edge function, which
 * queries Stripe directly and updates the subscribers cache row. Entitlement
 * is never decided client-side — this just mirrors the server's answer.
 */
export async function refreshPlan(): Promise<PlanSnapshot> {
  try {
    const { data, error } = await supabase.functions.invoke("check-subscription");
    if (!error && data && !data.error) {
      publish({
        plan: (data.plan as PlanTier) || "free",
        subscribed: !!data.subscribed,
        subscriptionEnd: data.subscription_end ?? null,
        billingIssue: !!data.billing_issue,
        cancelAtPeriodEnd: !!data.cancel_at_period_end,
        loaded: true,
      });
    } else {
      // Keep whatever we had (cached row) rather than demoting on a transient error.
      publish({ loaded: true });
    }
  } catch {
    publish({ loaded: true });
  }
  return snapshot;
}

function ensureLoaded(userId: string | null) {
  if (loadedForUser === userId) return;
  loadedForUser = userId;
  if (!userId) {
    snapshot = { ...defaults, loaded: true };
    listeners.forEach((l) => l());
    return;
  }
  publish({ ...defaults });
  void (async () => {
    // Fast path: cached subscribers row (RLS lets the owner read it).
    try {
      const { data } = await supabase
        .from("subscribers" as any)
        .select("plan, subscribed, subscription_end, billing_issue")
        .eq("user_id", userId)
        .maybeSingle();
      if (loadedForUser !== userId) return;
      if (data) {
        const row = data as any;
        publish({
          plan: (row.plan as PlanTier) || "free",
          subscribed: !!row.subscribed,
          subscriptionEnd: row.subscription_end ?? null,
          billingIssue: !!row.billing_issue,
          loaded: true,
        });
      }
    } catch { /* table may not exist yet on first deploy */ }
    // Then re-derive from Stripe (handles renewals, cancellations, demotions).
    if (loadedForUser === userId) await refreshPlan();
  })();
}

export function usePlan() {
  const { user } = useAuth();
  const { isAdmin } = useIsAdmin();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { ensureLoaded(user?.id ?? null); }, [user]);
  // Admin accounts are entitled to everything regardless of Stripe state.
  // This only relaxes client-side gating; the database/edge gates check the
  // admin role independently (accessible_wiki_ids, enforce_neuron_limit,
  // auto-structure), so a tampered client still can't escalate.
  if (isAdmin) {
    return {
      ...snap,
      plan: "lifetime" as PlanTier,
      subscribed: true,
      billingIssue: false,
      isPaid: true,
      refresh: refreshPlan,
    };
  }
  return {
    ...snap,
    isPaid: snap.subscribed && snap.plan !== "free",
    refresh: refreshPlan,
  };
}
