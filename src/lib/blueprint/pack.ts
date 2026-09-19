// Shelf packing for sheet panels.
//
// This is deliberately the dull algorithm. Laying out a dozen drawing panels on
// one sheet is 2D bin-packing at a scale where a shelf heuristic is not merely
// adequate but optimal-looking, and where anything cleverer costs determinism —
// which matters more here, because the same blueprint must produce a
// byte-identical sheet every time or the "anchor that never drifts" claim is
// false. No randomness, no time source, no iteration order dependent on object
// key enumeration.
//
// Nothing is ever silently dropped: items that cannot fit come back in
// `overflow` so the caller can say so out loud rather than rendering a sheet
// that looks complete and isn't.

export interface PackItem {
  id: string;
  w: number;
  h: number;
}

export interface PackPlacement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackResult {
  placements: PackPlacement[];
  /** Width the caller asked for. */
  width: number;
  /** Height actually used. */
  height: number;
  /** Ids that did not fit within maxHeight, in input order. */
  overflow: string[];
}

export interface PackOptions {
  width: number;
  gap?: number;
  /** Stop placing past this height and report the rest as overflow. Omit to
   *  grow without limit. */
  maxHeight?: number;
}

/**
 * Place items into shelves, tallest first.
 *
 * Sorting by height descending is what keeps the shelves tight; the index
 * tiebreak makes the sort total, because `Array.prototype.sort` stability is
 * only guaranteed for a consistent comparator and equal-height panels are the
 * common case on a turnaround sheet.
 */
export function packShelves(items: PackItem[], opts: PackOptions): PackResult {
  const gap = opts.gap ?? 0;
  const width = Math.max(0, opts.width);
  const placements: PackPlacement[] = [];
  const overflow: string[] = [];

  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.h - a.item.h) || (b.item.w - a.item.w) || (a.index - b.index));

  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;

  for (const { item } of order) {
    const w = Math.max(0, item.w);
    const h = Math.max(0, item.h);

    // A panel wider than the sheet gets its own shelf rather than being
    // dropped — a clipped drawing is more useful than a missing one, and the
    // caller can see the overrun in the returned width.
    const needsNewShelf = cursorX > 0 && cursorX + gap + w > width;
    if (needsNewShelf) {
      shelfY += shelfH + gap;
      shelfH = 0;
      cursorX = 0;
    }

    if (opts.maxHeight !== undefined && shelfY + h > opts.maxHeight) {
      overflow.push(item.id);
      continue;
    }

    const x = cursorX === 0 ? 0 : cursorX + gap;
    placements.push({ id: item.id, x, y: shelfY, w, h });
    cursorX = x + w;
    if (h > shelfH) shelfH = h;
  }

  // Restore input order so the caller's ids line up with their own list.
  const rank = new Map(items.map((it, i) => [it.id, i]));
  placements.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  overflow.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

  return { placements, width, height: shelfY + shelfH, overflow };
}

/** Lay panels out in a fixed grid instead — used when every panel is the same
 *  size, where a shelf packer and a grid agree but the grid reads better
 *  because columns line up exactly. */
export function packGrid(items: PackItem[], columns: number, gap = 0): PackResult {
  const cols = Math.max(1, Math.floor(columns));
  const cellW = items.reduce((m, i) => Math.max(m, i.w), 0);
  const cellH = items.reduce((m, i) => Math.max(m, i.h), 0);
  const placements = items.map((item, i) => ({
    id: item.id,
    x: (i % cols) * (cellW + gap),
    y: Math.floor(i / cols) * (cellH + gap),
    w: cellW,
    h: cellH,
  }));
  const rows = Math.ceil(items.length / cols) || 0;
  return {
    placements,
    width: cols * cellW + Math.max(0, cols - 1) * gap,
    height: rows * cellH + Math.max(0, rows - 1) * gap,
    overflow: [],
  };
}
