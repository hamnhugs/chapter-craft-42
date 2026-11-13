import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BookDocument } from "@/types/library";
import type { BookFolder } from "@/lib/bookFolders";

/**
 * The library's deck: shelves as tabs, their books in slots, and one button
 * that takes a shelf to Counsel.
 *
 * What is pinned here is the contract between the three things the deck ties
 * together — books, shelves, the notebook — because each of these was a way
 * the old layout confused people:
 *   - looking at a shelf must not load it;
 *   - "Ask Counsel" loads exactly the open shelf and KEEPS the notebook (no
 *     dialog in between);
 *   - a shelf's contents are the truth, whatever is typed in the search box;
 *   - opening a book to read leaves what Counsel has loaded alone.
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
const tab = (name: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent!.includes(name))!;
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent!.includes(name))!;
const slots = () => host.querySelector('[role="tabpanel"]')!;

beforeEach(() => {
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

describe("shelves are the deck's tabs", () => {
  it("lists Reading now, every shelf with its true size, and a way to make one", async () => {
    await mount();
    expect(tab("Reading now")).toBeTruthy();
    expect(tab("Stoics").textContent).toContain("2");
    expect(tab("Design").textContent).toContain("1");
    expect(button("New shelf")).toBeTruthy();
  });

  it("opens a shelf's books in slots, filled out to the eight Counsel takes", async () => {
    await mount();
    await act(async () => { tab("Stoics").click(); });
    expect(tab("Stoics").getAttribute("aria-selected")).toBe("true");
    expect(slots().querySelectorAll("[data-deck-card]")).toHaveLength(2);
    expect(slots().querySelectorAll(".cc-slot")).toHaveLength(6);
  });

  it("looking at a shelf does not load it", async () => {
    await mount();
    await act(async () => { tab("Stoics").click(); });
    await act(async () => { tab("Design").click(); });
    expect(app.loadFocus).not.toHaveBeenCalled();
  });

  it("remembers the open shelf, and falls back when it has been deleted", async () => {
    localStorage.setItem("vault_deck_tab", "s2");
    await mount();
    expect(tab("Design").getAttribute("aria-selected")).toBe("true");
    await mount({ shelves: [SHELVES[0]] });
    expect(tab("Stoics").getAttribute("aria-selected")).toBe("true");
  });

  it("keeps a shelf's size honest while a search narrows the collection", async () => {
    await mount({ books: [BOOKS[3]], filtered: true });
    expect(tab("Stoics").textContent).toContain("2");
    // The slots step aside for the results.
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
  });
});

describe("Ask Counsel takes the open shelf and keeps the notebook", () => {
  it("loads the shelf with the notebook untouched — nothing is asked on the way", async () => {
    await mount();
    await act(async () => { tab("Stoics").click(); });
    await act(async () => { button("Ask Counsel").click(); });
    expect(app.loadFocus).toHaveBeenCalledWith({ kind: "shelf", shelfId: "s1", neurons: { kind: "keep" } });
  });

  it("says which notebook goes along", async () => {
    app.activeWikis = [{ id: "w1", name: "Philosophy notes" }];
    await mount();
    expect(host.querySelector(".cc-notebook-slot")!.textContent).toContain("Philosophy notes");
    app.activeWikis = [];
    await mount();
    expect(host.querySelector(".cc-notebook-slot")!.textContent).toContain("None — just chat");
  });

  it("shows which shelf Counsel already has", async () => {
    app.loaded = { shelfId: "s1", bookIds: [], excludedIds: [] };
    await mount();
    // With no remembered tab, the loaded shelf is the one that opens.
    expect(tab("Stoics").getAttribute("aria-selected")).toBe("true");
    expect(button("Open Counsel")).toBeTruthy();
  });

  it("cannot send an empty shelf", async () => {
    await mount({ shelves: [...SHELVES, shelf("s3", "Empty")] });
    await act(async () => { tab("Empty").click(); });
    expect(button("Ask Counsel").disabled).toBe(true);
  });
});

describe("the Library page around the deck", () => {
  const LIBRARY = readFileSync(resolve(__dirname, "../components/Library.tsx"), "utf8");

  it("opens a book to read without touching what Counsel has loaded", () => {
    expect(LIBRARY).toContain('void loadFocus({ kind: "book", bookId, neurons: { kind: "keep" }, alongside: true });');
    // The notebook dialog is no longer on the way to reading a book: the
    // page does not take the dialog-raising loader from the app at all.
    expect(LIBRARY).not.toContain("emptyTrash, requestBookLoad");
  });

  it("gives the deck the whole library as well as the search results", () => {
    expect(LIBRARY).toContain("allBooks={sortedBooks}");
  });
});
