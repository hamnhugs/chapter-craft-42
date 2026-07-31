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
