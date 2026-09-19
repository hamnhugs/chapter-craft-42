import { BOOK_CATEGORIES } from "@/lib/autoTag";

// One shared color per category, used by the mind-map nodes, folder view, and
// list view so a category always reads as the same color everywhere.
//
// Palette built from colorblind-safe sets (Paul Tol "light"/"vibrant", Okabe-
// Ito), tuned for dark surfaces. With 17 categories color alone can't be the
// only code (research caps reliable distinction around 8) — every use pairs
// the color with the category label, so color is a scan aid, not the message.
const PALETTE: Record<(typeof BOOK_CATEGORIES)[number], string> = {
  "fiction": "#77AADD",
  "sci-fi & fantasy": "#AA4499",
  "mystery & thriller": "#EE8866",
  "romance": "#FFAABB",
  "history": "#EEDD88",
  "biography & memoir": "#44BB99",
  "science & nature": "#BBCC33",
  "technology & computing": "#99DDFF",
  "business & economics": "#AAAA00",
  "self-improvement": "#E69F00",
  "philosophy & religion": "#CC79A7",
  "politics & society": "#D55E00",
  "arts & culture": "#EE3377",
  "health & psychology": "#009E73",
  "reference & education": "#0077BB",
  "poetry & essays": "#66CCEE",
  "other": "#BBBBBB",
};

export const UNCATEGORIZED = "uncategorized";
const UNCATEGORIZED_COLOR = "#999999";

/** Stable display color for a category (hex). */
export function categoryColor(category?: string | null): string {
  if (!category || category === UNCATEGORIZED) return UNCATEGORIZED_COLOR;
  return PALETTE[category as keyof typeof PALETTE] || PALETTE.other;
}
