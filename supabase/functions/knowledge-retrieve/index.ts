// Graph-aware retrieval for chat synthesis.
// Body: { query: string, depth?: number, match_count?: number, book_id?: string|null, deep?: boolean }
// Returns: { nodes: [{id,title,content,entry_type,score,from_seed,hop,via}], edges: [...] }
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedQuery } from "../_shared/embed.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

    const { query, depth = 2, match_count = 12, deep = false, wiki_id = null } = await req.json();
    if (!query || typeof query !== "string") {
      return json({ error: "query (string) required" }, 400);
    }

    const matchN = deep ? 20 : match_count;
    const walkDepth = deep ? 3 : depth;

    // 1. Embed query
    const qVec = await embedQuery(query);

    // 2. Hybrid search (graceful fallback to FTS-only if embedding failed)
    let seeds: any[] = [];
    if (qVec) {
      const { data, error } = await supabase.rpc("hybrid_search_knowledge", {
        query_text: query,
        query_embedding: qVec as any,
        match_count: matchN,
      });
      if (!error && data) seeds = data;
    }

    // Fallback: keyword-only if hybrid failed or embedding missing
    if (seeds.length === 0) {
      const { data } = await supabase
        .from("knowledge_entries")
        .select("id, title, content, entry_type, tags, source_book_id")
        .eq("user_id", user.id)
        .textSearch("tsv", query, { type: "websearch", config: "english" })
        .limit(matchN);
      seeds = (data || []).map((r: any, i: number) => ({ ...r, score: 1 / (50 + i) }));
    }

    // 2b. Wiki scoping: keep only entries native to or bridged into the active wiki.
    // wiki_id === null preserves legacy all-entries behavior.
    if (wiki_id && seeds.length > 0) {
      const ids = seeds.map((s: any) => s.id);
      const { data: scoped } = await supabase
        .from("knowledge_entries")
        .select("id, wiki_id")
        .in("id", ids)
        .or(`wiki_id.eq.${wiki_id},wiki_id.is.null`);
      const allowed = new Set((scoped || []).map((r: any) => r.id));
      const { data: bridged } = await supabase
        .from("entry_bridges")
        .select("entry_id")
        .eq("wiki_id", wiki_id)
        .in("entry_id", ids);
      for (const b of (bridged || []) as any[]) allowed.add(b.entry_id);
      seeds = seeds.filter((s: any) => allowed.has(s.id));
    }

    if (seeds.length === 0) {
      return json({ nodes: [], edges: [] });
    }

    const seedIds = seeds.map((s: any) => s.id);

    // 3. Graph expansion — prefer structural edges
    const { data: neighborsRaw } = await supabase.rpc("get_neighbors", {
      seed_ids: seedIds,
      depth: walkDepth,
      classes: ["structural"],
    });
    const neighbors = neighborsRaw || [];

    // 3b. Wiki scoping for neighbors
    let allowedNeighborIds: Set<string> | null = null;
    if (wiki_id && neighbors.length > 0) {
      const nIds = (neighbors as any[]).map((n: any) => n.entry_id);
      const { data: scoped } = await supabase
        .from("knowledge_entries")
        .select("id, wiki_id")
        .in("id", nIds)
        .or(`wiki_id.eq.${wiki_id},wiki_id.is.null`);
      allowedNeighborIds = new Set((scoped || []).map((r: any) => r.id));
      const { data: bridged } = await supabase
        .from("entry_bridges")
        .select("entry_id")
        .eq("wiki_id", wiki_id)
        .in("entry_id", nIds);
      for (const b of (bridged || []) as any[]) allowedNeighborIds.add(b.entry_id);
    }

    // 4. Build node map, applying graph boost
    const nodeMap = new Map<string, any>();
    for (const s of seeds) {
      nodeMap.set(s.id, {
        id: s.id,
        title: s.title,
        content: s.content,
        entry_type: s.entry_type,
        score: (s.score ?? 0) * 0.7,
        hop: 0,
        via: null,
        from_seed: s.id,
      });
    }
    for (const n of neighbors as any[]) {
      if (n.hop === 0) continue; // already a seed
      if (allowedNeighborIds && !allowedNeighborIds.has(n.entry_id)) continue;
      const existing = nodeMap.get(n.entry_id);
      const boost = 0.3 / (n.hop + 1);
      if (existing) {
        existing.score += boost;
      } else {
        nodeMap.set(n.entry_id, {
          id: n.entry_id,
          title: n.title,
          content: n.content,
          entry_type: null,
          score: boost,
          hop: n.hop,
          via: n.via_relationship,
          from_seed: n.from_seed,
        });
      }
    }

    // 5. Fetch all edges among the selected nodes for context
    const ids = Array.from(nodeMap.keys());
    let edges: any[] = [];
    if (ids.length > 0) {
      const { data: edgeRows } = await supabase
        .from("memory_graph")
        .select("source_entry_id, target_entry_id, relationship, edge_class")
        .eq("user_id", user.id)
        .in("source_entry_id", ids)
        .in("target_entry_id", ids);
      edges = edgeRows || [];
    }

    const nodes = Array.from(nodeMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, deep ? 30 : 18);

    // Bump retrieval stats (vibrancy boost + retrieval_count) for returned nodes.
    // Fire-and-forget: don't await — don't block the response.
    const returnedIds = nodes.map((n) => n.id);
    if (returnedIds.length > 0) {
      Promise.resolve(supabase.rpc("touch_node_retrievals", { node_ids: returnedIds })).catch(() => {});
    }

    return json({ nodes, edges, query_embedded: !!qVec });
  } catch (e) {
    console.error("knowledge-retrieve error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
