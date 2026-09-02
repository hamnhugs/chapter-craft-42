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

// The roster arrives through AppContext now, not a component-local fetch —
// that single copy is what A-2 bought, and this mock is shaped to prove it.
vi.mock("@/context/AppContext", () => ({
  useApp: () => ({
    toggleBookShelf: vi.fn(),
    multiShelf: true,
    setActiveTab: vi.fn(),
    shelves: state.shelves,
    shelvesLoading: false,
    createShelf: vi.fn(),
    renameShelf: vi.fn(),
    deleteShelf: vi.fn(),
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

/** Click the first button whose visible text contains `text`. */
async function clickButton(host: HTMLElement, text: string) {
  const btn = Array.from(host.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(text),
  );
  if (!btn) throw new Error(`no button containing ${JSON.stringify(text)}`);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Richer fixture: two categories, overlapping tags, two unfiled books. */
const faceted = (
  id: string, title: string, folderIds: string[], category: string, tags: string[],
): BookDocument => ({ ...book(id, title, folderIds), category, tags });

const FACETED = [
  faceted("b1", "Dune", ["s1"], "fiction", ["space"]),
  faceted("b2", "Neuromancer", ["s1"], "fiction", ["cyber"]),
  faceted("b3", "Solaris", ["s1"], "fiction", ["space"]),
  faceted("b4", "Ubik", [], "essays", ["space"]),
  faceted("b5", "Anathem", [], "essays", []),
];

describe("LibraryShelves facets are co-equal filters", () => {
  it("offers tags without requiring a category first", async () => {
    // Tags used to render only once a category was picked, which made them a
    // CHILD of category in the UI while the data model has them independent.
    const host = await mount({ books: FACETED, allBooks: FACETED });
    expect(host.textContent).toContain("#space");
    expect(host.textContent).toContain("#cyber");
  });

  it("narrows shelf-card counts too, not just the All-books grid", async () => {
    const host = await mount({ books: FACETED, allBooks: FACETED });
    // Before: shelf cards sat above the facets quoting unfiltered sizes, so
    // one screen gave two different answers to "how many books".
    expect(host.textContent).not.toContain("matching");
    await clickButton(host, "#space");
    expect(host.textContent).toContain("3 books");   // Sci-fi's true size
    expect(host.textContent).toContain("2 matching"); // Dune + Solaris
  });

  it("keeps the tag selection when a category is chosen", async () => {
    const host = await mount({ books: FACETED, allBooks: FACETED });
    await clickButton(host, "#space");
    await clickButton(host, "fiction");
    // Orthogonal: both facets apply. fiction ∩ space = Dune, Solaris.
    expect(host.textContent).toContain("All books (2 of 5)");
  });

  it("takes each facet's counts with the other facet applied", async () => {
    const host = await mount({ books: FACETED, allBooks: FACETED });
    await clickButton(host, "#cyber");
    // Only Neuromancer carries #cyber, and it is fiction — so "essays" must
    // not still advertise 2 results it could not deliver.
    expect(host.textContent).not.toContain("essays2");
  });
});

describe("LibraryShelves unshelved pile", () => {
  it("gives the unfiled books a named place", async () => {
    const host = await mount({ books: FACETED, allBooks: FACETED });
    expect(host.textContent).toContain("Unshelved");
    expect(host.textContent).toContain("2 books"); // Ubik + Anathem
  });

  it("stays hidden when every book is filed", async () => {
    const allFiled = FACETED.map((b) => ({ ...b, folderIds: ["s1"] }));
    const host = await mount({ books: allFiled, allBooks: allFiled });
    expect(host.textContent).not.toContain("Unshelved");
  });

  it("counts the pile against the library and annotates matches", async () => {
    const host = await mount({ books: FACETED, allBooks: FACETED });
    await clickButton(host, "#space");
    // Pile holds Ubik + Anathem; only Ubik carries #space.
    expect(host.textContent).toContain("1 matching");
  });
});
