import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveWikiLlm } from "../_shared/wiki-llm.ts";
import { selectLintSample } from "../_shared/lint-sample.ts";
import { selectAllPages } from "../_shared/memory-layers.ts";

// Hard caps on what one lint call sends to the LLM.
const LINT_SAMPLE_BUDGET = 150;
const LINT_EDGE_BUDGET = 300;

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

    // Parse optional scope: { wiki_id?: string|null }. When provided, lint only
    // entries (and edges) inside that wiki. When omitted/null → global behaviour.
    const body = await req.json().catch(() => ({}));
    const wikiId: string | null = body?.wiki_id ?? null;

    // Fetch LIGHT rows for every living entry (optionally scoped to a wiki via
    // the entries_for_wiki RPC) and every edge — explicit columns, paged past
    // PostgREST's silent 1000-row cap. The old code selected * (both vector
    // columns and the tsvector) and then sent ALL entries and ALL edges to the
    // LLM in one unbounded prompt. Stats below still cover the whole library;
    // only the audited sample is capped (see _shared/lint-sample.ts).
    const LITE_COLS = "id, title, confidence, created_at, updated_at, superseded_by";
    const entryRead = (cols: string) => () =>
      (wikiId
        ? supabase.rpc("entries_for_wiki", { target_wiki_id: wikiId }).select(cols)
        : supabase.from("knowledge_entries").select(cols).eq("user_id", user.id))
        .order("id", { ascending: true });
    let entriesRes = await selectAllPages<any>(entryRead(LITE_COLS));
    if (entriesRes.error && (entriesRes.error as any).code === "42703") {
      entriesRes = await selectAllPages<any>(entryRead("id, title, confidence, created_at, updated_at"));
    }
    const graphRes = await selectAllPages<any>(() =>
      (wikiId
        ? supabase.rpc("memory_graph_for_wiki", { target_wiki_id: wikiId }).select("id, source_entry_id, target_entry_id, relationship")
        : supabase.from("memory_graph").select("id, source_entry_id, target_entry_id, relationship").eq("user_id", user.id))
        .order("id", { ascending: true })
    );
    if (entriesRes.error || graphRes.error) {
      const err = entriesRes.error || graphRes.error;
      console.error("knowledge-lint read failed:", err?.message);
      return new Response(JSON.stringify({ error: "Couldn't read the wiki for linting" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Superseded versions are history, not lint targets.
    const entries: any[] = entriesRes.rows.filter((e) => !e.superseded_by);
    const graph: any[] = graphRes.rows;

    if (entries.length === 0) {
      return new Response(JSON.stringify({
        issues: [],
        suggestions: [],
        stats: { total_entries: 0, total_relationships: 0, orphan_count: 0 },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Find orphan entries (no relationships) — over the whole library.
    const connectedIds = new Set<string>([
      ...graph.map((g) => g.source_entry_id),
      ...graph.map((g) => g.target_entry_id),
    ]);
    const orphans = entries.filter((e) => !connectedIds.has(e.id));

    // Bounded audit sample: ≤ LINT_SAMPLE_BUDGET entries, prioritized by likely
    // duplicates, lowest confidence, orphans, stalest. Content is fetched for
    // the sample only.
    const sample = selectLintSample(entries, connectedIds, LINT_SAMPLE_BUDGET);
    const sampleSet = new Set(sample.ids);
    const { data: sampleRows } = await supabase
      .from("knowledge_entries")
      .select("id, title, content, entry_type, confidence, tags")
      .in("id", sample.ids);
    const byId = new Map(((sampleRows || []) as any[]).map((r) => [r.id, r]));
    const sampled = sample.ids.map((id) => byId.get(id)).filter(Boolean) as any[];

    const entrySummary = sampled.map((e) =>
      `[${e.id.slice(0, 8)}] "${e.title}" (${e.entry_type}, confidence: ${e.confidence}, tags: ${e.tags?.join(", ") || "none"})\n${(e.content || "").slice(0, 200)}`
    ).join("\n\n");

    const sampleEdges = graph
      .filter((g) => sampleSet.has(g.source_entry_id) && sampleSet.has(g.target_entry_id))
      .slice(0, LINT_EDGE_BUDGET);
    const graphSummary = sampleEdges.map((g) =>
      `${g.source_entry_id.slice(0, 8)} --${g.relationship}--> ${g.target_entry_id.slice(0, 8)}`
    ).join("\n");
    const sampledOrphanTitles = orphans.filter((o) => sampleSet.has(o.id)).map((o) => o.title);
    const scopeNote = sampled.length < entries.length
      ? `\n\nNOTE: this is a prioritized sample of ${sampled.length} of ${entries.length} entries (likely duplicates, lowest confidence, orphans and stalest first); relationships are limited to edges among the sampled entries. ${orphans.length} entries in total have no connections.`
      : "";

    const llm = await resolveWikiLlm(supabase, user.id);
    const aiResponse = await fetch(llm.url, {
      method: "POST",
      headers: llm.headers,
      body: JSON.stringify({
        model: llm.model,
        messages: [
          {
            role: "system",
            content: `You are a knowledge base quality auditor. Analyze the wiki entries and their relationships for issues.`,
          },
          {
            role: "user",
            content: `Analyze these knowledge entries for issues:\n\nENTRIES:\n${entrySummary}\n\nRELATIONSHIPS:\n${graphSummary || "(none)"}\n\nORPHAN ENTRIES (no connections): ${sampledOrphanTitles.join(", ") || "(none)"}${scopeNote}`,
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
        total_relationships: graph.length,
        sampled_entries: sampled.length,
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
