import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ExtractedEntry {
  title: string;
  content: string;
  entry_type: string;
  tags: string[];
  confidence: number;
  relationships: { target_title: string; relationship: string }[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
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

    const { messages, source_book_id } = await req.json();
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch existing entries for deduplication
    const { data: existingEntries } = await supabase
      .from("knowledge_entries")
      .select("id, title, content, entry_type, tags")
      .eq("user_id", user.id)
      .limit(200);

    const existingSummary = (existingEntries || [])
      .map(e => `- "${e.title}" (${e.entry_type}): ${e.content.slice(0, 100)}`)
      .join("\n");

    const conversationText = messages
      .map((m: any) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const systemPrompt = `You are a knowledge extraction engine. Analyze the conversation and extract distinct knowledge entries (concepts, entities, facts, syntheses, comparisons, summaries).

EXISTING KNOWLEDGE (avoid duplicates, update if new info available):
${existingSummary || "(none yet)"}

For each entry, determine if it should be ADDED (new knowledge) or if it UPDATES an existing entry.

Rules:
- Extract 1-8 entries per conversation
- Each entry needs a clear, specific title
- Content should be concise markdown (2-5 sentences)
- Assign confidence 0.5-1.0 based on how well-supported the knowledge is
- Tag with relevant topics
- Note relationships between entries`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Extract knowledge entries from this conversation:\n\n${conversationText}` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "save_knowledge_entries",
            description: "Save extracted knowledge entries from the conversation",
            parameters: {
              type: "object",
              properties: {
                entries: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string", description: "Clear, specific title for this knowledge entry" },
                      content: { type: "string", description: "Concise markdown content (2-5 sentences)" },
                      entry_type: { type: "string", enum: ["concept", "entity", "synthesis", "fact", "comparison", "summary"] },
                      tags: { type: "array", items: { type: "string" } },
                      confidence: { type: "number", description: "0.5-1.0 confidence score" },
                      action: { type: "string", enum: ["ADD", "UPDATE", "NO-OP"], description: "Whether to add new, update existing, or skip" },
                      existing_title: { type: "string", description: "If UPDATE, the title of the existing entry to update" },
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
                    required: ["title", "content", "entry_type", "tags", "confidence", "action"],
                  },
                },
                conversation_summary: { type: "string", description: "Brief summary of what was discussed" },
                key_facts: { type: "array", items: { type: "string" }, description: "Key facts learned from this conversation" },
              },
              required: ["entries", "conversation_summary", "key_facts"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "save_knowledge_entries" } },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errText);
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, please try again later" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "AI extraction failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
      if (entry.action === "NO-OP") continue;

      if (entry.action === "UPDATE" && entry.existing_title) {
        const existing = (existingEntries || []).find(
          e => e.title.toLowerCase() === entry.existing_title.toLowerCase()
        );
        if (existing) {
          await supabase.from("knowledge_entries").update({
            content: entry.content,
            tags: entry.tags,
            confidence: Math.min(1, Math.max(0, entry.confidence)),
          }).eq("id", existing.id).eq("user_id", user.id);
          savedEntries.push({ ...entry, id: existing.id, action: "UPDATED" });
          continue;
        }
      }

      // ADD
      const { data: inserted, error: insertError } = await supabase
        .from("knowledge_entries")
        .insert({
          user_id: user.id,
          title: entry.title,
          content: entry.content,
          entry_type: entry.entry_type,
          tags: entry.tags || [],
          confidence: Math.min(1, Math.max(0, entry.confidence || 0.8)),
          source_book_id: source_book_id || null,
        })
        .select("id")
        .single();

      if (!insertError && inserted) {
        savedEntries.push({ ...entry, id: inserted.id, action: "ADDED" });
      }
    }

    // Create relationships
    const allEntries = [...(existingEntries || []), ...savedEntries.filter(e => e.id)];
    for (const entry of savedEntries) {
      if (!entry.relationships || !entry.id) continue;
      for (const rel of entry.relationships) {
        const target = allEntries.find(
          e => e.title.toLowerCase() === rel.target_title.toLowerCase()
        );
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

    // Update conversation memory
    const { data: existingMemory } = await supabase
      .from("conversation_memory")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    const newKeyFacts = extracted.key_facts || [];
    if (existingMemory) {
      const existingFacts = Array.isArray(existingMemory.key_facts) ? existingMemory.key_facts : [];
      const mergedFacts = [...existingFacts, ...newKeyFacts].slice(-50);
      const newSummary = existingMemory.summary
        ? `${existingMemory.summary}\n\n---\n\n${extracted.conversation_summary}`
        : extracted.conversation_summary;
      // Keep summary under ~2000 chars
      const trimmedSummary = newSummary.length > 2000
        ? newSummary.slice(newSummary.length - 2000)
        : newSummary;

      await supabase.from("conversation_memory").update({
        summary: trimmedSummary,
        key_facts: mergedFacts,
        total_conversations: (existingMemory.total_conversations || 0) + 1,
      }).eq("user_id", user.id);
    } else {
      await supabase.from("conversation_memory").insert({
        user_id: user.id,
        summary: extracted.conversation_summary || "",
        key_facts: newKeyFacts,
        total_conversations: 1,
      });
    }

    return new Response(JSON.stringify({
      entries: savedEntries,
      summary: extracted.conversation_summary,
      key_facts: newKeyFacts,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("knowledge-extract error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
