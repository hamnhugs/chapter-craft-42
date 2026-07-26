import React, { useCallback, useEffect, useRef, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { useMediaHeightTier } from "@/components/MediaFrame";
import {
  fetchVideoByJobId, pollVideo, finalizeVideoJob, markVideoJobFailed,
  getSignedVideoUrl, resolveVideoSourceImages,
  type ChatVideoRef, type VideoGenerationRow, type VideoQcResult,
} from "@/lib/videoGen";
import { isFalJobId, pollFalVideo, finalizeFalVideoJob } from "@/lib/falVideoGen";
import { formatUSD } from "@/lib/videoCatalog";

type Phase = "loading" | "generating" | "completed" | "failed" | "stopped";

/** True when this clip was identity-conditioned and should get a QC pass. */
const isIdentityClip = (row: VideoGenerationRow): boolean =>
  !!(row.condition_mode || (row.motion_mode && row.motion_mode !== "text") || row.master_id
     || (row.source_image_ids && row.source_image_ids.length > 0));

const QC_DOT: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

const qcTitle = (qc: VideoQcResult): string => {
  const parts: string[] = [];
  if (qc.ref_sim_mean != null) parts.push(`identity similarity ${qc.ref_sim_mean} (min ${qc.ref_sim_min})`);
  if (qc.temporal_mean != null) parts.push(`temporal consistency ${qc.temporal_mean}`);
  if (qc.palette_delta_e != null) parts.push(`palette drift ΔE ${qc.palette_delta_e}`);
  const advice = qc.verdict === "green"
    ? "Consistent with the locked identity."
    : "Possible identity drift — consider regenerating with a higher identity_scale or a reference-capable model.";
  return `Consistency check (advisory): ${parts.join(" · ")}. ${advice}`;
};

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
  const { apiKey, falApiKey, videoQcEnabled, loaded } = useChatSettings();
  const { maxHeight, tierLabel, cycle } = useMediaHeightTier("video");
  const [phase, setPhase] = useState<Phase>("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [cost, setCost] = useState<number | null>(null);
  const [savedToMemory, setSavedToMemory] = useState(false);
  const [retryable, setRetryable] = useState(false);
  // Upstream job state (queued vs rendering) — surfacing it turns an opaque
  // "stall" into a diagnosable symptom: queued forever points at the provider
  // (backlog, or it can't fetch the reference images); rendering means work.
  const [jobStatus, setJobStatus] = useState<"pending" | "processing" | null>(null);
  const [identityMode, setIdentityMode] = useState<string | null>(null);
  const [qc, setQc] = useState<VideoQcResult | null>(null);
  const [qcRunning, setQcRunning] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const jobStatusRef = useRef<"pending" | "processing" | null>(null);
  const mountedRef = useRef(true);
  const startRef = useRef(0);
  const qcStartedRef = useRef(false);

  // Motion-transfer / draft clips are fal queue jobs (job_id "fal:…") and
  // poll/finalize with the fal key; everything else is an OpenRouter job.
  const isFal = isFalJobId(video.job_id);
  const activeKey = isFal ? falApiKey : apiKey;

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  /** Post-completion consistency check — advisory, background, and strictly
   *  best-effort: any failure just means no chip. Runs once per mount, only
   *  for identity-conditioned clips, and never re-runs when scores exist. */
  const maybeRunQc = useCallback(async (row: VideoGenerationRow, signedUrl: string) => {
    if (row.qc) { qcStartedRef.current = true; setQc(row.qc); return; }
    // Don't consult (or latch on) the QC toggle before settings actually load —
    // the module default is `true`, and latching against it would either run a
    // check the user disabled or permanently skip one they left enabled. The
    // settings arrival re-runs init() → showCompleted → here.
    if (!loaded) return;
    if (qcStartedRef.current) return;
    qcStartedRef.current = true;
    if (videoQcEnabled === false || !isIdentityClip(row)) return;
    const refIds = row.source_image_ids || [];
    if (refIds.length === 0) return; // nothing to compare identity against
    setQcRunning(true);
    try {
      const { urls } = await resolveVideoSourceImages(refIds);
      // Lazy import: the DINOv2 embedder (~22-44 MB, CDN-cached) must never
      // load for users who don't use identity video.
      const { runVideoQc, writeQcResult } = await import("@/lib/videoQc");
      const result = await runVideoQc({
        videoUrl: signedUrl,
        refImageUrls: urls,
        lockPalette: row.lock_palette || null,
      });
      if (!mountedRef.current) return;
      setQc(result);
      void writeQcResult(row.job_id, result);
    } catch (e) {
      console.warn("[VideoBubble] QC skipped:", e);
    } finally {
      if (mountedRef.current) setQcRunning(false);
    }
  }, [videoQcEnabled, loaded]);

  const showCompleted = useCallback(async (row: VideoGenerationRow) => {
    stopTimers();
    setSavedToMemory(!!row.entry_id);
    setIdentityMode(row.condition_mode || (row.motion_mode && row.motion_mode !== "text" ? row.motion_mode : null));
    const u = row.storage_path ? await getSignedVideoUrl(row.storage_path) : null;
    if (!mountedRef.current) return;
    if (typeof row.cost === "number") setCost(row.cost);
    if (row.poster_path) {
      const p = await getSignedVideoUrl(row.poster_path);
      if (mountedRef.current && p) setPosterUrl(p);
    }
    if (u) {
      setUrl(u);
      setPhase("completed");
      if (mountedRef.current) void maybeRunQc(row, u);
    }
    else { setError("The clip was stored but could not be loaded."); setRetryable(true); setPhase("failed"); }
  }, [stopTimers, maybeRunQc]);

  const finalize = useCallback(async (snapCost?: number | null) => {
    if (busyRef.current || !activeKey) return;
    busyRef.current = true;
    try {
      const row = isFal
        ? await finalizeFalVideoJob({ apiKey: activeKey, jobId: video.job_id, model: video.model, prompt: video.prompt })
        : await finalizeVideoJob({ apiKey: activeKey, jobId: video.job_id, cost: snapCost, model: video.model, prompt: video.prompt });
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
  }, [activeKey, isFal, video.job_id, video.model, video.prompt, showCompleted, stopTimers]);

  const startPolling = useCallback(() => {
    if (pollRef.current || !activeKey) return;
    setError("");
    setRetryable(false);
    setPhase("generating");
    startRef.current = Date.now();
    setElapsed(0);
    jobStatusRef.current = null;
    setJobStatus(null);
    tickRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      const e = Math.floor((Date.now() - startRef.current) / 1000);
      setElapsed(e);
      if (e > MAX_ELAPSED_S) {
        // Give up watching after 15 min. Leave the row pending (don't mark it
        // failed) so "Try again" or a later reload can still recover a clip
        // that finishes late on the server.
        stopTimers();
        setError(jobStatusRef.current === "pending"
          ? "Still queued upstream after 15 minutes — the provider is backed up, or it can't fetch the conditioning images. Try again keeps waiting; the job stays recoverable."
          : "This is taking unusually long. Try again to keep waiting.");
        setRetryable(true);
        setPhase("failed");
      }
    }, 1000);
    pollRef.current = setInterval(async () => {
      if (busyRef.current) return;
      try {
        const snap = isFal
          ? await pollFalVideo(activeKey, { model: video.model, jobId: video.job_id })
          : await pollVideo(activeKey, video.job_id);
        if (!mountedRef.current) return;
        const snapCost = (snap as any).cost;
        if (typeof snapCost === "number") setCost(snapCost);
        if (snap.status === "pending" || snap.status === "processing") {
          jobStatusRef.current = snap.status;
          setJobStatus(snap.status);
        }
        if (snap.status === "completed") {
          await finalize(typeof snapCost === "number" ? snapCost : null);
        } else if (snap.status === "failed") {
          stopTimers();
          if (snap.authError) {
            // The KEY is bad, not the job — the paid clip may still be
            // rendering. Leave the row alone so it stays recoverable, and
            // offer a retry for after the key is fixed.
            if (mountedRef.current) { setError(snap.error || "The API key was rejected."); setRetryable(true); setPhase("failed"); }
          } else {
            await markVideoJobFailed(video.job_id, snap.error || "Generation failed");
            if (mountedRef.current) { setError(snap.error || "Generation failed"); setRetryable(false); setPhase("failed"); }
          }
        }
      } catch { /* transient network — keep polling */ }
    }, POLL_MS);
  }, [activeKey, isFal, video.job_id, video.model, finalize, stopTimers]);

  const init = useCallback(async () => {
    const row = await fetchVideoByJobId(video.job_id);
    if (!mountedRef.current) return;
    if (row) {
      if (typeof row.cost === "number") setCost(row.cost);
      if (row.status === "completed" && row.storage_path) { await showCompleted(row); return; }
      if (row.status === "failed") { setError(row.error || "Generation failed"); setRetryable(false); setPhase("failed"); return; }
    }
    if (!activeKey) {
      // Settings load asynchronously — don't flash a false error before they do.
      if (!loaded) return; // the effect re-runs when `loaded`/key arrive
      setError(isFal
        ? "Add your fal.ai key in Settings to load this clip."
        : "Add your OpenRouter key in Settings to load this clip.");
      setRetryable(false);
      setPhase("failed");
      return;
    }
    startPolling();
  }, [video.job_id, activeKey, isFal, loaded, showCompleted, startPolling]);

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
          // Height is user-adjustable (S/M/L/XL button below); fullscreen is
          // already covered by the player's native controls.
          style={{ maxHeight }}
          className="rounded-xl w-auto max-w-full border border-outline-variant/20 shadow-sm bg-black"
        />
        <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] text-on-surface-variant/70 max-w-sm">
          <span className="min-w-0 truncate">
            {video.prompt}{savedToMemory ? " · saved to memory" : ""}{cost != null ? ` · ${formatUSD(cost)}` : ""}
          </span>
          <button
            onClick={cycle}
            title={`Display size: ${tierLabel} — click to cycle`}
            aria-label={`Display size ${tierLabel}, click to change`}
            className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-outline-variant/30 px-1.5 py-px text-[10px] font-medium text-on-surface-variant hover:text-primary hover:border-primary/40 transition-colors"
          >
            <span className="material-symbols-outlined text-[11px] leading-none">aspect_ratio</span>
            {tierLabel}
          </button>
        </figcaption>
        {(identityMode || qc || qcRunning) && (
          <div className="mt-0.5 flex items-center gap-2 max-w-sm text-[10px] text-on-surface-variant/70">
            {identityMode && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-container-high/80 border border-outline-variant/20 px-1.5 py-px">
                <span className="material-symbols-outlined text-[11px] leading-none">fingerprint</span>
                {identityMode === "motion_plate" ? "motion transfer" : `identity lock (${identityMode})`}
              </span>
            )}
            {qcRunning && <span className="opacity-70">checking consistency…</span>}
            {qc && (
              <span
                className="inline-flex items-center gap-1 cursor-help"
                title={qcTitle(qc)}
              >
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${QC_DOT[qc.verdict] || "bg-outline-variant"}`} />
                {qc.verdict === "green" ? "consistent" : qc.verdict === "amber" ? "some drift" : "identity drift"}
                {qc.ref_sim_mean != null ? ` · ${qc.ref_sim_mean}` : ""}
              </span>
            )}
          </div>
        )}
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
        {retryable && activeKey && (
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
          <span className="ml-auto text-[11px] tabular-nums text-on-surface-variant">
            {jobStatus === "pending" ? "queued · " : jobStatus === "processing" ? "rendering · " : ""}{mmss(elapsed)}
          </span>
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
