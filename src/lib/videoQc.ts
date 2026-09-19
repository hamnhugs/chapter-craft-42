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
//
// Optionally a VLM identity judge runs as a SECOND opinion (see
// judgeIdentityWithVlm). EntityBench (2026) measured that embedding
// similarity disagrees with judged identity: DINO cosine correlates with
// human raters at only ~51%, while a vision-model judge reaches ~83%. The
// two signals are therefore reported side by side and NEVER averaged —
// folding a ~51%-correlated number into an ~83%-correlated one would launder
// the weaker signal, and their disagreement is itself the most informative
// thing the report can surface (amber ≠ precision; thresholds here still
// deserve calibration against real clips).

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

/** What the VLM judge returns: its own 0–1 identity score plus a categorical
 *  verdict. Deliberately NOT on the green/amber/red scale — it answers a
 *  different question ("same character?") than the cosine does. */
export interface VlmIdentityJudgement {
  score: number;
  verdict: "match" | "drift" | "mismatch";
  reasons: string[];
}

/** The judge signal as embedded in a QC report: judgement + provenance +
 *  an explicit disagreement flag so consumers never have to re-derive it. */
export interface VlmJudgeSignal extends VlmIdentityJudgement {
  model: string;
  /** True when the judge and the DINO identity band point different
   *  directions (per EntityBench, when they disagree the judge is the one
   *  more likely to match a human rater — but we surface, never override). */
  disagrees_with_embedding: boolean;
}

/** VideoQcResult (videoGen.ts) plus the optional judge signal. Additive and
 *  optional so persisted rows from before the judge existed parse unchanged. */
export interface VideoQcResultV2 extends VideoQcResult {
  vlm_judge?: VlmJudgeSignal;
}

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
  /** Aspect-correct ≤512px data URL for the VLM judge — the 224×224 embed
   *  crop squashes aspect, which is fine for DINO but would distort exactly
   *  the silhouette cues the judge is asked to weigh. Captured only when a
   *  judge is requested. */
  judgeUrl?: string;
}

async function sampleFrames(videoUrl: string, maxFrames: number, captureJudgeFrames = false): Promise<SampledFrame[]> {
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

  let judgeCtx: CanvasRenderingContext2D | null = null;
  let judgeCanvas: HTMLCanvasElement | null = null;
  if (captureJudgeFrames) {
    const vw = video.videoWidth || 512, vh = video.videoHeight || 512;
    const scale = Math.min(1, 512 / Math.max(vw, vh));
    judgeCanvas = document.createElement("canvas");
    judgeCanvas.width = Math.max(1, Math.round(vw * scale));
    judgeCanvas.height = Math.max(1, Math.round(vh * scale));
    judgeCtx = judgeCanvas.getContext("2d");
    // No judge canvas ⇒ the judge silently doesn't run; embed QC still does.
  }

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
    let judgeUrl: string | undefined;
    if (judgeCtx && judgeCanvas) {
      judgeCtx.drawImage(video, 0, 0, judgeCanvas.width, judgeCanvas.height);
      judgeUrl = judgeCanvas.toDataURL("image/jpeg", 0.9);
    }
    frames.push({
      ts: Math.round(ts * 100) / 100,
      embedUrl: embedCanvas.toDataURL("image/jpeg", 0.9),
      palettePixels: palCtx.getImageData(0, 0, 48, 48).data.slice(),
      judgeUrl,
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

// ── VLM identity judge (optional second opinion) ────────────────────────────

// Same endpoint imageGen uses — hardcoded on purpose: the adapter seam is for
// chat routing, and QC must not grow a dependency on files mid-refactor.
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Balanced-brace scan for the first {...} block, string-aware. Models love
 *  wrapping JSON in prose or markdown fences, so "parse the whole reply" is a
 *  losing strategy, and a greedy regex breaks on trailing text. */
function extractFirstJsonObject(text: string): any | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Signed ref URL → aspect-correct ≤512px jpeg data URL (the judge API wants
 *  inline images, and full-res refs would bloat the request for no benefit).
 *  Null on any failure — one bad ref shouldn't kill the judge. */
async function refToDataUrl(url: string): Promise<string | null> {
  try {
    if (url.startsWith("data:")) return url;
    const img = new Image();
    img.crossOrigin = "anonymous"; // Supabase storage serves CORS — keeps the canvas untainted
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ref image timed out")), 10000);
      img.onload = () => { clearTimeout(timeout); resolve(); };
      img.onerror = () => { clearTimeout(timeout); reject(new Error("ref image failed to load")); };
      img.src = url;
    });
    const scale = Math.min(1, 512 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch { return null; }
}

/** Up to n items spread evenly across the array (always includes both ends). */
function pickSpread<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return out;
}

const JUDGE_RUBRIC = `You are a character-identity judge for animated-video QC.
The images labeled "REFERENCE (canonical)" define the one true look of a character.
The images labeled "FRAME n" are frames sampled from a generated video.
Judge whether the character in the frames is the SAME character as in the references.
Compare: face/head structure, overall silhouette and proportions, color palette,
and costume/marking details. Ignore pose, camera angle, lighting, background,
compression artifacts, and motion blur.
Verdicts: "match" = clearly the same character; "drift" = same character but
details have shifted (palette, proportions, costume); "mismatch" = a different character.
Reply with STRICT JSON only, no prose, no markdown, exactly this shape:
{"score": <number 0..1, identity similarity>, "verdict": "match"|"drift"|"mismatch", "reasons": [<short concrete observations>]}`;

/** Ask a vision model the actual question the cosine only approximates:
 *  "is this the same character?". EntityBench (2026): DINO embedding
 *  similarity agrees with human raters ~51% of the time, a VLM judge ~83% —
 *  which is why this exists at all, and why its output is reported as its own
 *  labeled signal instead of being averaged into the embedding score.
 *
 *  Returns null on ANY failure (network, refusal, unparseable). Callers must
 *  treat null strictly as "judge unavailable" — never as a pass or a fail. */
export async function judgeIdentityWithVlm(opts: {
  /** Frame data URLs, ≤4 used. */
  frames: string[];
  /** Reference data URLs (hero first), ≤3 used. */
  referenceImages: string[];
  apiKey: string;
  model: string;
  /** Only OpenRouter today; the field exists so a second judge host is an
   *  additive change, not a signature break. */
  endpoint?: "openrouter";
}): Promise<VlmIdentityJudgement | null> {
  const frames = opts.frames.slice(0, 4);
  const refs = opts.referenceImages.slice(0, 3);
  if (frames.length === 0 || refs.length === 0 || !opts.apiKey || !opts.model) return null;
  try {
    // Rubric first, then labeled images — the labels are text parts directly
    // before each image so the model can address them unambiguously.
    const content: any[] = [{ type: "text", text: JUDGE_RUBRIC }];
    refs.forEach((url, i) => {
      content.push({ type: "text", text: `REFERENCE (canonical) ${i + 1}:` });
      content.push({ type: "image_url", image_url: { url } });
    });
    frames.forEach((url, i) => {
      content.push({ type: "text", text: `FRAME ${i + 1}:` });
      content.push({ type: "image_url", image_url: { url } });
    });
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        "HTTP-Referer": window.location.origin,
        "X-Title": "Chapter Craft",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content }],
        // Deterministic-ish judging; enough tokens for a handful of reasons.
        temperature: 0,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter · ${opts.model}: HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data?.error) throw new Error(`OpenRouter · ${opts.model}: ${data.error?.message || "API error"}`);
    const raw = data?.choices?.[0]?.message?.content;
    // Content can be a plain string or an array of parts, provider-dependent.
    const text = typeof raw === "string"
      ? raw
      : Array.isArray(raw) ? raw.map((p: any) => p?.text || "").join("\n") : "";
    const parsed = extractFirstJsonObject(text);
    if (!parsed || typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) return null;
    const score = Math.min(1, Math.max(0, parsed.score));
    // A missing/garbled verdict with a sane score is still usable — derive it
    // rather than discarding a whole paid judge call.
    const verdict: VlmIdentityJudgement["verdict"] =
      parsed.verdict === "match" || parsed.verdict === "drift" || parsed.verdict === "mismatch"
        ? parsed.verdict
        : score >= 0.75 ? "match" : score >= 0.4 ? "drift" : "mismatch";
    const reasons: string[] = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r: any) => typeof r === "string" && r.trim()).slice(0, 8)
      : [];
    return { score: Math.round(score * 1000) / 1000, verdict, reasons };
  } catch (e: any) {
    // Named so a bug report can say WHICH provider/model failed (the
    // provider-visibility lesson) — but the judge stays advisory: null out.
    console.warn(`OpenRouter · ${opts.model}: VLM identity judge unavailable —`, e?.message || e);
    return null;
  }
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function runVideoQc(opts: {
  /** Signed URL of the finished clip. */
  videoUrl: string;
  /** Signed URLs of the identity references (hero first). */
  refImageUrls: string[];
  lockPalette?: string[] | null;
  thresholds?: QcThresholds;
  /** When set, a VLM second opinion runs whenever the DINO identity signal is
   *  anything short of a clear green (see the EntityBench note up top). */
  vlmJudge?: { apiKey: string; model: string } | null;
}): Promise<VideoQcResultV2> {
  const t = opts.thresholds || QC_THRESHOLDS;
  const started = Date.now();
  const { embed, device } = await getEmbedder();

  const frames = await sampleFrames(opts.videoUrl, t.maxFrames, !!opts.vlmJudge);
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
  let identityBand: Band | null = null;
  if (refSimMean != null && refSimMin != null) {
    identityBand =
      refSimMean < t.identity.redMean ? "red"
      : refSimMean >= t.identity.greenMean && refSimMin >= t.identity.greenMin ? "green"
      : "amber";
    bands.push(identityBand);
  }
  if (temporalMean != null) {
    bands.push(temporalMean < t.temporal.red ? "red" : temporalMean >= t.temporal.green ? "green" : "amber");
  }
  if (paletteDeltaE != null) {
    bands.push(paletteDeltaE > t.paletteDeltaE.red ? "red" : paletteDeltaE <= t.paletteDeltaE.green ? "green" : "amber");
  }
  const verdict: Band = bands.includes("red") ? "red" : bands.includes("amber") ? "amber" : "green";

  // Optional VLM second opinion — only when the caller supplied a key AND the
  // embedding identity signal is not a clear green (amber, red, or absent).
  // EntityBench (2026): DINO cosine agrees with human raters ~51%, a VLM
  // judge ~83% — so a non-green cosine is exactly where a second, differently
  // wired signal earns its API spend. The judge result is a SEPARATE labeled
  // field: it never moves ref_sim_* numbers, never shifts the band verdict,
  // and carries an explicit disagreement flag instead of being blended away.
  let vlmJudge: VlmJudgeSignal | undefined;
  if (opts.vlmJudge?.apiKey && opts.vlmJudge.model && identityBand !== "green" && opts.refImageUrls.length > 0) {
    const judgeFrames = pickSpread(frames, 4)
      .map((f) => f.judgeUrl || f.embedUrl)
      .filter(Boolean);
    const refDataUrls: string[] = [];
    for (const url of opts.refImageUrls.slice(0, 3)) {
      const d = await refToDataUrl(url);
      if (d) refDataUrls.push(d);
    }
    if (judgeFrames.length > 0 && refDataUrls.length > 0) {
      const judged = await judgeIdentityWithVlm({
        frames: judgeFrames,
        referenceImages: refDataUrls,
        apiKey: opts.vlmJudge.apiKey,
        model: opts.vlmJudge.model,
      });
      // null = judge unavailable — the report simply omits the signal.
      if (judged) {
        const judgeBand: Band = judged.verdict === "match" ? "green" : judged.verdict === "drift" ? "amber" : "red";
        vlmJudge = {
          ...judged,
          model: opts.vlmJudge.model,
          disagrees_with_embedding: identityBand != null && judgeBand !== identityBand,
        };
      }
    }
  }

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
    // Omitted (not null) when the judge didn't run — JSON.stringify drops it,
    // so persisted rows only carry the field when there is a real judgement.
    vlm_judge: vlmJudge,
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

export function qcSummaryLine(qc: VideoQcResultV2): string {
  const parts: string[] = [];
  if (qc.ref_sim_mean != null) parts.push(`identity ${qc.ref_sim_mean}`);
  if (qc.temporal_mean != null) parts.push(`temporal ${qc.temporal_mean}`);
  if (qc.palette_delta_e != null) parts.push(`palette ΔE ${qc.palette_delta_e}`);
  // The judge is its own labeled signal; when it disagrees with the embedding,
  // say so out loud — that disagreement is the report's most useful fact.
  if (qc.vlm_judge) {
    parts.push(`judge ${qc.vlm_judge.verdict} ${qc.vlm_judge.score}${qc.vlm_judge.disagrees_with_embedding ? " (disagrees with embedding)" : ""}`);
  }
  return parts.join(" · ");
}
