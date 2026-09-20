/**
 * Visual preview harness — NOT part of the app bundle.
 *
 * The Vault and the pocket screen both sit behind a login, so there is no way
 * to look at them from a headless browser without one. This mounts the real
 * components with fixture data so a change to how they LOOK can be checked by
 * looking, the way the worm's render scripts do for the sprite.
 *
 *   npx vite --port 5199 &
 *   chromium --headless --screenshot=out.png --window-size=1280,900 \
 *     "http://localhost:5199/scripts/preview/index.html?view=showcase&theme=aurora"
 *
 *   ?view=showcase|pocket  &theme=<id>  &state=listening|thinking|speaking
 *   &caption=1 (pocket: show a reply)   &empty=1 (showcase: sparse book)
 */
import React from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import type { BookDocument } from "@/types/library";

const q = new URLSearchParams(location.search);
const theme = q.get("theme");
if (theme) localStorage.setItem("cc-theme", theme);
if (q.get("season") === "off") localStorage.setItem("cc-seasonal", "off");
else localStorage.removeItem("cc-seasonal");
localStorage.setItem("vault_showcase_book", q.get("empty") ? "b4" : "b1");

// The pocket screen only exists on touch devices and arms after 12s idle.
// Claim a coarse pointer; the caller supplies --virtual-time-budget.
if (q.get("view") === "pocket") {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((m: string) => (m.includes("pointer: coarse") ? { ...real(m), matches: true, media: m, addEventListener() {}, removeEventListener() {} } : real(m))) as typeof window.matchMedia;
}

const book = (id: string, title: string, over: Partial<BookDocument> = {}): BookDocument => ({
  id, title, fileName: `${title}.pdf`, fileData: "", pageCount: 412,
  chapters: [], addedAt: Date.now() - 86400000 * 9, folderIds: [], ...over,
});
const ch = (i: number, name: string, gist: string) => ({ id: `c${i}`, name, startPage: i * 40 + 1, endPage: i * 40 + 40, textContent: "", gist });

const BOOKS: BookDocument[] = [
  book("b1", "The Master and His Emissary", {
    category: "philosophy", tags: ["mind", "attention", "hemispheres", "culture"], pageCount: 616,
    summary: "An argument that the two hemispheres of the brain attend to the world in fundamentally different ways, and that the history of Western culture can be read as a slow shift in the balance of power between them.",
    summaryModel: "claude-opus-5", folderIds: ["s1"],
    chapters: [ch(0, "Asymmetry and the Brain", "Why the brain is divided at all."), ch(1, "What Do the Two Hemispheres Do?", "Breadth of attention versus focus."), ch(2, "Language, Truth and Music", "Music came first."), ch(3, "The Primacy of the Right", "The whole precedes the parts.")],
  }),
  book("b2", "Seeing Like a State", { category: "politics", pageCount: 445, tags: ["legibility"], summary: "How certain schemes to improve the human condition have failed." }),
  book("b3", "The Order of Time", { category: "physics", pageCount: 224 }),
  book("b4", "notes-final-v3"),
  book("b5", "A Pattern Language", { category: "architecture", pageCount: 1171, tags: ["design"] }),
  book("b6", "Gödel, Escher, Bach", { category: "mathematics", pageCount: 777 }),
  book("b7", "The Timeless Way of Building", { category: "architecture", pageCount: 552 }),
  book("b8", "How Buildings Learn", { category: "architecture", pageCount: 243 }),
  book("b9", "Thinking in Systems", { category: "systems", pageCount: 240 }),
  book("b10", "The Dream Machine", { category: "history", pageCount: 528 }),
  book("b11", "Finite and Infinite Games", { category: "philosophy", pageCount: 160 }),
];
localStorage.setItem("cc_reader_page_b1", "231");

const REPLY =
  "The short version is that the right hemisphere takes in the whole scene first, and the left then picks out the part it has been asked about.\n\nMcGilchrist's point is that this is a division of attention, not of subject matter — both halves handle language, both handle images. What differs is how each one looks.\n\nSo when he says the emissary has usurped the master, he means a culture that trusts the narrow, grasping kind of attention and has forgotten it was only ever meant to report back.";

async function main() {
  const { ThemeProvider } = await import("@/context/ThemeContext");
  const view = q.get("view") ?? "showcase";
  let el: React.ReactNode;
  if (view === "pocket") {
    const { default: PocketScreen } = await import("@/components/PocketScreen");
    const state = q.get("state") ?? "listening";
    const caption = q.get("caption")
      ? { id: "m1", from: (state === "thinking" ? "user" : "assistant") as "user" | "assistant", text: state === "thinking" ? "What does he mean by the emissary usurping the master?" : REPLY }
      : null;
    el = <PocketScreen active state={state} caption={caption} />;
  } else {
    const { default: LibraryShowcase } = await import("@/components/LibraryShowcase");
    el = (
      <div className="min-h-screen bg-background p-3 sm:p-8">
        <div className="max-w-6xl mx-auto">
          <LibraryShowcase books={BOOKS} shelves={[{ id: "s1", name: "Mind" }]} onOpenBook={() => {}} />
        </div>
      </div>
    );
  }
  createRoot(document.getElementById("root")!).render(<ThemeProvider>{el}</ThemeProvider>);
}
void main();
