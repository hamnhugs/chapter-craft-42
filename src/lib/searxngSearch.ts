// SearXNG — the local edition's web search. A metasearch engine running in a
// container on this machine (docker-compose.local.yml), reached through the
// same-origin /local/searxng proxy. No key, no quota, no account: the query
// leaves this computer only as ordinary searches to the engines SearXNG asks.
//
// SearXNG returns ranked results, not a written answer, so `answer` is the top
// snippets with their sources — the model writes the prose, as it already does
// for Tavily's short answers.

import type { SearchHit } from "@/lib/tavilySearch";

const SEARXNG = "/local/searxng/search";

/** Served by the local dev/preview server — the only place the proxy exists. */
export function localSearchAvailable(): boolean {
  return typeof window !== "undefined" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);
}

export async function searxngSearch(
  query: string,
  opts: { maxResults?: number; signal?: AbortSignal } = {},
): Promise<{ answer: string; citations: SearchHit[] }> {
  const params = new URLSearchParams({ q: query.slice(0, 400), format: "json", safesearch: "1" });
  let res: Response;
  try {
    res = await fetch(`${SEARXNG}?${params}`, { signal: opts.signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error("Local search isn't running — start it with scripts/local-up.sh.");
  }
  if (!res.ok) throw new Error(`Local search failed (${res.status}).`);
  const j = await res.json();
  const max = Math.min(10, Math.max(1, opts.maxResults ?? 6));
  const citations: SearchHit[] = (Array.isArray(j?.results) ? j.results : [])
    .filter((r: any) => typeof r?.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, max)
    .map((r: any) => ({ title: String(r.title || "").slice(0, 200), url: r.url, snippet: String(r.content || "").slice(0, 500) }));
  const direct = [...(Array.isArray(j?.answers) ? j.answers : []), ...(Array.isArray(j?.infoboxes) ? j.infoboxes.map((b: any) => b?.content) : [])]
    .map((a: any) => (typeof a === "string" ? a : a?.answer))
    .filter((a: unknown): a is string => typeof a === "string" && a.trim().length > 0);
  const answer = [
    ...direct.slice(0, 2),
    ...citations.map((c, i) => `[${i + 1}] ${c.title}: ${c.snippet}`),
  ].join("\n").slice(0, 8000);
  if (!answer) throw new Error(`No results for "${query.slice(0, 60)}".`);
  return { answer, citations };
}
