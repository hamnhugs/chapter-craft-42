import { useEffect, useMemo } from "react";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import type { BookFolder } from "@/lib/bookFolders";

// Shelf marks: every shelf wears its own color + glyph, and every book on it
// carries that mark (ribbons on the cover, a colored spine, a shelf-colored
// jacket when there's no cover image) — so the books of one shelf can be
// picked out of the whole Vault at a glance.
//
// Color alone stops being reliably distinguishable past ~10 hues, so each
// mark pairs a color with a glyph. The first 12 shelves get a curated set of
// maximally distinct colors (Trubetskoy's "20 distinct colors", best 12 —
// purple left out: the app's own themes are purple, and it read as magenta);
// every shelf after that gets a fresh golden-angle hue, so a new shelf is
// never a copy of an existing one.
//
// A shelf's mark is a SLOT, saved per user in this browser, and a new shelf
// takes the lowest free slot — so marks never reshuffle when shelves are
// renamed, reordered or created. Deleting a shelf frees its slot. Without
// storage the slots fall back to creation order, which is the same answer
// until a shelf is deleted.

const CURATED = [
  "#E6194B", "#3CB44B", "#4363D8", "#FFE119", "#F58231", "#42D4F4",
  "#F032E6", "#BFEF45", "#469990", "#FABED4", "#9A6324", "#E8E8E8",
];

const GLYPHS = [
  "star", "bolt", "diamond", "favorite", "eco", "rocket_launch",
  "local_fire_department", "water_drop", "pets", "anchor", "spa", "emoji_objects",
];

export interface ShelfMark {
  slot: number;
  /** CSS color for the mark's fill. */
  color: string;
  /** Readable text/glyph color on top of `color`. */
  ink: string;
  /** Material Symbols name. */
  glyph: string;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.35 ? "#14101c" : "#ffffff";
}

export function markForSlot(slot: number): ShelfMark {
  const color = slot < CURATED.length
    ? CURATED[slot]
    // Golden-angle hues never repeat; alternating lightness separates
    // neighbours that land close on the wheel.
    : hslToHex((slot * 137.508) % 360, 0.68, slot % 2 ? 0.62 : 0.5);
  // Offset the glyph by the lap so the 13th shelf isn't "red star" again in
  // a different shade — its glyph moves too.
  const lap = Math.floor(slot / GLYPHS.length);
  return { slot, color, ink: inkFor(color), glyph: GLYPHS[(slot + lap) % GLYPHS.length] };
}

/**
 * Give every shelf a slot. Saved slots are kept; shelves without one take the
 * lowest free slot, in creation order. Slots of shelves that no longer exist
 * are dropped (freed).
 */
export function assignShelfSlots(
  shelves: Pick<BookFolder, "id" | "created_at">[],
  saved: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const s of shelves) {
    const slot = saved[s.id];
    if (Number.isInteger(slot) && slot >= 0 && !used.has(slot)) {
      out[s.id] = slot;
      used.add(slot);
    }
  }
  const fresh = shelves
    .filter((s) => out[s.id] === undefined)
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id));
  let next = 0;
  for (const s of fresh) {
    while (used.has(next)) next++;
    out[s.id] = next;
    used.add(next);
  }
  return out;
}

const storageKey = (userId: string | null | undefined) => `cc-shelf-marks:v1:${userId || "anon"}`;

function readSaved(userId: string | null | undefined): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Every shelf's mark, by shelf id. Stable identity until the roster changes. */
export function useShelfMarks(): Map<string, ShelfMark> {
  const { shelves, shelvesLoading } = useApp();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const slots = useMemo(() => assignShelfSlots(shelves, readSaved(userId)), [shelves, userId]);

  // Persist only once the roster has really loaded: an empty roster while it
  // is still loading would otherwise free every slot.
  useEffect(() => {
    if (shelvesLoading) return;
    try { localStorage.setItem(storageKey(userId), JSON.stringify(slots)); } catch { /* private window */ }
  }, [slots, shelvesLoading, userId]);

  return useMemo(() => {
    const map = new Map<string, ShelfMark>();
    for (const [id, slot] of Object.entries(slots)) map.set(id, markForSlot(slot));
    return map;
  }, [slots]);
}

/** A book's marks in roster order (the order the shelf cards show). */
export function marksForBook(
  folderIds: string[],
  shelves: Pick<BookFolder, "id" | "name">[],
  marks: Map<string, ShelfMark>,
): { id: string; name: string; mark: ShelfMark }[] {
  if (folderIds.length === 0) return [];
  const on = new Set(folderIds);
  return shelves
    .filter((s) => on.has(s.id) && marks.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, mark: marks.get(s.id)! }));
}

/** A spine/band background: one solid color, or equal stripes for several. */
export function markStripes(colors: string[], direction = "180deg"): string {
  if (colors.length === 0) return "transparent";
  if (colors.length === 1) return colors[0];
  const step = 100 / colors.length;
  return `linear-gradient(${direction}, ${colors
    .map((c, i) => `${c} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`)
    .join(", ")})`;
}
