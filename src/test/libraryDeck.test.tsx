import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BookDocument } from "@/types/library";
import type { BookFolder } from "@/lib/bookFolders";

/**
 * The library's deck: shelves as tabs, their books in slots, and one button
 * that takes a shelf to Chat.
 *
 * What is pinned here is the contract between the three things the deck ties
 * together — books, shelves, the notebook — because each of these was a way
 * the old layout confused people:
 *   - looking at a shelf must not load it;
 *   - "Ask Chat" loads exactly the open shelf and KEEPS the notebook (no
 *     dialog in between);
 *   - a shelf's contents are the truth, whatever is typed in the search box;
 *   - opening a book to read leaves what Chat has loaded alone.
 */

const app = vi.hoisted(() => ({
  loadFocus: vi.fn(async () => ({})),
  toggleBookShelf: vi.fn(async () => {}),
  activeWikis: [] as { id: string; name: string }[],
  loaded: { shelfId: null as string | null, bookIds: [] as string[], excludedIds: [] as string[] },
}));

vi.mock("@/context/AppContext", () => ({
  useApp: () => ({
    toggleBookShelf: app.toggleBookShelf, createShelf: vi.fn(), renameShelf: vi.fn(), deleteShelf: vi.fn(),
    loadFocus: app.loadFocus, activeWikis: app.activeWikis, membershipLoaded: true,
    applyChapterGists: vi.fn(), applyBookSummary: vi.fn(), applyShelfDigest: vi.fn(), setBookCover: vi.fn(),
  }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/useChatSettings", () => ({
  useChatSettings: () => ({ apiKey: "k", selectedModel: "m", geminiApiKey: "", nvidiaKeyLast4: "" }),
}));
vi.mock("@/lib/chatBooks", () => ({
  bookContextStore: { init: vi.fn(), subscribe: () => () => {}, get: () => app.loaded },
  bookHasCatalog: () => false,
  BOOK_CONTEXT_MAX_BOOKS: 8,
}));
vi.mock("@/lib/catalogJobs", () => ({ catalogJobs: { enqueue: vi.fn() } }));
vi.mock("@/lib/shelfDigest", () => ({ acquireDigestRun: () => true, releaseDigestRun: vi.fn(), generateShelfDigest: vi.fn() }));
vi.mock("@/lib/shelfMarks", () => ({ useShelfMarks: () => new Map() }));
vi.mock("@/components/WikiQuickSwitcher", () => ({ OPEN_NEURON_SWITCHER_EVENT: "open-neuron-switcher" }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import LibraryDeck from "@/components/LibraryDeck";

const act = React.act as unknown as (cb: () => void | Promise<void>) => Promise<void>;

const book = (id: string, folderIds: string[] = []): BookDocument => ({
  id, title: `Book ${id}`, fileName: `${id}.pdf`, fileData: "", pageCount: 100,
  chapters: [], addedAt: 1_000 - Number(id.replace(/\D/g, "")), folderIds,
});
const shelf = (id: string, name: string): BookFolder => ({ id, user_id: "u1", name, sort_index: 0, created_at: "", updated_at: "" });

const SHELVES = [shelf("s1", "Stoics"), shelf("s2", "Design")];
const BOOKS = [book("b1", ["s1"]), book("b2", ["s1"]), book("b3", ["s2"]), book("b4")];

let host: HTMLDivElement;
let root: Root;

const mount = async (props: Partial<React.ComponentProps<typeof LibraryDeck>> = {}) => {
  await act(async () => {
    root.render(
      <LibraryDeck
        books={BOOKS}
        allBooks={BOOKS}
        shelves={SHELVES}
        filtered={false}
        softDelete
        busyByBook={new Map()}
        handlers={{ onRead: vi.fn(), onDetect: vi.fn(), onExtractFigures: vi.fn(), onRemove: vi.fn(), onRename: vi.fn() }}
        {...props}
      />,
    );
  });
};
/** The button naming the open shelf — the one way to the list of shelves. */
const picker = () => host.querySelector<HTMLElement>("[data-shelf-picker]")!;
const shelfRows = () => Array.from(document.querySelectorAll<HTMLElement>(".cc-shelf-row"));
/** Open a shelf the way a person does: the picker, then its row in the list. */
const openShelf = async (name: string) => {
  await act(async () => { picker().click(); });
  await act(async () => { shelfRows().find((r) => r.textContent!.includes(name))!.click(); });
};
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent!.includes(name))!;
const slots = () => host.querySelector("[data-deck-body]")!;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  app.loadFocus.mockClear();
  app.activeWikis = [];
  app.loaded = { shelfId: null, bookIds: [], excludedIds: [] };
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("one shelf is open at a time", () => {
  it("has no sideways row of shelf tabs", async () => {
    await mount();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });

  it("lists Reading now, every shelf with its true size, and a way to make one", async () => {
    await mount();
    await act(async () => { picker().click(); });
    const rows = shelfRows();
    expect(rows[0].textContent).toContain("Reading now");
    expect(rows.find((r) => r.textContent!.includes("Stoics"))!.textContent).toContain("2");
    expect(rows.find((r) => r.textContent!.includes("Design"))!.textContent).toContain("1");
    expect(button("New shelf")).toBeTruthy();
  });

  it("opens a shelf's books in slots, filled out to the eight Chat takes", async () => {
    await mount();
    await openShelf("Stoics");
    expect(picker().textContent).toContain("Stoics");
    expect(slots().querySelectorAll("[data-deck-card]")).toHaveLength(2);
    expect(slots().querySelectorAll(".cc-slot")).toHaveLength(6);
  });

  it("looking at a shelf does not load it", async () => {
    await mount();
    await openShelf("Stoics");
    await openShelf("Design");
    expect(app.loadFocus).not.toHaveBeenCalled();
  });

  it("remembers the open shelf, and falls back when it has been deleted", async () => {
    localStorage.setItem("vault_deck_tab", "s2");
    await mount();
    expect(picker().textContent).toContain("Design");
    await mount({ shelves: [SHELVES[0]] });
    expect(picker().textContent).toContain("Stoics");
  });

  it("keeps a shelf's size honest while a search narrows the collection", async () => {
    await mount({ books: [BOOKS[3]], filtered: true });
    await openShelf("Stoics");
    expect(picker().textContent).toContain("2");
    // The slots step aside for the results.
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
  });
});

describe("Ask Chat takes the open shelf and keeps the notebook", () => {
  it("loads the shelf with the notebook untouched — nothing is asked on the way", async () => {
    await mount();
    await openShelf("Stoics");
    await act(async () => { button("Ask Chat").click(); });
    expect(app.loadFocus).toHaveBeenCalledWith({ kind: "shelf", shelfId: "s1", neurons: { kind: "keep" } });
  });

  it("says which notebook goes along", async () => {
    app.activeWikis = [{ id: "w1", name: "Philosophy notes" }];
    await mount();
    await openShelf("Stoics");
    expect(host.querySelector(".cc-deck-go")!.textContent).toContain("the notebook “Philosophy notes”");
    app.activeWikis = [];
    await mount();
    await openShelf("Stoics");
    expect(host.querySelector(".cc-deck-go")!.textContent).toContain("Takes this shelf to the chat.");
  });

  it("is not offered on Reading now — only a shelf goes to Chat", async () => {
    await mount();
    await openShelf("Reading now");
    expect(picker().textContent).toContain("Reading now");
    expect(button("Ask Chat")).toBeUndefined();
    expect(host.querySelector(".cc-deck-go")).toBeNull();
  });

  it("shows which shelf Chat already has", async () => {
    app.loaded = { shelfId: "s1", bookIds: [], excludedIds: [] };
    await mount();
    // With no remembered tab, the loaded shelf is the one that opens.
    expect(picker().textContent).toContain("Stoics");
    expect(button("Open Chat")).toBeTruthy();
  });

  it("cannot send an empty shelf", async () => {
    await mount({ shelves: [...SHELVES, shelf("s3", "Empty")] });
    await openShelf("Empty");
    expect(button("Ask Chat").disabled).toBe(true);
  });
});

describe("the list of shelves", () => {
  it("lists every shelf in a sheet, and opens the one that is picked", async () => {
    await mount();
    await act(async () => { picker().click(); });
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".cc-shelf-row"));
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Reading now"), expect.stringContaining("Stoics"), expect.stringContaining("Design"),
    ]);
    await act(async () => { rows[2].click(); });
    expect(picker().textContent).toContain("Design");
    expect(document.querySelector(".cc-shelf-row")).toBeNull();
    expect(app.loadFocus).not.toHaveBeenCalled();
  });

  it("offers a filter once there are too many shelves to scan", async () => {
    await mount();
    await act(async () => { picker().click(); });
    expect(document.querySelector('[aria-label="Find a shelf"]')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount({ shelves: Array.from({ length: 9 }, (_, i) => shelf(`m${i}`, `Shelf ${i}`)) });
    await act(async () => { picker().click(); });
    expect(document.querySelector('[aria-label="Find a shelf"]')).toBeTruthy();
  });
});

/**
 * The card's menu must open on TAP, never on touch-down — see
 * promptSwitcherTap.test.tsx for the same bug in Chat's tool row. Here the
 * finger that landed on a card to scroll the Library opened its menu, and the
 * menu, being modal, then stopped the page until it was dismissed.
 */
describe("a book card's menu", () => {
  const card = () => host.querySelector<HTMLElement>("[data-deck-card]")!;
  const fire = async (el: HTMLElement, type: string) => {
    await act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); });
  };

  it("does not open on pointerdown — that touch may be the start of a scroll", async () => {
    await mount();
    await fire(card(), "pointerdown");
    await fire(card(), "pointerup");
    expect(card().getAttribute("data-state")).toBe("closed");
  });

  it("opens on click, closes on a second one, and never locks the page", async () => {
    await mount();
    await fire(card(), "pointerdown");
    await fire(card(), "click");
    expect(card().getAttribute("data-state")).toBe("open");
    // A modal Radix menu sets this on <body>; a non-modal one must not.
    expect(document.body.style.pointerEvents).not.toBe("none");
    await fire(card(), "pointerdown");
    await fire(card(), "click");
    expect(card().getAttribute("data-state")).toBe("closed");
  });

  it("gets out of the way when the page scrolls", async () => {
    await mount();
    await fire(card(), "click");
    expect(card().getAttribute("data-state")).toBe("open");
    await act(async () => { document.dispatchEvent(new Event("scroll")); });
    expect(card().getAttribute("data-state")).toBe("closed");
  });
});

describe("the Library page around the deck", () => {
  const LIBRARY = readFileSync(resolve(__dirname, "../components/Library.tsx"), "utf8");

  it("opens a book to read without touching what Chat has loaded", () => {
    expect(LIBRARY).toContain('void loadFocus({ kind: "book", bookId, neurons: { kind: "keep" }, alongside: true });');
    // The notebook dialog is no longer on the way to reading a book: the
    // page does not take the dialog-raising loader from the app at all.
    expect(LIBRARY).not.toContain("emptyTrash, requestBookLoad");
  });

  it("gives the deck the whole library as well as the search results", () => {
    expect(LIBRARY).toContain("allBooks={sortedBooks}");
  });
});
