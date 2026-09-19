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

export type BookSource = "user" | "assistant" | "youtube";

/** The fallback marker for sessions where the source column is absent.
 *  Namespaced so no auto-tagger or human topic tag can collide with it. */
export const ASSISTANT_TAG = "written-by:assistant";

/** Fallback marker for a YouTube transcript (video-to-pdf) when the source
 *  column can't hold "youtube" yet (migration 20260917120000). */
export const YOUTUBE_TAG = "source:youtube";

const RESERVED_PREFIXES = ["written-by:", "source:"];

export function isReservedTag(tag: string): boolean {
  return typeof tag === "string" && RESERVED_PREFIXES.some((p) => tag.startsWith(p));
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
  if (b.source === "assistant" || b.source === "youtube") return b.source;
  if ((b.tags ?? []).includes(ASSISTANT_TAG)) return "assistant";
  if ((b.tags ?? []).includes(YOUTUBE_TAG)) return "youtube";
  return "user";
}

/** A book the From YouTube importer saved: an automatic video transcript. */
export function isYoutubeTranscript(b: Pick<BookDocument, "source" | "tags">): boolean {
  return bookSource(b) === "youtube";
}

export interface YoutubeSourceInfo {
  videoUrl: string | null;
  channel: string | null;
  durationSeconds: number | null;
}

/** Video details for a YouTube transcript (null for any other book). */
export function youtubeSource(b: Pick<BookDocument, "source" | "tags" | "sourceContext">): YoutubeSourceInfo | null {
  if (!isYoutubeTranscript(b)) return null;
  const ctx = (b.sourceContext ?? {}) as Record<string, unknown>;
  const url = typeof ctx.video_url === "string" && /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(ctx.video_url) ? ctx.video_url : null;
  return {
    videoUrl: url,
    channel: typeof ctx.channel === "string" && ctx.channel.trim() ? ctx.channel.trim() : null,
    durationSeconds: typeof ctx.duration_seconds === "number" && ctx.duration_seconds > 0 ? ctx.duration_seconds : null,
  };
}

export function formatVideoDuration(seconds: number | null): string | null {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h ? `${h}h ${m}m` : `${m}m ${s}s`;
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
export function provenanceLabel(b: Pick<BookDocument, "source" | "tags" | "sourceModel" | "addedAt" | "sourceContext">): string | null {
  const yt = youtubeSource(b);
  if (yt) return `Automatic transcript of a YouTube video${yt.channel ? ` by ${yt.channel}` : ""} — may contain transcription errors`;
  if (!isAssistantBook(b)) return null;
  const when = b.addedAt ? new Date(b.addedAt).toLocaleDateString() : null;
  return `Written by the assistant at your request${when ? ` on ${when}` : ""}${b.sourceModel ? ` (${b.sourceModel})` : ""}`;
}
