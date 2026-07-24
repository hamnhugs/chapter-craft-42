import React, { useEffect, useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  SPLAT_MODELS, QUALITY_TIERS, DEFAULT_SPLAT_MODEL,
  getSplatModel, tierSizeLabel, formatUSD, formatMB,
} from "@/lib/splatCatalog";
import { splatStorageBytes, countSplatsThisMonth } from "@/lib/splatGen";

const SplatModelsSettings: React.FC = () => {
  const {
    falApiKey, splatModelPrimary, splatDefaultQuality, splatMaxFileMb,
    splatConfirmThreshold, splatClickToActivate, splatMonthlyQuota, splatAutoFallback,
    setFalApiKey, setSplatModelPrimary, setSplatDefaultQuality, setSplatMaxFileMb,
    setSplatConfirmThreshold, setSplatClickToActivate, setSplatMonthlyQuota, setSplatAutoFallback,
  } = useChatSettings();

  const [showKey, setShowKey] = useState(false);
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [bytes, count] = await Promise.all([splatStorageBytes(), countSplatsThisMonth()]);
        if (!cancelled) setUsage({ bytes, count });
      } catch { /* table not migrated yet — the readout just stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const effectiveModel = splatModelPrimary || DEFAULT_SPLAT_MODEL;
  const modelInfo = getSplatModel(effectiveModel);

  const selectCls = "w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40";
  const labelCls = "text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1";

  return (
    <section className="p-3 md:p-4 rounded-xl bg-surface-container-low flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-bold text-foreground">3D Models</h3>
        <p className="text-xs text-on-surface-variant">
          Turn an image into an interactive 3D Gaussian splat with <code className="text-[11px]">generate_splat</code>.
          There's no text-to-3D — the AI generates an image first, then lifts it into 3D. Billed per generation to your
          fal.ai key.
        </p>
      </header>

      {/* fal key */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="fal-api-key" className={labelCls}>fal.ai API Key</label>
        <div className="flex gap-2">
          <input
            id="fal-api-key"
            type={showKey ? "text" : "password"}
            value={falApiKey}
            // Saved as you type (the settings store debounces the write) so the
            // key can't be lost by closing the panel before the field blurs.
            onChange={(e) => setFalApiKey(e.target.value)}
            placeholder="Paste your fal.ai key"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-surface-container-high border-none rounded-lg text-sm py-2.5 px-4 font-mono focus:ring-1 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? "Hide key" : "Show key"}
            className="px-3 rounded-lg bg-surface-container-high text-on-surface-variant hover:text-foreground transition-colors"
          >
            <span className="material-symbols-outlined text-base">{showKey ? "visibility_off" : "visibility"}</span>
          </button>
        </div>
        <p className="text-[11px] text-amber-600 dark:text-amber-400/90 leading-relaxed px-1">
          <strong className="font-semibold">Use a dedicated key and keep a low balance.</strong> This key is stored in
          your browser and sent straight to fal.ai, so it's visible in developer tools. fal scopes keys by endpoint but
          has no per-key spending cap, which means a leaked key can run up unlimited paid GPU time. Set a monthly limit
          below as a second line of defence.
        </p>
        <a
          href="https://fal.ai/dashboard/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary hover:underline px-1 w-fit"
        >
          Create a key at fal.ai →
        </a>
      </div>

      {/* model + quality */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="splat-model-primary" className={labelCls}>Default 3D Model</label>
          <select
            id="splat-model-primary"
            value={splatModelPrimary}
            onChange={(e) => setSplatModelPrimary(e.target.value)}
            className={selectCls}
          >
            <option value="">Auto — TripoSplat</option>
            {SPLAT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label} — {formatUSD(m.price)}</option>
            ))}
          </select>
          {modelInfo && <p className="text-[11px] text-on-surface-variant px-1">{modelInfo.note}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="splat-quality" className={labelCls}>Default Quality</label>
          <select
            id="splat-quality"
            value={splatDefaultQuality}
            onChange={(e) => setSplatDefaultQuality(e.target.value)}
            className={selectCls}
          >
            {QUALITY_TIERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} — {t.numGaussians.toLocaleString()} gaussians, {tierSizeLabel(t)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-on-surface-variant px-1">
            Every tier costs the same; only the file size changes.
          </p>
        </div>
      </div>

      {/* guards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="splat-max-mb" className={labelCls}>Max file size (MB)</label>
          <input
            id="splat-max-mb"
            type="number" min={1} max={50} step={1} value={splatMaxFileMb}
            onChange={(e) => setSplatMaxFileMb(parseFloat(e.target.value))}
            className={selectCls}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="splat-confirm-threshold" className={labelCls}>Confirm cost above ($)</label>
          <input
            id="splat-confirm-threshold"
            type="number" min={0} step={0.05} value={splatConfirmThreshold}
            onChange={(e) => setSplatConfirmThreshold(parseFloat(e.target.value))}
            className={selectCls}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="splat-monthly-quota" className={labelCls}>Monthly limit (0 = none)</label>
          <input
            id="splat-monthly-quota"
            type="number" min={0} step={1} value={splatMonthlyQuota}
            onChange={(e) => setSplatMonthlyQuota(parseInt(e.target.value, 10))}
            className={selectCls}
          />
        </div>
      </div>

      {/* toggles */}
      <div className="flex flex-col gap-3">
        <button
          type="button" role="switch" aria-checked={splatClickToActivate}
          onClick={() => setSplatClickToActivate(!splatClickToActivate)}
          className="flex items-center gap-2.5 text-left"
        >
          <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${splatClickToActivate ? "bg-accent" : "bg-outline-variant/40"}`}>
            <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${splatClickToActivate ? "translate-x-4" : "translate-x-0"}`} />
          </span>
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">Show a preview image first</span>
            <span className="text-[11px] text-on-surface-variant">
              3D loads only when you tap "View in 3D". Turning this off starts the viewer automatically, which uses more
              memory and battery.
            </span>
          </span>
        </button>

        <button
          type="button" role="switch" aria-checked={splatAutoFallback}
          onClick={() => setSplatAutoFallback(!splatAutoFallback)}
          className="flex items-center gap-2.5 text-left"
        >
          <span className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${splatAutoFallback ? "bg-accent" : "bg-outline-variant/40"}`}>
            <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${splatAutoFallback ? "translate-x-4" : "translate-x-0"}`} />
          </span>
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">Try a backup model on failure</span>
            <span className="text-[11px] text-on-surface-variant">
              If the main model rejects an image, retry once with SAM 3D Objects ({formatUSD(0.02)}).
            </span>
          </span>
        </button>
      </div>

      {usage && (
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-outline-variant/15 text-[11px] text-on-surface-variant">
          <span>{usage.count} generated this month</span>
          <span className="tabular-nums">{formatMB(usage.bytes)} stored</span>
        </div>
      )}
    </section>
  );
};

export default SplatModelsSettings;
