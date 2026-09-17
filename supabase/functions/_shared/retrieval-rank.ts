// Pure ranking for knowledge-retrieve: fuse hybrid-search seeds with graph
// neighbours, apply the relevance floors, blend in salience, cut to `limit`.
// No Deno/network references so the vitest suite can import it directly
// (src/test/retrievalRank.test.ts).
//
// Scoring (all nodes end up on one scale before the salience blend):
//   seed          0.7 · rrf_score / best_rrf_score
//   seed that is also a neighbour   + 0.3 / (hop + 1)
//   neighbour-only 0.3 / (hop + 1) + 0.4 · max(0, cosine_to_query)
//                 (legacy search path without cosine: 0.3 / (hop + 1))
//   × (0.55 + 0.3 · vibrancy + 0.15 · confidence)   Park et al. 2023 blend;
//                 the factor spans [0.55, 1.0] so it re-ranks, never zeroes.
//
// Floors (the old pipeline returned the top 18 no matter how weak):
//   • a seed whose cosine < cosineFloor is dropped unless it ALSO matched full
//     text (a keyword hit on an unembedded or oddly-phrased card is still real
//     evidence). Seeds with no cosine at all (query not embedded / legacy RPC)
//     are kept — there is nothing to judge them by.
//   • any node scoring < relativeFloor × the top score is dropped — including
//     neighbours, which therefore only take a slot when they are relevant to
//     the query, not merely adjacent to something that is.

export interface SeedRow {
  id: string;
  title: string;
  content: string;
  entry_type?: string | null;
  score?: number | null;
  similarity?: number | null;
  ft_match?: boolean | null;
  wiki_id?: string | null;
  vibrancy?: number | null;
  confidence?: number | null;
  locators?: unknown;
  aliases?: string[] | null;
  author?: string | null;
}

export interface NeighborRow {
  entry_id: string;
  title: string;
  content: string;
  hop: number;
  via_relationship?: string | null;
  from_seed?: string | null;
  similarity?: number | null;
  entry_type?: string | null;
  wiki_id?: string | null;
  vibrancy?: number | null;
  confidence?: number | null;
}

export interface RankedNode {
  id: string;
  title: string;
  content: string;
  entry_type: string | null;
  score: number;
  /** Raw cosine between the query and this entry; null when unknown. */
  similarity: number | null;
  hop: number;
  via: string | null;
  from_seed: string | null;
  vibrancy?: number;
  confidence?: number;
  wiki_id?: string | null;
  ft_match?: boolean;
  locators?: unknown;
  aliases?: string[] | null;
  author?: string | null;
}

export interface FuseOptions {
  limit: number;
  cosineFloor?: number;
  relativeFloor?: number;
}

export const DEFAULT_COSINE_FLOOR = 0.30;
export const DEFAULT_RELATIVE_FLOOR = 0.35;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Seeds that clear the absolute cosine floor (see header). */
export function applySeedFloor<T extends SeedRow>(seeds: T[], cosineFloor = DEFAULT_COSINE_FLOOR): T[] {
  return seeds.filter((s) => {
    const sim = num(s.similarity);
    if (sim === null) return true;
    return sim >= cosineFloor || s.ft_match === true;
  });
}

export function fuseRetrieval(
  seedsIn: SeedRow[],
  neighbors: NeighborRow[],
  opts: FuseOptions,
): { nodes: RankedNode[]; dropped_seeds: number; dropped_below_floor: number } {
  const relFloor = opts.relativeFloor ?? DEFAULT_RELATIVE_FLOOR;
  const seeds = applySeedFloor(seedsIn, opts.cosineFloor ?? DEFAULT_COSINE_FLOOR);
  const droppedSeeds = seedsIn.length - seeds.length;
  if (seeds.length === 0) return { nodes: [], dropped_seeds: droppedSeeds, dropped_below_floor: 0 };

  const maxSeed = Math.max(...seeds.map((s) => num(s.score) ?? 0), 1e-9);
  const map = new Map<string, RankedNode>();
  for (const s of seeds) {
    map.set(s.id, {
      id: s.id,
      title: s.title,
      content: s.content,
      entry_type: s.entry_type ?? null,
      score: ((num(s.score) ?? 0) / maxSeed) * 0.7,
      similarity: num(s.similarity),
      hop: 0,
      via: null,
      from_seed: s.id,
      ...(num(s.vibrancy) !== null ? { vibrancy: num(s.vibrancy)! } : {}),
      ...(num(s.confidence) !== null ? { confidence: num(s.confidence)! } : {}),
      ...(s.wiki_id !== undefined ? { wiki_id: s.wiki_id } : {}),
      ...(typeof s.ft_match === "boolean" ? { ft_match: s.ft_match } : {}),
      ...(s.locators != null ? { locators: s.locators } : {}),
      ...(Array.isArray(s.aliases) && s.aliases.length > 0 ? { aliases: s.aliases } : {}),
      ...(typeof s.author === "string" ? { author: s.author } : {}),
    });
  }

  const seen = new Set<string>();
  for (const n of neighbors) {
    if (!n || n.hop <= 0 || seen.has(n.entry_id)) continue;
    seen.add(n.entry_id);
    const graph = 0.3 / (n.hop + 1);
    const existing = map.get(n.entry_id);
    if (existing) {
      existing.score += graph;
      continue;
    }
    const sim = num(n.similarity);
    map.set(n.entry_id, {
      id: n.entry_id,
      title: n.title,
      content: n.content,
      entry_type: n.entry_type ?? null,
      score: graph + 0.4 * Math.max(0, sim ?? 0),
      similarity: sim,
      hop: n.hop,
      via: n.via_relationship ?? null,
      from_seed: n.from_seed ?? null,
      ...(num(n.vibrancy) !== null ? { vibrancy: num(n.vibrancy)! } : {}),
      ...(num(n.confidence) !== null ? { confidence: num(n.confidence)! } : {}),
      ...(n.wiki_id !== undefined ? { wiki_id: n.wiki_id } : {}),
    });
  }

  for (const node of map.values()) {
    const vib = node.vibrancy ?? 0.5;
    const conf = node.confidence ?? 0.8;
    node.score = node.score * (0.55 + 0.3 * vib + 0.15 * conf);
  }

  const sorted = [...map.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = sorted[0]?.score ?? 0;
  const kept = sorted.filter((n) => n.score >= relFloor * top);
  return {
    nodes: kept.slice(0, Math.max(1, opts.limit)),
    dropped_seeds: droppedSeeds,
    dropped_below_floor: sorted.length - kept.length,
  };
}

/** Normalize the request's wiki scope: `wiki_ids` (preferred) ∪ legacy `wiki_id`.
 *  Returns null for "no scope" (all entries). Invalid ids are dropped. */
export function normalizeWikiIds(wikiIds: unknown, wikiId: unknown): string[] | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && uuid.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  };
  if (Array.isArray(wikiIds)) wikiIds.forEach(push);
  push(wikiId);
  return out.length > 0 ? out : null;
}
