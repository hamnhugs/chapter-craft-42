// Live OpenRouter VIDEO model catalog. Unlike the text/chat catalog
// (openrouterCatalog.ts), video models are served from a dedicated endpoint,
// GET /api/v1/videos/models, which returns per-model supported resolutions,
// durations, aspect ratios, audio support, and a heterogeneous pricing_skus
// map. No API key is needed and the endpoint allows browser CORS. Cached in
// localStorage for an hour — the catalog changes only occasionally.

export interface VideoModel {
  id: string;
  name: string;
  description?: string;
  supported_resolutions: string[];
  supported_aspect_ratios: string[] | null;
  supported_sizes: string[] | null;
  supported_durations: number[];
  supported_frame_images: string[] | null; // e.g. ["first_frame"] => image-to-video
  generate_audio: boolean | null;
  seed: boolean | null;
  pricing_skus: Record<string, string>;
}

// User's chosen default (confirmed available on OpenRouter). Google DeepMind's
// fast tier — good value, native audio.
export const DEFAULT_VIDEO_MODEL = "google/veo-3.1-fast";

// Offline fallback shown before the live catalog resolves (or if it fails).
// Ordered: default first, then genuinely non-Google options, then premium.
export const FALLBACK_VIDEO_MODELS: Array<{ id: string; label: string }> = [
  { id: "google/veo-3.1-fast", label: "Veo 3.1 Fast — default, great value ($0.08–0.30/s)" },
  { id: "google/veo-3.1-lite", label: "Veo 3.1 Lite — cheapest Veo ($0.03–0.08/s)" },
  { id: "minimax/hailuo-2.3", label: "Hailuo 2.3 — non-Google, 1080p ($0.082/s)" },
  { id: "bytedance/seedance-2.0", label: "Seedance 2.0 — non-Google, cheapest tier" },
  { id: "alibaba/wan-2.7", label: "Wan 2.7 — non-Google ($0.04–0.15/s)" },
  { id: "kwaivgi/kling-v3.0-pro", label: "Kling v3.0 Pro — non-Google ($0.112/s)" },
  { id: "x-ai/grok-imagine-video-1.5", label: "Grok Imagine 1.5 — non-Google" },
  { id: "openai/sora-2-pro", label: "Sora 2 Pro — non-Google, premium ($0.30–0.50/s)" },
  { id: "google/veo-3.1", label: "Veo 3.1 — premium ($0.20–0.60/s)" },
];

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = "or_video_models";
const ENDPOINT = "https://openrouter.ai/api/v1/videos/models";

export async function fetchVideoModels(): Promise<VideoModel[]> {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { t, data } = JSON.parse(cached);
      if (Date.now() - t < CACHE_TTL_MS && Array.isArray(data)) return data as VideoModel[];
    }
  } catch { /* corrupt cache — refetch */ }

  const res = await fetch(ENDPOINT);
  if (!res.ok) throw new Error(`OpenRouter video catalog request failed (${res.status})`);
  const json = await res.json();
  const models = (json?.data || []) as VideoModel[];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data: models }));
  } catch { /* storage full — fine, just uncached */ }
  return models;
}

/** Normalize a resolution string to a lowercase token used in pricing keys.
 *  "1080p" -> "1080p", "4K" -> "4k", "1K" -> "1k". */
export function resolutionToken(res?: string | null): string {
  return (res || "").toLowerCase().trim();
}

/** Best-effort resolve of USD-per-second for a model at a given resolution +
 *  audio setting, from its heterogeneous pricing_skus. Returns null when the
 *  model is token-priced (e.g. Seedance) and no per-second key exists — callers
 *  treat null as "usage-based, typically pennies" rather than a hard cost. */
export function estimatePerSecondUSD(
  model: Pick<VideoModel, "pricing_skus">,
  opts: { resolution?: string | null; audio?: boolean } = {},
): number | null {
  const skus = model?.pricing_skus || {};
  const resTok = resolutionToken(opts.resolution);
  const audio = opts.audio;
  const RES_TOKENS = ["480p", "720p", "1080p", "1024p", "1k", "2k", "4k"];

  const entries = Object.entries(skus)
    .map(([k, v]) => [k, parseFloat(v)] as [string, number])
    .filter(([, v]) => Number.isFinite(v));

  // 1) Dollar-per-second keys (e.g. duration_seconds, duration_seconds_with_audio_720p).
  const durKeys = entries.filter(([k]) => /duration_second/i.test(k));
  const scoreDur = ([k]: [string, number]): number => {
    const kl = k.toLowerCase();
    let s = 0;
    if (resTok && kl.includes(resTok)) s += 3;
    // Penalize keys pinned to a DIFFERENT resolution than requested.
    if (resTok && RES_TOKENS.some((r) => kl.includes(r)) && !kl.includes(resTok)) s -= 4;
    if (audio === true && /with_audio/.test(kl)) s += 1;
    if (audio === false && /without_audio/.test(kl)) s += 1;
    if (audio === true && /without_audio/.test(kl)) s -= 1;
    if (/image_to_video/.test(kl)) s -= 1; // default is text-to-video
    return s;
  };
  if (durKeys.length) {
    durKeys.sort((a, b) => scoreDur(b) - scoreDur(a));
    return durKeys[0][1];
  }

  // 2) Cents-per-second keys (e.g. cents_per_video_output_second_720p).
  const centKeys = entries.filter(([k]) => /cents_per_video_output_second/i.test(k));
  if (centKeys.length) {
    const scoreCent = ([k]: [string, number]): number => {
      const kl = k.toLowerCase();
      let s = 0;
      if (resTok && kl.includes(resTok)) s += 3;
      if (resTok && RES_TOKENS.some((r) => kl.includes(r)) && !kl.includes(resTok)) s -= 4;
      return s;
    };
    centKeys.sort((a, b) => scoreCent(b) - scoreCent(a));
    return centKeys[0][1] / 100;
  }

  // 3) Token-priced (Seedance): can't estimate per-second without a token count.
  return null;
}

/** Estimated USD cost of a clip. null => usage-based (typically very cheap). */
export function estimateClipCostUSD(
  model: Pick<VideoModel, "pricing_skus">,
  opts: { duration: number; resolution?: string | null; audio?: boolean },
): number | null {
  const perSec = estimatePerSecondUSD(model, opts);
  if (perSec == null) return null;
  const dur = Math.max(1, Number(opts.duration) || 0);
  return perSec * dur;
}

/** True when a model is token-priced (e.g. Seedance's video_tokens) — it has no
 *  per-second key, so estimatePerSecondUSD legitimately returns null. Lets the
 *  cost guard tell a genuinely-cheap token-priced model apart from one whose
 *  per-second pricing shape we simply failed to recognize (which must confirm). */
export function isTokenPriced(model: Pick<VideoModel, "pricing_skus">): boolean {
  return Object.keys(model?.pricing_skus || {}).some((k) => /token/i.test(k));
}

export function formatUSD(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  return n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

/** Compact "≈ $0.48 for a 6s 720p clip" style estimate label. */
export function clipCostLabel(
  model: Pick<VideoModel, "pricing_skus"> | undefined,
  opts: { duration: number; resolution?: string | null; audio?: boolean },
): string {
  if (!model) return "";
  const est = estimateClipCostUSD(model, opts);
  const clip = `${opts.duration}s${opts.resolution ? ` ${opts.resolution}` : ""}`;
  if (est == null) return `usage-based (typically pennies) · ${clip}`;
  return `≈ ${formatUSD(est)} for a ${clip} clip`;
}
