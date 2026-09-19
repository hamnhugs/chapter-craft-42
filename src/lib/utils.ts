import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Heuristic: detect embedding-only model ids (OpenRouter and NVIDIA).
 * These cannot be used with /chat/completions and must be filtered
 * out of the Chat selector (Wiki reindex still uses them).
 * NVIDIA's catalog carries embedding ids WITHOUT "embed" in the name
 * (baai/bge-m3, nvidia/nvclip, nemoretriever rows) — matched explicitly.
 */
/**
 * OpenRouter's `:batch` variant ids route ONLY to the asynchronous Batch API —
 * the synchronous /chat/completions endpoint answers 404 "This model is only
 * available through the Batch API" (hit live 2026-08-24: the user picked
 * `google/gemini-3.6-flash:batch` for its cheaper pricing and every chat send
 * died). Nothing in this app speaks the batch endpoint, so a `:batch` id must
 * never reach any live-model role. The gate does NOT silently strip the suffix:
 * the un-suffixed sibling bills at full price, and swapping a user's model for
 * a differently-priced one behind their back violates the provider-visibility
 * rule — the refusal names the runnable sibling instead.
 */
export function isBatchOnlyModel(id: string): boolean {
  return /:batch$/i.test(id || "");
}

export function isEmbeddingModel(id: string): boolean {
  if (!id) return false;
  const s = id.toLowerCase();
  return (
    s.includes("/embed") ||
    s.includes("-embed") ||
    s.includes("text-embedding") ||
    s.includes("embedding-") ||
    /\bembed(ding)?\b/.test(s) ||
    s.includes("bge-") ||
    s.includes("nvclip") ||
    s.includes("nemoretriever")
  );
}
