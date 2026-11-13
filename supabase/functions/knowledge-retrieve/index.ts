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
//     route_prompts?:    boolean               score the user's saved prompts
//                                              against THIS query            (new)
//     active_prompt_id?: string | null         the prompt in force right now (new)
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
//     search: "v2",
//     scoped_wiki_ids: string[] | null,                              (new)
//     dropped: { seeds_below_cosine: number, below_relative_floor: number } (new)
//     routing?: {                                                           (new)
//       candidates: [{ id, name, similarity }],   best first, max 5
//       active_similarity: number | null,         null = none in force
//       top_memory_score: number | null,          drives the plain-voice guard
//     } | null       // null = routing off, migration unapplied, or no
//                    // routing-enabled prompts. NEVER an error to the caller.
//   }
//   Nodes are living entries only (superseded / archived / expired excluded).
//
// Pipeline: embed once → hybrid_search_knowledge_v2 (scope + liveness inside
// the SQL, OR-semantics full text, raw cosine) → get_neighbors_v2 (bounded,
// scoped, cosine per neighbour) → fuseRetrieval (floors + salience blend,
// _shared/retrieval-rank.ts) → edges among the returned nodes.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedBatch, embedQuery, EMBEDDING_MODEL_ID } from "../_shared/embed.ts";
import { fuseRetrieval, normalizeWikiIds, type NeighborRow, type SeedRow } from "../_shared/retrieval-rank.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NEIGHBOR_ROW_CAP = 40;
const NEIGHBOR_CONTENT_CHARS = 600;

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

    // 2. Hybrid search (scope + liveness inside the SQL).
    const search = "v2" as const;
    let seeds: SeedRow[] = [];
    {
      const { data, error } = await supabase.rpc("hybrid_search_knowledge_v2", {
        query_text: query,
        query_embedding: (qVec as any) ?? null,
        match_count: matchN,
        filter_wiki_ids: wikiIds,
        active_embedding_model: EMBEDDING_MODEL_ID,
      });
      if (error) {
        console.error("hybrid_search_knowledge_v2 failed:", error.message);
        return json({ error: error.message }, 500);
      }
      seeds = (data || []) as SeedRow[];
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

    // Prompt routing rides on the vector we already paid for. Deliberately
    // LAST and deliberately best-effort: retrieval is the caller's actual
    // errand, and a routing hiccup must never cost them their memories.
    const routing = body?.route_prompts
      ? await routePrompts(supabase, qVec, body?.active_prompt_id ?? null, fused.nodes).catch((e) => {
        console.error("routePrompts failed (ignored):", e);
        return null;
      })
      : null;

    return json({
      nodes: fused.nodes,
      edges: edgeRows || [],
      query_embedded: !!qVec,
      search,
      scoped_wiki_ids: wikiIds,
      dropped: { seeds_below_cosine: fused.dropped_seeds, below_relative_floor: fused.dropped_below_floor },
      routing,
    });
  } catch (e) {
    console.error("knowledge-retrieve error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// ── Prompt routing ──────────────────────────────────────────────────────────
//
// WHY THIS LIVES HERE. Scoring the user's saved prompts against their turn
// needs exactly one thing: an embedding of that turn. This function already
// computed one. Doing the match anywhere else would mean paying for a second
// embedding of the same words on every single message, which is the difference
// between routing being free and routing being a line on a bill.
//
// It returns DATA, never a decision. Which prompt (if any) wins is policy, it
// changes with user settings, and it must be unit-testable without a database
// — so it lives in the client (src/lib/promptRouting.ts) and this function
// stops at "here is how close each one is".
//
// Vectors are compared with FULL cosine, not a dot product: the deployment may
// be running pplx-embed, whose vectors are unnormalized, and a dot product
// there would rank longer descriptions higher for being longer.

const ROUTING_CANDIDATES = 5;
/** A prompt with no `when_to_use` is matched on its name alone, which is weak
 *  but honest; one with neither has nothing to match and is skipped. */
const routingText = (p: { name?: string; when_to_use?: string }) =>
  (p.when_to_use || "").trim() || (p.name || "").trim();

function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== "string") return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number | null {
  if (a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function routePrompts(
  supabase: any,
  qVec: number[] | null,
  activePromptId: string | null,
  nodes: Array<{ similarity?: number | null }>,
): Promise<unknown> {
  if (!qVec) return null;

  const { data, error } = await supabase
    .from("prompt_presets")
    .select("id, name, when_to_use, embedding, embedding_model")
    .eq("routing_enabled", true);
  // 42703 / PGRST204 = migration not applied; PGRST205 = table unknown to the
  // schema cache. All of them mean "this feature isn't deployed yet", which is
  // a silent no-op, not an error the user should ever see.
  if (error) {
    const code = (error as any)?.code;
    if (code !== "42703" && code !== "PGRST204" && code !== "PGRST205") {
      console.error("routePrompts select failed:", error);
    }
    return null;
  }
  const rows = (data || []) as any[];
  if (rows.length === 0) return null;

  // Self-healing embeddings. A prompt the user just wrote has no vector, and a
  // vector written by a previous embedding model is not comparable with this
  // one — stale rows are re-embedded rather than silently scored as noise.
  // Doing it here means there is no separate pipeline to run, forget, or fail.
  const stale = rows.filter((r) => {
    if (!routingText(r)) return false;
    return !parseVector(r.embedding) || r.embedding_model !== EMBEDDING_MODEL_ID;
  });
  if (stale.length > 0) {
    const vecs = await embedBatch(stale.map(routingText));
    await Promise.all(stale.map(async (r, i) => {
      const vec = vecs[i];
      if (!vec) return;
      r.embedding = vec;
      r.embedding_model = EMBEDDING_MODEL_ID;
      const { error: upErr } = await supabase
        .from("prompt_presets")
        .update({ embedding: vec as any, embedding_model: EMBEDDING_MODEL_ID })
        .eq("id", r.id);
      // A failed write is not fatal: the vector is still used for THIS turn,
      // and the next call re-embeds. Routing degrades to costing an embedding
      // rather than to being wrong.
      if (upErr) console.error("routePrompts embed write failed:", upErr.message);
    }));
  }

  const scored = rows
    .map((r) => {
      const vec = parseVector(r.embedding);
      const similarity = vec ? cosine(qVec, vec) : null;
      return similarity === null ? null : { id: r.id as string, name: r.name as string, similarity };
    })
    .filter((x): x is { id: string; name: string; similarity: number } => x !== null)
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) return null;

  // How strongly this turn is a memory-recall turn. The client uses it for the
  // plain-voice guard (PRISM: personas help alignment tasks and hurt factual
  // recall), which is why it is reported from here — the caller has no other
  // view of how well the retrieved cards actually matched.
  const topMemory = nodes.reduce<number | null>((best, n) => {
    const s = typeof n?.similarity === "number" ? n.similarity : null;
    return s === null ? best : best === null || s > best ? s : best;
  }, null);

  return {
    candidates: scored.slice(0, ROUTING_CANDIDATES),
    active_similarity: activePromptId ? (scored.find((s) => s.id === activePromptId)?.similarity ?? null) : null,
    top_memory_score: topMemory,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
