// Recompute wiki centroids from current knowledge_entries.embedding_v2.
// Called on-demand or scheduled (every 6h). Per-user invocation via auth header.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: wikis } = await supabase
      .from("wikis")
      .select("id")
      .eq("user_id", user.id);
    if (!wikis || wikis.length === 0) return json({ recomputed: 0 });

    let recomputed = 0;
    for (const w of wikis as any[]) {
      // Fetch entry embeddings for this wiki (native or bridged)
      const { data: entries } = await supabase
        .rpc("entries_for_wiki", { target_wiki_id: w.id });
      if (!entries || entries.length === 0) {
        // Delete centroid if no entries
        await supabase.from("wiki_centroids").delete().eq("wiki_id", w.id);
        continue;
      }

      // Pull embedding_v2 for those entries
      const ids = (entries as any[]).map((e) => e.id);
      const { data: embedRows } = await supabase
        .from("knowledge_entries")
        .select("embedding_v2")
        .in("id", ids)
        .not("embedding_v2", "is", null);

      if (!embedRows || embedRows.length === 0) continue;

      // Mean across vectors (parse halfvec from "[...]" string format)
      const vectors: number[][] = [];
      for (const row of embedRows as any[]) {
        const v = parseVector(row.embedding_v2);
        if (v && v.length === 1536) vectors.push(v);
      }
      if (vectors.length === 0) continue;

      const dim = 1536;
      const mean = new Array(dim).fill(0);
      for (const v of vectors) {
        for (let i = 0; i < dim; i++) mean[i] += v[i];
      }
      for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
      const centroidStr = "[" + mean.join(",") + "]";

      // ── Phase 3: adaptive thresholds per wiki ───────────────────────
      let confidentThreshold = 0.78;
      let noveltyThreshold = 0.55;
      try {
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const { data: decisions } = await supabase
          .from("routing_decisions")
          .select("s_max, s_active, proposed_action, final_wiki_id, proposed_wiki_id, user_corrected")
          .eq("user_id", user.id)
          .gte("created_at", since)
          .or(`final_wiki_id.eq.${w.id},proposed_wiki_id.eq.${w.id}`);
        if (decisions && decisions.length >= 8) {
          // p60 of s_max where user kept the destination (proposed accepted OR active assimilate)
          const keptScores = (decisions as any[])
            .filter((d) => !d.user_corrected && d.s_max > 0)
            .map((d) => d.s_max as number)
            .sort((a, b) => a - b);
          if (keptScores.length >= 5) {
            const p60 = keptScores[Math.floor(keptScores.length * 0.6)];
            confidentThreshold = clamp(p60, 0.65, 0.92);
          }
          // p20 of s_max for entries that should have incubated (low scores)
          const incubateScores = (decisions as any[])
            .filter((d) => d.proposed_action === "incubate")
            .map((d) => d.s_max as number)
            .sort((a, b) => a - b);
          if (incubateScores.length >= 3) {
            const p20 = incubateScores[Math.floor(incubateScores.length * 0.2)];
            noveltyThreshold = clamp(p20, 0.40, 0.65);
          }
        }
      } catch (e) {
        console.error("threshold learn failed for wiki", w.id, e);
      }

      await supabase.from("wiki_centroids").upsert({
        wiki_id: w.id,
        user_id: user.id,
        centroid: centroidStr,
        entry_count: vectors.length,
        confident_threshold: confidentThreshold,
        novelty_threshold: noveltyThreshold,
        last_recomputed_at: new Date().toISOString(),
      }, { onConflict: "wiki_id" });

      recomputed++;
    }

    // ── Auto-pause if recent reject rate > 70% over last 20 ─────────────
    try {
      const { data: recent } = await supabase
        .from("reroute_suggestions")
        .select("status")
        .eq("user_id", user.id)
        .in("status", ["accepted", "dismissed"])
        .order("updated_at", { ascending: false })
        .limit(20);
      if (recent && recent.length >= 10) {
        const rejects = (recent as any[]).filter((r) => r.status === "dismissed").length;
        if (rejects / recent.length > 0.7) {
          await supabase
            .from("user_settings")
            .update({ smart_filing_enabled: false })
            .eq("user_id", user.id);
          return json({ recomputed, total_wikis: wikis.length, auto_paused: true });
        }
      }
    } catch (e) {
      console.error("auto-pause check failed:", e);
    }

    return json({ recomputed, total_wikis: wikis.length });

  } catch (e) {
    console.error("recompute-centroids error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

function parseVector(raw: any): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
      return trimmed.split(",").map((x) => parseFloat(x));
    } catch { return null; }
  }
  return null;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
