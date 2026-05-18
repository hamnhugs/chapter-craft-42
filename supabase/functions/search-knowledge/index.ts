// Cross-wiki semantic search.
// Body: { query: string, wiki_ids?: string[] (null/empty = all wikis), threshold?, limit? }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedTexts, vectorLiteral } from "../_shared/wiki-embed.ts";

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
    const query: string = (body?.query || "").toString().trim();
    const wikiIds: string[] | null = Array.isArray(body?.wiki_ids) && body.wiki_ids.length > 0 ? body.wiki_ids : null;
    const threshold: number = typeof body?.threshold === "number" ? body.threshold : 0.3;
    const limit: number = Math.min(Math.max(body?.limit || 20, 1), 50);

    if (!query) {
      return new Response(JSON.stringify({ error: "query required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Embed the query
    const [queryVec] = await embedTexts(LOVABLE_API_KEY, [query]);

    // Call the RPC. auth.uid() inside the function scopes to this user.
    const { data: matches, error: rpcError } = await supabase.rpc("match_knowledge_entries", {
      query_embedding: vectorLiteral(queryVec) as unknown as any,
      match_threshold: threshold,
      match_count: limit,
      filter_wiki_ids: wikiIds,
    });

    if (rpcError) {
      console.error("match_knowledge_entries error:", rpcError);
      return new Response(JSON.stringify({ error: rpcError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hydrate with wiki names for nicer client rendering.
    const wikiIdsInResults = Array.from(new Set((matches || []).map((m: any) => m.wiki_id).filter(Boolean)));
    let wikiMap: Record<string, { name: string; cover_color: string }> = {};
    if (wikiIdsInResults.length > 0) {
      const { data: wikis } = await supabase
        .from("wikis")
        .select("id, name, cover_color")
        .in("id", wikiIdsInResults);
      for (const w of wikis || []) {
        wikiMap[(w as any).id] = { name: (w as any).name, cover_color: (w as any).cover_color };
      }
    }

    return new Response(
      JSON.stringify({
        query,
        count: (matches || []).length,
        matches: (matches || []).map((m: any) => ({
          ...m,
          wiki_name: m.wiki_id ? wikiMap[m.wiki_id]?.name || null : null,
          wiki_color: m.wiki_id ? wikiMap[m.wiki_id]?.cover_color || null : null,
        })),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("search-knowledge error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
