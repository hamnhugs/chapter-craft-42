import React, { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface VideoJob {
  id: string;
  video_url: string;
  title: string | null;
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
  const [formatForChapterize, setFormatForChapterize] = useState(false);
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
          const typedJobs = data as unknown as VideoJob[];
          setJobs(typedJobs);
          // Resume polling for any pending/processing jobs
          typedJobs.forEach((job: VideoJob) => {
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
                title: data.title || data.metadata?.title || j.title,
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
          body: JSON.stringify({ videoUrl: url.trim(), formatForChapterize }),
        }
      );

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed");

      const newJob: VideoJob = {
        id: data.job_id,
        video_url: url.trim(),
        title: null,
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

  const handleDelete = async (jobId: string) => {
    if (!user) return;
    if (!window.confirm("Delete this entry? The transcript saved to your library will not be removed.")) return;

    // Stop any active polling for this job
    if (pollingRef.current[jobId]) {
      clearInterval(pollingRef.current[jobId]);
      delete pollingRef.current[jobId];
    }

    const prev = jobs;
    setJobs((curr) => curr.filter((j) => j.id !== jobId));

    const { error: delErr } = await supabase
      .from("video_jobs")
      .delete()
      .eq("id", jobId)
      .eq("user_id", user.id);

    if (delErr) {
      setJobs(prev); // restore on failure
      setError("Could not delete entry. Please try again.");
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
        <h2 className="font-headline font-bold text-2xl text-primary">Reel</h2>
        <p className="text-secondary text-sm mt-1">
          Paste a YouTube URL to extract a full raw transcript + downloadable PDF. Saved to your library automatically.
        </p>
      </div>

      {/* Format for Chapterization toggle */}
      <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={formatForChapterize}
          onClick={() => setFormatForChapterize((v) => !v)}
          className="flex items-center gap-3 w-full text-left group"
        >
          <div
            className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${
              formatForChapterize ? "bg-accent" : "bg-border"
            }`}
          >
            <span
              className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                formatForChapterize ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </div>
          <div>
            <p className="text-sm font-semibold text-primary">Format for Chapterization</p>
            <p className="text-xs text-secondary mt-0.5">
              Uses AI to divide the transcript into labeled sections, making it much easier to detect and name chapters afterward.
            </p>
          </div>
        </button>
        {formatForChapterize && (
          <p className="text-xs text-accent pl-13 ml-[52px]">
            The transcript will be organized into titled sections with a table of contents. Processing takes a few extra seconds.
          </p>
        )}
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
              <div className="flex-1 min-w-0">
                <p className="text-primary text-sm font-medium truncate">
                  {job.title || job.video_url}
                </p>
                {job.title && (
                  <p className="text-secondary text-xs truncate mt-0.5">{job.video_url}</p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className={`material-symbols-outlined text-xl ${statusColor(job.status)}`}>
                  {statusIcon(job.status)}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(job.id)}
                  aria-label="Delete entry"
                  title="Delete entry"
                  className="text-secondary hover:text-red-400 transition-colors p-1 rounded-lg"
                >
                  <span className="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
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

            {job.status === "completed" && (
              <button
                onClick={async () => {
                  try {
                    const token = await getToken();
                    const res = await fetch(
                      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/video-to-pdf/download/${job.id}`,
                      { headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY } }
                    );
                    if (!res.ok) throw new Error(`Download failed (${res.status})`);
                    const blob = await res.blob();
                    const objUrl = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = objUrl;
                    a.download = `transcript-${job.id}.html`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
                  } catch (e) {
                    alert(e instanceof Error ? e.message : "Download failed");
                  }
                }}
                className="inline-flex items-center gap-1 text-accent text-sm font-medium hover:underline self-start"
              >
                <span className="material-symbols-outlined text-base">article</span>
                Download Transcript HTML
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default VideoTranscript;
