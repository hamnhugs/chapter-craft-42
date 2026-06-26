// Shared book-ingestion runner. Used by both the synchronous knowledge-ingest
// endpoint and the background enqueue-ingest worker so behaviour stays in sync.
//
// Designed to run with a service-role Supabase client: every query scopes by
// user_id explicitly, so we never rely on RLS / auth.uid().

import { atomicitySplit, embedAndStore, probeAndLinkConflicts, type Candidate } from "./atomicity.ts";
import { resolveWikiLlm } from "./wiki-llm.ts";

export interface IngestRunResult {
  entries_created: number;
  book_summary?: string;
  entries: Array<{ title: string; type: string }>;
  splits: number;
  conflicts: number;
  skipped_reason?: string;
}

export interface IngestRunOptions {
  supabase: any;
  userId: string;
  bookId: string;
  wikiId?: string | null;
  model?: string | null;
  onProgress?: (msg: string) => Promise<void> | void;
}

const VALID_RELS = new Set([
  "contradicts", "refutes", "supports", "extends",
  "derived_from", "prerequisite", "relates_to", "mentions",
]);

export async function runIngestForBook(opts: IngestRunOptions): Promise<IngestRunResult> {
  const { supabase, userId, bookId, onProgress } = opts;
  let effectiveWikiId: string | null = opts.wikiId || null;

  if (!effectiveWikiId) {
    const { data: settings } = await supabase
      .from("user_settings")
      .select("active_wiki_id")
      .eq("user_id", userId)
      .maybeSingle();
    effectiveWikiId = (settings as any)?.active_wiki_id || null;
  }

  await onProgress?.("Loading book & chapters");

  const [{ data: book }, { data: chapters }] = await Promise.all([
    supabase.from("books").select("*").eq("id", bookId).eq("user_id", userId).single(),
    supabase.from("chapters").select("*").eq("book_id", bookId).eq("user_id", userId).order("start_page"),
  ]);

  if (!book) throw new Error("Book not found");
  if (!chapters || chapters.length === 0) throw new Error("No chapters isolated yet. Isolate chapters first.");

  let dedupQuery = supabase
    .from("knowledge_entries")
    .select("id, title")
    .eq("user_id", userId)
    .eq("source_book_id", bookId);
  if (effectiveWikiId) dedupQuery = dedupQuery.eq("wiki_id", effectiveWikiId);
  const { data: existingEntries } = await dedupQuery;
  const existingTitles = (existingEntries || []).map((e: any) => e.title.toLowerCase());

  const chapterTexts = chapters.map((ch: any) =>
    `## ${ch.name} (pages ${ch.start_page}-${ch.end_page})\n${(ch.text_content || "").slice(0, 6000)}`
  ).join("\n\n");

  await onProgress?.("Calling extraction model");
  const llm = await resolveWikiLlm(supabase, userId);
  const modelToUse = opts.model || llm.model;

  const aiResponse = await fetch(llm.url, {
    method: "POST",
    headers: llm.headers,
    body: JSON.stringify({
      model: modelToUse,
      messages: [
        {
          role: "system",
          content: `You are a knowledge extraction engine for books. Extract key concepts, entities, facts, and syntheses from the book chapters provided. Create comprehensive wiki-style entries.\n\nAlready extracted titles (avoid duplicates): ${existingTitles.join(", ") || "(none)"}`,
        },
        { role: "user", content: `Extract knowledge entries from "${book.title}" (${book.page_count} pages):\n\n${chapterTexts}` },
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
    const status = aiResponse.status;
    if (status === 429) throw new Error("Rate limited by AI gateway");
    if (status === 402) throw new Error("AI credits exhausted");
    throw new Error(`AI extraction failed (${status})`);
  }

  const aiData = await aiResponse.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return { entries_created: 0, entries: [], splits: 0, conflicts: 0, skipped_reason: "No knowledge extracted" };
  }

  const extracted = JSON.parse(toolCall.function.arguments);

  const rawCandidates: Candidate[] = (extracted.entries || [])
    .filter((e: any) => !existingTitles.includes(e.title.toLowerCase()))
    .map((e: any) => ({
      title: e.title,
      content: e.content,
      entry_type: e.entry_type || "concept",
      tags: e.tags || [],
      confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
    }));

  await onProgress?.(`Saving ${rawCandidates.length} candidate entries`);
  const { candidates: atomicAdds, splits } = await atomicitySplit(rawCandidates);

  const savedEntries: any[] = [];
  for (const entry of atomicAdds) {
    const { data: inserted, error } = await supabase
      .from("knowledge_entries")
      .insert({
        user_id: userId,
        title: entry.title,
        content: entry.content,
        entry_type: entry.entry_type,
        tags: entry.tags || [],
        confidence: Math.min(1, Math.max(0, entry.confidence || 0.8)),
        source_book_id: bookId,
        wiki_id: effectiveWikiId,
      } as any)
      .select("id")
      .single();
    if (error || !inserted) { console.error("ingest insert failed:", error?.message); continue; }
    const vec = await embedAndStore(supabase, inserted.id, userId, entry.title, entry.content);
    savedEntries.push({ ...entry, id: inserted.id, embedding: vec });
  }

  for (const entry of extracted.entries || []) {
    const sourceSaved = savedEntries.find((s: any) => s.title.toLowerCase() === (entry.title || "").toLowerCase());
    if (!sourceSaved || !entry.relationships) continue;
    for (const rel of entry.relationships) {
      if (!VALID_RELS.has(rel.relationship)) continue;
      const target = savedEntries.find((e: any) => e.title.toLowerCase() === rel.target_title.toLowerCase());
      if (target && target.id !== sourceSaved.id) {
        await supabase.from("memory_graph").upsert({
          user_id: userId,
          source_entry_id: sourceSaved.id,
          target_entry_id: target.id,
          relationship: rel.relationship,
          created_by: "ingest",
        }, { onConflict: "source_entry_id,target_entry_id,relationship" });
      }
    }
  }

  await onProgress?.("Probing for conflicts");
  const conflictCount = await probeAndLinkConflicts(
    supabase, userId,
    savedEntries.map((e) => ({ id: e.id, title: e.title, content: e.content, embedding: e.embedding })),
  );

  return {
    entries_created: savedEntries.length,
    book_summary: extracted.book_summary,
    entries: savedEntries.map((e) => ({ title: e.title, type: e.entry_type })),
    splits,
    conflicts: conflictCount,
  };
}
