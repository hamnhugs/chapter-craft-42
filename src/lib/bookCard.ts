/**
 * A book as a collectible card: the handful of numbers the collection view
 * prints on each one.
 *
 * None of it is invented. Every figure is a re-reading of something the app
 * already knows:
 *
 *   tier   how big the book is       (page count)
 *   level  how far you are into it   (the last page this device remembers)
 *   cost   how long it takes to read (page count at a steady pace)
 *
 * Pure and DOM-free; the reading position is passed in, as in bookProfile.
 */

import type { BookDocument } from "@/types/library";

export type TierId = "leaflet" | "volume" | "tome" | "opus";

export interface Tier {
  id: TierId;
  label: string;
  /** Smallest page count that belongs to the tier. */
  min: number;
  /** For sorting: bigger is grander. */
  rank: number;
}

export const TIERS: Tier[] = [
  { id: "leaflet", label: "Leaflet", min: 0, rank: 0 },
  { id: "volume", label: "Volume", min: 80, rank: 1 },
  { id: "tome", label: "Tome", min: 300, rank: 2 },
  { id: "opus", label: "Opus", min: 600, rank: 3 },
];

/** A book whose page count is unknown (0) is treated as an ordinary Volume
 *  rather than as the smallest thing in the collection. */
export function tierOf(pageCount: number): Tier {
  if (!(pageCount > 0)) return TIERS[1];
  let hit = TIERS[0];
  for (const t of TIERS) if (pageCount >= t.min) hit = t;
  return hit;
}

export const MAX_LEVEL = 10;

export interface CardLevel {
  /** 1–10. A book you have not opened is level 1. */
  level: number;
  /** 0–1: progress through the current level. 1 at max level. */
  fill: number;
  /** Whole-book percentage read, 0–100. */
  pct: number;
  maxed: boolean;
  /** Pages still to read before the next level; 0 at max. */
  pagesToNext: number;
}

/**
 * Ten levels, one per tenth of the book. Being on page 1 is "opened", not
 * progress (the same rule bookProfile applies), so it stays at level 1 with
 * an empty meter.
 */
export function levelOf(pageCount: number, lastPage: number): CardLevel {
  const pages = pageCount > 0 ? pageCount : 0;
  if (pages === 0 || !(lastPage > 1)) return { level: 1, fill: 0, pct: 0, maxed: false, pagesToNext: pages > 0 ? Math.ceil(pages / MAX_LEVEL) : 0 };
  const page = Math.min(lastPage, pages);
  const frac = page / pages;
  if (page >= pages) return { level: MAX_LEVEL, fill: 1, pct: 100, maxed: true, pagesToNext: 0 };
  const scaled = frac * (MAX_LEVEL - 1); // 0 … 9 across levels 1 → 10
  const level = Math.min(MAX_LEVEL - 1, 1 + Math.floor(scaled));
  const nextAt = Math.ceil((level / (MAX_LEVEL - 1)) * pages);
  return {
    level,
    fill: scaled - Math.floor(scaled),
    pct: Math.min(99, Math.round(frac * 100)),
    maxed: false,
    pagesToNext: Math.max(1, nextAt - page),
  };
}

/** Minutes to read a page at an unhurried pace. */
const MINUTES_PER_PAGE = 2;

/** "45m", "6h", "22h" — the corner badge. Null when the length is unknown. */
export function readTimeLabel(pageCount: number): string | null {
  if (!(pageCount > 0)) return null;
  const minutes = pageCount * MINUTES_PER_PAGE;
  if (minutes < 60) return `${Math.max(5, Math.round(minutes / 5) * 5)}m`;
  return `${Math.round(minutes / 60)}h`;
}

export type CardSort = "recent" | "name" | "tier" | "level";

export interface CardEntry {
  book: BookDocument;
  tier: Tier;
  level: CardLevel;
}

export function toCard(book: BookDocument, lastPage: number): CardEntry {
  return { book, tier: tierOf(book.pageCount), level: levelOf(book.pageCount, lastPage) };
}

export function sortCards(cards: CardEntry[], by: CardSort): CardEntry[] {
  const out = cards.slice();
  const byName = (a: CardEntry, b: CardEntry) => a.book.title.localeCompare(b.book.title);
  switch (by) {
    case "name":
      return out.sort(byName);
    case "tier":
      return out.sort((a, b) => b.tier.rank - a.tier.rank || b.book.pageCount - a.book.pageCount || byName(a, b));
    case "level":
      return out.sort((a, b) => b.level.level - a.level.level || b.level.pct - a.level.pct || byName(a, b));
    default:
      return out.sort((a, b) => b.book.addedAt - a.book.addedAt);
  }
}

/** Books being read right now: started, not finished, furthest-along first. */
export function readingNow(cards: CardEntry[], limit = 8): CardEntry[] {
  return cards
    .filter((c) => c.level.pct > 0 && !c.level.maxed)
    .sort((a, b) => b.level.pct - a.level.pct)
    .slice(0, limit);
}
