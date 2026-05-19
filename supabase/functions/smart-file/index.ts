// Smart Filing router — Phase 1 (reroute suggestions only)
// Called from embed-entries AFTER embedding_v2 is written.
// Input: { entry_ids: string[] }
// For each entry: scores against wiki centroids, applies the A/B/C decision tree,
// writes routing_decisions and (when applicable) reroute_suggestions.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COLD_START_MIN_WIKIS = 2;
const COLD_START_MIN_ENTRIES = 10;
const REROUTE_MARGIN = 0.08;
const PENDING_CAP = 10;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { entry_ids } = await req.json().catch(() => ({}));
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
      return json({ error: "entry_ids required" }, 400);
    }

    // ── Read user settings: active wiki + smart filing toggle ─────────
    const { data: settings } = await supabase
      .from("user_settings")
      .select("active_wiki_id, smart_filing_enabled")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!(settings as any)?.smart_filing_enabled) {
      return json({ skipped: "disabled", count: 0 });
    }
    const activeWikiId = (settings as any)?.active_wiki_id || null;

    // ── Cold-start guard: need ≥2 wikis with ≥10 entries each ─────────
    const { data: wikis } = await supabase
      .from("wikis")
      .select("id, name")
      .eq("user_id", user.id);
    if (!wikis || wikis.length < COLD_START_MIN_WIKIS) {
      return json({ skipped: "cold_start_wikis", count: 0 });
    }
    const wikiNameMap = new Map(wikis.map((w: any) => [w.id, w.name]));

    // Count entries per wiki via the centroids table (entry_count is maintained there).
    // If centroids don't exist yet, fall back to counting knowledge_entries.
    const { data: centroidsForCount } = await supabase
      .from("wiki_centroids")
      .select("wiki_id, entry_count")
      .eq("user_id", user.id);

    let qualified = 0;
    if (centroidsForCount && centroidsForCount.length > 0) {
      qualified = centroidsForCount.filter((c: any) => c.entry_count >= COLD_START_MIN_ENTRIES).length;
    }
    if (qualified < COLD_START_MIN_WIKIS) {
      return json({ skipped: "cold_start_entries", count: 0 });
    }

    // ── Pending cap ───────────────────────────────────────────────────
    const { count: pendingCount } = await supabase
      .from("reroute_suggestions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "pending");
    const capped = (pendingCount ?? 0) >= PENDING_CAP;

    // ── Process each entry ────────────────────────────────────────────
    const results: any[] = [];
    for (const entryId of entry_ids as string[]) {
      try {
        const { data: entry } = await supabase
          .from("knowledge_entries")
          .select("id, embedding_v2, wiki_id, title")
          .eq("id", entryId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!entry || !(entry as any).embedding_v2) {
          results.push({ entry_id: entryId, skipped: "no_embedding" });
          continue;
        }
        const embedding = (entry as any).embedding_v2;
        const currentWikiId = (entry as any).wiki_id || activeWikiId;

        // Score against all wiki centroids
        const { data: scores, error: scoreErr } = await supabase
          .rpc("score_entry_against_wikis", { query_embedding: embedding });
        if (scoreErr || !scores || scores.length === 0) {
          results.push({ entry_id: entryId, skipped: "no_centroids" });
          continue;
        }
        const ranked = (scores as any[]).sort((a, b) => b.similarity - a.similarity);
        const best = ranked[0];
        const second = ranked[1];
        const s_max = best.similarity as number;
        const s_2nd = (second?.similarity as number) ?? 0;
        const activeRow = ranked.find((r) => r.wiki_id === currentWikiId);
        const s_active = (activeRow?.similarity as number) ?? 0;
        const confident = (activeRow?.confident_threshold as number) ?? best.confident_threshold ?? 0.78;

        // Compute novelty: 1 - mean similarity to k=8 nearest entries in best wiki
        let novelty = 0;
        try {
          const { data: nn } = await supabase.rpc("match_knowledge_entries", {
            query_embedding: embedding,
            match_threshold: 0.0,
            match_count: 8,
            filter_wiki_ids: [best.wiki_id],
          });
          if (nn && nn.length > 0) {
            const meanSim = (nn as any[]).reduce((s, r) => s + (r.similarity || 0), 0) / nn.length;
            novelty = 1 - meanSim;
          } else {
            novelty = 1;
          }
        } catch { /* ignore */ }

        // Decision tree
        const novelty_threshold = (activeRow?.novelty_threshold as number) ?? best.novelty_threshold ?? 0.55;
        let action: "assimilate_active" | "reroute" | "incubate" = "assimilate_active";
        let proposedWikiId: string | null = null;
        let createReroute = false;
        let incubate = false;

        if (s_active >= confident) {
          action = "assimilate_active";
        } else if (
          s_max >= confident &&
          best.wiki_id !== currentWikiId &&
          (s_max - s_2nd) >= REROUTE_MARGIN
        ) {
          action = "reroute";
          proposedWikiId = best.wiki_id;
          createReroute = true;
        } else if (s_max < novelty_threshold) {
          // No wiki is a good home — drop into incubator for clustering.
          action = "incubate";
          incubate = true;
        } else {
          action = "assimilate_active";
        }

        // Log decision
        await supabase.from("routing_decisions").insert({
          user_id: user.id,
          entry_id: entryId,
          s_max,
          s_active,
          s_2nd,
          novelty,
          proposed_wiki_id: proposedWikiId,
          proposed_action: action,
          final_wiki_id: currentWikiId,
        });

        // Create reroute suggestion (skip if cap reached)
        if (createReroute && !capped && currentWikiId) {
          const toName = wikiNameMap.get(best.wiki_id) || "another wiki";
          const fromName = wikiNameMap.get(currentWikiId) || "current wiki";
          const reason = `Better fit in "${toName}" (similarity ${(s_max * 100).toFixed(0)}% vs ${(s_active * 100).toFixed(0)}% in "${fromName}")`;
          await supabase.from("reroute_suggestions").insert({
            user_id: user.id,
            entry_id: entryId,
            from_wiki_id: currentWikiId,
            to_wiki_id: best.wiki_id,
            reason,
          });
        }

        // Park in incubator (idempotent via unique index on user_id,entry_id)
        if (incubate) {
          const reason = `No strong fit (best ${(s_max * 100).toFixed(0)}% < novelty ${(novelty_threshold * 100).toFixed(0)}%)`;
          await supabase.from("incubator_entries").upsert({
            user_id: user.id,
            entry_id: entryId,
            embedding,
            reason,
            status: "pending",
          }, { onConflict: "user_id,entry_id" });
        }

        results.push({ entry_id: entryId, action, s_max, s_active, s_2nd, novelty });
      } catch (err) {
        console.error("smart-file entry error:", err);
        results.push({ entry_id: entryId, error: err instanceof Error ? err.message : String(err) });
      }
    }


    return json({ count: results.length, results });
  } catch (e) {
    console.error("smart-file error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
