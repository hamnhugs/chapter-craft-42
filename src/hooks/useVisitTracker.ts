import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

/**
 * Logs a single "visit" activity event per browser session, per user.
 * Powers the per-user metrics in the admin dashboard. Best-effort — a
 * failed insert is logged but never disrupts the app.
 */
export function useVisitTracker() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const key = `visit_logged_${user.id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");

    supabase
      .from("activity_events" as any)
      .insert({ user_id: user.id, event_type: "visit" } as any)
      .then(({ error }) => {
        if (error) {
          // Don't keep the flag if it failed, so we retry next mount.
          sessionStorage.removeItem(key);
          console.warn("visit log failed:", error.message);
        }
      });
  }, [user]);
}
