// Book provenance — who wrote a book, as data the app sets and the model
// cannot. docs/library-agent.md §2.4.
//
// The primary store is the `books.source` column (migration
// 20260903120000_book_provenance). Until it is applied, the RESERVED tag below
// carries the same fact: every tag writer must preserve reserved tags
// (`mergeReservedTags`) and Auto-tag must skip assistant-written books, or
// the label evaporates on the next re-tag. Both readers go through
// `bookSource`, so no door ever inspects the tag array directly.

import type { BookDocument } from "@/types/library";

export type BookSource = "user" | "assistant";

/** The fallback marker for sessions where the source column is absent.
 *  Namespaced so no auto-tagger or human topic tag can collide with it. */
export const ASSISTANT_TAG = "written-by:assistant";

const RESERVED_PREFIX = "written-by:";

export function isReservedTag(tag: string): boolean {
  return typeof tag === "string" && tag.startsWith(RESERVED_PREFIX);
}

/** Reserved markers survive a whole-array replace; incoming reserved values
 *  are ignored (only the app writes them). */
export function mergeReservedTags(existing: readonly string[] | undefined, incoming: readonly string[]): string[] {
  const reserved = (existing ?? []).filter(isReservedTag);
  const plain = incoming.filter((t) => typeof t === "string" && !isReservedTag(t));
  return Array.from(new Set([...reserved, ...plain]));
}

/** The one read door. Column first; reserved tag second; user otherwise. */
export function bookSource(b: Pick<BookDocument, "source" | "tags">): BookSource {
  if (b.source === "assistant") return "assistant";
  if ((b.tags ?? []).includes(ASSISTANT_TAG)) return "assistant";
  return "user";
}

export function isAssistantBook(b: Pick<BookDocument, "source" | "tags">): boolean {
  return bookSource(b) === "assistant";
}

/** Tags without the reserved markers — for surfaces that show TOPIC tags
 *  (mind map, search chips), where a provenance marker is not a topic. */
export function topicTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter((t) => !isReservedTag(t));
}

/** What the reader sees on a derived book: a derivation label, not a bare
 *  "AI" badge (the blanket label measurably lowers perceived accuracy even
 *  for true text; a label that says what it derives from does not). */
export function provenanceLabel(b: Pick<BookDocument, "source" | "tags" | "sourceModel" | "addedAt">): string | null {
  if (!isAssistantBook(b)) return null;
  const when = b.addedAt ? new Date(b.addedAt).toLocaleDateString() : null;
  return `Written by the assistant at your request${when ? ` on ${when}` : ""}${b.sourceModel ? ` (${b.sourceModel})` : ""}`;
}
