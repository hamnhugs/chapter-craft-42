import type { CardLocator } from "@/lib/cardLocators";
import type { BookDocument } from "@/types/library";

/** Notes asked per day (DailyRecall.tsx). */
export const DAILY_RECALL_SIZE = 3;

const doneKey = (d = new Date()) => `daily-recall-done:${d.toISOString().slice(0, 10)}`;

export function dailyRecallDoneToday(): boolean {
  try { return localStorage.getItem(doneKey()) === "1"; } catch { return false; }
}

export function markDailyRecallDone(): void {
  try { localStorage.setItem(doneKey(), "1"); } catch { /* cosmetic */ }
}

/** The book a locator points into: its stamped id, else the book that owns its chapter. */
export function locatorBookId(loc: CardLocator, books: BookDocument[]): string | null {
  if (loc.book_id && books.some((b) => b.id === loc.book_id)) return loc.book_id;
  return books.find((b) => b.chapters?.some((c) => c.id === loc.chapter_id))?.id ?? null;
}
