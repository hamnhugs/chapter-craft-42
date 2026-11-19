import React, { useMemo, useRef, useState } from "react";
import Index from "./Index";
import { AppContext, useApp } from "@/context/AppContext";
import type { BookDocument } from "@/types/library";
import { bookContextStore } from "@/lib/chatBooks";
import {
  buildPaperHtml, chaptersForPages, newPageId, parsePaperHtml, type PaperMeta, type PaperPage,
} from "@/lib/paperBook";
import type { Transcriber, Transcription } from "@/lib/pageTranscribe";
import { metaFor, PaperIOContext, paperFileName, type PaperIO } from "@/lib/paperStore";
import { paperSession } from "@/lib/paperSession";

/**
 * PAPER LAB — dev-only. Route: #/arena-lab?paper
 *
 * The scanning desk with no account, no AI key and no camera: books are held
 * in memory and a stand-in "transcriber" hands back the next fixture page a
 * second after any photo is given to it. What is real is everything else —
 * the desk, the engine (ordering, retakes, saving), speech, the Library card.
 *
 *   #/arena-lab?paper          the start screen (no paper book yet)
 *   #/arena-lab?paper&resume   an unfinished book of three pages, plus a
 *                              second unfinished book and a finished one
 *   &tab=Library               land on the Library instead
 *
 * `window.__paperLab.next = "cover" | "spread" | "unreadable" | "offline"`
 * makes the NEXT photo come back as that instead of a page.
 */

const P = (n: number, text: string, extra: Partial<PaperPage> = {}): PaperPage => ({
  id: newPageId(), printed: String(n), heading: null, text, footnotes: [], figures: [],
  startsMid: false, endsMid: false, unclear: 0, at: Date.now() + n, ...extra,
});

const FIXTURE: PaperPage[] = [
  P(41, "The lighthouse keeper had a rule about weather, which was that he never talked about it before breakfast. He would stand at the gallery rail with his tea and look at the sea as if it owed him money, and say nothing at all.\n\nMara learned the rule in her first week. She learned the second rule, which was about the lamp, a good deal faster, because the second rule had consequences.", { heading: "Chapter Four: The Second Rule" }),
  P(42, "“You may touch anything in this room,” he told her, “except the thing that matters.” He meant the lens. It stood in the middle of the lantern room like a glass beehive, taller than she was, and it turned so smoothly that she could not hear it move.\n\nShe asked him once what would happen if it stopped. He considered the question for longer than she expected, and then said that he had", { endsMid: true, footnotes: ["A first-order lens of this kind weighs close to three tons."] }),
  P(43, "never needed to find out, and that he intended to keep it that way.\n\nThat night the wind came round to the north. Mara lay awake listening to the tower hum, a low note she could feel in her teeth, and counted the seconds between each sweep of the light across her ceiling. Nine. Always nine.", { startsMid: true, figures: ["A cutaway drawing of the tower showing the lantern room, the watch room and the stair."] }),
  P(44, "In the morning the sea had gone the colour of slate and the supply boat did not come. The keeper looked at the water over his tea and, because it was before breakfast, said nothing.\n\nShe understood then that the first rule was not really about weather. It was about not saying a frightening thing until you had eaten something."),
  P(45, "By the third day they had started to ration the oil. He showed her how to trim the wick so that it burned low and clean, and how to read the gauge on the reservoir, which lied by about a finger's width [unclear] in cold weather.\n\n“Everything here lies a little,” he said. “You only need to know by how much.”", { unclear: 1 }),
];

declare global {
  interface Window { __paperLab?: { next?: "cover" | "spread" | "unreadable" | "offline"; given: number; started?: number; flying?: number; peak?: number; plain?: boolean } }
}

function labBook(id: string, title: string, pages: PaperPage[], status: "open" | "done", ago: number): { book: BookDocument; html: string } {
  const html = buildPaperHtml(title, pages);
  const meta: PaperMeta = { ...metaFor(pages, null), status, updated_at: Date.now() - ago };
  return {
    html,
    book: {
      id, title, fileName: paperFileName(id), fileData: URL.createObjectURL(new Blob([html], { type: "text/html" })),
      pageCount: pages.length, addedAt: Date.now() - ago, folderIds: [], sourceContext: meta,
      chapters: chaptersForPages(pages),
    },
  };
}

const PaperLab: React.FC<{ resume: boolean }> = ({ resume }) => {
  const real = useApp();
  const files = useRef(new Map<string, string>());
  const [books, setBooks] = useState<BookDocument[]>(() => {
    if (!resume) return [];
    const seeds = [
      labBook("lab-paper-1", "The Keeper's Rules", FIXTURE.slice(0, 3), "open", 3_600_000),
      labBook("lab-paper-2", "A Field Guide to Getting Lost", [P(12, "Maps are opinions."), P(13, "This one is wrong about the river.")], "open", 5 * 86_400_000),
      labBook("lab-paper-3", "Small Hours", [P(1, "It was late, and then it was early.")], "done", 9 * 86_400_000),
    ];
    seeds.forEach((s) => files.current.set(s.book.id, s.html));
    return seeds.map((s) => s.book);
  });
  const booksRef = useRef(books);
  booksRef.current = books;
  const [activeBookId, setActiveBookId] = useState<string | null>(resume ? "lab-paper-1" : null);
  const [tab, setTab] = useState<typeof real.activeTab>("viewer");
  if (!resume && !activeBookId && !paperSession.isStarting() && books.length === 0) paperSession.start();

  const lab = useMemo(() => {
    window.__paperLab = { given: 0 };
    const io: PaperIO = {
      async create(title, meta) {
        const id = `lab-paper-${Date.now()}`;
        files.current.set(id, buildPaperHtml(title, []));
        setBooks((prev) => [{ id, title, fileName: paperFileName(id), fileData: "", pageCount: 0, chapters: [], addedAt: Date.now(), folderIds: [], sourceContext: meta }, ...prev]);
        return id;
      },
      async load(bookId) { return parsePaperHtml(files.current.get(bookId) || ""); },
      async save(bookId, next) {
        await new Promise((r) => setTimeout(r, 250));
        const html = buildPaperHtml(next.title, next.pages);
        files.current.set(bookId, html);
        setBooks((prev) => prev.map((b) => b.id !== bookId ? b : {
          ...b, title: next.title, pageCount: next.pages.length, sourceContext: next.meta,
          fileData: URL.createObjectURL(new Blob([html], { type: "text/html" })),
          chapters: chaptersForPages(next.pages),
        }));
      },
      async setCover() { /* the lab keeps no images at all */ },
    };
    const transcribe: Transcriber = async (_photo, opts) => {
      const lab = window.__paperLab!;
      // Pages are handed out in the order reads START, and finish out of
      // order on purpose: the engine must still file them in the order given.
      const mine = lab.started = (lab.started ?? 0) + 1;
      lab.flying = (lab.flying ?? 0) + 1;
      lab.peak = Math.max(lab.peak ?? 0, lab.flying);
      try { await new Promise((r) => setTimeout(r, mine % 3 === 1 ? 1100 : 500)); } finally { lab.flying--; }
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const state = window.__paperLab!;
      const forced = state.next;
      state.next = undefined;
      const base: Transcription = { kind: "page", bookTitle: null, author: null, pages: [], problem: null };
      if (forced === "offline") {
        const { TranscribeError } = await import("@/lib/pageTranscribe");
        throw new TranscribeError("No connection. The page is kept here until you try again.", "network");
      }
      if (forced === "unreadable") return { ...base, kind: "other", problem: "blurry" };
      if (forced === "cover") return { ...base, kind: "cover", bookTitle: "The Keeper's Rules", author: "A. N. Author" };
      // `plain`: unnumbered pages named after the PHOTO (its height encodes
      // which one it is), so a test can see that pages are filed in the order
      // the photos were taken even though the reads finish out of order.
      if (lab.plain) {
        const height = await new Promise<number>((resolve) => { const im = new Image(); im.onload = () => resolve(im.naturalHeight); im.onerror = () => resolve(0); im.src = _photo; });
        return { ...base, pages: [{ ...FIXTURE[0], id: newPageId(), at: Date.now(), printed: null, heading: null, text: `Photo number ${height - 1300}.` }] };
      }
      const fresh = (i: number) => ({ ...FIXTURE[i % FIXTURE.length], id: newPageId(), at: Date.now(), printed: String(41 + i) });
      const i = state.given;
      if (forced === "spread") { state.given += 2; return { ...base, kind: "spread", pages: [fresh(i), fresh(i + 1)] }; }
      state.given += 1;
      return { ...base, pages: [fresh(i)] };
    };
    return { io, transcribe };
  }, []);

  // A resumed lab book already holds the first three fixture pages.
  if (resume && window.__paperLab && window.__paperLab.given === 0) window.__paperLab.given = 3;

  const value = useMemo(() => ({
    ...real,
    books,
    booksLoading: false, shelvesLoading: false, membershipLoaded: true,
    getBooks: () => books,
    activeBookId,
    getActiveBook: () => books.find((b) => b.id === activeBookId),
    getActiveBookId: () => activeBookId,
    setActiveBook: (id: string) => { paperSession.end(); setActiveBookId(id); setTab("viewer"); },
    setActiveBookSilent: (id: string | null) => setActiveBookId(id),
    loadBookFile: async (id: string) => booksRef.current.find((b) => b.id === id)?.fileData ?? "",
    loadFocus: async (action: { kind: string; bookId?: string; bookIds?: string[] }) => {
      if (action.kind === "book" && action.bookId) { paperSession.end(); setActiveBookId(action.bookId); setTab("viewer"); return {} as never; }
      if (action.bookIds) bookContextStore.set({ bookIds: action.bookIds, excludedIds: [] } as never);
      setTab("chat");
      return {} as never;
    },
    activeTab: tab,
    setActiveTab: setTab,
  }), [real, books, activeBookId, tab]);

  return (
    <AppContext.Provider value={value as unknown as typeof real}>
      <PaperIOContext.Provider value={lab}>
        <Index />
      </PaperIOContext.Provider>
    </AppContext.Provider>
  );
};

export default PaperLab;
