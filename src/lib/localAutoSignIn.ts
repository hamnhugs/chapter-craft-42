// Local edition: no sign-in screen. scripts/local-up.sh creates one owner
// account on this machine's Supabase and writes its credentials to the
// gitignored .env.local (VITE_LOCAL_AUTO_EMAIL / VITE_LOCAL_AUTO_PASSWORD).
// The app signs in with them silently before anything renders.
//
// Only ever active against a loopback backend, so a build pointed at the
// hosted project can never carry or use these.

import { supabase } from "@/integrations/supabase/client";
import { isLocalBackend } from "@/lib/localServices";

const EMAIL = import.meta.env.VITE_LOCAL_AUTO_EMAIL as string | undefined;
const PASSWORD = import.meta.env.VITE_LOCAL_AUTO_PASSWORD as string | undefined;

/** True when this build signs itself in (local backend + owner credentials). */
export function localAutoSignInEnabled(): boolean {
  return !!EMAIL && !!PASSWORD && isLocalBackend();
}

let pending: Promise<void> | null = null;

/** Resolves once there is a session (or auto sign-in isn't configured, or it
 *  failed — then the normal sign-in page shows). Runs once per page load. */
export function ensureLocalSession(): Promise<void> {
  if (!localAutoSignInEnabled()) return Promise.resolve();
  return (pending ??= (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return;
    const { error } = await supabase.auth.signInWithPassword({ email: EMAIL!, password: PASSWORD! });
    if (error) console.warn("Local auto sign-in failed — showing the sign-in page:", error.message);
  })().catch((e) => console.warn("Local auto sign-in failed:", e)));
}
