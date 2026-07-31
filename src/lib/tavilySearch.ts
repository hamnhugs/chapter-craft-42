// Tavily — the free web-search backend.
//
// WHY TAVILY AND NOT GEMINI GROUNDING. Google's Search grounding is free on
// Gemini 2.5 Flash, but it cannot serve as this app's `web_search` tool for
// two verified reasons: (1) it is not exposed on Gemini's OpenAI-compatible
// surface at all (schema-probed: the field is rejected as unknown), so it
// would need a whole second native code path; and (2) Google's API terms
// forbid extracting grounded results for another purpose or interspersing
// them with other content — which is exactly what "search on Gemini, answer
// on NVIDIA" would be. Tavily has no such constraint and works with every
// chat provider.
//
// Free tier: 1,000 credits/month, no credit card. A basic search is 1
// credit. The API is CORS-open, so this runs browser-direct with the user's
// own key — the same posture as the existing Burplexity and fal keys.

const TAVILY_URL = "https://api.tavily.com/search";

export interface SearchHit {
  title?: string;
  url: string;
  snippet?: string;
}

export interface SearchAnswer {
  answer: string;
  citations: SearchHit[];
  /** Which backend served this — surfaced so a silent fallback is visible. */
  provider: "tavily";
}

export function looksLikeTavilyKey(key: string): boolean {
  return /^tvly-/.test(key.trim());
}

/** One web search. Throws with user-facing copy on failure. */
export async function tavilySearch(
  apiKey: string,
  query: string,
  opts: { maxResults?: number; signal?: AbortSignal } = {},
): Promise<SearchAnswer> {
  const key = (apiKey || "").trim();
  if (!key) throw new Error("No Tavily key saved — add one in Settings → Research & Web Search.");

  let res: Response;
  try {
    res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: query.slice(0, 400),
        // "basic" costs 1 credit; "advanced" costs 2. Free tier is 1,000
        // credits/month, so basic doubles how far the allowance goes.
        search_depth: "basic",
        include_answer: true,
        max_results: Math.min(10, Math.max(1, opts.maxResults ?? 5)),
      }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error("Couldn't reach Tavily — check your connection.");
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw.slice(0, 300);
    try { detail = JSON.parse(raw)?.detail?.error || JSON.parse(raw)?.error || detail; } catch { /* raw */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Tavily rejected your key — check it in Settings (keys start with tvly-).");
    }
    if (res.status === 429) {
      throw new Error("Tavily's free monthly searches are used up. They reset next month, or add a Burplexity token for more.");
    }
    throw new Error(`Tavily search failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const citations: SearchHit[] = (Array.isArray(data?.results) ? data.results : [])
    .map((r: any) => ({
      title: typeof r?.title === "string" ? r.title : undefined,
      url: String(r?.url || ""),
      snippet: typeof r?.content === "string" ? r.content.slice(0, 400) : undefined,
    }))
    .filter((r: SearchHit) => r.url);

  const answer = String(data?.answer || "").trim()
    || citations.map((c, i) => `${i + 1}. ${c.title || c.url}: ${c.snippet || ""}`).join("\n")
    || "No results found.";

  return { answer, citations, provider: "tavily" };
}
