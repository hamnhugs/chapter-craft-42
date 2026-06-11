// Live OpenRouter model catalog. The public models endpoint needs no API key,
// allows browser CORS (Access-Control-Allow-Origin: *), and supports
// server-side ranking — `?category=programming&sort=top-weekly` returns the
// top 20 models by weekly usage in that category, the same data behind
// openrouter.ai/rankings. Responses are cached in localStorage for an hour
// (the catalog only changes a few times a week).

export interface ORModel {
  id: string;
  name: string;
  description: string;
  created: number; // unix seconds
  context_length: number;
  pricing: { prompt: string; completion: string }; // USD per token, as strings
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

// Official `category` enum on GET /api/v1/models.
export const OR_CATEGORIES = [
  "programming",
  "roleplay",
  "marketing",
  "marketing/seo",
  "technology",
  "science",
  "translation",
  "legal",
  "finance",
  "health",
  "trivia",
  "academia",
] as const;

export type ORSort = "top-weekly" | "newest" | "most-popular" | "pricing-low-to-high";

const CACHE_TTL_MS = 60 * 60 * 1000;

export function isFreeModel(m: ORModel): boolean {
  return m.pricing?.prompt === "0" && m.pricing?.completion === "0";
}

/** "0.000003" USD/token → "$3.00" per million tokens. */
export function pricePerMillion(perToken: string): string {
  const n = parseFloat(perToken || "0") * 1_000_000;
  if (n === 0) return "Free";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatContext(len: number): string {
  if (!len) return "—";
  return len >= 1_000_000 ? `${(len / 1_000_000).toFixed(1)}M` : `${Math.round(len / 1000)}K`;
}

export async function fetchCatalog(opts: { category?: string; sort?: ORSort } = {}): Promise<ORModel[]> {
  const params = new URLSearchParams();
  if (opts.category) params.set("category", opts.category);
  params.set("sort", opts.sort || "top-weekly");
  const url = `https://openrouter.ai/api/v1/models?${params.toString()}`;

  const cacheKey = `or_catalog_${params.toString()}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const { t, data } = JSON.parse(cached);
      if (Date.now() - t < CACHE_TTL_MS && Array.isArray(data)) return data as ORModel[];
    }
  } catch { /* corrupt cache — refetch */ }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenRouter catalog request failed (${res.status})`);
  const json = await res.json();
  const models = (json?.data || []) as ORModel[];
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data: models }));
  } catch { /* storage full — fine, just uncached */ }
  return models;
}
