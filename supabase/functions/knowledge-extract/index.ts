import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { atomicitySplit, embedAndStore, probeAndLinkConflicts, type Candidate } from "../_shared/atomicity.ts";
import { embedOne } from "../_shared/embed.ts";
import { resolveWikiLlm } from "../_shared/wiki-llm.ts";
import {
  checkRecordingMode,
  logEpisode,
  enqueueEntry,
  enqueueConflictStaged,
  QUEUE_PRIORITY,
} from "../_shared/memory-layers.ts";

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

    // ── Layer 2 Encoding Gate: block writes when in Retrieval Mode ──────────
    const gate = await checkRecordingMode(supabase, user.id);
    if (!gate.allowed) {
      return new Response(JSON.stringify({ error: gate.reason, mode: "retrieval" }), {
        status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { messages, source_book_id, session_id, wiki_id } = await req.json();
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Derive a stable session id for the episodic log.
    const effectiveSessionId: string = session_id || `sess_${Date.now()}`;

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

    // Fetch existing entries for deduplication (scoped to active wiki when set)
    let dedupQuery = supabase
      .from("knowledge_entries")
      .select("id, title, content, entry_type, tags")
      .eq("user_id", user.id)
      .limit(200);
    if (effectiveWikiId) dedupQuery = dedupQuery.eq("wiki_id", effectiveWikiId);
    const { data: existingEntries } = await dedupQuery;

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

    const llm = await resolveWikiLlm(supabase, user.id);
    const aiResponse = await fetch(llm.url, {
      method: "POST",
      headers: llm.headers,
      body: JSON.stringify({
        model: llm.model,
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

    // Partition into UPDATE vs ADD candidates
    const updateEntries = (extracted.entries || []).filter((e: any) => e.action === "UPDATE" && e.existing_title);
    const addEntriesRaw: Candidate[] = (extracted.entries || [])
      .filter((e: any) => e.action === "ADD" || (!e.action && e.title))
      .map((e: any) => ({
        title: e.title,
        content: e.content,
        entry_type: e.entry_type || "concept",
        tags: e.tags || [],
        confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
      }));

    // Atomicity split for new entries
    const { candidates: atomicAdds, splits } = await atomicitySplit(addEntriesRaw);

    // Apply UPDATEs
    for (const entry of updateEntries) {
      const existing = (existingEntries || []).find(
        (e: any) => e.title.toLowerCase() === entry.existing_title.toLowerCase()
      );
      if (existing) {
        await supabase.from("knowledge_entries").update({
          content: entry.content,
          tags: entry.tags,
          confidence: Math.min(1, Math.max(0, entry.confidence)),
        }).eq("id", existing.id).eq("user_id", user.id);
        const vec = await embedAndStore(supabase, existing.id, user.id, entry.title, entry.content);
        savedEntries.push({ ...entry, id: existing.id, action: "UPDATED", embedding: vec });
      }
    }

    // Apply ADDs (atomic), with semantic dedup first.
    // The LLM only sees titles + 100-char previews, so it misses duplicates
    // that are worded differently ("Python classes explained" vs "How to use
    // classes in Python"). Before inserting, compare the new entry's embedding
    // against existing entries (Mem0-style ADD/UPDATE/NOOP adjudication):
    //   similarity >= 0.92 → near-identical, skip (NOOP)
    //   similarity >= 0.85 → same topic, merge into the existing entry (UPDATE)
    //   otherwise          → genuinely new, insert (ADD)
    const dedupIds = new Set((existingEntries || []).map((e: any) => e.id));
    for (const entry of atomicAdds) {
      let dedupHit: { id: string; similarity: number } | null = null;
      try {
        const vecPre = await embedOne(`${entry.title}\n${entry.content}`);
        if (vecPre) {
          const { data: near } = await supabase.rpc("match_knowledge", {
            query_embedding: vecPre as any,
            match_count: 3,
          });
          // Only entries in the dedup scope (active wiki) count as duplicates.
          const top = ((near || []) as any[]).find(
            (m) => dedupIds.has(m.id) && typeof m.similarity === "number",
          );
          if (top && top.similarity >= 0.85) dedupHit = { id: top.id, similarity: top.similarity };
        }
      } catch (err) { console.warn("semantic dedup check failed, treating as ADD:", err); }

      if (dedupHit && dedupHit.similarity >= 0.92) {
        savedEntries.push({ ...entry, id: dedupHit.id, action: "SKIPPED_DUPLICATE" });
        continue;
      }
      if (dedupHit) {
        await supabase.from("knowledge_entries").update({
          content: entry.content,
          tags: entry.tags || [],
          confidence: Math.min(1, Math.max(0, entry.confidence || 0.8)),
        }).eq("id", dedupHit.id).eq("user_id", user.id);
        const vec = await embedAndStore(supabase, dedupHit.id, user.id, entry.title, entry.content);
        savedEntries.push({ ...entry, id: dedupHit.id, action: "UPDATED", embedding: vec });
        continue;
      }

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
          wiki_id: effectiveWikiId,
        } as any)
        .select("id")
        .single();

      if (insertError) { console.error("insert failed:", insertError.message); continue; }
      if (!inserted) continue;
      const vec = await embedAndStore(supabase, inserted.id, user.id, entry.title, entry.content);
      savedEntries.push({ ...entry, id: inserted.id, action: "ADDED", embedding: vec });
    }

    // ── Conflict probe + encoding gate: route hard conflicts to queue ───────
    // probeAndLinkConflicts writes memory_graph edges and knowledge_conflicts rows.
    // For entries flagged as hard contradictions, we additionally enqueue them
    // in the consolidation_queue with reason 'conflict_staged' so the Sleep
    // Cycle can generate bridging edges before they become part of the graph.
    const conflictCount = await probeAndLinkConflicts(
      supabase,
      user.id,
      savedEntries
        .filter((e) => e.id && e.action !== "SKIPPED_DUPLICATE")
        .map((e) => ({
          id: e.id, title: e.title, content: e.content, embedding: e.embedding,
        })),
    );

    if (conflictCount > 0) {
      // Enqueue each entry that triggered an open conflict for Sleep Cycle review.
      const { data: openConflicts } = await supabase
        .from("knowledge_conflicts")
        .select("entry_a")
        .eq("user_id", user.id)
        .eq("status", "open");
      for (const c of (openConflicts || []) as any[]) {
        await enqueueEntry(supabase, user.id, c.entry_a, "conflict_staged");
      }
    }

    // Queue all new entries for edge generation in the Sleep Cycle.
    for (const e of savedEntries.filter((e) => e.id && e.action === "ADDED")) {
      await enqueueEntry(supabase, user.id, e.id, "new_entry");
    }

    // Create LLM-asserted relationships (enum-validated)
    const VALID_RELS = new Set(["contradicts","refutes","supports","extends","derived_from","prerequisite","relates_to","mentions"]);
    const allEntries = [...(existingEntries || []), ...savedEntries.filter(e => e.id)];
    for (const entry of savedEntries) {
      if (!entry.relationships || !entry.id) continue;
      for (const rel of entry.relationships) {
        if (!VALID_RELS.has(rel.relationship)) continue;
        const target = allEntries.find(
          e => e.title.toLowerCase() === rel.target_title.toLowerCase()
        );
        if (target && target.id !== entry.id) {
          await supabase.from("memory_graph").upsert({
            user_id: user.id,
            source_entry_id: entry.id,
            target_entry_id: target.id,
            relationship: rel.relationship,
            created_by: "ingest",
          }, { onConflict: "source_entry_id,target_entry_id,relationship" });
        }
      }
    }

    // ── Layer 2: Write to episodic_log (one row per session) ────────────────
    // This replaces the old single-row conversation_memory pattern for new sessions.
    // The legacy conversation_memory row is still updated for backward compat
    // with any code that reads the rolling summary.
    const newKeyFacts = extracted.key_facts || [];
    await logEpisode(
      supabase,
      user.id,
      effectiveSessionId,
      extracted.conversation_summary || "",
      newKeyFacts,
      savedEntries.length,
      effectiveWikiId,
    );

    // Legacy rolling summary update (kept for WikiPanel backward compat).
    const { data: existingMemory } = await supabase
      .from("conversation_memory")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingMemory) {
      const existingFacts = Array.isArray(existingMemory.key_facts) ? existingMemory.key_facts : [];
      const mergedFacts = [...existingFacts, ...newKeyFacts].slice(-50);
      const newSummary = existingMemory.summary
        ? `${existingMemory.summary}\n\n---\n\n${extracted.conversation_summary}`
        : extracted.conversation_summary;
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

    // Fire-and-forget: generate halfvec(1536) embeddings for new entries
    const newIds = savedEntries.filter((e) => e.id && e.action === "ADDED").map((e) => e.id);
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
      entries: savedEntries.map((e) => ({ ...e, embedding: undefined })),
      summary: extracted.conversation_summary,
      key_facts: newKeyFacts,
      splits,
      conflicts: conflictCount,
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
