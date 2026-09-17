// Shared embedding helper for knowledge_entries.embedding (vector(768)).
//
// ONE MODEL PER DEPLOYMENT. Every vector in the `embedding` column must come
// from the same model, or cosine similarity between a query and a document is
// meaningless (different models = different vector spaces; a pplx vector
// compared with a text-embedding-004 vector is noise that merely LOOKS like a
// score). The old helper tried OpenRouter → Lovable gateway → Gemini direct on
// every call, so one transient OpenRouter 5xx silently wrote a Google vector
// into a column full of Perplexity vectors — and stamped every row
// `google/text-embedding-004` regardless.
//
// Now the provider is chosen once, from configuration:
//   EMBED_PROVIDER=openrouter|google   explicit override (optional)
//   otherwise OPENROUTER_API_KEY set → "openrouter", else → "google"
//
//   openrouter: OPENROUTER_EMBED_MODEL (default perplexity/pplx-embed-v1-4b),
//               requested at `dimensions: 768`. pplx-embed-v1 is trained with
//               Matryoshka representation learning (128–2560 dims for the 4b
//               model), so a 768-dim prefix is a valid embedding in its own
//               right; if the route rejects `dimensions` we retry once without
//               it and truncate client-side (same model, same space). Its
//               vectors are unnormalized — fine, retrieval uses cosine.
//   google:     google/text-embedding-004 (768 native) via the Lovable gateway,
//               falling back to the Gemini REST API. That fallback is the SAME
//               model on two transports, so it can't mix spaces — identical to
//               the previous Google path.
//
// A failure returns null — never a vector from some other model. Rows stay
// NULL and are picked up by the next targeted embed (knowledgeApi
// embedEntriesSoon) or an all_missing reindex.
//
// Queries and documents go through the same provider/model (embedQuery only
// differs in Google's RETRIEVAL_QUERY task type on the direct path).
//
// The true model id is exported as EMBEDDING_MODEL_ID and stamped on every
// write (embedding_model + embedding_768_model — see writeEntryEmbedding).
// Changing provider/model does NOT re-embed anything by itself: run
// knowledge-embed with { stale_model: true } to migrate existing rows.

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_EMBED_MODEL = Deno.env.get("OPENROUTER_EMBED_MODEL") || "perplexity/pplx-embed-v1-4b";

const GOOGLE_MODEL = "text-embedding-004";
export const EMBEDDING_DIMS = 768;

export type EmbedProvider = "openrouter" | "google";

/** Pure provider choice — exported for tests / diagnostics. */
export function chooseEmbedProvider(env: { override?: string | null; openrouterKey?: string | null }): EmbedProvider {
  const o = (env.override || "").trim().toLowerCase();
  if (o === "openrouter" || o === "google") return o;
  return env.openrouterKey ? "openrouter" : "google";
}

export const EMBED_PROVIDER: EmbedProvider = chooseEmbedProvider({
  override: Deno.env.get("EMBED_PROVIDER"),
  openrouterKey: OPENROUTER_API_KEY,
});

/** The model that actually produced every vector this deployment writes. */
export const EMBEDDING_MODEL_ID = EMBED_PROVIDER === "openrouter"
  ? OPENROUTER_EMBED_MODEL
  : `google/${GOOGLE_MODEL}`;

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/embeddings";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
// Google direct REST (v1, not v1beta — v1beta returns 404 for this model)
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${GOOGLE_MODEL}:embedContent`;
const GOOGLE_BATCH_ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${GOOGLE_MODEL}:batchEmbedContents`;

const trim = (t: string) => (t || "").slice(0, 8000);

// Matryoshka prefix to the DB's fixed dim. Shorter vectors are REJECTED (null)
// rather than zero-padded: padding a vector from a smaller model would pass the
// column's dim check while living in a different space.
let dimWarned = false;
const fit = (v: number[] | null | undefined): number[] | null => {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (v.length === EMBEDDING_DIMS) return v;
  if (v.length < EMBEDDING_DIMS) {
    console.error(`embedding model ${EMBEDDING_MODEL_ID} returned ${v.length} dims (< ${EMBEDDING_DIMS}) — rejected`);
    return null;
  }
  if (!dimWarned) {
    console.log(`${EMBEDDING_MODEL_ID} returned ${v.length} dims — Matryoshka-truncated to ${EMBEDDING_DIMS}`);
    dimWarned = true;
  }
  return v.slice(0, EMBEDDING_DIMS);
};

// ---------- OpenRouter path ----------

// Flips false the first time the route refuses `dimensions`, so later calls in
// this isolate don't pay the failed round trip again.
let openrouterDimsParam = true;

async function openrouterEmbed(inputs: string[]): Promise<(number[] | null)[] | null> {
  if (!OPENROUTER_API_KEY) return null;
  const call = async (withDims: boolean) => fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://bookwormstudio.com",
      "X-Title": "Bookworm Wiki",
    },
    body: JSON.stringify({
      model: OPENROUTER_EMBED_MODEL,
      input: inputs.map(trim),
      encoding_format: "float",
      ...(withDims ? { dimensions: EMBEDDING_DIMS } : {}),
    }),
  });
  try {
    let res = await call(openrouterDimsParam);
    if (!res.ok && openrouterDimsParam && res.status === 400) {
      const t = (await res.text()).slice(0, 300);
      console.warn("openrouterEmbed: request with dimensions refused, retrying without:", t);
      openrouterDimsParam = false;
      res = await call(false);
    }
    if (!res.ok) {
      console.error("openrouterEmbed failed:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const j = await res.json();
    const data = Array.isArray(j?.data) ? j.data : [];
    // Honor `index` when present — batch order isn't guaranteed by every route.
    const byIndex = new Map<number, unknown>();
    data.forEach((d: any, i: number) => byIndex.set(typeof d?.index === "number" ? d.index : i, d?.embedding));
    const out: (number[] | null)[] = inputs.map((_, i) => fit(byIndex.get(i) as number[] | undefined));
    if (out.every((v) => v === null)) return null;
    return out;
  } catch (e) {
    console.error("openrouterEmbed exception:", e);
    return null;
  }
}

// ---------- Google: Lovable gateway transport ----------

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
      body: JSON.stringify({ model: `google/${GOOGLE_MODEL}`, input: inputs.map(trim) }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("gatewayEmbed failed:", res.status, t.slice(0, 300));
      return null;
    }
    const j = await res.json();
    const data = Array.isArray(j?.data) ? j.data : [];
    const out: (number[] | null)[] = inputs.map((_, i) => fit(data[i]?.embedding));
    // Reject if everything came back empty
    if (out.every((v) => v === null)) return null;
    return out;
  } catch (e) {
    console.error("gatewayEmbed exception:", e);
    return null;
  }
}

// ---------- Google: direct REST transport (same model) ----------

async function googleEmbedOne(text: string, taskType: string): Promise<number[] | null> {
  if (!GEMINI_API_KEY) return null;
  try {
    const res = await fetch(`${GOOGLE_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${GOOGLE_MODEL}`,
        content: { parts: [{ text: trim(text) }] },
        taskType,
      }),
    });
    if (!res.ok) {
      console.error("googleEmbedOne failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const j = await res.json();
    return fit(j?.embedding?.values);
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
          model: `models/${GOOGLE_MODEL}`,
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
    const out: (number[] | null)[] = (j?.embeddings || []).map((e: any) => fit(e?.values));
    while (out.length < texts.length) out.push(null);
    return out;
  } catch (e) {
    console.error("googleEmbedBatch exception:", e);
    return texts.map(() => null);
  }
}

// ---------- Public API ----------

export async function embedOne(text: string): Promise<number[] | null> {
  if (EMBED_PROVIDER === "openrouter") {
    const or = await openrouterEmbed([text]);
    return or?.[0] ?? null;
  }
  const gw = await gatewayEmbed([text]);
  if (gw && gw[0]) return gw[0];
  return googleEmbedOne(text, "RETRIEVAL_DOCUMENT");
}

export async function embedQuery(text: string): Promise<number[] | null> {
  if (EMBED_PROVIDER === "openrouter") {
    const or = await openrouterEmbed([text]);
    return or?.[0] ?? null;
  }
  const gw = await gatewayEmbed([text]);
  if (gw && gw[0]) return gw[0];
  return googleEmbedOne(text, "RETRIEVAL_QUERY");
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  if (EMBED_PROVIDER === "openrouter") {
    return (await openrouterEmbed(texts)) ?? texts.map(() => null);
  }
  const gw = await gatewayEmbed(texts);
  if (gw) return gw;
  return googleEmbedBatch(texts);
}

// ---------- Persisting ----------

// embedding_768_model arrives with 20260917130100_embedding_model_tracking.
// Until that migration is applied the write is retried without it (PGRST204 /
// 42703), and the flag remembers so later writes in this isolate skip the probe.
let modelColumnMissing = false;

/** Write a 768-dim vector + the model that produced it. Returns the error
 *  message on failure, null on success. */
export async function writeEntryEmbedding(
  supabase: any,
  entryId: string,
  userId: string,
  vec: number[],
): Promise<string | null> {
  const base = { embedding: vec as any, embedding_model: EMBEDDING_MODEL_ID };
  if (!modelColumnMissing) {
    const { error } = await supabase
      .from("knowledge_entries")
      .update({ ...base, embedding_768_model: EMBEDDING_MODEL_ID })
      .eq("id", entryId)
      .eq("user_id", userId);
    if (!error) return null;
    const code = (error as any)?.code;
    if (code !== "PGRST204" && code !== "42703") return error.message || "update failed";
    modelColumnMissing = true;
  }
  const { error } = await supabase
    .from("knowledge_entries")
    .update(base)
    .eq("id", entryId)
    .eq("user_id", userId);
  return error ? (error.message || "update failed") : null;
}
