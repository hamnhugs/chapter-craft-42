import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";

/**
 * Human-in-the-loop notification for knowledge graph contradictions.
 * - Shows a bell with a live badge of OPEN conflicts awaiting review
 * - Subscribes to realtime inserts and pops a toast with a "Review" action
 * - Clicking opens the Wiki -> Conflicts tab
 */
const ConflictNotifier: React.FC = () => {
  const { setActiveTab } = useApp();
  const [openCount, setOpenCount] = useState(0);
  const [pulse, setPulse] = useState(false);

  const openConflictsTab = useCallback(() => {
    // The live event only reaches WikiPanel when it's already mounted; when
    // arriving from another tab the panel mounts AFTER this dispatch, so a
    // flag lets it consume the intent on mount instead of losing it.
    try { sessionStorage.setItem("open-conflicts-pending", "1"); } catch { /* private mode */ }
    setActiveTab("wiki" as any);
    // WikiPanel listens for this event and switches to its Conflicts view
    window.dispatchEvent(new CustomEvent("open-conflicts"));
  }, [setActiveTab]);

  const refreshCount = useCallback(async () => {
    const { count, error } = await supabase
      .from("knowledge_conflicts")
      .select("id", { count: "exact", head: true })
      .eq("status", "open");
    if (!error && typeof count === "number") setOpenCount(count);
  }, []);

  useEffect(() => {
    let mounted = true;
    refreshCount();

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
          setOpenCount((c) => c + 1);
          setPulse(true);
          setTimeout(() => setPulse(false), 2000);
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
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "knowledge_conflicts" },
        () => {
          if (mounted) refreshCount();
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [refreshCount, openConflictsTab]);

  return (
    <button
      onClick={openConflictsTab}
      aria-label={`${openCount} open knowledge conflicts to review`}
      title={
        openCount === 0
          ? "No conflicts — knowledge graph is clean"
          : `${openCount} contradiction${openCount === 1 ? "" : "s"} need review`
      }
      className={`relative inline-flex items-center justify-center h-9 w-9 rounded-lg text-primary hover:bg-primary/10 transition-all active:scale-95 ${
        pulse ? "animate-pulse" : ""
      }`}
    >
      <span className="material-symbols-outlined text-[22px]">
        {openCount > 0 ? "notifications_active" : "notifications"}
      </span>
      {openCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold leading-[18px] text-center shadow-sm">
          {openCount > 99 ? "99+" : openCount}
        </span>
      )}
    </button>
  );
};

export default ConflictNotifier;
