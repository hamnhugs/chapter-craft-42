import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { atomicitySplit, embedAndStore, probeAndLinkConflicts, type Candidate } from "../_shared/atomicity.ts";
import { resolveWikiLlm } from "../_shared/wiki-llm.ts";

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

    const { book_id, wiki_id } = await req.json();
    if (!book_id) {
      return new Response(JSON.stringify({ error: "book_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve wiki_id: explicit param wins, otherwise fall back to user_settings.active_wiki_id
    let effectiveWikiId: string | null = wiki_id || null;
    if (!effectiveWikiId) {
      const { data: settings } = await supabase
        .from("user_settings")
        .select("active_wiki_id")
        .eq("user_id", user.id)
        .maybeSingle();
      effectiveWikiId = (settings as any)?.active_wiki_id || null;
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

    // Fetch existing entries for this book (scoped to wiki when set)
    let dedupQuery = supabase
      .from("knowledge_entries")
      .select("id, title")
      .eq("user_id", user.id)
      .eq("source_book_id", book_id);
    if (effectiveWikiId) dedupQuery = dedupQuery.eq("wiki_id", effectiveWikiId);
    const { data: existingEntries } = await dedupQuery;

    const existingTitles = (existingEntries || []).map(e => e.title.toLowerCase());

    const chapterTexts = chapters.map(ch =>
      `## ${ch.name} (pages ${ch.start_page}-${ch.end_page})\n${(ch.text_content || "").slice(0, 6000)}`
    ).join("\n\n");

    const llm = await resolveWikiLlm(supabase, user.id);
    const aiResponse = await fetch(llm.url, {
      method: "POST",
      headers: llm.headers,
      body: JSON.stringify({
        model: llm.model,
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

    // Atomicity split
    const rawCandidates: Candidate[] = (extracted.entries || [])
      .filter((e: any) => !existingTitles.includes(e.title.toLowerCase()))
      .map((e: any) => ({
        title: e.title,
        content: e.content,
        entry_type: e.entry_type || "concept",
        tags: e.tags || [],
        confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
      }));
    const { candidates: atomicAdds, splits } = await atomicitySplit(rawCandidates);

    for (const entry of atomicAdds) {
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
          wiki_id: effectiveWikiId,
        } as any)
        .select("id")
        .single();

      if (error || !inserted) { console.error("ingest insert failed:", error?.message); continue; }
      const vec = await embedAndStore(supabase, inserted.id, user.id, entry.title, entry.content);
      savedEntries.push({ ...entry, id: inserted.id, embedding: vec });
    }

    // LLM-asserted relationships from the original extraction (preserve when present)
    const VALID_RELS = new Set(["contradicts","refutes","supports","extends","derived_from","prerequisite","relates_to","mentions"]);
    for (const entry of extracted.entries || []) {
      const sourceSaved = savedEntries.find((s: any) => s.title.toLowerCase() === (entry.title || "").toLowerCase());
      if (!sourceSaved || !entry.relationships) continue;
      for (const rel of entry.relationships) {
        if (!VALID_RELS.has(rel.relationship)) continue;
        const target = savedEntries.find((e: any) => e.title.toLowerCase() === rel.target_title.toLowerCase());
        if (target && target.id !== sourceSaved.id) {
          await supabase.from("memory_graph").upsert({
            user_id: user.id,
            source_entry_id: sourceSaved.id,
            target_entry_id: target.id,
            relationship: rel.relationship,
            created_by: "ingest",
          }, { onConflict: "source_entry_id,target_entry_id,relationship" });
        }
      }
    }

    // Conflict probe across whole library
    const conflictCount = await probeAndLinkConflicts(
      supabase, user.id,
      savedEntries.map((e) => ({ id: e.id, title: e.title, content: e.content, embedding: e.embedding })),
    );

    // Fire-and-forget: generate halfvec(1536) embeddings for new entries
    const newIds = savedEntries.filter((e) => e.id).map((e) => e.id);
    if (newIds.length > 0) {
      try {
        fetch(`${supabaseUrl}/functions/v1/embed-entries`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ entry_ids: newIds }),
        }).catch((err) => console.warn("embed-entries fire-and-forget failed:", err));
      } catch (err) { console.warn("embed-entries dispatch error:", err); }
    }

    return new Response(JSON.stringify({
      entries_created: savedEntries.length,
      book_summary: extracted.book_summary,
      entries: savedEntries.map(e => ({ title: e.title, type: e.entry_type })),
      splits,
      conflicts: conflictCount,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("knowledge-ingest error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
