// Shared embedding helper — uses Google Gemini text-embedding-004 (768 dims) directly.
// The Lovable AI Gateway does not expose embeddings, so we call Google's REST endpoint with GEMINI_API_KEY.

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "text-embedding-004";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;
const BATCH_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;

export const EMBEDDING_DIMS = 768;
export const EMBEDDING_MODEL_ID = `google/${MODEL}`;

export async function embedOne(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY missing — cannot embed");
    return null;
  }
  const body = {
    model: `models/${MODEL}`,
    content: { parts: [{ text: (text || "").slice(0, 8000) }] },
    taskType: "RETRIEVAL_DOCUMENT",
  };
  const res = await fetch(`${ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("embedOne failed:", res.status, t.slice(0, 200));
    return null;
  }
  const j = await res.json();
  return j?.embedding?.values ?? null;
}

export async function embedQuery(text: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) return null;
  const body = {
    model: `models/${MODEL}`,
    content: { parts: [{ text: (text || "").slice(0, 8000) }] },
    taskType: "RETRIEVAL_QUERY",
  };
  const res = await fetch(`${ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.embedding?.values ?? null;
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!GEMINI_API_KEY || texts.length === 0) return texts.map(() => null);
  const body = {
    requests: texts.map((t) => ({
      model: `models/${MODEL}`,
      content: { parts: [{ text: (t || "").slice(0, 8000) }] },
      taskType: "RETRIEVAL_DOCUMENT",
    })),
  };
  const res = await fetch(`${BATCH_ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("embedBatch failed:", res.status, t.slice(0, 200));
    return texts.map(() => null);
  }
  const j = await res.json();
  const out: (number[] | null)[] = (j?.embeddings || []).map((e: any) => e?.values ?? null);
  // Pad if response shorter than input
  while (out.length < texts.length) out.push(null);
  return out;
}
