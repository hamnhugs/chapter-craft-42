import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { triggerSleepCycle } from "@/lib/knowledgeApi";

// The daily tidy-up (knowledge-consolidate: link related notes, write
// missing one-line summaries, queue unlinked notes for the next run). Runs
// once per day, shortly after sign-in, when the last run is stale AND there
// is work: queued notes, or notes still without a summary. Failures are
// swallowed — a tidy-up is an optimization, never something to bother the
// user about. Every run that changes anything can be undone from the
// notebook's Recent tidy-ups.

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
        const [{ count: queued }, { count: unsummarized }] = await Promise.all([
          supabase
            .from("consolidation_queue" as any)
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .is("processed_at", null),
          supabase
            .from("knowledge_entries")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .is("hook" as any, null)
            .is("superseded_by", null)
            .not("entry_type", "in", "(tool,program)"),
        ]);
        if (!queued && !unsummarized) return;
        await triggerSleepCycle(null);
      } catch {
        /* background — never surface */
      }
    }, BOOT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [user?.id]);
}
