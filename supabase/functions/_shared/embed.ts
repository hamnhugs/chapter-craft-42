// Shared embedding helper.
// Primary: Lovable AI Gateway (OpenAI-compatible /v1/embeddings) using LOVABLE_API_KEY.
// Fallback: Google Generative Language REST API using GEMINI_API_KEY.
// Both paths target google/text-embedding-004 (768 dims) to match the existing
// `embedding vector(768)` column on knowledge_entries.

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_EMBED_MODEL = Deno.env.get("OPENROUTER_EMBED_MODEL") || "perplexity/pplx-embed-v1-4b";

const MODEL = "text-embedding-004";
export const EMBEDDING_DIMS = 768;
export const EMBEDDING_MODEL_ID = `google/${MODEL}`;

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/embeddings";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
// Google direct REST (v1, not v1beta — v1beta returns 404 for this model)
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:embedContent`;
const GOOGLE_BATCH_ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:batchEmbedContents`;

const trim = (t: string) => (t || "").slice(0, 8000);

// Truncate (or pad with zeros) to fit the DB's fixed-dim vector column.
let dimWarned = false;
const fit = (v: number[] | null | undefined): number[] | null => {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (v.length !== EMBEDDING_DIMS && !dimWarned) {
    console.log(`openrouter returned ${v.length} dims — truncated to ${EMBEDDING_DIMS}`);
    dimWarned = true;
  }
  if (v.length === EMBEDDING_DIMS) return v;
  if (v.length > EMBEDDING_DIMS) return v.slice(0, EMBEDDING_DIMS);
  return [...v, ...new Array(EMBEDDING_DIMS - v.length).fill(0)];
};

// ---------- OpenRouter path (primary) ----------

async function openrouterEmbed(inputs: string[]): Promise<(number[] | null)[] | null> {
  if (!OPENROUTER_API_KEY) return null;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://bookwormstudio.com",
        "X-Title": "Bookworm Wiki",
      },
      body: JSON.stringify({ model: OPENROUTER_EMBED_MODEL, input: inputs.map(trim) }),
    });
    if (!res.ok) {
      console.error("openrouterEmbed failed:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const j = await res.json();
    const data = Array.isArray(j?.data) ? j.data : [];
    const out: (number[] | null)[] = inputs.map((_, i) => fit(data[i]?.embedding));
    if (out.every((v) => v === null)) return null;
    return out;
  } catch (e) {
    console.error("openrouterEmbed exception:", e);
    return null;
  }
}


// ---------- Gateway path ----------

async function gatewayEmbed(inputs: string[]): Promise<(number[] | null)[] | null> {
  if (!LOVABLE_API_KEY) return null;
  try {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LOVABLE_API_KEY}`,
        "Lovable-API-Key": LOVABLE_API_KEY,
        "X-Lovable-AIG-SDK": "edge-fn-embed",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL_ID, input: inputs.map(trim) }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("gatewayEmbed failed:", res.status, t.slice(0, 300));
      return null;
    }
    const j = await res.json();
    const data = Array.isArray(j?.data) ? j.data : [];
    const out: (number[] | null)[] = inputs.map((_, i) => {
      const v = data[i]?.embedding;
      return Array.isArray(v) ? v as number[] : null;
    });
    // Reject if everything came back empty
    if (out.every((v) => v === null)) return null;
    return out;
  } catch (e) {
    console.error("gatewayEmbed exception:", e);
    return null;
  }
}

// ---------- Google direct path (fallback) ----------

async function googleEmbedOne(text: string, taskType: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) return null;
  try {
    const res = await fetch(`${GOOGLE_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        content: { parts: [{ text: trim(text) }] },
        taskType,
      }),
    });
    if (!res.ok) {
      console.error("googleEmbedOne failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const j = await res.json();
    return j?.embedding?.values ?? null;
  } catch (e) {
    console.error("googleEmbedOne exception:", e);
    return null;
  }
}

async function googleEmbedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!GEMINI_API_KEY || texts.length === 0) return texts.map(() => null);
  try {
    const res = await fetch(`${GOOGLE_BATCH_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text: trim(t) }] },
          taskType: "RETRIEVAL_DOCUMENT",
        })),
      }),
    });
    if (!res.ok) {
      console.error("googleEmbedBatch failed:", res.status, (await res.text()).slice(0, 200));
      return texts.map(() => null);
    }
    const j = await res.json();
    const out: (number[] | null)[] = (j?.embeddings || []).map((e: any) => e?.values ?? null);
    while (out.length < texts.length) out.push(null);
    return out;
  } catch (e) {
    console.error("googleEmbedBatch exception:", e);
    return texts.map(() => null);
  }
}

// ---------- Public API ----------

export async function embedOne(text: string): Promise<number[] | null> {
  const or = await openrouterEmbed([text]);
  if (or && or[0]) return or[0];
  const gw = await gatewayEmbed([text]);
  if (gw && gw[0]) return gw[0];
  return googleEmbedOne(text, "RETRIEVAL_DOCUMENT");
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const or = await openrouterEmbed([text]);
  if (or && or[0]) return or[0];
  const gw = await gatewayEmbed([text]);
  if (gw && gw[0]) return gw[0];
  return googleEmbedOne(text, "RETRIEVAL_QUERY");
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const or = await openrouterEmbed(texts);
  if (or) return or;
  const gw = await gatewayEmbed(texts);
  if (gw) return gw;
  return googleEmbedBatch(texts);
}
