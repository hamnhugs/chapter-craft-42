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

    const { book_id } = await req.json();
    if (!book_id) {
      return new Response(JSON.stringify({ error: "book_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch book and chapters
    const [{ data: book }, { data: chapters }] = await Promise.all([
      supabase.from("books").select("*").eq("id", book_id).eq("user_id", user.id).single(),
      supabase.from("chapters").select("*").eq("book_id", book_id).eq("user_id", user.id).order("start_page"),
    ]);

    if (!book) {
      return new Response(JSON.stringify({ error: "Book not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!chapters || chapters.length === 0) {
      return new Response(JSON.stringify({ error: "No chapters isolated yet. Isolate chapters first." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch existing entries for this book
    const { data: existingEntries } = await supabase
      .from("knowledge_entries")
      .select("id, title")
      .eq("user_id", user.id)
      .eq("source_book_id", book_id);

    const existingTitles = (existingEntries || []).map(e => e.title.toLowerCase());

    const chapterTexts = chapters.map(ch =>
      `## ${ch.name} (pages ${ch.start_page}-${ch.end_page})\n${(ch.text_content || "").slice(0, 6000)}`
    ).join("\n\n");

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
            content: `You are a knowledge extraction engine for books. Extract key concepts, entities, facts, and syntheses from the book chapters provided. Create comprehensive wiki-style entries.

Already extracted titles (avoid duplicates): ${existingTitles.join(", ") || "(none)"}`,
          },
          {
            role: "user",
            content: `Extract knowledge entries from "${book.title}" (${book.page_count} pages):\n\n${chapterTexts}`,
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "save_book_knowledge",
            description: "Save extracted knowledge from a book",
            parameters: {
              type: "object",
              properties: {
                entries: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      content: { type: "string" },
                      entry_type: { type: "string", enum: ["concept", "entity", "synthesis", "fact", "comparison", "summary"] },
                      tags: { type: "array", items: { type: "string" } },
                      confidence: { type: "number" },
                      relationships: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            target_title: { type: "string" },
                            relationship: { type: "string", enum: ["relates_to", "contradicts", "extends", "supports", "derived_from", "prerequisite"] },
                          },
                          required: ["target_title", "relationship"],
                        },
                      },
                    },
                    required: ["title", "content", "entry_type", "tags", "confidence"],
                  },
                },
                book_summary: { type: "string" },
              },
              required: ["entries", "book_summary"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "save_book_knowledge" } },
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "AI extraction failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      return new Response(JSON.stringify({ entries: [], summary: "No knowledge extracted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const extracted = JSON.parse(toolCall.function.arguments);
    const savedEntries: any[] = [];

    for (const entry of extracted.entries || []) {
      if (existingTitles.includes(entry.title.toLowerCase())) continue;

      const { data: inserted, error } = await supabase
        .from("knowledge_entries")
        .insert({
          user_id: user.id,
          title: entry.title,
          content: entry.content,
          entry_type: entry.entry_type,
          tags: entry.tags || [],
          confidence: Math.min(1, Math.max(0, entry.confidence || 0.8)),
          source_book_id: book_id,
        })
        .select("id")
        .single();

      if (!error && inserted) {
        savedEntries.push({ ...entry, id: inserted.id });
      }
    }

    // Create relationships between new entries
    for (const entry of savedEntries) {
      if (!entry.relationships) continue;
      for (const rel of entry.relationships) {
        const target = savedEntries.find(e => e.title.toLowerCase() === rel.target_title.toLowerCase());
        if (target && target.id !== entry.id) {
          await supabase.from("memory_graph").upsert({
            user_id: user.id,
            source_entry_id: entry.id,
            target_entry_id: target.id,
            relationship: rel.relationship,
          }, { onConflict: "source_entry_id,target_entry_id,relationship" });
        }
      }
    }

    return new Response(JSON.stringify({
      entries_created: savedEntries.length,
      book_summary: extracted.book_summary,
      entries: savedEntries.map(e => ({ title: e.title, type: e.entry_type })),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("knowledge-ingest error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
