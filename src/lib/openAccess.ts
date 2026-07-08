// ============================================================================
// OPEN ACCESS KILL SWITCH
// ----------------------------------------------------------------------------
// While this flag is true, the paywall is fully retired: every signed-in user
// gets Pro-tier entitlements (unlimited neurons, Deep Research, no ads, no
// upgrade prompts). Stripe code, PricingDialog, ads, and lock overlays remain
// in the repo but are dormant.
//
// To re-enable billing later: set OPEN_ACCESS to false and redeploy. No other
// code changes are required — entitlements will resume flowing from the server.
// ============================================================================
export const OPEN_ACCESS = true;
