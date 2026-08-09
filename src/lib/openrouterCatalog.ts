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
  /** Request parameters OpenRouter accepts for this model, verbatim from
   *  GET /api/v1/models — e.g. ["max_tokens","response_format","stop",
   *  "temperature","tool_choice","tools"]. The presence of "tools" is the
   *  provider's own statement that the model can call functions. The field
   *  being ABSENT means the row predates this reading (or came from a cache
   *  written before it) and says nothing either way — never read a missing
   *  field as "no tools"; see cachedOrToolSupport below. */
  supported_parameters?: string[];
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
/** One cache bucket per query string, so the picker's category/sort tabs
 *  don't clobber each other. Shared with cachedOrToolSupport, which has to
 *  sweep EVERY bucket — the model a user chats with was usually added from
 *  one tab and asked about from somewhere else entirely. */
const CACHE_PREFIX = "or_catalog_";

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

  const cacheKey = `${CACHE_PREFIX}${params.toString()}`;
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
    // Whole rows, unmapped — every field the endpoint sent survives the
    // round trip, supported_parameters included. Anything that starts
    // projecting columns here silently blinds cachedOrToolSupport.
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data: models }));
  } catch { /* storage full — fine, just uncached */ }
  return models;
}

/** Does OpenRouter say this model takes a `tools` parameter?
 *
 *  Answers from catalog buckets ALREADY in localStorage and never fetches:
 *  this runs on the hot path of every turn, where a network round trip would
 *  either block the send or (worse) resolve after the request went out.
 *
 *  `null` means "nothing cached says anything about this model" — a cold
 *  cache, a model the picker never listed, or a bucket written before
 *  supported_parameters was read. It does NOT mean "no tools", and callers
 *  must fail open on it (see modelToolSupport in lib/modelCapabilities).
 *
 *  Bucket age is deliberately ignored. Whether a model can call functions is
 *  a stable property of the model, unlike price or availability, so an
 *  hour-old row is still the best evidence we have; honouring the TTL here
 *  would answer `null` for almost every turn and make the check inert.
 */
export function cachedOrToolSupport(modelId: string): boolean | null {
  if (!modelId) return null;
  // Routing suffixes ("author/slug:free", ":nitro", ":floor") choose which
  // upstream serves the SAME model, so the base row answers for them. Only
  // strip a suffix from something that already looks like author/slug, so a
  // provider-namespaced id can never be mangled into a base model.
  const base = /^(.+\/[^:]+):[^:/]+$/.exec(modelId)?.[1];
  let best: { t: number; hasTools: boolean } | null = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      let parsed: { t?: number; data?: unknown };
      try {
        parsed = JSON.parse(localStorage.getItem(key) || "null") || {};
      } catch { continue; /* one corrupt bucket must not blind the others */ }
      if (!Array.isArray(parsed.data)) continue;
      const row = (parsed.data as ORModel[]).find((m) => m?.id === modelId)
        ?? (base ? (parsed.data as ORModel[]).find((m) => m?.id === base) : undefined);
      if (!row || !Array.isArray(row.supported_parameters)) continue;
      const t = typeof parsed.t === "number" ? parsed.t : 0;
      if (!best || t > best.t) best = { t, hasTools: row.supported_parameters.includes("tools") };
    }
  } catch { return null; /* storage unavailable (private mode, SSR) */ }
  return best ? best.hasTools : null;
}
