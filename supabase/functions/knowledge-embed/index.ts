// Backfill or refresh embeddings for knowledge_entries.
// Body: { entry_ids?: string[], all_missing?: boolean, force?: boolean }
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedBatch, EMBEDDING_MODEL_ID } from "../_shared/embed.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 25;

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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { entry_ids, all_missing, force, wiki_id } = await req.json().catch(() => ({}));

    let query = supabase
      .from("knowledge_entries")
      .select("id, title, content")
      .eq("user_id", user.id);

    if (Array.isArray(entry_ids) && entry_ids.length > 0) {
      query = query.in("id", entry_ids);
    } else if (all_missing) {
      if (!force) query = query.is("embedding", null);
      if (wiki_id) query = query.eq("wiki_id", wiki_id);
    } else {
      return json({ error: "Provide entry_ids[] or all_missing:true" }, 400);
    }

    const { data: rows, error } = await query.limit(1000);
    if (error) return json({ error: error.message }, 500);
    if (!rows || rows.length === 0) return json({ updated: 0, message: "Nothing to embed" });

    let updated = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      const texts = chunk.map((r) => `${r.title}\n\n${r.content || ""}`);
      const vectors = await embedBatch(texts);
      for (let j = 0; j < chunk.length; j++) {
        const v = vectors[j];
        if (!v) { failed++; continue; }
        const { error: upErr } = await supabase
          .from("knowledge_entries")
          .update({ embedding: v as any, embedding_model: EMBEDDING_MODEL_ID })
          .eq("id", chunk[j].id)
          .eq("user_id", user.id);
        if (upErr) failed++; else updated++;
      }
    }

    return json({ updated, failed, total: rows.length });
  } catch (e) {
    console.error("knowledge-embed error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
