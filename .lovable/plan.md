## Goal
Let you (admin) flip any user to **Lifetime** access — or revoke it — directly from the Admin → Users table. No Stripe charge, no checkout. Lifetime users immediately get the same entitlements as paid Pro/Lifetime accounts (unlimited neurons, full feature access).

## How it will work (user view)
- In **Admin → Users**, each row gets a new **Plan** column showing one of: `Free`, `Pro`, `Lifetime (Admin Grant)`, `Lifetime (Stripe)`.
- A "⋯" action menu per row with:
  - **Grant Lifetime** (free users) — confirm dialog: "Grant lifetime access to alice@example.com? They will keep full access until you revoke it."
  - **Revoke Lifetime grant** (only for admin-granted lifetimes) — confirm dialog.
- Stripe-purchased subscriptions are shown read-only and cannot be revoked from this screen (must be handled in Stripe to avoid billing conflicts).
- Every grant/revoke is written to the existing `admin_audit_log` so there's a permanent record.
- Toast confirms success; the row updates instantly.

## How it works (technical)

### Data model
Add to `public.subscribers`:
- `granted_by_admin_id uuid` — admin who issued the grant (null for Stripe rows).
- `grant_note text` — optional reason.
- `granted_at timestamptz`.
Plan value `'lifetime_admin'` distinguishes admin grants from Stripe `'lifetime'`. Entitlement checks (`accessible_wiki_ids`, `enforce_neuron_limit`) already key off `subscribed = true`, so they keep working unchanged.

### Server-side functions (SECURITY DEFINER, admin-gated)
- `admin_grant_lifetime(_user_id uuid, _note text)` — upserts a subscribers row with `subscribed=true, plan='lifetime_admin', subscription_end=null, granted_by_admin_id=auth.uid()`. Refuses to overwrite an active Stripe subscription. Writes audit log entry `grant_lifetime`.
- `admin_revoke_lifetime(_user_id uuid)` — only clears rows where `plan='lifetime_admin'` (cannot touch Stripe rows). Writes audit log entry `revoke_lifetime`.
- `admin_list_users()` extended to return `plan`, `subscribed`, `granted_by_admin_id`, `subscription_end` for each user.

### Security best practices applied
- Roles stay in `user_roles` table; admin check via existing `is_admin()` SECURITY DEFINER function (no client-trusted flags).
- All grant/revoke logic runs server-side; client cannot self-promote.
- Every action audited with admin id, target user, timestamp, and note.
- Stripe-managed rows are protected from admin overwrite to prevent billing/entitlement drift.
- `check-subscription` edge function updated to **not downgrade** `lifetime_admin` rows when Stripe reports no subscription.

### Frontend
- `src/lib/adminApi.ts` — add `adminGrantLifetime`, `adminRevokeLifetime`; extend `AdminUserRow` with plan fields.
- `src/components/AdminPanel.tsx` — new Plan column, dropdown action menu, two confirm dialogs, optimistic reload after action.

## Out of scope
- Time-bounded grants (e.g. "1 year free") — can be added later by setting `subscription_end`.
- Bulk grants / CSV import.
- Self-service promo codes for users.
