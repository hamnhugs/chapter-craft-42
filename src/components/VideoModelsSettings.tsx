import React, { useEffect, useMemo, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  fetchVideoModels, FALLBACK_VIDEO_MODELS, DEFAULT_VIDEO_MODEL,
  clipCostLabel, type VideoModel,
} from "@/lib/videoCatalog";
import { Button } from "@/components/ui/button";

const COMMON_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

const VideoModelsSettings: React.FC = () => {
  const {
    videoModelPrimary, savedVideoModels,
    videoDefaultDuration, videoDefaultResolution, videoDefaultAspect,
    videoGenerateAudio, videoConfirmThreshold,
    setVideoModelPrimary, setVideoDefaultDuration, setVideoDefaultResolution,
    setVideoDefaultAspect, setVideoGenerateAudio, setVideoConfirmThreshold,
    addVideoModel, removeVideoModel,
  } = useChatSettings();

  const [catalog, setCatalog] = useState<VideoModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [newModel, setNewModel] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchVideoModels()
      .then((m) => { if (!cancelled) setCatalog(m); })
      .catch(() => { /* offline — fall back to the built-in list */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Model options: live catalog first, then any saved custom ids not in it,
  // then the offline fallback list (so the picker is never empty).
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; label: string }> = [];
    for (const m of catalog) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ id: m.id, label: m.name || m.id });
    }
    for (const id of savedVideoModels) {
      if (!seen.has(id)) { seen.add(id); out.push({ id, label: id }); }
    }
    if (out.length === 0) {
      for (const m of FALLBACK_VIDEO_MODELS) { if (!seen.has(m.id)) { seen.add(m.id); out.push({ id: m.id, label: m.label }); } }
    }
    return out;
  }, [catalog, savedVideoModels]);

  const effectiveModelId = videoModelPrimary || DEFAULT_VIDEO_MODEL;
  const selected = useMemo(() => catalog.find((m) => m.id === effectiveModelId), [catalog, effectiveModelId]);

  const durations = selected?.supported_durations && selected.supported_durations.length
    ? selected.supported_durations : [4, 6, 8];
  const resolutions = selected?.supported_resolutions && selected.supported_resolutions.length
    ? selected.supported_resolutions : ["720p", "1080p"];
  const aspects = selected?.supported_aspect_ratios && selected.supported_aspect_ratios.length
    ? selected.supported_aspect_ratios : COMMON_ASPECTS;

  const effDuration = videoDefaultDuration || (durations.includes(6) ? 6 : durations[0]);
  const effResolution = videoDefaultResolution || (resolutions.includes("720p") ? "720p" : resolutions[0]);
  const costLabel = selected
    ? clipCostLabel(selected, { duration: effDuration, resolution: effResolution, audio: videoGenerateAudio })
    : "";

  const selectCls = "w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40";
  const labelCls = "text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1";

  return (
    <section className="p-3 md:p-4 rounded-xl bg-surface-container-low flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-bold text-foreground">Video Generation</h3>
        <p className="text-xs text-on-surface-variant">
          Pick which model the AI uses for <code className="text-[11px]">generate_video</code>. Video is billed per
          second to your OpenRouter key and costs far more than an image — set defaults and a confirm threshold below.
          {loading && <span className="italic"> Loading models…</span>}
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="video-model-primary" className={labelCls}>Default Video Model</label>
          <select id="video-model-primary" value={videoModelPrimary} onChange={(e) => setVideoModelPrimary(e.target.value)} className={selectCls}>
            <option value="">Auto — {DEFAULT_VIDEO_MODEL}</option>
            {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="video-confirm-threshold" className={labelCls}>Confirm cost above ($)</label>
          <input
            id="video-confirm-threshold"
            type="number" min={0} step={0.25} value={videoConfirmThreshold}
            onChange={(e) => setVideoConfirmThreshold(parseFloat(e.target.value))}
            className={selectCls}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="video-default-duration" className={labelCls}>Default Length</label>
          <select id="video-default-duration" value={videoDefaultDuration || 0} onChange={(e) => setVideoDefaultDuration(Number(e.target.value))} className={selectCls}>
            <option value={0}>Auto</option>
            {durations.map((d) => <option key={d} value={d}>{d}s</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="video-default-resolution" className={labelCls}>Default Resolution</label>
          <select id="video-default-resolution" value={videoDefaultResolution} onChange={(e) => setVideoDefaultResolution(e.target.value)} className={selectCls}>
            <option value="">Auto</option>
            {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="video-default-aspect" className={labelCls}>Default Aspect</label>
          <select id="video-default-aspect" value={videoDefaultAspect} onChange={(e) => setVideoDefaultAspect(e.target.value)} className={selectCls}>
            <option value="">Auto</option>
            {aspects.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button" role="switch" aria-checked={videoGenerateAudio}
          onClick={() => setVideoGenerateAudio(!videoGenerateAudio)}
          className="flex items-center gap-2.5 text-left"
        >
          <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${videoGenerateAudio ? "bg-accent" : "bg-outline-variant/40"}`}>
            <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${videoGenerateAudio ? "translate-x-4" : "translate-x-0"}`} />
          </span>
          <span className="text-sm font-medium text-foreground">Generate audio</span>
        </button>
        {costLabel && (
          <span className="text-[11px] text-on-surface-variant tabular-nums" aria-live="polite">{costLabel}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className={labelCls}>Saved Video Models</label>
        <div className="flex flex-wrap gap-1.5">
          {savedVideoModels.length === 0 && (
            <span className="text-xs text-on-surface-variant italic">No custom video models saved yet.</span>
          )}
          {savedVideoModels.map((m) => (
            <span key={m} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-xs">
              <span className="font-mono">{m}</span>
              <button onClick={() => removeVideoModel(m)} aria-label={`Remove ${m}`} className="opacity-60 hover:opacity-100">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newModel.trim()) { addVideoModel(newModel.trim()); setNewModel(""); } }}
            placeholder="e.g. openai/sora-2-pro"
            className="flex-1 bg-surface-container-high border-none rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40"
          />
          <Button size="sm" onClick={() => { if (newModel.trim()) { addVideoModel(newModel.trim()); setNewModel(""); } }}>Add</Button>
        </div>
      </div>
    </section>
  );
};

export default VideoModelsSettings;
