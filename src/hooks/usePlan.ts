// Backwards-compatible wrapper around the unified useEntitlements() hook.
// Every plan-gated component (PlanBadgeButton, ChatPanel toggles, WikiLibrary
// locks, Library auto-chapterize, chatTools deps) reads from here, so the
// single server RPC drives every gate without races.
import { useEntitlements, refreshEntitlements, type PlanTier as ETier } from "@/hooks/useEntitlements";

export type PlanTier = ETier;

export const refreshPlan = refreshEntitlements;

export function usePlan() {
  const e = useEntitlements();
  return {
    plan: e.plan,
    subscribed: e.subscribed,
    subscriptionEnd: e.subscriptionEnd,
    billingIssue: e.billingIssue,
    cancelAtPeriodEnd: e.cancelAtPeriodEnd,
    loaded: e.loaded,
    isPaid: e.isPaid,
    refresh: refreshEntitlements,
  };
}
