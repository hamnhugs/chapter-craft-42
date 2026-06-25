# Admin Entitlements — Server-Authoritative Fix

## Why your admin still sees "Upgrade"

Entitlement today is decided by **two independent client calls** that race:

1. `useIsAdmin()` — calls `is_admin()` RPC
2. `usePlan()` — reads `subscribers` row + calls `check-subscription`

The UI shows "Upgrade" until **both** resolve and `isAdmin` flips true. On a slow network or if `is_admin` momentarily fails, `isPaid` flickers to `false`, ad gates close, the badge shows "Upgrade", and Counsel tools that captured a stale `isPaid` reject features. That matches the "glitches and removes my access on refresh" symptom.

The data layer is already correct — `has_role()`, `accessible_wiki_ids()`, and `enforce_neuron_limit()` all bypass admins. The problem is only in how the client and edge functions assemble the answer.

## Fix (one source of truth, admin-first)

**1. New RPC `public.my_entitlements()`** — single SECURITY DEFINER call that returns everything the UI and tools need:

```
{ is_admin, plan, subscribed, is_paid, billing_issue,
  subscription_end, cancel_at_period_end, locked_wiki_ids[] }
```

Admin short-circuit inside the RPC: if `has_role(auth.uid(),'admin')`, return `plan='lifetime_admin'`, `is_paid=true`, `locked_wiki_ids=[]` regardless of the `subscribers` row. No race possible — one round trip, server-decided.

**2. Auto-provision admins in `subscribers`** — migration upserts `plan='lifetime_admin'` for every existing admin and a trigger does the same for new admins. So even legacy code paths that read `subscribers` directly see the right answer.

**3. Harden `check-subscription`** — if the caller is an admin, skip Stripe entirely and return `lifetime_admin`. Never downgrade an admin from a transient Stripe error.

**4. Replace `useIsAdmin` + `usePlan` with `useEntitlements`** — one hook, one RPC, no races. `usePlan` and `useIsAdmin` become thin wrappers over it so no existing components break.

**5. Edge-function audit** — every server gate (`auto-structure`, `auto-tag`, future `counsel-chat`) uses the same helper: `requireEntitlement(req, 'pro')` which checks admin first, then subscriber row. Removes copy-pasted gate logic and the "I forgot to check admin here" class of bug.

**6. UI gates** — `PlanBadgeButton`, `ChatPanel` (Deep Research, all-neurons), `WikiLibrary` / `LoadNeuronDialog` / `WikiQuickSwitcher` (locked cards), `Library` (auto-chapterize), `chatTools` (`generate_image`, `edit_image`, `switch_wiki`) all read from `useEntitlements`. Lock UI never renders until `loaded=true` — no flicker, no "Upgrade" flash for admins.

## Files

**Migration**
- `supabase/migrations/<ts>_admin_entitlements.sql`
  - `CREATE FUNCTION public.my_entitlements()` + `GRANT EXECUTE TO authenticated`
  - Backfill: `UPDATE subscribers SET plan='lifetime_admin', subscribed=true, billing_issue=false WHERE user_id IN (SELECT user_id FROM user_roles WHERE role='admin')` plus `INSERT … ON CONFLICT DO UPDATE` for admins without a row
  - Trigger `on_admin_role_grant` → upsert `lifetime_admin` subscriber row

**Edge functions**
- `supabase/functions/check-subscription/index.ts` — admin short-circuit at the top
- `supabase/functions/_shared/entitlement.ts` — new `requireEntitlement()` helper
- `supabase/functions/auto-structure/index.ts`, `auto-tag/index.ts` — switch to helper

**Frontend**
- `src/hooks/useEntitlements.ts` — new single-source hook
- `src/hooks/usePlan.ts`, `src/hooks/useIsAdmin.ts` — re-export from `useEntitlements`
- `src/lib/neuronAccess.ts` — `computeLockedWikiIds` now also accepts `isAdmin` and returns empty set
- Lock-rendering components defer until `loaded`

## Verification

- Sign in as `4325skyviewdrive@gmail.com` → badge immediately shows **Lifetime**, no flicker on hard refresh
- Counsel: Deep Research and "all neurons" toggles work without upsell
- BRAIN: no neuron is locked; can create a 2nd, 3rd neuron
- Library: Auto-chapterize runs without 402
- Chat AI: `switch_wiki` to any neuron succeeds; `generate_image` works
- Non-admin free account still hits every gate exactly as before (regression check)
