// Atomicity + conflict-probe helper for ingestion pipelines.
// Splits compound entries, probes for contradictions against nearest existing nodes,
// inserts entries, embeds them, creates contradicts/refutes/supports edges,
// and logs conflicts to public.knowledge_conflicts.
import { embedOne, EMBEDDING_MODEL_ID } from "./embed.ts";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface Candidate {
  title: string;
  content: string;
  entry_type: string;
  tags: string[];
  confidence: number;
  source_book_id?: string | null;
}

export interface IngestStats {
  inserted: number;
  split: number;
  conflicts: number;
  embedded: number;
}

/**
 * Ask the LLM to split compound entries (>1500 chars OR multi-claim) into atomic pieces.
 * Returns the original entries unchanged if no split needed; otherwise replaces them.
 */
export async function atomicitySplit(candidates: Candidate[]): Promise<{ candidates: Candidate[]; splits: number }> {
  if (!LOVABLE_API_KEY) return { candidates, splits: 0 };
  const needsSplit = candidates.filter((c) => (c.content?.length || 0) > 1500);
  if (needsSplit.length === 0) return { candidates, splits: 0 };

  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "system",
          content:
            "You enforce atomicity in a knowledge graph. Each node should express ONE claim or concept. Split compound entries into atomic children. Each child must be self-contained, < 1200 chars, with a precise title. Preserve entry_type, tags, confidence on each child.",
        },
        {
          role: "user",
          content: `Split these entries into atomic nodes if they cover multiple claims:\n${JSON.stringify(needsSplit, null, 2)}`,
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "submit_split",
          description: "Submit atomic entries",
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
                    entry_type: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                    confidence: { type: "number" },
                  },
                  required: ["title", "content", "entry_type"],
                },
              },
            },
            required: ["entries"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "submit_split" } },
    }),
  });

  if (!resp.ok) return { candidates, splits: 0 };
  const data = await resp.json();
  const tc = data?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) return { candidates, splits: 0 };
  let atomic: Candidate[] = [];
  try {
    atomic = (JSON.parse(tc.function.arguments).entries || []).map((e: any) => ({
      title: e.title,
      content: e.content,
      entry_type: e.entry_type || "concept",
      tags: e.tags || [],
      confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
    }));
  } catch { return { candidates, splits: 0 }; }

  // Replace original compound entries with their atomic children
  const compoundTitles = new Set(needsSplit.map((c) => c.title.toLowerCase()));
  const kept = candidates.filter((c) => !compoundTitles.has(c.title.toLowerCase()));
  return { candidates: [...kept, ...atomic], splits: needsSplit.length };
}

/**
 * Probe each new entry against nearest neighbors. If a contradiction/refutation/support
 * is detected, create a memory_graph edge and (for negatives) a knowledge_conflicts row.
 */
export async function probeAndLinkConflicts(
  supabase: any,
  user_id: string,
  newEntries: { id: string; title: string; content: string; embedding: number[] | null }[],
): Promise<number> {
  if (!LOVABLE_API_KEY) return 0;
  let conflictCount = 0;

  for (const entry of newEntries) {
    if (!entry.embedding) continue;
    const { data: neighbors } = await supabase.rpc("match_knowledge", {
      query_embedding: entry.embedding as any,
      match_count: 6,
    });
    const candidates = (neighbors || []).filter((n: any) => n.id !== entry.id);
    if (candidates.length === 0) continue;

    const resp = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content:
              "You audit knowledge graph relationships. Compare the NEW entry to each CANDIDATE. For each, classify the relationship as one of: contradicts (mutually exclusive), refutes (new disproves old), supports (new corroborates old), supersedes (new replaces old), consistent (no notable structural link). Only emit edges for clear semantic relationships, not loose topical overlap.",
          },
          {
            role: "user",
            content: `NEW ENTRY:\nTitle: ${entry.title}\nContent: ${entry.content.slice(0, 2000)}\n\nCANDIDATES:\n${candidates
              .map((c: any, i: number) => `[${i}] id=${c.id} | "${c.title}"\n${(c.content || "").slice(0, 1500)}`)
              .join("\n\n")}`,
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "report_conflicts",
            parameters: {
              type: "object",
              properties: {
                assessments: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      target_id: { type: "string" },
                      kind: { type: "string", enum: ["contradicts", "refutes", "supports", "supersedes", "consistent"] },
                      rationale: { type: "string" },
                    },
                    required: ["target_id", "kind"],
                  },
                },
              },
              required: ["assessments"],
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "report_conflicts" } },
      }),
    });

    if (!resp.ok) continue;
    const data = await resp.json();
    const tc = data?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) continue;
    let assessments: any[] = [];
    try { assessments = JSON.parse(tc.function.arguments).assessments || []; } catch { continue; }

    for (const a of assessments) {
      if (!a.target_id || a.kind === "consistent") continue;
      const target = candidates.find((c: any) => c.id === a.target_id);
      if (!target) continue;

      // Map "supersedes" → edge "refutes" + conflict
      const edgeRel = a.kind === "supersedes" ? "refutes" : a.kind;
      const validEdge = ["contradicts", "refutes", "supports"].includes(edgeRel);
      if (!validEdge) continue;

      await supabase.from("memory_graph").upsert({
        user_id,
        source_entry_id: entry.id,
        target_entry_id: target.id,
        relationship: edgeRel,
        created_by: "ingest",
      }, { onConflict: "source_entry_id,target_entry_id,relationship" });

      if (edgeRel === "contradicts" || edgeRel === "refutes") {
        await supabase.from("knowledge_conflicts").upsert({
          user_id,
          entry_a: entry.id,
          entry_b: target.id,
          kind: edgeRel,
          rationale: (a.rationale || "").slice(0, 1000),
          status: "open",
        }, { onConflict: "user_id,entry_a,entry_b,kind" });
        conflictCount++;
      }
    }
  }
  return conflictCount;
}

/** Embed a freshly inserted entry and persist the vector. Returns the vector. */
export async function embedAndStore(
  supabase: any,
  entry_id: string,
  user_id: string,
  title: string,
  content: string,
): Promise<number[] | null> {
  const vec = await embedOne(`${title}\n\n${content}`);
  if (!vec) return null;
  await supabase
    .from("knowledge_entries")
    .update({ embedding: vec as any, embedding_model: EMBEDDING_MODEL_ID })
    .eq("id", entry_id)
    .eq("user_id", user_id);
  return vec;
}
