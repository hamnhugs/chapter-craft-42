import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface IngestJob {
  id: string;
  user_id: string;
  book_id: string | null;
  wiki_id: string | null;
  folder_id: string | null;
  model: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  progress: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: any;
}

/**
 * useIngestJobs — watch the current user's ingest queue in real time.
 *
 * Returns the most recent ~50 jobs (queued + running + recently finished) and
 * keeps them live via Postgres Changes on `public.ingest_jobs`. Cross-device:
 * any tab logged into the same account sees the same queue.
 */
export function useIngestJobs(folderId?: string | null) {
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let q = (supabase.from("ingest_jobs" as any) as any)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (folderId) q = q.eq("folder_id", folderId);
    const { data } = await q;
    setJobs(((data as any[]) || []) as IngestJob[]);
    setLoading(false);
  }, [folderId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let userId: string | null = null;
    let channel: any = null;
    (async () => {
      const { data } = await supabase.auth.getUser();
      userId = data.user?.id || null;
      if (!userId) return;
      channel = supabase
        .channel(`ingest_jobs:${userId}`)
        .on(
          "postgres_changes" as any,
          { event: "*", schema: "public", table: "ingest_jobs", filter: `user_id=eq.${userId}` },
          () => { load(); },
        )
        .subscribe();
    })();
    return () => { if (channel) supabase.removeChannel(channel); };
  }, [load]);

  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const recent = jobs.filter((j) => j.status === "succeeded" || j.status === "failed").slice(0, 20);

  return { jobs, active, recent, loading, reload: load };
}
