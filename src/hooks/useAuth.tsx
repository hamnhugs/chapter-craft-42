import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { ensureLocalSession, localAutoSignInEnabled } from "@/lib/localAutoSignIn";

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Local edition signs itself in; until that settles, an empty session is
    // "not yet", not "signed out" — otherwise the sign-in page flashes.
    let settling = localAutoSignInEnabled();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!settling || session) setLoading(false);
    });

    ensureLocalSession().then(() => {
      settling = false;
      return supabase.auth.getSession();
    }).then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = () => supabase.auth.signOut();

  return { user, loading, signOut };
};
