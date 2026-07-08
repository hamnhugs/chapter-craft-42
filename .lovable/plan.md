# Open Access — Retire the Paywall (for now)

Goal: every signed-in user gets full Pro capabilities. No Stripe calls, no ads, no locked neurons, no upgrade prompts. Keep the billing code intact but dormant so we can flip it back on later.

## Best-practice notes applied
- **Single source of truth**: flip the gate at the entitlements layer (`useEntitlements`) so every downstream gate (`usePlan`, locked neurons, ads, Pricing dialog, Deep Research, auto-chapterize, BRAIN locks, ⌘K switcher, chat tools) inherits "paid" without touching each call site. Avoids drift and future re-enable pain.
- **Fail closed → fail open, intentionally**: force `plan = "lifetime"`, `isPaid = true`, `lockedWikiIds = ∅`, `billingIssue = false` locally. Do not touch the DB or Stripe — server still knows the truth for when we re-enable.
- **Don't rip code out**: leave Stripe edge functions, `PricingDialog`, `AdBanner`, `houseAds` in the repo but stop rendering/invoking them. One-line kill switch (`OPEN_ACCESS = true`) documented in `src/lib/openAccess.ts` so re-enabling is a single revert.
- **No dead UI**: hide (not disable) the Upgrade button, plan badge upsell state, ad strip, ad interstitial, "locked" overlays on neuron cards, and paywall CTA in ⌘K. Keeps the surface clean rather than showing greyed-out affordances (Nielsen: remove rather than disable when action is unavailable indefinitely).
- **Accessibility / clarity**: no lingering "Free plan" copy or lock icons that would confuse screen readers now that nothing is actually locked.
- **Reversibility**: a single constant toggles everything back. Documented at top of `openAccess.ts`.

## Changes

1. **New `src/lib/openAccess.ts`** — exports `OPEN_ACCESS = true` with a comment explaining the kill switch and what to revert.

2. **`src/hooks/useEntitlements.ts`** — when `OPEN_ACCESS` is on, short-circuit `refreshEntitlements` / `ensureLoaded` to publish `{ isAdmin: current, plan: "lifetime", subscribed: true, isPaid: true, billingIssue: false, subscriptionEnd: null, cancelAtPeriodEnd: false, lockedWikiIds: ∅, loaded: true }` immediately after auth. Skip the `my_entitlements` RPC and the `check-subscription` invoke entirely. Admin flag still fetched cheaply (or left as false — doesn't matter since everyone is Pro).

3. **`src/lib/neuronAccess.ts`** — `computeLockedWikiIds` returns empty set when `OPEN_ACCESS` is on (belt + suspenders in case any caller bypasses entitlements).

4. **`src/components/ads/AdBanner.tsx`** and **`src/components/ads/AdInterstitial.tsx`** — early `return null` when `OPEN_ACCESS`. Ads never render.

5. **`src/components/PricingDialog.tsx`** — `openPricing()` becomes a no-op when `OPEN_ACCESS` (no dialog, no console noise). Any component still calling it silently does nothing.

6. **Plan badge / Upgrade button** — locate the header/nav plan badge (likely `PlanBadgeButton` referenced from `usePlan.ts` comment) and hide it entirely under `OPEN_ACCESS`. If it also serves as an account menu, keep the account menu portion and drop only the plan/upgrade affordance.

7. **`src/pages/Auth.tsx`** — no changes needed to the sign-in form; keep the intro video block added earlier. Remove any "Free plan starts here" style copy if present.

8. **`src/pages/PaymentSuccess.tsx`** — keep the route reachable (in case of stray links) but render a neutral "You're all set — everything is open right now, no payment needed" message and a button back to `/`. No Stripe polling.

9. **Locked overlays** — anywhere neuron cards, ⌘K switcher, or BRAIN tab render a lock icon or "Upgrade to unlock" tooltip, gate that JSX on `!OPEN_ACCESS`. Driven off `lockedWikiIds` being empty, so mostly automatic, but audit visible strings (`Locked`, `Upgrade`, `Pro`) and hide the ones that no longer apply.

10. **Chat tools / Deep Research / auto-chapterize** — already gated on `isPaid`; with entitlements forced to paid, these enable for everyone. No code change beyond step 2.

## Out of scope
- Deleting Stripe edge functions or removing `stripe` deps.
- DB migrations to `subscribers` / `user_roles`.
- Changing pricing copy in marketing pages (none present in-app).
- Rotating Stripe keys.

## Re-enabling later
Flip `OPEN_ACCESS` to `false` in `src/lib/openAccess.ts`. Everything reverts to server-driven entitlements with no other code changes.

## Verification
- Load `/auth`, sign in, confirm: no ad strip, no Upgrade button, all neurons unlocked, ⌘K shows no locks, Deep Research toggle available, Pricing dialog cannot be opened, `PaymentSuccess` shows the neutral message.
- Network tab: no calls to `check-subscription`, `create-checkout`, `customer-portal`, or `my_entitlements` RPC after sign-in.
