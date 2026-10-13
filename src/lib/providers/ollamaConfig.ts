import { LOCAL_SERVICES } from "@/lib/localServices";

// Where the local Ollama server lives and how big a context to ask for.
//
// Browser-only settings, kept out of useChatSettings on purpose: they describe
// THIS machine, not the user's account, so they must not sync to another
// device through the profile row. localStorage is the right scope.
//
// num_ctx is sent on every request because Ollama's own default is sized from
// VRAM (4096 on a 6 GiB card) and silently truncates anything longer from the
// FRONT — the system prompt is the first thing to go. Measured on this repo's
// reference machine (docs/local-ai/results/2026-10-12-speed.txt): the
// OpenAI-compatible /v1 surface ignores options.num_ctx entirely, which is why
// the adapter speaks the native /api/chat protocol.

export const OLLAMA_DEFAULT_BASE = LOCAL_SERVICES.ollama;
export const OLLAMA_DEFAULT_NUM_CTX = 16384;
/** How long Ollama keeps a model resident after a request. Long enough that a
 *  laptop dGPU never runtime-suspends mid-conversation (a cold wake measured
 *  4-5x slower prefill), short enough to give the VRAM back overnight. */
export const OLLAMA_KEEP_ALIVE = "30m";

/** Prompt tokens per GPU job. Ollama chose 1024 on this machine; right after a
 *  model load or a GPU wake the card is at low clocks and one 1024-token job
 *  outran the kernel's compute timeout — "ErrorDeviceLost", 9 of 9 fresh loads.
 *  At 512: 0 of 7, and faster (docs/local-ai/results/2026-10-12-gpu-profile.txt).
 *  Every caller must send the same value, or Ollama reloads the model to switch.
 *  Mirrored in supabase/functions/_shared/ai-local.ts. */
export const OLLAMA_NUM_BATCH = 512;

/** The local embedding model. Set once per install by scripts/local-up.sh
 *  (VITE_LOCAL_EMBED_MODEL, the same value it gives the edge functions as
 *  LOCAL_EMBED_MODEL) — vectors from two models can't be compared, so the
 *  browser and the server must agree. */
export const LOCAL_EMBED_MODEL: string =
  (import.meta.env.VITE_LOCAL_EMBED_MODEL as string | undefined) || "embeddinggemma:300m";

/** The task prefix a retrieval model was trained with. Leaving it off costs
 *  recall; queries and documents get different ones. Mirrors taskPrefix in
 *  supabase/functions/_shared/embed.ts. */
export function embedPrefix(model: string, kind: "query" | "document"): string {
  const m = model.toLowerCase();
  if (m.includes("nomic-embed")) return kind === "query" ? "search_query: " : "search_document: ";
  if (m.includes("embeddinggemma")) return kind === "query" ? "task: search result | query: " : "title: none | text: ";
  if (m.includes("qwen3-embedding")) return kind === "query" ? "Instruct: Given a search query, retrieve relevant passages\nQuery: " : "";
  return "";
}

/** Cosine above which a later turn adds a tool to the roster unasked. Each
 *  model has its own scale: on the app's tools nomic gives the RIGHT tool a
 *  median 0.65 and the best WRONG one 0.64, so its old 0.55 floor passed 94%
 *  of wrong tools; embeddinggemma's medians are 0.43 / 0.38, and at 0.45 it
 *  adds the right tool 44% of the time and a wrong one 24%
 *  (docs/local-ai/results/2026-10-13-embedders.txt). The model can still ask
 *  for anything through find_tools. */
export function rosterAutoAddFloor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("nomic-embed")) return 0.55;
  if (m.includes("embeddinggemma")) return 0.45;
  return 0.5;
}

const BASE_KEY = "ollama.baseUrl";
const CTX_KEY = "ollama.numCtx";

function store(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Only loopback hosts are accepted. The adapter sends the whole conversation
 *  — book text, memories, uploads — to this URL, so a typo or a pasted
 *  "helpful" value must not be able to point it at someone else's server. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function ollamaBaseUrl(): string {
  const v = store()?.getItem(BASE_KEY) || "";
  return v && isLoopbackUrl(v) ? v.replace(/\/+$/, "") : OLLAMA_DEFAULT_BASE;
}

export function setOllamaBaseUrl(v: string): boolean {
  const s = store();
  if (!s) return false;
  if (!v.trim()) { s.removeItem(BASE_KEY); return true; }
  if (!isLoopbackUrl(v.trim())) return false;
  s.setItem(BASE_KEY, v.trim().replace(/\/+$/, ""));
  return true;
}

export function ollamaNumCtx(): number {
  const n = Number(store()?.getItem(CTX_KEY));
  return Number.isFinite(n) && n >= 2048 && n <= 262144 ? Math.round(n) : OLLAMA_DEFAULT_NUM_CTX;
}

export function setOllamaNumCtx(n: number): void {
  const s = store();
  if (!s) return;
  if (!Number.isFinite(n) || n < 2048) s.removeItem(CTX_KEY);
  else s.setItem(CTX_KEY, String(Math.min(262144, Math.round(n))));
}
