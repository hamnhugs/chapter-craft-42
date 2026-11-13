import React, { useEffect, useMemo } from "react";
import Index from "./Index";
import LibraryDeck from "@/components/LibraryDeck";
import type { BookDocument } from "@/types/library";
import { saveLastPage } from "@/hooks/useReaderPrefs";

/**
 * ARENA LAB — dev-only. Route: #/arena-lab  (and #/arena-lab?deck)
 *
 * Every surface of the app is behind the sign-in wall, which makes the arena
 * shell (dock, top bar) and the card collection impossible to look at
 * in a real browser without an account. This mounts the REAL components with
 * no session:
 *
 *   #/arena-lab        the whole shell — `Index` itself, signed out. The
 *                      library is empty, which is also the honest look of
 *                      its empty state.
 *   #/arena-lab?deck   `LibraryDeck` over a fixture library covering every
 *                      tier, every level band, covers and no covers.
 *
 * Like WorkspaceLab it is gated on `import.meta.env.DEV` in App.tsx, so a
 * production build never emits it.
 */

const TITLES = [
  "A Mathematical Theory of Communication", "Thinking, Fast and Slow", "The Pragmatic Programmer",
  "Gödel, Escher, Bach: An Eternal Golden Braid", "Meditations", "Deep Work", "Sapiens",
  "The Art of War", "Structure and Interpretation of Computer Programs", "Dune", "On Writing Well",
  "The Design of Everyday Things", "Attention Is All You Need", "Walden", "The Feynman Lectures on Physics",
  "A Pattern Language", "Notes on the Synthesis of Form", "How to Read a Book",
];
const PAGES = [14, 512, 352, 794, 96, 304, 498, 62, 688, 612, 322, 368, 15, 222, 1552, 1171, 216, 426];
const CATS = ["science & nature", "health & psychology", "technology & computing", "philosophy & religion", "philosophy & religion", "self-improvement", "history", "history", "technology & computing", undefined, "reference & education", "arts & culture", "technology & computing", "poetry & essays", "science & nature", "arts & culture", "arts & culture", "reference & education"];
/** Fraction read, per fixture: unopened, mid-way, nearly done, finished. */
const READ = [0, 0.42, 0.9, 0.08, 1, 0.55, 0, 0.3, 0.02, 0.7, 0, 0.15, 1, 0, 0.004, 0, 0.6, 0];

function cover(i: number): string | undefined {
  // Every third fixture has a "real" cover, drawn here so the lab needs no network.
  if (i % 3 !== 0) return undefined;
  const hue = (i * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560"><rect width="420" height="560" fill="hsl(${hue} 45% 92%)"/><rect x="40" y="60" width="340" height="8" fill="hsl(${hue} 50% 30%)"/><text x="40" y="150" font-family="Georgia,serif" font-size="34" fill="hsl(${hue} 50% 22%)">${TITLES[i].split(" ").slice(0, 3).join(" ").replace(/&/g, "and")}</text><rect x="40" y="430" width="180" height="6" fill="hsl(${hue} 50% 30%)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DeckLab: React.FC = () => {
  const books = useMemo<BookDocument[]>(() => TITLES.map((title, i) => {
    const id = `lab-book-${i}`;
    const lastPage = Math.round(PAGES[i] * READ[i]);
    if (lastPage > 0) saveLastPage(id, lastPage);
    return {
      id, title, fileName: `${id}.pdf`, fileData: "", pageCount: PAGES[i],
      chapters: Array.from({ length: (i % 5) + 2 }, (_, c) => ({
        id: `${id}-c${c}`, name: `Chapter ${c + 1}`, startPage: 1 + c * 10, endPage: 10 + c * 10, textContent: "",
        gist: c < 2 ? "What this part argues, in a line." : null,
      })),
      addedAt: Date.now() - i * 4 * 86_400_000,
      coverImageUrl: cover(i),
      category: CATS[i],
      tags: i % 2 ? ["classic", "reread"] : [],
      summary: i % 4 === 0 ? "A short model-written summary of what the book covers and why it is worth the time." : null,
      summaryModel: i % 4 === 0 ? "example/model" : null,
      folderIds: [],
    };
  }), []);
  const noop = () => {};
  return (
    <div className="h-app overflow-auto bg-background">
      <main className="max-w-7xl mx-auto px-6 py-8">
        <LibraryDeck
          books={books}
          shelves={[]}
          filtered={false}
          softDelete
          busyByBook={new Map([[books[6].id, "Finding chapters…"]])}
          handlers={{ onRead: noop, onDetect: noop, onExtractFigures: noop, onRemove: noop, onRename: noop }}
        />
      </main>
    </div>
  );
};

/**
 * `&open` clicks the first card (the profile), `?tab=<Label>` clicks a dock
 * tab — so a headless screenshot can reach states that need a tap.
 */
const ArenaLab: React.FC = () => {
  const hash = window.location.hash;
  useEffect(() => {
    const t = setTimeout(() => {
      if (hash.includes("open")) document.querySelector<HTMLElement>("[data-deck-card]")?.click();
      const tab = /tab=([A-Za-z]+)/.exec(hash)?.[1];
      if (tab) document.querySelector<HTMLElement>(`[data-mobile-nav] button[aria-label="${tab}"]`)?.click();
    }, 600);
    return () => clearTimeout(t);
  }, [hash]);
  return hash.includes("?deck") ? <DeckLab /> : <Index />;
};

export default ArenaLab;
