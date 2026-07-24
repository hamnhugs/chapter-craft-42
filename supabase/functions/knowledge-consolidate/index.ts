/**
 * knowledge-consolidate — Sleep Cycle background worker.
 *
 * Three-phase pipeline (runs sequentially, non-blocking to the caller):
 *
 *   Phase 1 — Re-Ranking
 *     Recompute ACT-R vibrancy for every node using updated idle time.
 *     Executed as a single parameterized SQL UPDATE; no LLM call needed.
 *
 *   Phase 2 — Re-Consolidation
 *     Pull unprocessed items from consolidation_queue (SKIP LOCKED for
 *     concurrent-safe batching). For each item, ask the LLM to propose
 *     ≥ MIN_EDGES_PER_CONSOLIDATION new edges connecting it to Core nodes.
 *     Write those edges to memory_graph. If the item is a conflict-staged
 *     pending entry, insert it into knowledge_entries only after edge
 *     generation succeeds.
 *
 *   Phase 3 — Pruning
 *     Identify orphan nodes (zero edges). Add them to the queue with reason
 *     'orphan' for next-run consolidation. Report them in the response.
 *
 * Called from the frontend via knowledgeApi.triggerSleepCycle().
 * Also suitable for pg_cron: `SELECT pg_net.http_post(url, ...)`.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveWikiLlm } from "../_shared/wiki-llm.ts";
import {
  checkRecordingMode,
  markProcessed,
  enqueueEntry,
  computeVibrancy,
  isCoreNode,
  ACT_R_DECAY,
  VIBRANCY_FLOOR,
  VIBRANCY_CEIL,
  RETRIEVAL_BOOST,
  SLEEP_CYCLE_BATCH_SIZE,
  MIN_EDGES_PER_CONSOLIDATION,
  QUEUE_PRIORITY,
} from "../_shared/memory-layers.ts";
import { embedOne } from "../_shared/embed.ts";
import { embedAndStore } from "../_shared/atomicity.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL   = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FAST_MODEL = "google/gemini-3-flash-preview";

// ── helpers ────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Phase 1: Re-Ranking via ACT-R vibrancy ─────────────────────────────────────

async function rerank(supabase: any, userId: string): Promise<{ updated: number }> {
  // Compute vibrancy using the ACT-R single-access approximation in SQL:
  //   raw  = ln(retrieval_count + 1) - 0.5 * ln(idle_seconds + 1)
  //   v    = 1 / (1 + exp(-raw)) * 0.9 + 0.1   [sigmoid → [0.1, 1.0]]
  // GREATEST / LEAST clamp to [FLOOR, CEIL].
  const { error, count } = await supabase.rpc("rerank_vibrancy", {
    p_user_id:    userId,
    p_decay:      ACT_R_DECAY,
    p_floor:      VIBRANCY_FLOOR,
    p_ceil:       VIBRANCY_CEIL,
  });

  if (error) {
    // Fallback: simple exponential decay when the RPC isn't deployed yet.
    const { error: fallbackErr } = await supabase
      .from("knowledge_entries")
      .update({ vibrancy: supabase.rpc("greatest", [VIBRANCY_FLOOR, 1]) }) // no-op placeholder
      .eq("user_id", userId); // harmless no-op if rpc missing
    console.warn("rerank_vibrancy RPC not found, skipping:", error.message);
    return { updated: 0 };
  }

  return { updated: count ?? 0 };
}

// ── Phase 2: Re-Consolidation (LLM edge generation) ───────────────────────────

async function reconsolidate(
  supabase: any,
  userId: string,
  lovableKey: string,
  llm: { url: string; headers: Record<string, string>; model: string },
  wikiId: string | null,
): Promise<{ processed: number; edges_created: number; conflicts_inserted: number }> {

  // Pull a batch from the queue using FOR UPDATE SKIP LOCKED for concurrency safety.
  // Supabase JS client doesn't expose advisory locks directly, so we use a raw RPC.
  const { data: queueItems, error: queueErr } = await supabase.rpc("dequeue_consolidation_batch", {
    p_user_id:    userId,
    p_batch_size: SLEEP_CYCLE_BATCH_SIZE,
  });

  if (queueErr || !queueItems || queueItems.length === 0) {
    return { processed: 0, edges_created: 0, conflicts_inserted: 0 };
  }

  // Fetch Core nodes (high vibrancy) to anchor new edges. Scope to wiki when provided.
  let coreQuery = supabase
    .from("knowledge_entries")
    .select("id, title, content, vibrancy, entry_type")
    .eq("user_id", userId)
    .gte("vibrancy", 0.70)
    .order("vibrancy", { ascending: false })
    .limit(20);
  if (wikiId) coreQuery = coreQuery.eq("wiki_id", wikiId);
  const { data: coreNodes } = await coreQuery;

  const cores = (coreNodes || []) as Array<{
    id: string; title: string; content: string; vibrancy: number; entry_type: string;
  }>;

  let edgesCreated    = 0;
  let conflictsInserted = 0;
  const processedIds: string[] = [];

  for (const item of queueItems as any[]) {
    try {
      // Resolve the entry we're consolidating.
      let entry: { id: string | null; title: string; content: string } | null = null;

      if (item.entry_id) {
        const { data: e } = await supabase
          .from("knowledge_entries")
          .select("id, title, content")
          .eq("id", item.entry_id)
          .single();
        entry = e;
      } else if (item.pending_data) {
        // conflict_staged: entry not yet inserted
        entry = { id: null, ...item.pending_data };
      }

      if (!entry) { processedIds.push(item.id); continue; }

      // Skip if no core nodes to link to.
      const linkableCores = cores.filter((c) => c.id !== entry!.id);
      if (linkableCores.length === 0) { processedIds.push(item.id); continue; }

      const coreList = linkableCores
        .slice(0, 10)
        .map((c, i) => `[${i}] id=${c.id}\nTitle: ${c.title}\n${c.content.slice(0, 400)}`)
        .join("\n\n");

      // Ask the LLM to generate ≥ MIN_EDGES_PER_CONSOLIDATION edges.
      const resp = await fetch(llm.url, {
        method: "POST",
        headers: llm.headers,
        body: JSON.stringify({
          model: llm.model,
          messages: [
            {
              role: "system",
              content: `You are a knowledge graph editor. Your job is to find meaningful structural relationships between a new node and existing high-vibrancy "Core" nodes. Only propose edges where there is a real semantic relationship (not superficial topic overlap). Propose at least ${MIN_EDGES_PER_CONSOLIDATION} edges.`,
            },
            {
              role: "user",
              content: `NEW NODE:\nTitle: ${entry.title}\nContent: ${entry.content.slice(0, 1500)}\n\nCORE NODES (anchor targets):\n${coreList}`,
            },
          ],
          tools: [{
            type: "function",
            function: {
              name: "propose_edges",
              description: "Propose edges from the new node to core nodes",
              parameters: {
                type: "object",
                properties: {
                  edges: {
                    type: "array",
                    minItems: MIN_EDGES_PER_CONSOLIDATION,
                    items: {
                      type: "object",
                      properties: {
                        target_id:    { type: "string" },
                        relationship: {
                          type: "string",
                          enum: ["relates_to", "extends", "supports", "derived_from",
                                 "prerequisite", "contradicts", "mentions"],
                        },
                        rationale: { type: "string" },
                      },
                      required: ["target_id", "relationship"],
                    },
                  },
                },
                required: ["edges"],
              },
            },
          }],
          tool_choice: { type: "function", function: { name: "propose_edges" } },
        }),
      });

      if (!resp.ok) { processedIds.push(item.id); continue; }

      const aiData = await resp.json();
      const tc = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!tc) { processedIds.push(item.id); continue; }

      let proposedEdges: any[] = [];
      try { proposedEdges = JSON.parse(tc.function.arguments).edges || []; } catch { /* skip */ }

      // If this is a conflict_staged entry, insert it now before creating edges.
      let resolvedId = entry.id;
      if (!resolvedId && item.reason === "conflict_staged" && proposedEdges.length >= MIN_EDGES_PER_CONSOLIDATION) {
        const { data: inserted } = await supabase
          .from("knowledge_entries")
          .insert({
            user_id:    userId,
            title:      entry.title,
            content:    entry.content,
            entry_type: (item.pending_data?.entry_type) || "concept",
            tags:       (item.pending_data?.tags)       || [],
            confidence: (item.pending_data?.confidence) || 0.75,
            vibrancy:   0.5, // starts mid-range; will grow with retrievals
          })
          .select("id")
          .single();
        resolvedId = inserted?.id ?? null;
        if (resolvedId) conflictsInserted++;
      }

      // Write edges to memory_graph.
      if (resolvedId) {
        for (const edge of proposedEdges) {
          const target = linkableCores.find((c) => c.id === edge.target_id);
          if (!target) continue;
          const { error: edgeErr } = await supabase.from("memory_graph").upsert(
            {
              user_id:         userId,
              source_entry_id: resolvedId,
              target_entry_id: edge.target_id,
              relationship:    edge.relationship,
              edge_class:      "structural",
              weight:          1.0,
              created_by:      "sleep_cycle",
            },
            { onConflict: "source_entry_id,target_entry_id,relationship" },
          );
          if (!edgeErr) edgesCreated++;
        }
      }

      processedIds.push(item.id);
    } catch (e) {
      console.error("consolidation item error:", e);
      processedIds.push(item.id); // still mark as processed to unblock queue
    }
  }

  await markProcessed(supabase, processedIds);
  return { processed: processedIds.length, edges_created: edgesCreated, conflicts_inserted: conflictsInserted };
}

// ── Phase 3: Pruning (orphan detection) ────────────────────────────────────────

async function prune(supabase: any, userId: string, wikiId: string | null): Promise<{ orphans: string[] }> {
  // Nodes with zero edges in either direction (scoped to wiki when provided).
  let edgesQuery = supabase
    .from("memory_graph")
    .select("source_entry_id, target_entry_id")
    .eq("user_id", userId);
  const { data: allEdges } = wikiId
    ? await supabase.rpc("memory_graph_for_wiki", { target_wiki_id: wikiId })
    : await edgesQuery;

  const connected = new Set<string>();
  for (const e of (allEdges || []) as any[]) {
    connected.add(e.source_entry_id);
    connected.add(e.target_entry_id);
  }

  let entriesQuery = supabase
    .from("knowledge_entries")
    .select("id, title")
    .eq("user_id", userId);
  if (wikiId) entriesQuery = entriesQuery.eq("wiki_id", wikiId);
  const { data: allEntries } = await entriesQuery;

  const orphanIds: string[] = [];
  for (const entry of (allEntries || []) as any[]) {
    if (!connected.has(entry.id)) orphanIds.push(entry.id);
  }

  // Enqueue orphans (won't overwrite if already queued).
  for (const id of orphanIds) {
    await enqueueEntry(supabase, userId, id, "orphan");
  }

  return { orphans: orphanIds };
}

// ── Phase 4: Semanticize (episodic → semantic consolidation) ──────────────────
// The brain's central consolidation act: replay recent episodes and distill
// recurring patterns into context-free semantic knowledge. Fully guarded — any
// failure returns { created: 0 } and never affects the other phases.
async function semanticize(
  supabase: any,
  userId: string,
  llm: { url: string; headers: Record<string, string>; model: string },
  wikiId: string | null,
): Promise<{ created: number }> {
  try {
    let epq = supabase
      .from("episodic_log")
      .select("summary, key_facts, created_at, wiki_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (wikiId) epq = epq.eq("wiki_id", wikiId);
    const { data: eps } = await epq;
    const episodes = (eps || []) as any[];
    if (episodes.length < 3) return { created: 0 };

    const facts: string[] = [];
    for (const e of episodes) {
      if (Array.isArray(e.key_facts)) for (const f of e.key_facts) if (typeof f === "string") facts.push(f);
    }
    if (facts.length < 6) return { created: 0 };

    const resp = await fetch(llm.url, {
      method: "POST",
      headers: llm.headers,
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: "You consolidate episodic memories into semantic knowledge, like the brain does during sleep. From facts gathered across many sessions, distill 1-3 GENERAL, durable, context-free semantic facts that RECUR or generalize across episodes. Ignore one-off specifics. Each must be a genuine generalization, not a copy of a single fact. If nothing genuinely recurs, return an empty list. Reply only via the tool." },
          { role: "user", content: `FACTS FROM RECENT SESSIONS:\n${facts.slice(0, 120).map((f) => `- ${f}`).join("\n")}` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "save_schema",
            description: "Save generalized semantic facts",
            parameters: {
              type: "object",
              properties: {
                entries: {
                  type: "array", maxItems: 3,
                  items: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] },
                },
              },
              required: ["entries"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "save_schema" } },
      }),
    });
    if (!resp.ok) return { created: 0 };
    const d = await resp.json();
    const tc = d.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) return { created: 0 };
    let entries: any[] = [];
    try { entries = JSON.parse(tc.function.arguments).entries || []; } catch { return { created: 0 }; }

    let created = 0;
    for (const e of entries.slice(0, 3)) {
      const title = String(e.title || "").trim();
      const content = String(e.content || "").trim();
      if (!title || !content) continue;
      // Dedup against existing memory so we never re-create the same schema.
      try {
        const vec = await embedOne(`${title}\n${content}`);
        if (vec) {
          const { data: near } = await supabase.rpc("match_knowledge", { query_embedding: vec as any, match_count: 1 });
          const top = ((near || []) as any[])[0];
          if (top && typeof top.similarity === "number" && top.similarity >= 0.85) {
            // match_knowledge isn't wiki-scoped; when this cycle is wiki-scoped,
            // only treat it as a duplicate if the match lives in the SAME wiki,
            // so wiki B still gets a schema that merely resembles one in wiki A.
            let sameScope = true;
            if (wikiId) {
              const { data: hit } = await supabase.from("knowledge_entries").select("wiki_id").eq("id", top.id).single();
              sameScope = (hit as any)?.wiki_id === wikiId;
            }
            if (sameScope) continue; // already known in this scope
          }
        }
      } catch { /* dedup best-effort */ }

      const { data: ins } = await supabase.from("knowledge_entries").insert({
        user_id: userId, title, content,
        entry_type: "synthesis", tags: ["consolidated", "schema"],
        confidence: 0.7, vibrancy: 0.6,
        ...(wikiId ? { wiki_id: wikiId } : {}),
      } as any).select("id").single();
      if (ins?.id) {
        try { await embedAndStore(supabase, ins.id, userId, title, content); } catch { /* reindex later */ }
        created++;
      }
    }
    return { created };
  } catch (e) {
    console.warn("semanticize skipped:", e);
    return { created: 0 };
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

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

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) return json({ error: "AI service not configured" }, 500);

    // Optional wiki scope. When provided, consolidation only considers entries
    // in that wiki for both anchoring (cores) and orphan pruning.
    const body = await req.json().catch(() => ({}));
    const wikiId: string | null = body?.wiki_id ?? null;

    const llm = await resolveWikiLlm(supabase, user.id);

    const t0 = Date.now();

    // Phase 1
    const rerankResult     = await rerank(supabase, user.id);

    // Phase 1b — SHY: gently renormalize vibrancy toward a target mean so it
    // can't saturate over time (synaptic homeostasis). Best-effort — skipped if
    // the renormalize_vibrancy RPC (brain_memory migration) isn't deployed yet.
    let renormalized = 0;
    try {
      const { data: rn } = await supabase.rpc("renormalize_vibrancy", { _user_id: user.id, _wiki_id: wikiId });
      if (typeof rn === "number") renormalized = rn;
    } catch (_e) { /* RPC not deployed — skip */ }

    // Phase 2
    const consolidateResult = await reconsolidate(supabase, user.id, LOVABLE_API_KEY, llm, wikiId);

    // Phase 3
    const pruneResult      = await prune(supabase, user.id, wikiId);

    // Phase 4 — Semanticize (episodic → semantic). Guarded; never breaks phases 1-3.
    const semanticizeResult = await semanticize(supabase, user.id, llm, wikiId);

    // Record last run time.
    await supabase
      .from("user_settings")
      .update({ last_sleep_cycle_at: new Date().toISOString() })
      .eq("user_id", user.id);

    const elapsed_ms = Date.now() - t0;

    return json({
      ok: true,
      elapsed_ms,
      phases: {
        rerank:       { ...rerankResult, renormalized },
        consolidate:  consolidateResult,
        prune:        pruneResult,
        semanticize:  semanticizeResult,
      },
    });
  } catch (e) {
    console.error("knowledge-consolidate error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
