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

      await supabase.from("wiki_centroids").upsert({
        wiki_id: w.id,
        user_id: user.id,
        centroid: centroidStr,
        entry_count: vectors.length,
        last_recomputed_at: new Date().toISOString(),
      }, { onConflict: "wiki_id" });

      recomputed++;
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
