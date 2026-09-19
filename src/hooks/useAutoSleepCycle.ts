import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { triggerSleepCycle } from "@/lib/knowledgeApi";

// Background memory consolidation. The Sleep Cycle (rerank vibrancy →
// generate graph edges → flag orphans) previously only ran when manually
// triggered from the BRAIN tab, so new entries could sit in the
// consolidation queue for weeks. This hook runs it automatically once per
// day: shortly after sign-in, if the queue has pending items and the last
// run is stale, fire it quietly in the background. Failures are swallowed —
// consolidation is an optimization, never something to bother the user about.

const STALE_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 15_000; // stay off the critical path of app startup

export function useAutoSleepCycle() {
  const { user } = useAuth();
  const ranForUser = useRef<string | null>(null);

  useEffect(() => {
    if (!user || ranForUser.current === user.id) return;
    ranForUser.current = user.id;
    const timer = window.setTimeout(async () => {
      try {
        const { data: settings } = await supabase
          .from("user_settings")
          .select("last_sleep_cycle_at" as any)
          .eq("user_id", user.id)
          .maybeSingle();
        const last = (settings as any)?.last_sleep_cycle_at;
        if (last && Date.now() - new Date(last).getTime() < STALE_MS) return;
        const { count } = await supabase
          .from("consolidation_queue" as any)
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .is("processed_at", null);
        if (!count) return;
        await triggerSleepCycle(null);
      } catch {
        /* background — never surface */
      }
    }, BOOT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [user?.id]);
}
