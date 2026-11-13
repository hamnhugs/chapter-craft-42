// One answer to "may this caller use a Pro feature?", for every edge function
// that gates on the plan.
//
// The functions used to read `subscribers.subscribed` directly, which knows
// about Stripe and nothing else: it refused everyone during open access (the
// client believed they were entitled, the server answered 402), and it would
// have refused a Pro pass bought with coins. `my_entitlements()` is the
// database's own single source — admin, subscription and coin pass — and
// `app_open_access()` is the server-side twin of the client's OPEN_ACCESS
// switch.
//
// `supabase` must be the CALLER-scoped client (their JWT): both RPCs answer
// for auth.uid().

//
// `openAccess: false` is for features that spend the app's own AI credits in
// volume (figure extraction through the gateway): open access does not extend
// to those, a real plan or pass does.

// deno-lint-ignore no-explicit-any
export async function isEntitled(supabase: any, opts: { openAccess?: boolean } = {}): Promise<boolean> {
  try {
    const { data: ent } = await supabase.rpc("my_entitlements");
    if (ent?.is_paid === true) return true;
  } catch { /* fall through to the open-access check */ }
  if (opts.openAccess === false) return false;
  try {
    const { data: open } = await supabase.rpc("app_open_access");
    return open === true;
  } catch {
    return false;
  }
}
