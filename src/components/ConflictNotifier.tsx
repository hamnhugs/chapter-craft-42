import React, { useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";

/**
 * Human-in-the-loop notification for knowledge graph contradictions.
 * - Subscribes to realtime inserts and pops a toast with a "Review" action
 * - "Review" opens the Wiki -> Conflicts tab
 * Renders nothing: the open conflicts themselves live in that tab.
 */
const ConflictNotifier: React.FC = () => {
  const { setActiveTab } = useApp();

  const openConflictsTab = useCallback(() => {
    // The live event only reaches WikiPanel when it's already mounted; when
    // arriving from another tab the panel mounts AFTER this dispatch, so a
    // flag lets it consume the intent on mount instead of losing it.
    try { sessionStorage.setItem("open-conflicts-pending", "1"); } catch { /* private mode */ }
    setActiveTab("wiki" as any);
    // WikiPanel listens for this event and switches to its Conflicts view
    window.dispatchEvent(new CustomEvent("open-conflicts"));
  }, [setActiveTab]);

  useEffect(() => {
    let mounted = true;
    let userId: string | null = null;
    supabase.auth.getUser().then(({ data }) => {
      userId = data.user?.id ?? null;
    });

    const channel = supabase
      .channel("knowledge-conflicts-notify")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "knowledge_conflicts" },
        (payload) => {
          if (!mounted) return;
          const row: any = payload.new;
          if (userId && row.user_id && row.user_id !== userId) return;
          toast.warning("Possible contradiction detected", {
            description:
              row.kind
                ? `A new "${row.kind}" needs your review.`
                : "A new knowledge conflict needs your review.",
            action: { label: "Review", onClick: openConflictsTab },
            duration: 10000,
          });
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [openConflictsTab]);

  return null;
};

export default ConflictNotifier;
