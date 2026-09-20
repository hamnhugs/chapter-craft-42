import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BookDocument } from "@/types/library";

/**
 * Library, actually mounted.
 *
 * There was no mount coverage for the Vault's own component, which is how a
 * temporal-dead-zone hazard got written in this session: a `useRef` holding
 * `runDetect` was placed above the `const runDetect` it captured. TypeScript
 * does not catch that across a function body, the build succeeds, and the tab
 * throws a ReferenceError the instant the Vault renders.
 *
 * This mounts it against stubbed context and asserts the three states the
 * audit separated — loading, failed, and genuinely empty — which used to be
 * one indistinguishable "Your library is empty".
 */

const state = vi.hoisted(() => ({
  books: [] as BookDocument[],
  booksLoading: false,
  booksError: null as string | null,
  retried: 0,
}));

vi.mock("@/context/AppContext", () => ({
  // A module-level export, not part of useApp().
  TRASH_RETENTION_DAYS: 30,
  useApp: () => ({
    books: state.books, booksLoading: state.booksLoading, booksError: state.booksError,
    retryLoadBooks: () => { state.retried += 1; },
    addBook: vi.fn(), removeBook: vi.fn(), trashAvailable: false, trashedBooks: [],
    trashLoading: false, refreshTrash: vi.fn(), restoreBook: vi.fn(), purgeBook: vi.fn(),
    emptyTrash: vi.fn(), requestBookLoad: vi.fn(), updateBookTitle: vi.fn(),
    updateBookTags: vi.fn(), addChapter: vi.fn(), removeChapter: vi.fn(),
    loadBookFile: vi.fn(), applyChapterGists: vi.fn(), applyBookSummary: vi.fn(),
    loadChapterText: vi.fn(), shelves: [], toggleBookShelf: vi.fn(), shelvesLoading: false,
    multiShelf: true, membershipLoaded: true, createShelf: vi.fn(), renameShelf: vi.fn(),
    deleteShelf: vi.fn(), applyShelfDigest: vi.fn(), setActiveTab: vi.fn(),
    requestShelfLoad: vi.fn(), requestBooksLoad: vi.fn(),
  }),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/useChatSettings", () => ({
  useChatSettings: () => ({
    apiKey: "k", imageExtractionModel: "m", selectedModel: "m",
    geminiApiKey: "", nvidiaKeyLast4: "", autoCatalogOnUpload: false,
  }),
}));
vi.mock("@/hooks/usePlan", () => ({ usePlan: () => ({ isPaid: true, loaded: true }) }));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => ({ isAdmin: false, loaded: true }) }));
vi.mock("@/lib/structureJobs", () => ({ useStructureJobs: () => ({}), structureJobs: { enqueue: vi.fn() } }));
vi.mock("@/lib/catalogJobs", () => ({ useCatalogJobs: () => ({}), catalogJobs: { enqueue: vi.fn() } }));
vi.mock("@/lib/figureJobs", () => ({ useFigureJobs: () => ({}), figureJobs: { enqueue: vi.fn() } }));
vi.mock("@/lib/chatBooks", () => ({
  bookContextStore: { init: vi.fn(), set: vi.fn() },
  bookHasCatalog: () => false,
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import Library from "@/components/Library";

const act = React.act as unknown as (cb: () => void | Promise<void>) => Promise<void>;

const book = (id: string, title: string): BookDocument => ({
  id, title, fileName: `${title}.pdf`, fileData: "", pageCount: 100,
  chapters: [], addedAt: Date.now(), folderIds: [],
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.books = []; state.booksLoading = false; state.booksError = null; state.retried = 0;
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

const mount = async () => { await act(async () => { root.render(<Library />); }); };
const text = () => host.textContent ?? "";

describe("Library, mounted", () => {
  it("renders at all — no temporal dead zone in the render body", async () => {
    state.books = [book("b1", "The Master and His Emissary")];
    await mount();
    expect(text()).toContain("The Master and His Emissary");
  });

  it("shows skeletons while loading, not the empty-library upsell", async () => {
    state.booksLoading = true;
    await mount();
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(text()).not.toContain("Your library is empty");
  });

  it("shows the failure and a retry, not the empty-library upsell", async () => {
    state.booksError = "Network request failed";
    await mount();
    expect(text()).toContain("Couldn’t load your library");
    expect(text()).toContain("Network request failed");
    expect(text()).not.toContain("Your library is empty");

    const retry = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Try again");
    await act(async () => { retry!.click(); });
    expect(state.retried).toBe(1);
  });

  it("still says the library is empty when it genuinely is", async () => {
    await mount();
    expect(text()).toContain("Your library is empty");
  });

  it("restores the remembered sort order", async () => {
    localStorage.setItem("vault_sort_by", "name");
    state.books = [book("b1", "Zebra"), book("b2", "Aardvark")];
    await mount();
    expect(text()).toContain("By Name");
  });

  it("restores the remembered search text", async () => {
    sessionStorage.setItem("vault_query", "emissary");
    state.books = [book("b1", "The Master and His Emissary"), book("b2", "Other")];
    await mount();
    const input = host.querySelector<HTMLInputElement>('input[type="text"], input[placeholder*="Search"]');
    expect(input?.value).toBe("emissary");
  });
});
