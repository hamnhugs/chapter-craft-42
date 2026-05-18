// Generate embeddings for knowledge_entries (writes to embedding_v2).
// Accepts either:
//   { entry_ids: string[] } — embed these specific entries
//   { backfill: true, limit?: number } — embed up to N entries with no embedding_v2 yet

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedAndStore } from "../_shared/wiki-embed.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const entryIds: string[] | undefined = body?.entry_ids;
    const backfill: boolean = !!body?.backfill;
    const backfillLimit: number = Math.min(Math.max(body?.limit || 50, 1), 200);

    let query = supabase
      .from("knowledge_entries")
      .select("id, title, content")
      .eq("user_id", user.id);

    if (entryIds && entryIds.length > 0) {
      query = query.in("id", entryIds);
    } else if (backfill) {
      query = query.is("embedding_v2", null).limit(backfillLimit);
    } else {
      return new Response(JSON.stringify({ error: "Provide entry_ids or set backfill=true" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: entries, error: fetchError } = await query;
    if (fetchError) throw fetchError;
    if (!entries || entries.length === 0) {
      return new Response(JSON.stringify({ embedded: 0, attempted: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const embedded = await embedAndStore(supabase, LOVABLE_API_KEY, entries as any, user.id);

    return new Response(
      JSON.stringify({ embedded, attempted: entries.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("embed-entries error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
