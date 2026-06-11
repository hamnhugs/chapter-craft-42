import { supabase } from "@/integrations/supabase/client";
import { BookDocument } from "@/types/library";

// Client side of the auto-tag pipeline. Token efficiency happens HERE: we
// never ship a book's full text to the model. Research on genre/topic
// classification shows accuracy saturates with the first ~1k tokens, so each
// book is reduced to its title, chapter names (a near-free summary of the
// whole book we already have from chapterization), and three ~1,000-char
// excerpts sampled from the start / middle / end (sampling hedges against
// front matter and multi-topic books). Books go up in batches so the shared
// taxonomy prompt is paid once per batch instead of once per book.

export interface AutoTagResult {
  id: string;
  category: string;
  tags: string[];
}

// Mirrors the enum in supabase/functions/auto-tag — used for graph hub colors
// and (defensively) to validate what comes back.
export const BOOK_CATEGORIES = [
  "fiction",
  "sci-fi & fantasy",
  "mystery & thriller",
  "romance",
  "history",
  "biography & memoir",
  "science & nature",
  "technology & computing",
  "business & economics",
  "self-improvement",
  "philosophy & religion",
  "politics & society",
  "arts & culture",
  "health & psychology",
  "reference & education",
  "poetry & essays",
  "other",
] as const;

const BATCH_SIZE = 8;
const EXCERPT_CHARS = 1000;

/** First EXCERPT_CHARS of meaningful text from a chapter, skipping leading noise. */
function excerptFrom(text: string): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.slice(0, EXCERPT_CHARS);
}

/** Start / middle / end excerpts. Books without chapter text get none — the
 *  model still has the title and chapter names to work from. */
function buildExcerpts(book: BookDocument): string[] {
  const withText = book.chapters.filter((c) => (c.textContent || "").trim().length > 80);
  if (withText.length === 0) return [];
  const picks =
    withText.length <= 3
      ? withText
      : [withText[0], withText[Math.floor(withText.length / 2)], withText[withText.length - 1]];
  return picks.map((c) => excerptFrom(c.textContent)).filter((e) => e.length > 0);
}

/** Every tag already used in the library — injected into the prompt so the
 *  model reuses "science fiction" instead of coining "sci-fi". Sorted by
 *  frequency so the most reusable tags survive the server-side cap. */
export function collectExistingTags(books: BookDocument[]): string[] {
  const counts = new Map<string, number>();
  for (const b of books) {
    for (const t of b.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * Tag a list of books via the auto-tag edge function (same model/provider as
 * chapterization). Resolves batches sequentially so tags assigned in batch N
 * are injected as "existing tags" for batch N+1 — cross-batch consistency is
 * what makes the mind map's shared-tag edges form.
 */
export async function autoTagBooks(
  booksToTag: BookDocument[],
  allBooks: BookDocument[],
  opts?: {
    apiKey?: string;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<AutoTagResult[]> {
  const vocabulary = collectExistingTags(allBooks);
  const results: AutoTagResult[] = [];

  for (let i = 0; i < booksToTag.length; i += BATCH_SIZE) {
    const batch = booksToTag.slice(i, i + BATCH_SIZE);
    const payload = {
      books: batch.map((b) => ({
        id: b.id,
        title: b.title,
        chapterTitles: b.chapters.map((c) => c.name),
        excerpts: buildExcerpts(b),
      })),
      existingTags: vocabulary,
      openrouterApiKey: opts?.apiKey || undefined,
    };

    const { data, error } = await supabase.functions.invoke("auto-tag", { body: payload });
    if (error) throw new Error(error.message || "Auto-tag request failed");
    if ((data as any)?.error) throw new Error((data as any).error);

    const batchResults: AutoTagResult[] = Array.isArray((data as any)?.results)
      ? (data as any).results
      : [];
    for (const r of batchResults) {
      if (!r?.id || !Array.isArray(r.tags) || r.tags.length === 0) continue;
      const category = (BOOK_CATEGORIES as readonly string[]).includes(r.category)
        ? r.category
        : "other";
      results.push({ id: r.id, category, tags: r.tags });
      // Feed this batch's tags into the next batch's vocabulary (front of the
      // list — freshly used tags are the likeliest to apply to neighbors).
      for (const t of r.tags) {
        if (!vocabulary.includes(t)) vocabulary.unshift(t);
      }
    }

    opts?.onProgress?.(Math.min(i + BATCH_SIZE, booksToTag.length), booksToTag.length);
  }

  return results;
}
