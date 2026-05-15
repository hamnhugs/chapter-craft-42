import React, { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface VideoJob {
  id: string;
  video_url: string;
  status: "pending" | "processing" | "completed" | "failed";
  pdf_url: string | null;
  word_count: number | null;
  error: string | null;
  created_at: string;
}

const VideoTranscript: React.FC = () => {
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const pollingRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Load existing jobs on mount
  useEffect(() => {
    if (!user) return;
    supabase
      .from("video_jobs")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) {
          setJobs(data as VideoJob[]);
          // Resume polling for any pending/processing jobs
          data.forEach((job: VideoJob) => {
            if (job.status === "pending" || job.status === "processing") {
              startPolling(job.id);
            }
          });
        }
      });
    return () => {
      Object.values(pollingRef.current).forEach(clearInterval);
    };
  }, [user]);

  const getToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || "";
  };

  const startPolling = (jobId: string) => {
    if (pollingRef.current[jobId]) return;
    pollingRef.current[jobId] = setInterval(async () => {
      await pollJob(jobId);
    }, 4000);
  };

  const pollJob = async (jobId: string) => {
    try {
      const token = await getToken();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/video-to-pdf/status/${jobId}`,
        { headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY } }
      );
      if (!res.ok) return;
      const data = await res.json();

      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? {
                ...j,
                status: data.status,
                pdf_url: data.url || j.pdf_url,
                word_count: data.word_count || j.word_count,
                error: data.error || null,
              }
            : j
        )
      );

      if (data.status === "completed" || data.status === "failed") {
        clearInterval(pollingRef.current[jobId]);
        delete pollingRef.current[jobId];
      }
    } catch {
      // silently retry
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || submitting) return;
    setError("");
    setSubmitting(true);

    try {
      const token = await getToken();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/video-to-pdf/submit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ videoUrl: url.trim() }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed");

      const newJob: VideoJob = {
        id: data.job_id,
        video_url: url.trim(),
        status: data.status,
        pdf_url: null,
        word_count: null,
        error: null,
        created_at: new Date().toISOString(),
      };

      setJobs((prev) => [newJob, ...prev]);
      setUrl("");
      startPolling(data.job_id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor = (status: VideoJob["status"]) => {
    if (status === "completed") return "text-green-400";
    if (status === "failed") return "text-red-400";
    return "text-yellow-400";
  };

  const statusIcon = (status: VideoJob["status"]) => {
    if (status === "completed") return "check_circle";
    if (status === "failed") return "error";
    return "hourglass_top";
  };

  return (
    <div className="flex flex-col h-full p-6 max-w-2xl mx-auto gap-6">
      {/* Header */}
      <div>
        <h2 className="font-headline font-bold text-2xl text-primary">Video Transcript</h2>
        <p className="text-secondary text-sm mt-1">
          Paste a YouTube URL to extract a full raw transcript + downloadable PDF. Saved to your library automatically.
        </p>
      </div>

      {/* Submit form */}
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          type="url"
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1 bg-surface border border-border rounded-xl px-4 py-3 text-sm text-primary placeholder:text-secondary focus:outline-none focus:ring-2 focus:ring-accent"
          disabled={submitting}
        />
        <button
          type="submit"
          disabled={submitting || !url.trim()}
          className="bg-accent text-on-primary-container font-medium text-sm px-5 py-3 rounded-xl transition-all active:scale-95 disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Extract"}
        </button>
      </form>

      {error && (
        <p className="text-red-400 text-sm bg-red-400/10 px-4 py-3 rounded-xl">{error}</p>
      )}

      {/* Job list */}
      <div className="flex flex-col gap-3 overflow-y-auto">
        {jobs.length === 0 && (
          <p className="text-secondary text-sm text-center py-12">
            No jobs yet. Paste a YouTube URL above to start.
          </p>
        )}
        {jobs.map((job) => (
          <div
            key={job.id}
            className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-primary text-sm font-medium truncate flex-1">{job.video_url}</p>
              <span className={`material-symbols-outlined text-xl ${statusColor(job.status)}`}>
                {statusIcon(job.status)}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-secondary">
              <span className={`font-semibold uppercase tracking-wide ${statusColor(job.status)}`}>
                {job.status}
              </span>
              {job.word_count && <span>{job.word_count.toLocaleString()} words</span>}
              <span>{new Date(job.created_at).toLocaleDateString()}</span>
            </div>

            {job.status === "pending" || job.status === "processing" ? (
              <p className="text-yellow-400 text-xs animate-pulse">Extracting transcript… this may take 1–3 minutes.</p>
            ) : null}

            {job.status === "failed" && job.error && (
              <p className="text-red-400 text-xs">{job.error}</p>
            )}

            {job.status === "completed" && job.pdf_url && (
              <a
                href={job.pdf_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent text-sm font-medium hover:underline"
              >
                <span className="material-symbols-outlined text-base">picture_as_pdf</span>
                Download Transcript PDF
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default VideoTranscript;
