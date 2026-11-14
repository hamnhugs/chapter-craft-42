import React, { useEffect, useMemo } from "react";
import Index from "./Index";
import LibraryDeck from "@/components/LibraryDeck";
import type { BookDocument } from "@/types/library";
import { saveLastPage } from "@/hooks/useReaderPrefs";
import { AppContext, useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import type { BookFolder } from "@/lib/bookFolders";
import WikiLibrary from "@/components/WikiLibrary";
import WikiPanel from "@/components/WikiPanel";
import WormCoach from "@/components/onboarding/WormCoach";
import { openSetupWizard } from "@/components/SetupWizard";
import { beginOnboarding, replayOnboarding } from "@/lib/onboarding";
import type { NotebookStore, WikiWithStats } from "@/lib/wikisApi";

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
 *   #/arena-lab?library the shell on the Library tab over the same fixture
 *                      library, with four shelves you can edit (in memory).
 *   #/arena-lab?reader the shell on the Read tab with a real PDF open (a
 *                      document from docs/, served by the dev server), with
 *                      three chapters. `&html` opens an HTML book instead.
 *   #/arena-lab?chat   the shell on Counsel with a reply on it that has every
 *                      kind of prose in it (heading, list, quote, rule, code).
 *   #/arena-lab?notebooks the Notebooks list and an open notebook over a
 *                      fixture tree held in memory: create, nest, move and
 *                      delete all work. `&flat` has no nesting, `&empty` none.
 *   #/arena-lab?onboarding the shell as a brand-new account sees it: the
 *                      setup helper, then the getting-started ring and the
 *                      tab tours. `&step=1` opens the helper on a later
 *                      screen; `&tips` skips it and goes straight to the tours.
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

function fixtureBooks(): BookDocument[] {
  return TITLES.map((title, i) => {
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
  });
}

const DeckLab: React.FC = () => {
  const books = useMemo<BookDocument[]>(fixtureBooks, []);
  const noop = () => {};
  return (
    <div className="h-app overflow-auto bg-background">
      <main className="max-w-7xl mx-auto px-6 py-8">
        <LibraryDeck
          books={books}
          allBooks={books}
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

const READER_HTML = `<!doctype html><meta charset="utf-8"><body style="font:18px/1.6 Georgia,serif;max-width:40rem;margin:2rem auto;padding:0 1rem">${Array.from({ length: 6 }, (_, i) => `<h2 id="section-${i + 1}">Section ${i + 1}</h2>${"<p>The quick brown fox jumps over the lazy dog, and then considers at some length what it has done and why it mattered to anyone at all.</p>".repeat(5)}`).join("")}</body>`;

/** `Index` on the Read tab over one fixture book, by overriding just the
 *  book-facing parts of the real (signed-out) app state. */
const ReaderLab: React.FC<{ html: boolean }> = ({ html }) => {
  const real = useApp();
  const book = useMemo<BookDocument>(() => ({
    id: "lab-reader-book",
    title: "Program Sandbox Reference",
    fileName: html ? "lab-reader-book.html" : "lab-reader-book.pdf",
    fileData: html ? URL.createObjectURL(new Blob([READER_HTML], { type: "text/html" })) : "/docs/program-sandbox-reference.pdf",
    pageCount: 5,
    chapters: [1, 2, 4].map((start, c) => ({
      id: `lab-reader-c${c}`, name: ["Overview", "The sandbox contract", "Limits and errors"][c], startPage: start, endPage: start + 1, textContent: "",
    })),
    addedAt: Date.now(),
    folderIds: [],
  }), [html]);
  const [tab, setTab] = React.useState<typeof real.activeTab>("viewer");
  const value = useMemo(() => ({
    ...real,
    books: [book],
    activeBookId: book.id,
    getActiveBook: () => book,
    getActiveBookId: () => book.id,
    loadBookFile: async () => book.fileData,
    activeTab: tab,
    setActiveTab: setTab,
  }), [real, book, tab]);
  return <AppContext.Provider value={value as typeof real}><Index /></AppContext.Provider>;
};

const LAB_SHELVES = ["Information theory", "Stoics", "Programming craft", "Design"];
/** Fixture index → the shelves it sits on. Index 3 is on two; half are on none. */
const LAB_MEMBERS: Record<number, number[]> = { 0: [0], 12: [0], 14: [0], 4: [1], 7: [1], 2: [2], 8: [2], 3: [2, 3], 11: [3], 15: [3], 16: [3] };

/** `Index` on the Library tab over the fixture library, with shelves that can
 *  be created, renamed, deleted and filled — all in memory. */
const LibraryLab: React.FC = () => {
  const real = useApp();
  const [shelves, setShelves] = React.useState<BookFolder[]>(() => LAB_SHELVES.map((name, i) => ({
    id: `lab-shelf-${i}`, user_id: "lab", name, sort_index: i, created_at: "", updated_at: "",
  })));
  const [books, setBooks] = React.useState<BookDocument[]>(() => fixtureBooks().map((b, i) => ({
    ...b, folderIds: (LAB_MEMBERS[i] ?? []).map((s) => `lab-shelf-${s}`),
  })));
  const [tab, setTab] = React.useState<typeof real.activeTab>("library");
  const value = useMemo(() => ({
    ...real,
    books, shelves,
    booksLoading: false, shelvesLoading: false, multiShelf: true, membershipLoaded: true,
    getBooks: () => books,
    getShelves: () => shelves,
    activeTab: tab,
    setActiveTab: setTab,
    toggleBookShelf: async (bookId: string, shelfId: string) => {
      setBooks((prev) => prev.map((b) => b.id !== bookId ? b : {
        ...b, folderIds: b.folderIds.includes(shelfId) ? b.folderIds.filter((x) => x !== shelfId) : [...b.folderIds, shelfId],
      }));
    },
    createShelf: async (name: string) => {
      const shelf: BookFolder = { id: `lab-shelf-${Date.now()}`, user_id: "lab", name, sort_index: 99, created_at: "", updated_at: "" };
      setShelves((prev) => [...prev, shelf]);
      return shelf;
    },
    renameShelf: async (id: string, name: string) => { setShelves((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s))); },
    deleteShelf: async (id: string) => {
      setShelves((prev) => prev.filter((s) => s.id !== id));
      setBooks((prev) => prev.map((b) => ({ ...b, folderIds: b.folderIds.filter((x) => x !== id) })));
    },
    updateBookTitle: (id: string, title: string) => setBooks((prev) => prev.map((b) => (b.id === id ? { ...b, title } : b))),
    // The real loader navigates the real (signed-out) shell; point it at the lab's tab.
    loadFocus: async (action: Parameters<typeof real.loadFocus>[0]) => {
      const report = await real.loadFocus(action, { navigate: false });
      setTab(action.kind === "book" ? "viewer" : "chat");
      return report;
    },
  }), [real, books, shelves, tab]);
  return <AppContext.Provider value={value as typeof real}><Index /></AppContext.Provider>;
};

/**
 * `&open` clicks the first card (the profile), `?tab=<Label>` clicks a dock
 * tab — so a headless screenshot can reach states that need a tap.
 */
/** A reply with every kind of prose in it, so a theme's typesetting can be looked at. */
const SAMPLE_REPLY = `## On the measure of a line

Shannon's opening move is to throw the meaning away. A message is one selected from a set of possible messages, and what matters to the engineer is only how *many* there were to choose from — which is why the measure is logarithmic.

That single decision is what lets the rest of the paper exist. Three things follow from it:

- **Entropy** is the average surprise of a source, in bits per symbol.
- **Redundancy** is what a language spends on being robust; English spends about half.
- **Capacity** is a property of the channel alone, whatever is sent down it.

> The fundamental problem of communication is that of reproducing at one point either exactly or approximately a message selected at another point.

1. Read section 1 for the discrete noiseless case.
2. Skip to section 12 if you only want the theorem.

---

The entropy itself is \`H = -Σ p log p\`. See [the paper](https://example.com) for the proof.`;

/** `?chat` — the Counsel tab with a reply already on it. */
const ChatLab: React.FC = () => {
  const { injectDisplayMessage } = useChat();
  useEffect(() => {
    injectDisplayMessage("Good evening. Which book shall we open?");
    const t = setTimeout(() => injectDisplayMessage(SAMPLE_REPLY), 50);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Index />;
};

const NB = (id: string, name: string, color: string, notes: number, parent?: string, due = 0): WikiWithStats => ({
  id, user_id: "lab", name, description: "", cover_color: color, tags: parent ? [`in:${parent}`] : [],
  is_default: false, is_meta: false, last_loaded_at: null, created_at: "", updated_at: "",
  entry_count: notes, due_count: due,
});
const LAB_NOTEBOOKS: WikiWithStats[] = [
  NB("n-my", "My notes", "#7C3AED", 42, undefined, 3),
  NB("n-stoics", "Stoics", "#10B981", 18),
  NB("n-med", "Meditations", "#0EA5E9", 31, "n-stoics", 2),
  NB("n-med-5", "Book 5 — on rising early", "#2563EB", 6, "n-med"),
  NB("n-seneca", "Seneca's letters", "#F59E0B", 12, "n-stoics"),
  NB("n-prog", "Programming craft", "#EF4444", 9),
  NB("n-sicp", "SICP exercises", "#EC4899", 27, "n-prog", 1),
  NB("n-prag", "Pragmatic Programmer", "#8B5CF6", 14, "n-prog"),
  NB("n-dune", "Dune lore", "#F59E0B", 57),
  NB("n-startup", "Startup strategy", "#2563EB", 0),
];

/** The Notebooks list and an open notebook over a tree held in memory. */
const NotebooksLab: React.FC<{ variant: "tree" | "flat" | "empty" }> = ({ variant }) => {
  const real = useApp();
  const [list, setList] = React.useState<WikiWithStats[]>(() =>
    variant === "empty" ? [] : variant === "flat" ? LAB_NOTEBOOKS.slice(0, 4).map((w) => ({ ...w, tags: [] })) : LAB_NOTEBOOKS);
  const listRef = React.useRef(list);
  listRef.current = list;
  const store = useMemo<NotebookStore>(() => ({
    list: async () => listRef.current,
    create: async (input) => {
      const w = { ...NB(`n-${Date.now()}`, input.name, input.cover_color || "#7C3AED", 0), tags: input.tags || [] };
      setList((l) => (listRef.current = [...l, w]));
      return w;
    },
    update: async (id, updates) => setList((l) => (listRef.current = l.map((w) => (w.id === id ? { ...w, ...updates } : w)))),
    remove: async (id) => setList((l) => (listRef.current = l.filter((w) => w.id !== id))),
  }), []);
  const [tab, setTab] = React.useState<typeof real.activeTab>("wikis");
  const [viewed, setViewed] = React.useState<string | null>(null);
  const value = useMemo(() => ({
    ...real,
    wikis: list,
    activeWikiId: "n-my",
    activeWikiIds: ["n-my"],
    viewedWikiId: viewed,
    activeTab: tab,
    setActiveTab: setTab,
    openNotebook: (id: string) => { setViewed(id); setTab("wiki"); },
    refreshWikis: async () => {},
  }), [real, list, tab, viewed]);
  useEffect(() => {
    // `&tips` runs Bookworm's Notebooks tour over the list.
    beginOnboarding("lab-notebooks", "veteran");
    if (window.location.hash.includes("tips")) replayOnboarding();
  }, []);
  return (
    <AppContext.Provider value={value as typeof real}>
      <div className="h-app bg-background">
        {tab === "wiki" ? <WikiPanel /> : <WikiLibrary store={store} />}
        <WormCoach />
      </div>
    </AppContext.Provider>
  );
};

/** The shell as a brand-new account meets it. */
const OnboardingLab: React.FC = () => {
  useEffect(() => {
    const hash = window.location.hash;
    beginOnboarding("lab", "new");
    replayOnboarding();
    if (!hash.includes("tips")) openSetupWizard(Number(/step=(\d)/.exec(hash)?.[1] ?? 0));
  }, []);
  return <Index />;
};

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
  if (hash.includes("?library")) return <LibraryLab />;
  if (hash.includes("?reader")) return <ReaderLab html={hash.includes("html")} />;
  if (hash.includes("?chat")) return <ChatLab />;
  if (hash.includes("?notebooks")) return <NotebooksLab variant={hash.includes("empty") ? "empty" : hash.includes("flat") ? "flat" : "tree"} />;
  if (hash.includes("?onboarding")) return <OnboardingLab />;
  return hash.includes("?deck") ? <DeckLab /> : <Index />;
};

export default ArenaLab;
