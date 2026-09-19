import React, { useState } from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { IMAGE_MODELS, IMAGE_ASPECT_RATIOS } from "@/lib/imageGen";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const ImageModelsSettings: React.FC = () => {
  const {
    savedImageModels, imageModelPrimary, imageModelFallback,
    imageQuality, imageSize,
    addImageModel, removeImageModel,
    setImageModelPrimary, setImageModelFallback,
    setImageQuality, setImageSize,
  } = useChatSettings();
  const [newModel, setNewModel] = useState("");
  const allModels = Array.from(new Set([...savedImageModels, ...IMAGE_MODELS]));

  return (
    <section className="p-3 md:p-4 rounded-xl bg-surface-container-low flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-bold text-foreground">Image Generation</h3>
        <p className="text-xs text-on-surface-variant">
          Pick which model the AI uses when generating or editing images. Primary is tried first;
          if it fails the fallback runs automatically. Built-in defaults are always available.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Primary Image Model</label>
          <select
            value={imageModelPrimary}
            onChange={(e) => setImageModelPrimary(e.target.value)}
            className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
          >
            <option value="">Auto (use built-in default)</option>
            {allModels.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Fallback Image Model</label>
          <select
            value={imageModelFallback}
            onChange={(e) => setImageModelFallback(e.target.value)}
            className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
          >
            <option value="">None</option>
            {allModels.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Quality</label>
          <select
            value={imageQuality}
            onChange={(e) => setImageQuality(e.target.value)}
            className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
          >
            <option value="">Auto</option>
            <option value="standard">Standard</option>
            <option value="hd">HD</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Default Aspect</label>
          <select
            value={imageSize}
            onChange={(e) => setImageSize(e.target.value)}
            className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
          >
            <option value="">Auto (1:1)</option>
            {IMAGE_ASPECT_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Saved Image Models</label>
        <div className="flex flex-wrap gap-1.5">
          {savedImageModels.length === 0 && (
            <span className="text-xs text-on-surface-variant italic">No custom image models saved yet.</span>
          )}
          {savedImageModels.map((m) => (
            <span key={m} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-xs">
              <span className="font-mono">{m}</span>
              <button onClick={() => removeImageModel(m)} aria-label={`Remove ${m}`} className="opacity-60 hover:opacity-100">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newModel.trim()) { addImageModel(newModel.trim()); setNewModel(""); } }}
            placeholder="e.g. google/gemini-3-pro-image"
            className="flex-1 bg-surface-container-high border-none rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40"
          />
          <Button size="sm" onClick={() => { if (newModel.trim()) { addImageModel(newModel.trim()); setNewModel(""); } }}>Add</Button>
        </div>
        <Link to="/models?kind=image" className="text-xs text-primary underline underline-offset-2 mt-1">
          Browse the image-model explorer →
        </Link>
      </div>
    </section>
  );
};

export default ImageModelsSettings;
