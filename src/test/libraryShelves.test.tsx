import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * LibraryShelves — the Vault's shelf surface.
 *
 * Until now the only shelf coverage was the DATA layer
 * (shelfMembership.test.ts) and the CSS (vaultMobileLayout.test.ts). Nothing
 * mounted the component, which is how the counting bug below lived through
 * every review of the feature.
 *
 * THE COUNTING LAW: a shelf card is an OVERVIEW. Its counts come from the
 * whole library (`allBooks`); only GRIDS come from the search-narrowed
 * `books`. Both used to come from the filtered prop, so typing one character
 * into Vault search silently rewrote every shelf card's size — a 40-book
 * shelf read "2 books" with nothing on screen saying why — and the All-books
 * header compared the filtered set against ITSELF, so `visibleBooks.length
 * !== books.length` was false and the "of N" clause was suppressed at exactly
 * the moment it carried information.
 *
 * Rendering goes through react-dom/client + React.act directly rather than
 * @testing-library/react, matching toolApprovalGrant.test.ts: RTL v16 is
 * present but its required peer @testing-library/dom is not declared, so
 * `render()` throws on import.
 */

const state = vi.hoisted(() => ({
  shelves: [] as { id: string; user_id: string; name: string; sort_index: number; created_at: string; updated_at: string }[],
}));

vi.mock("@/lib/bookFolders", () => ({
  listFolders: vi.fn(async () => state.shelves),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));

vi.mock("@/context/AppContext", () => ({
  useApp: () => ({
    toggleBookShelf: vi.fn(),
    clearShelfLocal: vi.fn(),
    multiShelf: true,
    setActiveTab: vi.fn(),
  }),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

vi.mock("@/lib/chatBooks", () => ({
  bookContextStore: { init: vi.fn(), set: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import LibraryShelves from "@/components/LibraryShelves";

/** React 18.3 ships `React.act`; it returns a thenable for sync callbacks too. */
const act = React.act as unknown as (cb: () => void | Promise<void>) => Promise<void>;

const shelf = (id: string, name: string) => ({
  id, user_id: "u1", name, sort_index: 0,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
});

const book = (id: string, title: string, folderIds: string[] = []): BookDocument => ({
  id, title, fileName: `${title}.pdf`, fileData: "", pageCount: 10,
  chapters: [], addedAt: 0, folderIds,
});

/** Five books; three of them on shelf s1. */
const ALL = [
  book("b1", "Dune", ["s1"]),
  book("b2", "Neuromancer", ["s1"]),
  book("b3", "Solaris", ["s1"]),
  book("b4", "Ubik", []),
  book("b5", "Anathem", []),
];

const openRoots: { root: Root; host: HTMLElement }[] = [];

async function mount(props: { books: BookDocument[]; allBooks: BookDocument[]; filtered?: boolean }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  openRoots.push({ root, host });
  await act(async () => {
    root.render(
      React.createElement(LibraryShelves, {
        ...props,
        renderBook: (b: BookDocument) => React.createElement("div", { key: b.id }, b.title),
      }),
    );
  });
  // Flush the listFolders() promise and its setState.
  await act(async () => { await Promise.resolve(); });
  return host;
}

type Mutable = { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(() => {
  (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT = true;
  state.shelves = [shelf("s1", "Sci-fi")];
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const { root, host } of openRoots.splice(0)) {
    await act(() => root.unmount());
    host.remove();
  }
  delete (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT;
});

describe("LibraryShelves counting law", () => {
  it("reports the shelf's TRUE size while a search narrows the view", async () => {
    // Only "Dune" survives the query, but the shelf still holds three books.
    const host = await mount({ books: [ALL[0]], allBooks: ALL, filtered: true });
    expect(host.textContent).toContain("Sci-fi");
    expect(host.textContent).toContain("3 books");
  });

  it("says how many of the shelf's books match, so neither number is inferred", async () => {
    const host = await mount({ books: [ALL[0]], allBooks: ALL, filtered: true });
    expect(host.textContent).toContain("1 matching");
  });

  it("omits the matching annotation when no filter is active", async () => {
    const host = await mount({ books: ALL, allBooks: ALL });
    expect(host.textContent).toContain("3 books");
    expect(host.textContent).not.toContain("matching");
  });

  it("counts the All-books header against the library, not against itself", async () => {
    // The old denominator was the filtered prop, so this rendered "(1)" with
    // the "of N" clause suppressed. That is the regression being pinned.
    const host = await mount({ books: [ALL[0]], allBooks: ALL, filtered: true });
    expect(host.textContent).toContain("All books (1 of 5)");
  });

  it("still renders only the matching books in the grid", async () => {
    const host = await mount({ books: [ALL[0]], allBooks: ALL, filtered: true });
    expect(host.textContent).toContain("Dune");
    expect(host.textContent).not.toContain("Neuromancer");
  });

  it("drops the 'of N' clause when nothing is filtered out", async () => {
    const host = await mount({ books: ALL, allBooks: ALL });
    expect(host.textContent).toContain("All books (5)");
  });
});
