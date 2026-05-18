// Shared embedding helper used by knowledge-extract, knowledge-ingest, and embed-entries.
// Writes to knowledge_entries.embedding_v2 (halfvec(1536)) so it lives side-by-side
// with the existing 768-dim `embedding` column used by knowledge-retrieve.

const EMBED_MODEL = "openai/text-embedding-3-small";
export const EMBED_DIMS = 1536;
const BATCH_SIZE = 16;
const MAX_INPUT_CHARS = 6000;

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

export async function embedTexts(apiKey: string, texts: string[]): Promise<number[][]> {
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Embedding API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as EmbeddingResponse;
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

// pgvector accepts a string literal like "[0.1,0.2,...]"
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export function prepareText(title: string, content: string): string {
  const combined = `${title}\n\n${content}`;
  return combined.length > MAX_INPUT_CHARS ? combined.slice(0, MAX_INPUT_CHARS) : combined;
}

// Embed a list of {id, title, content} entries and write to DB.
// Returns count successfully embedded. Best-effort: failures are logged, not thrown.
export async function embedAndStore(
  supabase: any,
  apiKey: string,
  entries: { id: string; title: string; content: string }[],
  userId: string,
): Promise<number> {
  if (entries.length === 0) return 0;

  let count = 0;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const texts = batch.map((e) => prepareText(e.title, e.content));

    try {
      const vectors = await embedTexts(apiKey, texts);
      if (vectors.length !== batch.length) {
        console.error(`embedAndStore: vector count mismatch (${vectors.length} vs ${batch.length})`);
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        const { error } = await supabase
          .from("knowledge_entries")
          .update({ embedding_v2: vectorLiteral(vectors[j]), embedding_model: EMBED_MODEL })
          .eq("id", batch[j].id)
          .eq("user_id", userId);
        if (error) {
          console.error(`embedAndStore: failed to write embedding for ${batch[j].id}:`, error.message);
        } else {
          count++;
        }
      }
    } catch (err) {
      console.error("embedAndStore: batch failed:", err instanceof Error ? err.message : err);
    }
  }
  return count;
}
