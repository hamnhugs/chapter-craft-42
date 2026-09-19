import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  fetchSplatByRequestId, pollSplat, finalizeSplatJob, markSplatJobFailed,
  getSignedSplatUrl, type ChatSplatRef, type SplatGenerationRow,
} from "@/lib/splatGen";
import { formatUSD, formatMB } from "@/lib/splatCatalog";
import { getPersistedFrameSize, SPLAT_FRAME_DEFAULT, SPLAT_FRAME_MIN } from "@/components/MediaFrame";

// The 1.78 MB WebGL renderer is a separate chunk that only downloads when a
// user actually asks for 3D. A chat session where nobody clicks "View in 3D"
// pays nothing for it.
const SplatViewer = React.lazy(() => import("@/components/SplatViewer"));

type Phase = "loading" | "generating" | "poster" | "live" | "failed" | "stopped";

const POLL_MS = 3000;
const MAX_ELAPSED_S = 300; // fal inference is ~5s; 5 min is a generous ceiling

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Renders a generated 3D Gaussian splat inline. While the fal job runs it
 *  shows a live "generating…" card; on completion it downloads + stores the
 *  asset and swaps in a poster with a "View in 3D" affordance. The
 *  `splat_generations` row (keyed by request_id) is the source of truth, so a
 *  reload resumes correctly. */
const SplatBubble: React.FC<{ splat: ChatSplatRef }> = ({ splat }) => {
  const { falApiKey, splatMaxFileMb, splatClickToActivate, loaded } = useChatSettings();
  const [phase, setPhase] = useState<Phase>("loading");
  const [row, setRow] = useState<SplatGenerationRow | null>(null);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [queuePos, setQueuePos] = useState<number | null>(null);
  const [savedToMemory, setSavedToMemory] = useState(false);
  const [retryable, setRetryable] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const startRef = useRef(0);
  // fal's own status_url, kept in a ref rather than in state: reading it from
  // `row` would put it in startPolling's deps, which cascades into init and
  // re-runs the mount effect the moment the first row arrives.
  const statusUrlRef = useRef<string | null>(null);

  const applyRow = useCallback((r: SplatGenerationRow) => {
    statusUrlRef.current = r.status_url ?? null;
    setRow(r);
  }, []);

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const showCompleted = useCallback(async (r: SplatGenerationRow) => {
    stopTimers();
    applyRow(r);
    setSavedToMemory(!!r.entry_id);
    if (r.poster_path) {
      const p = await getSignedSplatUrl(r.poster_path);
      if (mountedRef.current && p) setPosterUrl(p);
    }
    const u = r.storage_path ? await getSignedSplatUrl(r.storage_path) : null;
    if (!mountedRef.current) return;
    if (u) {
      setAssetUrl(u);
      // Respect the user's preference, but never auto-activate more than the
      // single allowed viewer — SplatViewer itself enforces the singleton.
      setPhase(splatClickToActivate === false ? "live" : "poster");
    } else {
      setError("The 3D file was stored but could not be loaded.");
      setRetryable(true);
      setPhase("failed");
    }
  }, [stopTimers, splatClickToActivate]);

  const finalize = useCallback(async () => {
    if (busyRef.current || !falApiKey) return;
    busyRef.current = true;
    try {
      const r = await finalizeSplatJob({
        apiKey: falApiKey,
        requestId: splat.request_id,
        model: splat.model,
        prompt: splat.prompt,
        maxFileMb: splatMaxFileMb,
      });
      await showCompleted(r);
    } catch (e: any) {
      if (!mountedRef.current) return;
      stopTimers();
      setError(e?.message || "Could not finalize the 3D model.");
      setRetryable(true);
      setPhase("failed");
    } finally {
      busyRef.current = false;
    }
  }, [falApiKey, splat.request_id, splat.model, splat.prompt, splatMaxFileMb, showCompleted, stopTimers]);

  const startPolling = useCallback(() => {
    if (pollRef.current || !falApiKey) return;
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
        // Give up watching, but leave the row pending so "Try again" or a later
        // reload can still recover a job that finishes late.
        stopTimers();
        setError("This is taking unusually long. Try again to keep waiting.");
        setRetryable(true);
        setPhase("failed");
      }
    }, 1000);
    pollRef.current = setInterval(async () => {
      if (busyRef.current) return;
      try {
        const snap = await pollSplat(falApiKey, {
          model: splat.model,
          requestId: splat.request_id,
          statusUrl: statusUrlRef.current,
        });
        if (!mountedRef.current) return;
        setQueuePos(snap.queuePosition);
        if (snap.status === "completed") {
          await finalize();
        } else if (snap.status === "failed") {
          stopTimers();
          await markSplatJobFailed(splat.request_id, snap.error || "Generation failed");
          if (mountedRef.current) {
            setError(snap.error || "Generation failed");
            setRetryable(false);
            setPhase("failed");
          }
        }
      } catch { /* transient network — keep polling */ }
    }, POLL_MS);
  }, [falApiKey, splat.request_id, splat.model, finalize, stopTimers]);

  const init = useCallback(async () => {
    const r = await fetchSplatByRequestId(splat.request_id);
    if (!mountedRef.current) return;
    if (r) {
      applyRow(r);
      if (r.status === "completed" && r.storage_path) { await showCompleted(r); return; }
      if (r.status === "failed") {
        setError(r.error || "Generation failed");
        setRetryable(false);
        setPhase("failed");
        return;
      }
    }
    if (!falApiKey) {
      // Settings load asynchronously — don't flash a false error before they do.
      if (!loaded) return; // the effect re-runs when loaded/falApiKey arrive
      setError("Add your fal.ai key in Settings to load this 3D model.");
      setRetryable(false);
      setPhase("failed");
      return;
    }
    startPolling();
  }, [splat.request_id, falApiKey, loaded, applyRow, showCompleted, startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    void init();
    return () => { mountedRef.current = false; stopTimers(); };
  }, [init, stopTimers]);

  const stopWatching = () => { stopTimers(); setPhase("stopped"); };
  // Stable identity — SplatViewer holds this across the life of its WebGL scene.
  const exitViewer = useCallback(() => setPhase("poster"), []);

  const meta = [
    savedToMemory ? "saved to memory" : "",
    row?.file_bytes ? formatMB(row.file_bytes) : "",
    typeof row?.cost === "number" ? formatUSD(row.cost) : "",
  ].filter(Boolean).join(" · ");

  // ── Live 3D ────────────────────────────────────────────────────────────
  if (phase === "live" && assetUrl && row) {
    // Match the placeholder to the size the frame will actually open at
    // (the user's persisted resize) so nothing jumps when the chunk lands.
    const frameSize = getPersistedFrameSize("splat", SPLAT_FRAME_DEFAULT, SPLAT_FRAME_MIN);
    return (
      <figure className="my-1">
        <Suspense
          fallback={
            <div
              className="rounded-xl border border-outline-variant/20 bg-surface-container-high/60 max-w-full grid place-items-center"
              style={{ width: frameSize.w, height: frameSize.h }}
            >
              <span className="text-[11px] text-on-surface-variant">Loading 3D viewer…</span>
            </div>
          }
        >
          <SplatViewer
            id={row.id}
            url={assetUrl}
            format={row.format}
            posterUrl={posterUrl}
            label={splat.prompt}
            onExit={exitViewer}
          />
        </Suspense>
        <figcaption className="mt-1 text-[11px] text-on-surface-variant/70 max-w-sm truncate">
          {splat.prompt}{meta ? ` · ${meta}` : ""}
        </figcaption>
      </figure>
    );
  }

  // ── Poster (completed, not yet activated) ──────────────────────────────
  if (phase === "poster" && assetUrl) {
    return (
      <figure className="my-1">
        <div className="relative group rounded-xl overflow-hidden border border-outline-variant/20 bg-surface-container-high/60 max-w-sm">
          {posterUrl ? (
            <img
              src={posterUrl}
              alt={splat.prompt}
              className="block max-h-80 w-auto max-w-full object-contain bg-black/40"
            />
          ) : (
            <div className="h-56 grid place-items-center bg-black/40">
              <span className="material-symbols-outlined text-4xl text-on-surface-variant/40">3d_rotation</span>
            </div>
          )}
          <div className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 backdrop-blur-sm">
            <span className="material-symbols-outlined text-[13px] leading-none text-white/90">3d_rotation</span>
            <span className="text-[10px] font-medium text-white/90">3D</span>
          </div>
          <button
            onClick={() => setPhase("live")}
            aria-label={`View "${splat.prompt}" in 3D`}
            className="absolute inset-0 grid place-items-center bg-black/0 hover:bg-black/30 focus-visible:bg-black/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          >
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container-highest/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
              <span className="material-symbols-outlined text-sm">3d_rotation</span>
              View in 3D
            </span>
          </button>
        </div>
        <figcaption className="mt-1 text-[11px] text-on-surface-variant/70 max-w-sm truncate">
          {splat.prompt}{meta ? ` · ${meta}` : ""}
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
          <span className="font-medium">3D model didn't finish</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-1 break-words">{error || "The generation failed."}</p>
        {retryable && falApiKey && (
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
          Stopped watching. The model may still be generating.
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
        <span className="text-sm font-medium text-foreground">Building 3D model…</span>
        {phase === "generating" && (
          <span className="ml-auto text-[11px] tabular-nums text-on-surface-variant">{mmss(elapsed)}</span>
        )}
      </div>
      <p className="text-[11px] text-on-surface-variant truncate">{splat.prompt}</p>
      <div className="flex items-center gap-2 text-[10px] text-on-surface-variant/70">
        <span className="font-mono">{splat.model}</span>
        {queuePos != null && queuePos > 0 && <span>· queued #{queuePos}</span>}
      </div>
      {phase === "generating" && (
        <div className="flex items-center gap-3">
          {elapsed > 30 && (
            <span className="text-[10px] text-on-surface-variant/60">Still working…</span>
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

export default SplatBubble;
