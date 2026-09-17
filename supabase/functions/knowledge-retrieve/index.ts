// Graph-aware retrieval for chat synthesis.
//
// Request body (all optional except query):
//   {
//     query:       string                       required
//     wiki_ids?:   string[]                     loaded neurons — ONE call for N
//     wiki_id?:    string | null                legacy single scope (merged
//                                               into wiki_ids when both given)
//     limit?:      number                       max nodes returned
//                                               (default 18, deep 30, max 50)
//     match_count?: number                      hybrid-search seed pool
//                                               (default 12, deep 20)
//     depth?:      number                       graph walk hops (default 2,
//                                               deep 3, max 3)
//     deep?:       boolean
//   }
//   No wiki_ids and no wiki_id → search ALL of the user's entries (legacy).
//
// Response (backward compatible — only fields were added):
//   {
//     nodes: [{
//       id, title, content, entry_type, score,
//       similarity,        // raw query cosine, null when unknown   (new)
//       hop, via, from_seed,
//       vibrancy?, confidence?,
//       wiki_id?,          // owning wiki (v2 search)               (new)
//       ft_match?,         // seed also matched full text (v2)      (new)
//       locators?, aliases?, author?   // card pointer fields (v2)  (new)
//     }],
//     edges: [{ source_entry_id, target_entry_id, relationship, edge_class }],
//     query_embedded: boolean,
//     search: "v2" | "legacy",                                       (new)
//     scoped_wiki_ids: string[] | null,                              (new)
//     dropped: { seeds_below_cosine: number, below_relative_floor: number } (new)
//   }
//   Nodes are living entries only (superseded / archived / expired excluded)
//   on BOTH paths, so the client-side filterSupersededNodes pass is redundant
//   (harmless) against this deployment.
//
// Pipeline: embed once → hybrid_search_knowledge_v2 (scope + liveness inside
// the SQL, OR-semantics full text, raw cosine) → get_neighbors_v2 (bounded,
// scoped, cosine per neighbour) → fuseRetrieval (floors + salience blend,
// _shared/retrieval-rank.ts) → edges among the returned nodes. Falls back to
// the v1 RPCs + post-filters when migration 20260917130500 isn't applied.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedQuery, EMBEDDING_MODEL_ID } from "../_shared/embed.ts";
import { fuseRetrieval, normalizeWikiIds, type NeighborRow, type SeedRow } from "../_shared/retrieval-rank.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NEIGHBOR_ROW_CAP = 40;
const NEIGHBOR_CONTENT_CHARS = 600;

const isMissingRpc = (error: unknown) => {
  const code = (error as any)?.code;
  return code === "PGRST202" || code === "42883";
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const { query, depth = 2, match_count = 12, deep = false } = body ?? {};
    if (!query || typeof query !== "string") {
      return json({ error: "query (string) required" }, 400);
    }
    const wikiIds = normalizeWikiIds(body?.wiki_ids, body?.wiki_id);

    const clampInt = (v: unknown, lo: number, hi: number, dflt: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
    const limit = clampInt(body?.limit, 1, 50, deep ? 30 : 18);
    // With the scope applied inside the search, N loaded neurons share one
    // seed pool — widen it a little per extra neuron so each can contribute.
    const baseSeeds = deep ? 20 : clampInt(match_count, 1, 50, 12);
    const matchN = Math.min(50, baseSeeds + 4 * Math.max(0, (wikiIds?.length ?? 1) - 1));
    const walkDepth = deep ? 3 : clampInt(depth, 0, 3, 2);

    // 1. Embed query — once, whatever the number of wikis.
    const qVec = await embedQuery(query);

    // 2. Hybrid search, v2 first.
    let search: "v2" | "legacy" = "v2";
    let seeds: SeedRow[] = [];
    {
      const { data, error } = await supabase.rpc("hybrid_search_knowledge_v2", {
        query_text: query,
        query_embedding: (qVec as any) ?? null,
        match_count: matchN,
        filter_wiki_ids: wikiIds,
        active_embedding_model: EMBEDDING_MODEL_ID,
      });
      if (!error) {
        seeds = (data || []) as SeedRow[];
      } else if (isMissingRpc(error)) {
        search = "legacy";
      } else {
        console.error("hybrid_search_knowledge_v2 failed:", error.message);
        search = "legacy";
      }
    }
    if (search === "legacy") {
      seeds = await legacySeeds(supabase, user.id, query, qVec, matchN, wikiIds);
    }

    const emptyResponse = (dropped = 0) => json({
      nodes: [], edges: [], query_embedded: !!qVec, search, scoped_wiki_ids: wikiIds,
      dropped: { seeds_below_cosine: dropped, below_relative_floor: 0 },
    });
    if (seeds.length === 0) return emptyResponse();

    // 3. Graph expansion — structural edges, bounded. Only seeds that clear the
    //    cosine floor are walked from (a dropped seed's neighbours would enter
    //    through the back door).
    const walkable = seeds.filter((s) => s.similarity == null || s.similarity >= 0.30 || s.ft_match === true);
    let neighbors: NeighborRow[] = [];
    if (walkable.length > 0 && walkDepth > 0) {
      const seedIds = walkable.map((s) => s.id);
      if (search === "v2") {
        const { data, error } = await supabase.rpc("get_neighbors_v2", {
          seed_ids: seedIds,
          depth: walkDepth,
          classes: ["structural"],
          filter_wiki_ids: wikiIds,
          max_rows: NEIGHBOR_ROW_CAP,
          content_chars: NEIGHBOR_CONTENT_CHARS,
          query_embedding: (qVec as any) ?? null,
        });
        if (error) console.warn("get_neighbors_v2 failed:", error.message);
        neighbors = (data || []) as NeighborRow[];
      } else {
        neighbors = await legacyNeighbors(supabase, seedIds, walkDepth, wikiIds);
      }
    }

    // 4. Fuse: floors, graph boost, salience blend, cut to limit.
    const fused = fuseRetrieval(seeds, neighbors, { limit });
    if (fused.nodes.length === 0) return emptyResponse(fused.dropped_seeds);

    // 5. Edges among the returned nodes, for context.
    const ids = fused.nodes.map((n) => n.id);
    const { data: edgeRows } = await supabase
      .from("memory_graph")
      .select("source_entry_id, target_entry_id, relationship, edge_class")
      .eq("user_id", user.id)
      .in("source_entry_id", ids)
      .in("target_entry_id", ids);

    // No retrieval-stat bump here any more. Touching every INJECTED card was a
    // popularity loop: injection raised vibrancy/recency → the vibrancy
    // multiplier ranked the card higher → it was injected again. Use is now
    // counted on deliberate dereference (read_span → touch_node_retrievals).

    return json({
      nodes: fused.nodes,
      edges: edgeRows || [],
      query_embedded: !!qVec,
      search,
      scoped_wiki_ids: wikiIds,
      dropped: { seeds_below_cosine: fused.dropped_seeds, below_relative_floor: fused.dropped_below_floor },
    });
  } catch (e) {
    console.error("knowledge-retrieve error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// ── Legacy path (migration 20260917130500 not applied) ──────────────────────
// v1 hybrid search is global, so scope + liveness are post-filters, and meta
// (vibrancy/confidence/wiki) comes from one extra batched select. No cosine is
// available, so only the relative floor applies.

async function allowedIds(supabase: any, ids: string[], wikiIds: string[] | null): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (ids.length === 0) return out;
  const cols = "id, wiki_id, vibrancy, confidence, superseded_by, archived, valid_to";
  let { data, error } = await supabase.from("knowledge_entries").select(cols).in("id", ids);
  if (error && (error as any).code === "42703") {
    ({ data, error } = await supabase.from("knowledge_entries").select("id, wiki_id, vibrancy, confidence").in("id", ids));
  }
  if (error) return out;
  let bridged = new Set<string>();
  if (wikiIds) {
    const { data: b } = await supabase.from("entry_bridges").select("entry_id").in("wiki_id", wikiIds).in("entry_id", ids);
    bridged = new Set(((b || []) as any[]).map((r) => r.entry_id));
  }
  const nowMs = Date.now();
  for (const r of (data || []) as any[]) {
    if (r.superseded_by || r.archived === true) continue;
    if (r.valid_to && new Date(r.valid_to).getTime() <= nowMs) continue;
    if (wikiIds && r.wiki_id && !wikiIds.includes(r.wiki_id) && !bridged.has(r.id)) continue;
    out.set(r.id, r);
  }
  return out;
}

async function legacySeeds(
  supabase: any,
  userId: string,
  query: string,
  qVec: number[] | null,
  matchN: number,
  wikiIds: string[] | null,
): Promise<SeedRow[]> {
  // Over-fetch: the scope filter below runs AFTER the global top-N.
  const pool = wikiIds ? Math.min(50, matchN * 2) : matchN;
  let rows: any[] = [];
  if (qVec) {
    const { data, error } = await supabase.rpc("hybrid_search_knowledge", {
      query_text: query,
      query_embedding: qVec as any,
      match_count: pool,
    });
    if (!error && data) rows = data;
  }
  if (rows.length === 0) {
    const { data } = await supabase
      .from("knowledge_entries")
      .select("id, title, content, entry_type, tags, source_book_id")
      .eq("user_id", userId)
      .textSearch("tsv", query, { type: "websearch", config: "english" })
      .limit(pool);
    rows = (data || []).map((r: any, i: number) => ({ ...r, score: 1 / (50 + i) }));
  }
  const meta = await allowedIds(supabase, rows.map((r) => r.id), wikiIds);
  return rows
    .filter((r) => meta.has(r.id))
    .slice(0, matchN)
    .map((r) => ({
      ...r,
      similarity: null,
      wiki_id: meta.get(r.id)?.wiki_id ?? null,
      vibrancy: meta.get(r.id)?.vibrancy,
      confidence: meta.get(r.id)?.confidence,
    }));
}

async function legacyNeighbors(
  supabase: any,
  seedIds: string[],
  depth: number,
  wikiIds: string[] | null,
): Promise<NeighborRow[]> {
  const { data } = await supabase.rpc("get_neighbors", { seed_ids: seedIds, depth, classes: ["structural"] });
  const rows = ((data || []) as any[]).filter((n) => n.hop > 0).slice(0, NEIGHBOR_ROW_CAP * 2);
  const meta = await allowedIds(supabase, rows.map((n) => n.entry_id), wikiIds);
  return rows
    .filter((n) => meta.has(n.entry_id))
    .sort((a, b) => a.hop - b.hop)
    .slice(0, NEIGHBOR_ROW_CAP)
    .map((n) => ({
      ...n,
      content: (n.content || "").slice(0, NEIGHBOR_CONTENT_CHARS),
      similarity: null,
      wiki_id: meta.get(n.entry_id)?.wiki_id ?? null,
      vibrancy: meta.get(n.entry_id)?.vibrancy,
      confidence: meta.get(n.entry_id)?.confidence,
    }));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
