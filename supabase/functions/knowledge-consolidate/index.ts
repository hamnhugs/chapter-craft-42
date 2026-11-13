/**
 * knowledge-consolidate — Sleep Cycle background worker.
 *
 * Three-phase pipeline (runs sequentially, non-blocking to the caller):
 *
 *   Phase 0 — Embed missing
 *     Bounded sweep of rows with embedding IS NULL (safety net for the
 *     client's fire-and-forget embedEntriesSoon).
 *
 *   Phase 1 — Re-Ranking
 *     Recompute vibrancy for every node from idle days + use count
 *     (half-life formula, see memory-layers.ts computeVibrancy).
 *     Executed as a single parameterized SQL UPDATE; no LLM call needed.
 *
 *   Phase 2 — Re-Consolidation
 *     Pull unprocessed items from consolidation_queue (SKIP LOCKED for
 *     concurrent-safe batching). For each item, pick anchor candidates from
 *     its semantic nearest neighbours blended with vibrancy, and ask the LLM
 *     for edges to them — zero edges is a valid answer, and no LLM call is
 *     made when nothing is close enough. Write those edges to memory_graph.
 *     If the item is a conflict-staged pending entry, insert it into
 *     knowledge_entries only after it earns ≥ STAGED_INSERT_MIN_EDGES edges.
 *
 *   Phase 3 — Pruning
 *     Identify orphan nodes (zero edges). Add them to the queue with reason
 *     'orphan' for next-run consolidation. Report them in the response.
 *
 *   Phase 4 — Hooks
 *     Write the one-line index hook for notes that have none (one LLM call).
 *
 * Every run that changes something writes a memory_sleep_runs row listing
 * the links it added and the hooks it wrote; undo_sleep_run reverses it.
 *
 * Called from the frontend via knowledgeApi.triggerSleepCycle().
 * Also suitable for pg_cron: `SELECT pg_net.http_post(url, ...)`.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveWikiLlm } from "../_shared/wiki-llm.ts";
import {
  markProcessed,
  enqueueEntries,
  selectAllPages,
  rankAnchorCandidates,
  ACT_R_DECAY,
  VIBRANCY_FLOOR,
  VIBRANCY_CEIL,
  SLEEP_CYCLE_BATCH_SIZE,
  MIN_EDGES_PER_CONSOLIDATION,
  STAGED_INSERT_MIN_EDGES,
  QUEUE_PRIORITY,
} from "../_shared/memory-layers.ts";
import { embedOne, embedBatch, writeEntryEmbedding } from "../_shared/embed.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── helpers ────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Phase 0: Embed missing vectors (safety net) ───────────────────────────────
// Writes re-embed themselves via knowledgeApi.embedEntriesSoon, but that call
// is fire-and-forget from the browser: a closed tab or an embedding outage
// leaves rows with embedding IS NULL (as does every edit made before the
// client shipped). Those rows are invisible to semantic retrieval and to
// Phase 2's nearest-neighbour anchoring, so the Sleep Cycle sweeps a bounded
// batch first.
const EMBED_MISSING_CAP = 50;

async function embedMissing(supabase: any, userId: string, wikiId: string | null): Promise<{ embedded: number }> {
  try {
    let q = supabase
      .from("knowledge_entries")
      .select("id, title, content")
      .eq("user_id", userId)
      .is("embedding", null)
      .order("updated_at", { ascending: false })
      .limit(EMBED_MISSING_CAP);
    if (wikiId) q = q.eq("wiki_id", wikiId);
    const { data: rows, error } = await q;
    if (error || !rows || rows.length === 0) return { embedded: 0 };
    const list = rows as Array<{ id: string; title: string; content: string | null }>;
    const vectors = await embedBatch(list.map((r) => `${r.title}\n\n${r.content || ""}`));
    let embedded = 0;
    for (let i = 0; i < list.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      if (!(await writeEntryEmbedding(supabase, list[i].id, userId, v))) embedded++;
    }
    return { embedded };
  } catch (e) {
    console.warn("embedMissing skipped:", e);
    return { embedded: 0 };
  }
}

// ── Phase 1: Re-Ranking via idle-days vibrancy ────────────────────────────────

async function rerank(supabase: any, userId: string): Promise<{ updated: number }> {
  // SQL twin of memory-layers.ts computeVibrancy (migration 20260917130300):
  //   H(n) = (15 / p_decay) days · (1 + ln(1 + n))    → 30 days at p_decay 0.5
  //   v    = FLOOR + (CEIL − FLOOR) · 2^(−idle_days / H(n))
  // Only rows that move by > 0.005 are written; updated_at is left alone.
  const { data: count, error } = await supabase.rpc("rerank_vibrancy", {
    p_user_id:    userId,
    p_decay:      ACT_R_DECAY,
    p_floor:      VIBRANCY_FLOOR,
    p_ceil:       VIBRANCY_CEIL,
  });

  if (error) {
    // (The old "fallback" here sent a PostgREST builder object as the new
    // vibrancy for every row — never a no-op. Just skip.)
    console.warn("rerank_vibrancy failed, skipping:", error.message);
    return { updated: 0 };
  }

  return { updated: typeof count === "number" ? count : 0 };
}

// ── Phase 2: Re-Consolidation (LLM edge generation) ───────────────────────────

async function reconsolidate(
  supabase: any,
  userId: string,
  lovableKey: string,
  llm: { url: string; headers: Record<string, string>; model: string },
  wikiId: string | null,
): Promise<{ processed: number; edges_created: number; conflicts_inserted: number; edge_ids: string[] }> {

  // Pull a batch from the queue using FOR UPDATE SKIP LOCKED for concurrency safety.
  // Supabase JS client doesn't expose advisory locks directly, so we use a raw RPC.
  const { data: queueItems, error: queueErr } = await supabase.rpc("dequeue_consolidation_batch", {
    p_user_id:    userId,
    p_batch_size: SLEEP_CYCLE_BATCH_SIZE,
  });

  if (queueErr || !queueItems || queueItems.length === 0) {
    return { processed: 0, edges_created: 0, conflicts_inserted: 0, edge_ids: [] };
  }

  // Anchor candidates are chosen PER ITEM (see anchorsFor below): the item's
  // semantic nearest neighbours, blended with vibrancy. The old code offered
  // every item the same 20 globally most-vibrant nodes, related or not — and
  // with the broken vibrancy formula that list was usually empty.
  // Global core list = fallback only, for items without a vector or before
  // the match_entry_neighbors migration is applied (fetched lazily, once).
  type Anchor = { id: string; title: string; content: string; vibrancy: number | null; similarity?: number };
  let globalCores: Anchor[] | null = null;
  let neighborsRpcMissing = false;
  const loadGlobalCores = async (): Promise<Anchor[]> => {
    if (globalCores) return globalCores;
    let coreQuery = supabase
      .from("knowledge_entries")
      .select("id, title, content, vibrancy")
      .eq("user_id", userId)
      .gte("vibrancy", 0.70)
      .is("superseded_by", null)
      .order("vibrancy", { ascending: false })
      .limit(10);
    if (wikiId) coreQuery = coreQuery.eq("wiki_id", wikiId);
    const { data } = await coreQuery;
    globalCores = (data || []) as Anchor[];
    return globalCores;
  };

  const anchorsFor = async (entry: { id: string | null; title: string; content: string }): Promise<Anchor[]> => {
    let candidates: Anchor[] | null = null;
    if (entry.id && !neighborsRpcMissing) {
      const { data, error } = await supabase.rpc("match_entry_neighbors", {
        p_entry_id: entry.id, p_count: 16, p_wiki_id: wikiId,
      });
      if (error) {
        const code = (error as any).code;
        if (code === "PGRST202" || code === "42883") neighborsRpcMissing = true;
      } else if (Array.isArray(data) && data.length > 0) {
        candidates = data as Anchor[];
      }
    }
    if (!candidates && !entry.id) {
      // Not inserted yet (conflict_staged): embed its text and use the
      // generic kNN, then scope/meta-filter the hits.
      const vec = await embedOne(`${entry.title}\n\n${entry.content}`);
      if (vec) {
        const { data } = await supabase.rpc("match_knowledge", { query_embedding: vec as any, match_count: 16 });
        const hits = (data || []) as Array<{ id: string; title: string; content: string; similarity: number }>;
        if (hits.length > 0) {
          const mq = supabase.from("knowledge_entries").select("id, vibrancy, wiki_id, superseded_by").in("id", hits.map((h) => h.id));
          const { data: meta } = await mq;
          const byId = new Map(((meta || []) as any[]).map((m) => [m.id, m]));
          candidates = hits
            .filter((h) => {
              const m = byId.get(h.id);
              return m && !m.superseded_by && (!wikiId || m.wiki_id === wikiId);
            })
            .map((h) => ({ ...h, content: (h.content || "").slice(0, 600), vibrancy: byId.get(h.id)?.vibrancy ?? null }));
        }
      }
    }
    if (candidates) {
      return rankAnchorCandidates(
        candidates.map((c) => ({ ...c, similarity: typeof c.similarity === "number" ? c.similarity : 0 })),
        { limit: 8, minSimilarity: 0.3, excludeId: entry.id },
      );
    }
    // No vector for the item (not embedded yet) → legacy behaviour.
    return (await loadGlobalCores()).filter((c) => c.id !== entry.id);
  };

  let edgesCreated    = 0;
  let conflictsInserted = 0;
  const edgeIds: string[] = [];
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

      // Skip (no LLM call) when nothing is close enough to link to.
      const linkableCores = await anchorsFor(entry);
      if (linkableCores.length === 0) { processedIds.push(item.id); continue; }

      const coreList = linkableCores
        .slice(0, 10)
        .map((c, i) => `[${i}] id=${c.id}\nTitle: ${c.title}\n${(c.content || "").slice(0, 400)}`)
        .join("\n\n");

      // Ask the LLM for edges — zero is an acceptable answer.
      const resp = await fetch(llm.url, {
        method: "POST",
        headers: llm.headers,
        body: JSON.stringify({
          model: llm.model,
          messages: [
            {
              role: "system",
              content: `You are a knowledge graph editor. Your job is to find meaningful structural relationships between a new node and nearby existing nodes. Only propose edges where there is a real semantic relationship (not superficial topic overlap). An empty list is the correct answer when no candidate is genuinely related — never invent a link to fill the list.`,
            },
            {
              role: "user",
              content: `NEW NODE:\nTitle: ${entry.title}\nContent: ${(entry.content || "").slice(0, 1500)}\n\nCANDIDATE NODES (anchor targets):\n${coreList}`,
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
                    minItems: MIN_EDGES_PER_CONSOLIDATION, // 0 — see memory-layers.ts
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
      if (!resolvedId && item.reason === "conflict_staged" && proposedEdges.length >= STAGED_INSERT_MIN_EDGES) {
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
          // ignoreDuplicates: an existing link is left as it was, so the
          // rows that come back are exactly the ones this run ADDED — the
          // run log's undo list must never include a link the user made.
          const { data: added, error: edgeErr } = await supabase.from("memory_graph").upsert(
            {
              user_id:         userId,
              source_entry_id: resolvedId,
              target_entry_id: edge.target_id,
              relationship:    edge.relationship,
              edge_class:      "structural",
              weight:          1.0,
              created_by:      "sleep_cycle",
            },
            { onConflict: "source_entry_id,target_entry_id,relationship", ignoreDuplicates: true },
          ).select("id");
          if (!edgeErr) {
            for (const row of (added || []) as Array<{ id: string }>) edgeIds.push(row.id);
            edgesCreated += (added || []).length;
          }
        }
      }

      processedIds.push(item.id);
    } catch (e) {
      console.error("consolidation item error:", e);
      processedIds.push(item.id); // still mark as processed to unblock queue
    }
  }

  await markProcessed(supabase, processedIds);
  return { processed: processedIds.length, edges_created: edgesCreated, conflicts_inserted: conflictsInserted, edge_ids: edgeIds };
}

// ── Phase 3: Pruning (orphan detection) ────────────────────────────────────────

async function prune(supabase: any, userId: string, wikiId: string | null): Promise<{ orphans: string[]; enqueued?: number }> {
  // Nodes with zero edges in either direction (scoped to wiki when provided).
  // Both reads are paged: PostgREST silently truncates at max-rows (1000), and
  // an edge list cut at 1000 turned every node past the cut into a false orphan.
  const { rows: allEdges, error: edgeErr } = await selectAllPages<{ source_entry_id: string; target_entry_id: string }>(() =>
    wikiId
      ? supabase
          .rpc("memory_graph_for_wiki", { target_wiki_id: wikiId })
          .select("id, source_entry_id, target_entry_id")
          .order("id", { ascending: true })
      : supabase
          .from("memory_graph")
          .select("id, source_entry_id, target_entry_id")
          .eq("user_id", userId)
          .order("id", { ascending: true })
  );
  // A partial edge list would mislabel connected nodes — better to skip.
  if (edgeErr) {
    console.warn("prune: edge read failed, skipping orphan detection:", edgeErr.message);
    return { orphans: [] };
  }

  const connected = new Set<string>();
  for (const e of allEdges) {
    connected.add(e.source_entry_id);
    connected.add(e.target_entry_id);
  }

  // Living entries only — a superseded card's edges were moved to its
  // successor, so it is "orphaned" by design and must not be re-linked.
  const entryQuery = (liveOnly: boolean) => () => {
    let q = supabase
      .from("knowledge_entries")
      .select("id")
      .eq("user_id", userId);
    if (liveOnly) q = q.is("superseded_by", null);
    if (wikiId) q = q.eq("wiki_id", wikiId);
    return q.order("id", { ascending: true });
  };
  let { rows: allEntries, error: entryErr } = await selectAllPages<{ id: string }>(entryQuery(true));
  if (entryErr && (entryErr as any).code === "42703") {
    ({ rows: allEntries, error: entryErr } = await selectAllPages<{ id: string }>(entryQuery(false)));
  }
  if (entryErr) {
    console.warn("prune: entry read failed:", entryErr.message);
    return { orphans: [] };
  }

  const orphanIds: string[] = [];
  for (const entry of allEntries) {
    if (!connected.has(entry.id)) orphanIds.push(entry.id);
  }

  // One set-based RPC call for all orphans (was one HTTP upsert per orphan,
  // each failing against the partial unique index). Already-queued rows are
  // left alone; long-processed ones are re-armed — see enqueueEntries.
  const enqueued = await enqueueEntries(supabase, userId, orphanIds, "orphan");

  return { orphans: orphanIds, enqueued };
}

// ── Phase 4: Hooks (the one-line index entry for each note) ───────────────────
// The chat keeps an always-loaded index of the user's notes, one line each:
// title + hook + where it points. A hook is a search-snippet-style line ("what
// it is and why it matters to this user") — it is what makes the model open
// the right note on the first try. New notes usually arrive with one (the
// save tool asks for it); this phase writes the rest, in ONE model call per
// run. Only empty hooks are written, and the run log keeps their ids so the
// whole run can be undone.
const HOOKS_PER_RUN = 40;
const HOOK_MAX = 160;

export function cleanHook(raw: unknown): string | null {
  const h = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”]+$/g, "");
  if (h.length < 8) return null;
  return h.length > HOOK_MAX ? `${h.slice(0, HOOK_MAX - 1).trimEnd()}…` : h;
}

async function writeHooks(
  supabase: any,
  userId: string,
  llm: { url: string; headers: Record<string, string>; model: string },
  wikiId: string | null,
): Promise<{ written: number; entry_ids: string[] }> {
  try {
    let q = supabase
      .from("knowledge_entries")
      .select("id, title, content, entry_type")
      .eq("user_id", userId)
      .is("hook", null)
      .is("superseded_by", null)
      .not("entry_type", "in", "(tool,program)")
      .order("updated_at", { ascending: false })
      .limit(HOOKS_PER_RUN);
    if (wikiId) q = q.eq("wiki_id", wikiId);
    const { data: rows, error } = await q;
    if (error || !rows || rows.length === 0) return { written: 0, entry_ids: [] };
    const notes = rows as Array<{ id: string; title: string; content: string | null }>;
    const listing = notes
      .map((n, i) => `[${i}] ${n.title}\n${(n.content || "").replace(/\s+/g, " ").slice(0, 500)}`)
      .join("\n\n");
    const resp = await fetch(llm.url, {
      method: "POST",
      headers: llm.headers,
      body: JSON.stringify({
        model: llm.model,
        messages: [
          {
            role: "system",
            content:
              "You write one-line hooks for a reader's notes. A hook is under 120 characters and reads like a search snippet: the note's specific claim or subject plus why it matters, in plain words. Never repeat the title verbatim, never start with 'This note', and never invent facts that are not in the note. Reply only via the tool, with one hook per note index.",
          },
          { role: "user", content: `NOTES:\n${listing}` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "write_hooks",
            description: "Save one hook per note",
            parameters: {
              type: "object",
              properties: {
                hooks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { index: { type: "number" }, hook: { type: "string" } },
                    required: ["index", "hook"],
                  },
                },
              },
              required: ["hooks"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "write_hooks" } },
      }),
    });
    if (!resp.ok) return { written: 0, entry_ids: [] };
    const d = await resp.json();
    const tc = d.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) return { written: 0, entry_ids: [] };
    let hooks: Array<{ index: number; hook: string }> = [];
    try { hooks = JSON.parse(tc.function.arguments).hooks || []; } catch { return { written: 0, entry_ids: [] }; }
    const ids: string[] = [];
    for (const h of hooks) {
      const note = notes[Number(h.index)];
      const hook = cleanHook(h.hook);
      if (!note || !hook || ids.includes(note.id)) continue;
      // `hook IS NULL` again at write time: a hook the user or the chat wrote
      // while this call ran wins.
      const { data: upd } = await supabase
        .from("knowledge_entries")
        .update({ hook })
        .eq("id", note.id)
        .is("hook", null)
        .select("id");
      if (upd && upd.length > 0) ids.push(note.id);
    }
    return { written: ids.length, entry_ids: ids };
  } catch (e) {
    console.warn("writeHooks skipped:", e);
    return { written: 0, entry_ids: [] };
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

    // Phase 0 — recent writes get vectors before anything ranks/anchors on them.
    const embedResult      = await embedMissing(supabase, user.id, wikiId);

    // Phase 1
    const rerankResult     = await rerank(supabase, user.id);

    // Phase 1b (SHY renormalize_vibrancy) is intentionally no longer run here.
    // It existed to stop incremental boosts from saturating vibrancy, but
    // rerank_vibrancy now recomputes every score from scratch (idle days + use
    // count), so nothing can accumulate — and renormalizing a young, active
    // corpus right after rerank just multiplied every fresh card by ~0.6,
    // pushing it back under the 0.70 core line. Reported as 0 for API shape.
    const renormalized = 0;

    // Phase 2
    const consolidateResult = await reconsolidate(supabase, user.id, LOVABLE_API_KEY, llm, wikiId);

    // Phase 3
    const pruneResult      = await prune(supabase, user.id, wikiId);

    // Phase 4 — hooks for notes that have none.
    const hooksResult      = await writeHooks(supabase, user.id, llm, wikiId);

    // Run log: what this run added, so the user can see it and undo it
    // (undo_sleep_run). Only runs that changed something are logged.
    let run_id: string | null = null;
    if (consolidateResult.edge_ids.length > 0 || hooksResult.entry_ids.length > 0) {
      const { data: run } = await supabase
        .from("memory_sleep_runs")
        .insert({
          user_id:        user.id,
          wiki_id:        wikiId,
          edge_ids:       consolidateResult.edge_ids,
          hook_entry_ids: hooksResult.entry_ids,
        })
        .select("id")
        .single();
      run_id = (run as any)?.id ?? null;
    }

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
        embed:        embedResult,
        rerank:       { ...rerankResult, renormalized },
        consolidate:  { processed: consolidateResult.processed, edges_created: consolidateResult.edges_created, conflicts_inserted: consolidateResult.conflicts_inserted },
        prune:        pruneResult,
        hooks:        { written: hooksResult.written },
      },
      run_id,
    });
  } catch (e) {
    console.error("knowledge-consolidate error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
