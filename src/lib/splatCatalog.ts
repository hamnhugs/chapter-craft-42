import { formatUSD } from "@/lib/videoCatalog";

// 3D Gaussian splat models on fal.ai. Unlike OpenRouter (which publishes a live
// /models catalog), fal has no machine-readable catalog endpoint, so this list
// is static and hand-verified. Prices and output schemas were checked against
// the live model pages on 2026-07-24.
//
// The important thing about TripoSplat: its output field is called `model_mesh`
// but it contains a GAUSSIAN SPLAT (.ply/.splat), not a mesh. fal's Trellis
// models use the identical field name for a genuine GLB. Never dispatch on the
// field name — always branch on the format we requested and persisted.

export { formatUSD };

export type SplatFormat = "splat" | "ply" | "glb";
export type QualityTier = "fast" | "standard" | "high";

export const DEFAULT_SPLAT_MODEL = "tripo3d/triposplat";
export const FALLBACK_SPLAT_MODEL = "fal-ai/sam-3/3d-objects";

/** The antimatter15 `.splat` record is a fixed 32 bytes: 3xf32 position +
 *  3xf32 scale + 4xu8 colour + 4xu8 rotation. That makes file size exact
 *  arithmetic — the reason it's the default over PLY, whose spherical-harmonics
 *  degree is undocumented by both fal and the model repo. */
export const SPLAT_BYTES_PER_GAUSSIAN = 32;

export interface SplatModelInfo {
  id: string;
  label: string;
  /** Flat USD per generation (not per second, not per token). */
  price: number;
  formats: SplatFormat[];
  /** Whether the model exposes a `num_gaussians` dial (the only size lever). */
  supportsGaussianCount: boolean;
  latencyHint: string;
  note: string;
}

export const SPLAT_MODELS: SplatModelInfo[] = [
  {
    id: DEFAULT_SPLAT_MODEL,
    label: "TripoSplat",
    price: 0.05,
    formats: ["splat", "ply"],
    supportsGaussianCount: true,
    latencyHint: "~5s",
    note: "Image → Gaussian splat. MIT model, commercial use, tunable splat count.",
  },
  {
    id: FALLBACK_SPLAT_MODEL,
    label: "SAM 3D Objects",
    price: 0.02,
    formats: ["splat", "glb"],
    supportsGaussianCount: false,
    latencyHint: "unpublished",
    note: "Cheaper fallback. Returns a splat plus a GLB mesh; no splat-count control.",
  },
];

export interface QualityTierInfo {
  id: QualityTier;
  label: string;
  numGaussians: number;
  format: SplatFormat;
  /** Exact byte count, or null when the format's size can't be computed. */
  exactBytes: number | null;
  blurb: string;
}

export const QUALITY_TIERS: QualityTierInfo[] = [
  {
    id: "fast",
    label: "Fast",
    numGaussians: 65_536,
    format: "splat",
    exactBytes: 65_536 * SPLAT_BYTES_PER_GAUSSIAN,
    blurb: "Lightest — best on mobile.",
  },
  {
    id: "standard",
    label: "Standard",
    numGaussians: 131_072,
    format: "splat",
    exactBytes: 131_072 * SPLAT_BYTES_PER_GAUSSIAN,
    blurb: "Balanced detail and size.",
  },
  {
    id: "high",
    label: "High",
    numGaussians: 262_144,
    format: "ply",
    exactBytes: null, // PLY size depends on an undocumented SH degree
    blurb: "Most detail. PLY size is unpredictable — guarded by the size limit.",
  },
];

export const DEFAULT_QUALITY: QualityTier = "standard";

export function getSplatModel(id: string | undefined | null): SplatModelInfo | null {
  if (!id) return null;
  return SPLAT_MODELS.find((m) => m.id === id) || null;
}

export function getTier(id: string | undefined | null): QualityTierInfo {
  return QUALITY_TIERS.find((t) => t.id === id) || QUALITY_TIERS[1];
}

/** Exact bytes for a `.splat` of n gaussians. Null for any other format. */
export function exactSplatBytes(numGaussians: number, format: SplatFormat): number | null {
  if (format !== "splat") return null;
  if (!Number.isFinite(numGaussians) || numGaussians <= 0) return null;
  return Math.round(numGaussians) * SPLAT_BYTES_PER_GAUSSIAN;
}

/** Flat per-generation cost. Returns null when the model isn't in the catalog
 *  (callers treat null as "price unknown" and ask the user to confirm). */
export function estimateSplatCostUSD(modelId: string): number | null {
  const m = getSplatModel(modelId);
  return m ? m.price : null;
}

export function formatMB(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(2)} MB`;
}

/** Human label for a tier's resulting file, e.g. "4.19 MB" or "15–65 MB". */
export function tierSizeLabel(tier: QualityTierInfo): string {
  if (tier.exactBytes != null) return formatMB(tier.exactBytes);
  return "15–65 MB (varies)";
}

/** Best-effort sniff of what a downloaded blob actually is, used to catch the
 *  `model_mesh`-contains-a-splat trap before anything is stored. */
export function detectSplatFormat(head: Uint8Array, byteLength: number): SplatFormat | "unknown" {
  const ascii = (n: number) => String.fromCharCode(...head.slice(0, n));
  if (ascii(3) === "ply") return "ply";
  if (ascii(4) === "glTF") return "glb";
  // `.splat` has no magic bytes — it's a packed record array, so the only
  // available signal is that its length divides evenly into 32-byte records.
  if (byteLength > 0 && byteLength % SPLAT_BYTES_PER_GAUSSIAN === 0) return "splat";
  return "unknown";
}

export function mimeForFormat(format: SplatFormat): string {
  if (format === "glb") return "model/gltf-binary";
  return "application/octet-stream";
}

export function extForFormat(format: SplatFormat): string {
  return format === "glb" ? "glb" : format === "ply" ? "ply" : "splat";
}
