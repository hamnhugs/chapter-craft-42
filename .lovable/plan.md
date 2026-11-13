# Switch on coins

1. Apply `supabase/migrations/20261112120000_coins.sql` exactly as written (wallets, history, Pro passes, welcome/daily coins, updated entitlements).
2. Deploy coin-chat and claim-coins (new) plus create-checkout, auto-structure and describe-figures (changed), with their shared helpers.
3. STRIPE_SECRET_KEY is already set — no action.
4. Check: database objects exist, function logs are clean, and the Store tab shows no "coins aren't switched on" notice and a 100-coin wallet.
