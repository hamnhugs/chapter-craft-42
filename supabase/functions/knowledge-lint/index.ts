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

    // Fetch all user's knowledge entries and graph
    const [{ data: entries }, { data: graph }] = await Promise.all([
      supabase.from("knowledge_entries").select("*").eq("user_id", user.id).order("created_at"),
      supabase.from("memory_graph").select("*").eq("user_id", user.id),
    ]);

    if (!entries || entries.length === 0) {
      return new Response(JSON.stringify({
        issues: [],
        suggestions: [],
        stats: { total_entries: 0, total_relationships: 0, orphan_count: 0 },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const entrySummary = entries.map(e =>
      `[${e.id.slice(0, 8)}] "${e.title}" (${e.entry_type}, confidence: ${e.confidence}, tags: ${e.tags?.join(", ") || "none"})\n${e.content.slice(0, 200)}`
    ).join("\n\n");

    const graphSummary = (graph || []).map(g =>
      `${g.source_entry_id.slice(0, 8)} --${g.relationship}--> ${g.target_entry_id.slice(0, 8)}`
    ).join("\n");

    // Find orphan entries (no relationships)
    const connectedIds = new Set([
      ...(graph || []).map(g => g.source_entry_id),
      ...(graph || []).map(g => g.target_entry_id),
    ]);
    const orphans = entries.filter(e => !connectedIds.has(e.id));

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content: `You are a knowledge base quality auditor. Analyze the wiki entries and their relationships for issues.`,
          },
          {
            role: "user",
            content: `Analyze these knowledge entries for issues:\n\nENTRIES:\n${entrySummary}\n\nRELATIONSHIPS:\n${graphSummary || "(none)"}\n\nORPHAN ENTRIES (no connections): ${orphans.map(o => o.title).join(", ") || "(none)"}`,
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "report_lint_results",
            description: "Report wiki quality issues and suggestions",
            parameters: {
              type: "object",
              properties: {
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["contradiction", "stale", "duplicate", "low_confidence", "orphan", "missing_concept"] },
                      severity: { type: "string", enum: ["low", "medium", "high"] },
                      description: { type: "string" },
                      affected_entries: { type: "array", items: { type: "string" }, description: "Titles of affected entries" },
                      suggested_fix: { type: "string" },
                    },
                    required: ["type", "severity", "description"],
                  },
                },
                suggestions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["new_entry", "merge_entries", "add_relationship", "update_content"] },
                      description: { type: "string" },
                      priority: { type: "string", enum: ["low", "medium", "high"] },
                    },
                    required: ["type", "description", "priority"],
                  },
                },
                health_score: { type: "number", description: "0-100 overall health score" },
              },
              required: ["issues", "suggestions", "health_score"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "report_lint_results" } },
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Lint analysis failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    const results = toolCall ? JSON.parse(toolCall.function.arguments) : { issues: [], suggestions: [], health_score: 100 };

    return new Response(JSON.stringify({
      ...results,
      stats: {
        total_entries: entries.length,
        total_relationships: (graph || []).length,
        orphan_count: orphans.length,
        avg_confidence: entries.reduce((sum, e) => sum + (e.confidence || 0), 0) / entries.length,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("knowledge-lint error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
