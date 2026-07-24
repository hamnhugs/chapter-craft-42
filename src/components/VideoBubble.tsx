import React, { useCallback, useEffect, useRef, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  fetchVideoByJobId, pollVideo, finalizeVideoJob, markVideoJobFailed,
  getSignedVideoUrl, type ChatVideoRef, type VideoGenerationRow,
} from "@/lib/videoGen";
import { formatUSD } from "@/lib/videoCatalog";

type Phase = "loading" | "generating" | "completed" | "failed" | "stopped";

const POLL_MS = 4000;
const MAX_ELAPSED_S = 900; // stop actively watching a job after 15 min

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Renders a generated video clip inline. While the OpenRouter job runs it
 *  shows a live "generating…" card (model, elapsed, cost, stop); on completion
 *  it downloads + stores the clip and swaps in a player. The `video_generations`
 *  row (keyed by job_id) is the source of truth, so a reload resumes correctly. */
const VideoBubble: React.FC<{ video: ChatVideoRef }> = ({ video }) => {
  const { apiKey, loaded } = useChatSettings();
  const [phase, setPhase] = useState<Phase>("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [cost, setCost] = useState<number | null>(null);
  const [savedToMemory, setSavedToMemory] = useState(false);
  const [retryable, setRetryable] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const startRef = useRef(0);

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const showCompleted = useCallback(async (row: VideoGenerationRow) => {
    stopTimers();
    setSavedToMemory(!!row.entry_id);
    const u = row.storage_path ? await getSignedVideoUrl(row.storage_path) : null;
    if (!mountedRef.current) return;
    if (typeof row.cost === "number") setCost(row.cost);
    if (row.poster_path) {
      const p = await getSignedVideoUrl(row.poster_path);
      if (mountedRef.current && p) setPosterUrl(p);
    }
    if (u) { setUrl(u); setPhase("completed"); }
    else { setError("The clip was stored but could not be loaded."); setRetryable(true); setPhase("failed"); }
  }, [stopTimers]);

  const finalize = useCallback(async (snapCost?: number | null) => {
    if (busyRef.current || !apiKey) return;
    busyRef.current = true;
    try {
      const row = await finalizeVideoJob({ apiKey, jobId: video.job_id, cost: snapCost, model: video.model, prompt: video.prompt });
      await showCompleted(row);
    } catch (e: any) {
      if (!mountedRef.current) return;
      stopTimers();
      setError(e?.message || "Could not finalize the video.");
      setRetryable(true); // a download/store hiccup — retrying may recover
      setPhase("failed");
    } finally {
      busyRef.current = false;
    }
  }, [apiKey, video.job_id, video.model, video.prompt, showCompleted, stopTimers]);

  const startPolling = useCallback(() => {
    if (pollRef.current || !apiKey) return;
    setError("");
    setRetryable(false);
    setPhase("generating");
    startRef.current = Date.now();
    setElapsed(0);
    tickRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      const e = Math.floor((Date.now() - startRef.current) / 1000);
      setElapsed(e);
      if (e > MAX_ELAPSED_S) {
        // Give up watching after 15 min. Leave the row pending (don't mark it
        // failed) so "Try again" or a later reload can still recover a clip
        // that finishes late on the server.
        stopTimers();
        setError("This is taking unusually long. Try again to keep waiting.");
        setRetryable(true);
        setPhase("failed");
      }
    }, 1000);
    pollRef.current = setInterval(async () => {
      if (busyRef.current) return;
      try {
        const snap = await pollVideo(apiKey, video.job_id);
        if (!mountedRef.current) return;
        if (typeof snap.cost === "number") setCost(snap.cost);
        if (snap.status === "completed") {
          await finalize(snap.cost);
        } else if (snap.status === "failed") {
          stopTimers();
          await markVideoJobFailed(video.job_id, snap.error || "Generation failed");
          if (mountedRef.current) { setError(snap.error || "Generation failed"); setRetryable(false); setPhase("failed"); }
        }
      } catch { /* transient network — keep polling */ }
    }, POLL_MS);
  }, [apiKey, video.job_id, finalize, stopTimers]);

  const init = useCallback(async () => {
    const row = await fetchVideoByJobId(video.job_id);
    if (!mountedRef.current) return;
    if (row) {
      if (typeof row.cost === "number") setCost(row.cost);
      if (row.status === "completed" && row.storage_path) { await showCompleted(row); return; }
      if (row.status === "failed") { setError(row.error || "Generation failed"); setRetryable(false); setPhase("failed"); return; }
    }
    if (!apiKey) {
      // Settings load asynchronously — don't flash a false error before they do.
      if (!loaded) return; // the effect re-runs when `loaded`/apiKey arrive
      setError("Add your OpenRouter key in Settings to load this clip.");
      setRetryable(false);
      setPhase("failed");
      return;
    }
    startPolling();
  }, [video.job_id, apiKey, loaded, showCompleted, startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    void init();
    return () => { mountedRef.current = false; stopTimers(); };
  }, [init, stopTimers]);

  const stopWatching = () => { stopTimers(); setPhase("stopped"); };

  // ── Completed: the player ──────────────────────────────────────────────
  if (phase === "completed" && url) {
    return (
      <figure className="my-1">
        <video
          src={url}
          poster={posterUrl || undefined}
          controls
          muted
          loop
          playsInline
          preload="metadata"
          autoPlay={!prefersReducedMotion()}
          className="rounded-xl max-h-80 w-auto max-w-full border border-outline-variant/20 shadow-sm bg-black"
        />
        <figcaption className="mt-1 text-[11px] text-on-surface-variant/70 max-w-sm truncate">
          {video.prompt}{savedToMemory ? " · saved to memory" : ""}{cost != null ? ` · ${formatUSD(cost)}` : ""}
        </figcaption>
      </figure>
    );
  }

  // ── Failed ─────────────────────────────────────────────────────────────
  if (phase === "failed") {
    return (
      <div className="rounded-xl bg-surface-container-high/60 border border-destructive/30 p-3 my-1 max-w-sm">
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span className="material-symbols-outlined text-base">error</span>
          <span className="font-medium">Video didn't finish</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-1 break-words">{error || "The generation failed."}</p>
        {retryable && apiKey && (
          <button
            onClick={() => { setRetryable(false); void init(); }}
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            <span className="material-symbols-outlined text-sm">refresh</span> Try again
          </button>
        )}
      </div>
    );
  }

  // ── Stopped ────────────────────────────────────────────────────────────
  if (phase === "stopped") {
    return (
      <div className="rounded-xl bg-surface-container-high/60 border border-outline-variant/20 p-3 my-1 max-w-sm">
        <p className="text-[11px] text-on-surface-variant">
          Stopped watching. The clip may still be generating on the server.
        </p>
        <button
          onClick={() => startPolling()}
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
        >
          <span className="material-symbols-outlined text-sm">play_arrow</span> Resume
        </button>
      </div>
    );
  }

  // ── Loading / generating ───────────────────────────────────────────────
  return (
    <div className="rounded-xl bg-surface-container-high/60 border border-outline-variant/20 p-4 my-1 max-w-sm flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
        </span>
        <span className="text-sm font-medium text-foreground">Generating video…</span>
        {phase === "generating" && (
          <span className="ml-auto text-[11px] tabular-nums text-on-surface-variant">{mmss(elapsed)}</span>
        )}
      </div>
      <p className="text-[11px] text-on-surface-variant truncate">{video.prompt}</p>
      <div className="flex items-center gap-2 text-[10px] text-on-surface-variant/70">
        <span className="font-mono">{video.model}</span>
        {cost != null && <span>· ~{formatUSD(cost)}</span>}
      </div>
      {phase === "generating" && (
        <div className="flex items-center gap-3">
          {elapsed > 45 && (
            <span className="text-[10px] text-on-surface-variant/60">This can take a few minutes…</span>
          )}
          <button
            onClick={stopWatching}
            className="ml-auto text-[11px] font-medium text-on-surface-variant hover:text-destructive transition-colors"
          >
            Stop watching
          </button>
        </div>
      )}
    </div>
  );
};

export default VideoBubble;
