import { supabase } from "@/integrations/supabase/client";
import type { VideoQcResult } from "@/lib/videoGen";

// Post-generation identity QC, fully client-side (no API spend, no new keys).
// Mirrors the published evaluation protocol for character consistency:
//   - reference similarity: DINOv2 embedding cosine between sampled frames and
//     the master's reference images (DINO features are the discriminative
//     identity signal; CLIP-I stays deceptively high under drift),
//   - temporal consistency: the VBench subject-consistency formula
//     (per frame: mean of clamped cosine to the previous frame and frame 0),
//   - palette drift: dominant-color extraction per frame scored against the
//     locked palette with CIEDE2000.
// ArcFace is deliberately absent: subjects here are usually non-human
// (robots, creatures), where face-identity models silently return garbage.
//
// Everything is a tunable heuristic — thresholds ship as a versioned config,
// never hardcoded elsewhere. The gate WARNS; it never blocks or deletes a
// paid clip.

export const QC_VERSION = 1;

/** DINOv2-small ONNX port: 384-d embeddings, ~44 MB fp16 (WebGPU) or ~24 MB
 *  quantized (WASM fallback). Downloaded from the HF hub on first QC run and
 *  browser-cached — zero impact on the app bundle. */
const QC_MODEL_ID = "Xenova/dinov2-small";

export interface QcThresholds {
  version: number;
  identity: { greenMean: number; greenMin: number; redMean: number };
  temporal: { green: number; red: number };
  paletteDeltaE: { green: number; red: number };
  maxFrames: number;
}

/** Starting thresholds — calibrated from published anchors (DreamBooth DINO
 *  ~0.7+ = good identity, VBench ~0.95+ = normal for good clips, ΔE00 >10 =
 *  clearly noticeable color shift), to be recalibrated against real clips. */
export const QC_THRESHOLDS: QcThresholds = {
  version: QC_VERSION,
  identity: { greenMean: 0.75, greenMin: 0.6, redMean: 0.6 },
  temporal: { green: 0.95, red: 0.88 },
  paletteDeltaE: { green: 10, red: 20 },
  maxFrames: 12,
};

// ── Embedder (lazy singleton) ───────────────────────────────────────────────

let embedderPromise: Promise<{ embed: (dataUrl: string) => Promise<number[]>; device: string }> | null = null;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const tryInit = async (device: "webgpu" | "wasm") => {
        const dtype = device === "webgpu" ? "fp16" : "q8";
        const fe: any = await pipeline("image-feature-extraction", QC_MODEL_ID, { device, dtype } as any);
        return fe;
      };
      let fe: any;
      let device = "webgpu";
      try {
        if (!(navigator as any).gpu) throw new Error("no WebGPU");
        fe = await tryInit("webgpu");
      } catch {
        // transformers.js does NOT fall back automatically — do it ourselves.
        device = "wasm";
        fe = await tryInit("wasm");
      }
      const embed = async (dataUrl: string): Promise<number[]> => {
        const out: any = await fe(dataUrl);
        // Output can be [1, tokens, dims] (per-token) or [1, dims] (pooled).
        // Token 0 is DINOv2's CLS token — the standard global descriptor.
        const dims: number[] = out.dims || [];
        const data: Float32Array = out.data;
        if (dims.length === 3) {
          const [, , d] = dims;
          return Array.from(data.slice(0, d));
        }
        return Array.from(data);
      };
      return { embed, device };
    })();
    // A failed init must not poison every later QC attempt.
    embedderPromise.catch(() => { embedderPromise = null; });
  }
  return embedderPromise;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Frame sampling ──────────────────────────────────────────────────────────

interface SampledFrame {
  ts: number;
  /** 224px data URL for embedding. */
  embedUrl: string;
  /** Small ImageData for palette extraction. */
  palettePixels: Uint8ClampedArray;
}

async function sampleFrames(videoUrl: string, maxFrames: number): Promise<SampledFrame[]> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous"; // Supabase storage serves CORS — keeps the canvas untainted
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = videoUrl;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Video metadata timed out")), 15000);
    video.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
    video.onerror = () => { clearTimeout(timeout); reject(new Error("Video failed to load for QC")); };
  });

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 6;
  const count = Math.max(2, Math.min(maxFrames, Math.round(duration * 1.5) + 2));
  // First + last + uniform interior (last slightly inset — seeking to the
  // exact end can land on an empty frame in some codecs).
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    timestamps.push(Math.min(duration * (i / (count - 1)), Math.max(0, duration - 0.05)));
  }

  const embedCanvas = document.createElement("canvas");
  embedCanvas.width = 224; embedCanvas.height = 224;
  const embedCtx = embedCanvas.getContext("2d", { willReadFrequently: true });
  const palCanvas = document.createElement("canvas");
  palCanvas.width = 48; palCanvas.height = 48;
  const palCtx = palCanvas.getContext("2d", { willReadFrequently: true });
  if (!embedCtx || !palCtx) throw new Error("Canvas unavailable for QC");

  const frames: SampledFrame[] = [];
  for (const ts of timestamps) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Frame seek timed out")), 8000);
      video.onseeked = () => { clearTimeout(timeout); resolve(); };
      video.onerror = () => { clearTimeout(timeout); reject(new Error("Seek failed")); };
      try { video.currentTime = ts; } catch { clearTimeout(timeout); reject(new Error("Seek failed")); }
    });
    embedCtx.drawImage(video, 0, 0, 224, 224);
    palCtx.drawImage(video, 0, 0, 48, 48);
    frames.push({
      ts: Math.round(ts * 100) / 100,
      embedUrl: embedCanvas.toDataURL("image/jpeg", 0.9),
      palettePixels: palCtx.getImageData(0, 0, 48, 48).data.slice(),
    });
  }
  try { video.src = ""; video.load(); } catch { /* teardown best-effort */ }
  return frames;
}

// ── Palette drift ───────────────────────────────────────────────────────────

/** Tiny k-means (k=5) over downsampled pixels → [{hex-ish rgb, weight}]. */
function dominantColors(pixels: Uint8ClampedArray, k = 5): Array<{ r: number; g: number; b: number; weight: number }> {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 32) continue; // skip transparent
    pts.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (pts.length === 0) return [];
  // Deterministic init: spread over the sorted-by-luma point list.
  const sorted = [...pts].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor((i + 0.5) * sorted.length / k)]);
  let assign = new Array(pts.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    for (let p = 0; p < pts.length; p++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dr = pts[p][0] - centers[c][0], dg = pts[p][1] - centers[c][1], db = pts[p][2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[p] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let p = 0; p < pts.length; p++) {
      const s = sums[assign[p]];
      s[0] += pts[p][0]; s[1] += pts[p][1]; s[2] += pts[p][2]; s[3]++;
    }
    centers = centers.map((c, i) => sums[i][3] > 0
      ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] as [number, number, number]
      : c);
  }
  const counts = centers.map(() => 0);
  for (const a of assign) counts[a]++;
  const total = pts.length;
  return centers
    .map((c, i) => ({ r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), weight: counts[i] / total }))
    .filter((c) => c.weight > 0.02)
    .sort((a, b) => b.weight - a.weight);
}

/** Area-weighted mean CIEDE2000 from each dominant color to its NEAREST lock
 *  swatch. Low = the clip stays inside the locked palette. */
async function paletteDriftDeltaE(frames: SampledFrame[], lockPalette: string[]): Promise<number | null> {
  if (!lockPalette || lockPalette.length === 0) return null;
  const { differenceCiede2000 } = await import("culori");
  const deltaE = differenceCiede2000();
  let weighted = 0, weightSum = 0;
  for (const f of frames) {
    for (const c of dominantColors(f.palettePixels)) {
      const rgb = `rgb(${c.r}, ${c.g}, ${c.b})`;
      let best = Infinity;
      for (const hex of lockPalette) {
        try {
          const d = deltaE(rgb, hex);
          if (Number.isFinite(d) && d < best) best = d;
        } catch { /* unparseable swatch — skip */ }
      }
      if (Number.isFinite(best)) { weighted += best * c.weight; weightSum += c.weight; }
    }
  }
  if (weightSum === 0) return null;
  return Math.round((weighted / weightSum) * 10) / 10;
}

// ── Reference embeddings ────────────────────────────────────────────────────

// Per-session cache so repeated QC runs against the same master don't
// re-embed the pack every time.
const refEmbedCache = new Map<string, number[]>();

export async function embedImageUrl(url: string): Promise<number[]> {
  const cached = refEmbedCache.get(url);
  if (cached) return cached;
  const { embed } = await getEmbedder();
  const vec = await embed(url);
  refEmbedCache.set(url, vec);
  return vec;
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function runVideoQc(opts: {
  /** Signed URL of the finished clip. */
  videoUrl: string;
  /** Signed URLs of the identity references (hero first). */
  refImageUrls: string[];
  lockPalette?: string[] | null;
  thresholds?: QcThresholds;
}): Promise<VideoQcResult> {
  const t = opts.thresholds || QC_THRESHOLDS;
  const started = Date.now();
  const { embed, device } = await getEmbedder();

  const frames = await sampleFrames(opts.videoUrl, t.maxFrames);
  if (frames.length < 2) throw new Error("Not enough frames for QC");

  const frameVecs: number[][] = [];
  for (const f of frames) frameVecs.push(await embed(f.embedUrl));

  // Reference similarity: per frame, the best match across the pack (a back
  // view SHOULD match the back reference, not the hero) — then mean AND min.
  let refSimMean: number | null = null;
  let refSimMin: number | null = null;
  if (opts.refImageUrls.length > 0) {
    const refVecs: number[][] = [];
    for (const url of opts.refImageUrls.slice(0, 6)) {
      try { refVecs.push(await embedImageUrl(url)); } catch { /* one bad ref shouldn't kill QC */ }
    }
    if (refVecs.length > 0) {
      const perFrame = frameVecs.map((fv) => Math.max(...refVecs.map((rv) => cosine(fv, rv))));
      refSimMean = perFrame.reduce((a, b) => a + b, 0) / perFrame.length;
      refSimMin = Math.min(...perFrame);
    }
  }

  // Temporal consistency — the VBench subject-consistency formula.
  let temporalMean: number | null = null;
  {
    const scores: number[] = [];
    for (let i = 1; i < frameVecs.length; i++) {
      const simPre = Math.max(0, cosine(frameVecs[i - 1], frameVecs[i]));
      const simFir = Math.max(0, cosine(frameVecs[0], frameVecs[i]));
      scores.push((simPre + simFir) / 2);
    }
    temporalMean = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  const paletteDeltaE = await paletteDriftDeltaE(frames, opts.lockPalette || []).catch(() => null);

  // Verdict = worst band across the metrics that actually ran.
  type Band = "green" | "amber" | "red";
  const bands: Band[] = [];
  if (refSimMean != null && refSimMin != null) {
    bands.push(
      refSimMean < t.identity.redMean ? "red"
      : refSimMean >= t.identity.greenMean && refSimMin >= t.identity.greenMin ? "green"
      : "amber",
    );
  }
  if (temporalMean != null) {
    bands.push(temporalMean < t.temporal.red ? "red" : temporalMean >= t.temporal.green ? "green" : "amber");
  }
  if (paletteDeltaE != null) {
    bands.push(paletteDeltaE > t.paletteDeltaE.red ? "red" : paletteDeltaE <= t.paletteDeltaE.green ? "green" : "amber");
  }
  const verdict: Band = bands.includes("red") ? "red" : bands.includes("amber") ? "amber" : "green";

  const round = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
  return {
    qc_version: QC_VERSION,
    model_id: QC_MODEL_ID,
    device,
    frame_timestamps: frames.map((f) => f.ts),
    ref_sim_mean: round(refSimMean),
    ref_sim_min: round(refSimMin),
    temporal_mean: round(temporalMean),
    palette_delta_e: paletteDeltaE,
    verdict,
    runtime_ms: Date.now() - started,
  };
}

/** Persist QC scores on the video row. Tolerates a missing qc column (the
 *  identity migration not applied) — QC is advisory, never load-bearing. */
export async function writeQcResult(jobId: string, qc: VideoQcResult): Promise<void> {
  try {
    await (supabase.from("video_generations" as any) as any)
      .update({ qc, updated_at: new Date().toISOString() })
      .eq("job_id", jobId);
  } catch { /* advisory only */ }
}

export function qcSummaryLine(qc: VideoQcResult): string {
  const parts: string[] = [];
  if (qc.ref_sim_mean != null) parts.push(`identity ${qc.ref_sim_mean}`);
  if (qc.temporal_mean != null) parts.push(`temporal ${qc.temporal_mean}`);
  if (qc.palette_delta_e != null) parts.push(`palette ΔE ${qc.palette_delta_e}`);
  return parts.join(" · ");
}
