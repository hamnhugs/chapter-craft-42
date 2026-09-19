/**
 * Where a request may tell a provider-side cache "everything up to here is
 * reusable".
 *
 * Extracted from ChatContext so the one invariant that matters can be a test
 * instead of a comment: **at most four breakpoints**. `withCacheBreakpoint`
 * (providers/openrouterAdapter.ts) walks the list in order and silently skips
 * everything once four distinct indices have been marked — so a fifth entry
 * does not error, it costs you the LAST one in the list, which is the newest
 * tool-result marker that makes multi-round tool loops cheap. That failure is
 * invisible at runtime and shows up only as a bill.
 *
 * The other trap this file exists to prevent: indices counted BACKWARDS from
 * the end of the leading system block. `leadingSystem.length - 1 - (summary ? 1
 * : 0)` silently encoded "there is exactly one optional member after the stable
 * head". The moment a second optional tail member was added (the switchable
 * prompt layer), that expression started pointing at churning bytes — and a
 * breakpoint on churning bytes is strictly worse than no breakpoint: it buys
 * cache WRITES at 1.25x that are never read. Indices here are counted from the
 * FRONT, where nothing appended later can move them.
 */

import type { CacheBreakpoint } from "@/lib/providers/types";

/** Anthropic accepts four `cache_control` markers per request; the adapter
 *  enforces the same number. Raising this without raising it there means
 *  silently dropping whichever breakpoints sort last. */
export const MAX_CACHE_BREAKPOINTS = 4;

export interface CacheLayout {
  /** Last index of the byte-stable head: book block, the ~23K instruction
   *  prompt, pinned focus. Counted from the front. */
  stableSystemEnd: number;
  /** Last index of the whole leading system block — the churning tails
   *  (rolling summary, switchable prompt) included. Equal to
   *  `stableSystemEnd` when there are none. */
  leadingSystemEnd: number;
  /** Index of the latest user message. */
  latestUserIndex: number;
  /** Characters of per-turn context appended to that user message, which must
   *  stay OUTSIDE the cached part. */
  tailChars: number;
  /** Current `messages.length` — grows as tool rounds append. */
  totalMessages: number;
}

/**
 * Four markers, most-stable first:
 *   1. the stable head — survives every prompt switch and every summary roll
 *   2. the end of the system block — absorbs BOTH churning tails in one marker,
 *      which is why adding the switchable prompt layer costs no slot
 *   3. the user's own words, with the per-turn context left uncached
 *   4. the newest message, so each tool round reads the previous round's prefix
 */
export function computeCacheBreakpoints(layout: CacheLayout): CacheBreakpoint[] {
  const { stableSystemEnd, leadingSystemEnd, latestUserIndex, tailChars, totalMessages } = layout;
  const out: CacheBreakpoint[] = [
    { index: stableSystemEnd },
    ...(leadingSystemEnd > stableSystemEnd ? [{ index: leadingSystemEnd }] : []),
    { index: latestUserIndex, tailChars },
    ...(totalMessages - 1 > latestUserIndex ? [{ index: totalMessages - 1 }] : []),
  ];
  // Belt and braces: the adapter would drop the overflow silently, and the
  // entry it drops is the one we can least afford to lose.
  return out.slice(0, MAX_CACHE_BREAKPOINTS);
}
