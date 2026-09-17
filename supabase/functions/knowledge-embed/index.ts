// Backfill or refresh embeddings for knowledge_entries.
// Body (exactly one mode):
//   { entry_ids: string[] }                     targeted (≤ MAX_TARGETED ids);
//                                               also refreshes a missing
//                                               embedding_v2 for those ids
//   { all_missing: true, wiki_id?, force? }     rows with embedding IS NULL
//                                               (force: every row, re-embed)
//   { stale_model: true, wiki_id? }             rows whose vector was NOT made
//                                               by the active model (or whose
//                                               model is unknown) — the manual
//                                               migration after changing
//                                               EMBED_PROVIDER / model. Never
//                                               run automatically.
// Returns { updated, failed, total, model, v2_updated, possible_duplicates }.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedBatch, EMBEDDING_MODEL_ID, writeEntryEmbedding } from "../_shared/embed.ts";
import { embedAndStore as embedV2AndStore } from "../_shared/wiki-embed.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 25;
const MAX_TARGETED = 100;
const MAX_ROWS_PER_CALL = 1000;
/** Cosine at/above which a freshly embedded entry is flagged as a likely duplicate. */
const NEAR_DUPLICATE_COSINE = 0.92;

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

    const { entry_ids, all_missing, force, wiki_id, stale_model } = await req.json().catch(() => ({}));

    const build = (withModelFilter: boolean) => {
      let query = supabase
        .from("knowledge_entries")
        .select("id, title, content")
        .eq("user_id", user.id);
      if (Array.isArray(entry_ids) && entry_ids.length > 0) {
        query = query.in("id", entry_ids.slice(0, MAX_TARGETED));
      } else if (stale_model && withModelFilter) {
        // NULL = legacy row whose true model is unknown (the old helper stamped
        // google/text-embedding-004 whatever it used) → treat as stale too.
        query = query.or(`embedding_768_model.is.null,embedding_768_model.neq."${EMBEDDING_MODEL_ID}"`);
        if (wiki_id) query = query.eq("wiki_id", wiki_id);
      } else {
        // stale_model lands here only pre-migration, where every row is "unknown".
        if (!force && !stale_model) query = query.is("embedding", null);
        if (wiki_id) query = query.eq("wiki_id", wiki_id);
      }
      return query.order("updated_at", { ascending: false }).limit(MAX_ROWS_PER_CALL);
    };

    if (!(Array.isArray(entry_ids) && entry_ids.length > 0) && !all_missing && !stale_model) {
      return json({ error: "Provide entry_ids[], all_missing:true or stale_model:true" }, 400);
    }

    let { data: rows, error } = await build(true);
    if (error && stale_model && ((error as any).code === "42703" || (error as any).code === "PGRST204")) {
      // Tracking column not migrated yet: every row's model is unknown.
      ({ data: rows, error } = await build(false));
    }
    if (error) return json({ error: error.message }, 500);
    if (!rows || rows.length === 0) return json({ updated: 0, failed: 0, total: 0, model: EMBEDDING_MODEL_ID, message: "Nothing to embed" });

    let updated = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      const texts = chunk.map((r) => `${r.title}\n\n${r.content || ""}`);
      const vectors = await embedBatch(texts);
      for (let j = 0; j < chunk.length; j++) {
        const v = vectors[j];
        if (!v) { failed++; continue; }
        const upErr = await writeEntryEmbedding(supabase, chunk[j].id, user.id, v);
        if (upErr) failed++; else updated++;
      }
    }

    // Targeted calls come from embedEntriesSoon after a create/edit. The
    // staleness trigger cleared embedding_v2 (the 1536-dim column behind
    // search-knowledge, smart filing and wiki centroids) along with the 768
    // vector, so refill it here for the same ids — otherwise an edited card
    // silently drops out of cross-wiki search until a manual backfill.
    // Best-effort; deliberately NOT chained to smart-file (that would re-route
    // entries the user just placed).
    let v2_updated = 0;
    if (Array.isArray(entry_ids) && entry_ids.length > 0) {
      try {
        const { data: v2Rows } = await supabase
          .from("knowledge_entries")
          .select("id, title, content")
          .eq("user_id", user.id)
          .in("id", rows.map((r) => r.id))
          .is("embedding_v2", null);
        if (v2Rows && v2Rows.length > 0) {
          v2_updated = await embedV2AndStore(supabase, Deno.env.get("LOVABLE_API_KEY") || "", v2Rows as any, user.id);
        }
      } catch (e) {
        console.warn("knowledge-embed: embedding_v2 refresh skipped:", e);
      }
    }

    // Semantic near-duplicate check for targeted (create/edit) embeds: flag —
    // never merge or delete — an entry whose nearest OLDER living entry in the
    // same wiki is ≥ NEAR_DUPLICATE_COSINE similar. The flag lands in
    // cleanup_flags (reason 'duplicate' — the table built for "should this be
    // deleted?" markers; no client screen reads it yet) and the pairs are
    // returned as possible_duplicates. flagged_by 'chat' because these are
    // write-time checks, and because
    // scan_cleanup_flags wipes non-dismissed 'scan' flags on every rescan.
    // Best-effort: missing RPC (migration 20260917130700) or any error → skip.
    let possible_duplicates: Array<{ entry_id: string; duplicate_of: string; similarity: number }> = [];
    if (Array.isArray(entry_ids) && entry_ids.length > 0 && updated > 0) {
      try {
        const { data: dups, error: dupErr } = await supabase.rpc("find_near_duplicates", {
          p_entry_ids: rows.map((r) => r.id),
          p_threshold: NEAR_DUPLICATE_COSINE,
        });
        if (!dupErr && Array.isArray(dups) && dups.length > 0) {
          possible_duplicates = (dups as any[]).map((d) => ({
            entry_id: d.entry_id, duplicate_of: d.duplicate_of, similarity: d.similarity,
          }));
          const { error: flagErr } = await supabase.from("cleanup_flags").upsert(
            (dups as any[]).map((d) => ({
              user_id: user.id,
              wiki_id: d.wiki_id,
              entry_id: d.entry_id,
              reason: "duplicate",
              note: `Near-duplicate of "${String(d.duplicate_title || "").slice(0, 120)}" (${Math.round(d.similarity * 100)}% similar, detected on save; possible_duplicate_of=${d.duplicate_of}).`,
              confidence: Math.max(0, Math.min(1, Number(d.similarity) || 0)),
              flagged_by: "chat",
            })),
            { onConflict: "entry_id,reason", ignoreDuplicates: true },
          );
          if (flagErr) console.warn("knowledge-embed: duplicate flag write failed:", flagErr.message);
        }
      } catch (e) {
        console.warn("knowledge-embed: near-duplicate check skipped:", e);
      }
    }

    return json({ updated, failed, total: rows.length, model: EMBEDDING_MODEL_ID, v2_updated, possible_duplicates });
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
