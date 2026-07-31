// Gemini model catalog: curated metadata + live list.
//
// Unlike NVIDIA, Google's models.list IS reachable from the browser and does
// carry useful metadata (displayName, description, inputTokenLimit,
// supportedGenerationMethods). We still curate a featured set, because the
// raw list includes embedding models, legacy versions, and specialist
// variants that would only confuse a chat picker.

import { GEMINI_NATIVE_BASE } from "@/lib/providers/geminiAdapter";
import { GEMINI_PREFIX } from "@/lib/providers/registry";

export interface GeminiModelInfo {
  /** Provider-local id, e.g. "gemini-2.5-flash" (no "models/" prefix). */
  localId: string;
  label: string;
  contextLength?: number;
  caps: { tools: boolean; vision: boolean; reasoning: boolean; images: boolean };
  featured?: boolean;
  /** True when Google's free tier can run it. Image models generally cannot. */
  freeTier: boolean;
  note?: string;
}

export const GEMINI_FEATURED: GeminiModelInfo[] = [
  {
    localId: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    contextLength: 1_048_576,
    caps: { tools: true, vision: true, reasoning: true, images: false },
    featured: true,
    freeTier: true,
    note: "The free daily driver — fast, 1M context, tools and vision. Best first pick.",
  },
  {
    localId: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    contextLength: 1_048_576,
    caps: { tools: true, vision: true, reasoning: true, images: false },
    featured: true,
    freeTier: true,
    note: "Strongest reasoning. Tighter free limits than Flash.",
  },
  {
    localId: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    contextLength: 1_048_576,
    caps: { tools: true, vision: true, reasoning: false, images: false },
    featured: true,
    freeTier: true,
    note: "Cheapest and quickest — good for voice replies.",
  },
  {
    localId: "gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image",
    caps: { tools: false, vision: true, reasoning: false, images: true },
    featured: true,
    freeTier: false,
    note: "Image generation and editing. Needs billing enabled — not available on the free tier.",
  },
];

const FEATURED_BY_ID = new Map(GEMINI_FEATURED.map((m) => [m.localId, m]));

/** Auto-selected when someone onboards with only a Gemini key. */
export const GEMINI_STARTER_MODEL = "gemini-2.5-flash";

const HIDE = [
  /embedding|aqa|text-bison|chat-bison|gemini-1\.0|gemini-pro-vision/i,
  /-tts$|-native-audio|-live-/i, // realtime/audio surfaces this app doesn't use
];

export function isChatworthyGeminiModel(localId: string): boolean {
  if (FEATURED_BY_ID.has(localId)) return true;
  return !HIDE.some((re) => re.test(localId));
}

export function geminiModelInfo(id: string): GeminiModelInfo {
  const localId = id.startsWith(GEMINI_PREFIX) ? id.slice(GEMINI_PREFIX.length) : id;
  const curated = FEATURED_BY_ID.get(localId);
  if (curated) return curated;
  const s = localId.toLowerCase();
  const images = /image/.test(s);
  return {
    localId,
    label: localId,
    caps: {
      tools: !images,
      vision: true,
      reasoning: /2\.5|3|thinking/.test(s),
      images,
    },
    // Conservative: assume an uncurated model might need billing.
    freeTier: !images,
  };
}

export function namespacedGeminiId(localId: string): string {
  return `${GEMINI_PREFIX}${localId}`;
}

const CACHE_PREFIX = "gemini_catalog_v1";
/** Non-reversible 32-bit FNV-1a: identifies WHICH key cached the list without
 *  storing any part of it, so switching keys or users can't serve stale rows. */
function cacheKeyFor(apiKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < apiKey.length; i++) {
    h ^= apiKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${CACHE_PREFIX}_${h.toString(36)}`;
}
const TTL_MS = 60 * 60 * 1000;

/** Live model list, browser-direct (no relay). Requires the user's key
 *  because models.list is authenticated. */
export async function fetchGeminiCatalog(apiKey: string): Promise<GeminiModelInfo[]> {
  if (!apiKey) throw new Error("Add your Gemini API key in Settings to browse Google's models.");
  let rows: Array<{ name?: string; displayName?: string; description?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> | null = null;
  try {
    const cached = localStorage.getItem(cacheKeyFor(apiKey));
    if (cached) {
      const { t, data } = JSON.parse(cached);
      if (Date.now() - t < TTL_MS && Array.isArray(data)) rows = data;
    }
  } catch { /* corrupt cache — refetch */ }

  if (!rows) {
    const res = await fetch(`${GEMINI_NATIVE_BASE}/models?pageSize=200`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let msg = `Gemini catalog request failed (${res.status})`;
      try { msg = JSON.parse(raw)?.error?.message || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    rows = ((await res.json())?.models || []) as typeof rows;
    try { localStorage.setItem(cacheKeyFor(apiKey), JSON.stringify({ t: Date.now(), data: rows })); } catch { /* full */ }
  }

  const live = (rows || [])
    .map((m) => ({
      localId: String(m.name || "").replace(/^models\//, ""),
      displayName: m.displayName,
      inputTokenLimit: m.inputTokenLimit,
      methods: m.supportedGenerationMethods || [],
    }))
    .filter((m) => m.localId && m.methods.some((x) => /generateContent/i.test(x)));

  const featured = GEMINI_FEATURED.filter(
    (f) => live.length === 0 || live.some((l) => l.localId === f.localId),
  );
  const rest = live
    .filter((l) => !FEATURED_BY_ID.has(l.localId) && isChatworthyGeminiModel(l.localId))
    .sort((a, b) => a.localId.localeCompare(b.localId))
    .map((l) => {
      const info = geminiModelInfo(l.localId);
      return {
        ...info,
        label: l.displayName || info.label,
        contextLength: l.inputTokenLimit ?? info.contextLength,
      };
    });
  return [...featured, ...rest];
}
