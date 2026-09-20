/**
 * The Vault audit.
 *
 * Reported: the Vault takes far too long to become usable, and loses your
 * place every time you come back to it. Auditing it turned up a specific set
 * of defects, and these are the assertions that stop each one returning. Each
 * test names the defect rather than the mechanism, because the mechanism is
 * what a future refactor will legitimately change.
 *
 * Source assertions, because all of this lives in JSX and effects. Comments
 * are stripped first: several of these files now explain at length why a call
 * was removed, and matching raw text would hit the explanation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const read = (p: string) => stripComments(readFileSync(resolve(process.cwd(), "src", p), "utf8"));

const LIBRARY = read("components/Library.tsx");
const SHELVES = read("components/LibraryShelves.tsx");
const LIST = read("components/LibraryList.tsx");
const APP = read("context/AppContext.tsx");

describe("the Vault says what it is doing", () => {
  it("was actually read", () => {
    for (const [name, src] of [["Library", LIBRARY], ["Shelves", SHELVES], ["AppContext", APP]] as const) {
      expect(src.length, name).toBeGreaterThan(5000);
    }
  });

  it("distinguishes loading, failed and genuinely empty", () => {
    // All three used to render the same "Your library is empty" upsell,
    // because the only condition was books.length === 0. A cold open showed
    // it for the length of the read; a failed read showed it forever, with
    // the sole trace a console.error.
    expect(APP).toContain("booksLoading");
    expect(APP).toContain("booksError");
    expect(LIBRARY).toContain("{booksError ? (");
    expect(LIBRARY).toContain("booksLoading && books.length === 0 ?");
    expect(LIBRARY).toContain("Couldn’t load your library");
    expect(LIBRARY).toContain("Your library is empty");
  });

  it("offers a retry that actually re-runs the read", () => {
    expect(APP).toContain("const retryLoadBooks = useCallback(");
    expect(APP).toContain("setLoadAttempt((n) => n + 1)");
    expect(APP).toMatch(/\}, \[user, loadAttempt\]\);/);
    expect(LIBRARY).toContain("onClick={retryLoadBooks}");
  });

  it("settles the loading flag on every path, including signed out", () => {
    // A flag that can stay true forever is the empty-state bug again wearing
    // a spinner.
    const settles = APP.match(/setBooksLoading\(false\)/g) ?? [];
    expect(settles.length).toBeGreaterThanOrEqual(3);
  });

  it("shows skeletons shaped like books rather than a spinner", () => {
    expect(LIBRARY).toContain('aria-busy="true"');
    expect(LIBRARY).toContain("motion-safe:animate-pulse");
  });
});

describe("the Vault does not block itself", () => {
  it("renders the books without waiting for the shelf roster", () => {
    // The default view is Shelves, and it used to return a bare "Loading
    // shelves…" until an unrelated roster fetch resolved — blanking the whole
    // view, including the All books section, which needs no shelves at all.
    expect(SHELVES).not.toContain("Loading shelves…");
    expect(SHELVES).not.toMatch(/if \(shelvesLoading\) \{\s*return/);
  });
});

describe("the Vault keeps your place", () => {
  it("remembers the sort, the search and the scroll position", () => {
    // Index.tsx unmounts Library on every tab switch, and opening a book IS a
    // tab switch — so all of this died every time you read something.
    for (const key of ['"vault_sort_by"', '"vault_query"', '"vault_scroll"']) {
      expect(LIBRARY).toContain(key);
    }
    expect(LIBRARY).toContain("scrollRef.current?.scrollTo({ top })");
  });

  it("restores the scroll only once the books are there to scroll", () => {
    expect(LIBRARY).toContain("if (scrollRestoredRef.current || books.length === 0");
  });

  it("does not reset the page count when a background job touches a book", () => {
    // usePagedBooks reset on `items` identity, which is a fresh array whenever
    // `books` changes — so a catalog job finishing threw the reader back to
    // the first 60 books after they had pressed Show more five times.
    expect(SHELVES).toContain("function usePagedBooks(items: BookDocument[], resetKey: string)");
    expect(SHELVES).toContain("useEffect(() => { setShown(GRID_PAGE_SIZE); }, [resetKey]);");
    expect(SHELVES).toContain("const pageResetKey =");
  });
});

describe("the Vault stops doing pointless work", () => {
  it("computes why a book matched once per query, not once per card per render", () => {
    // chapterMatch normalizes every chapter of every book that did not match
    // on its spine. Called inline in the render prop, that was roughly
    // eighteen hundred Unicode normalizations per keystroke.
    expect(LIBRARY).toContain("const matchByBook = useMemo(");
    expect(LIBRARY).toContain("match={matchByBook.get(book.id) ?? null}");
    expect(LIBRARY).not.toMatch(/match=\{chapterMatch\(/);
  });

  it("memoizes the book card, with props stable enough for the memo to bite", () => {
    expect(LIBRARY).toContain("const BookCard = React.memo(BookCardImpl);");
    // React.memo is decorative if the props are fresh closures. Passing
    // `onDetect={() => runDetect(book)}` and four more like it built five new
    // function identities per card per render, so every card re-rendered on
    // every parent render regardless.
    expect(LIBRARY).toContain("{...cardHandlers}");
    expect(LIBRARY).not.toMatch(/onDetect=\{\(\) =>/);
    expect(LIBRARY).not.toMatch(/onRead=\{\(\) =>/);
  });

  it("declares the stable handlers after the functions they capture", () => {
    // They are `const`, so reading them earlier in the body is a temporal
    // dead zone ReferenceError the moment the Vault renders. TypeScript does
    // not catch this across a function body, and it crashes the whole tab.
    const at = (needle: string) => {
      const i = LIBRARY.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const holder = at("const latestHandlers = useRef({");
    for (const dep of [
      "const handleRemove = async (book: BookDocument) => {",
      "const runDetect = (book: BookDocument) => {",
      "const runExtractFigures = (book: BookDocument) => {",
    ]) {
      expect(at(dep), dep).toBeLessThan(holder);
    }
  });

  it("releases a book's blob URL when it is replaced", () => {
    // Nothing revoked these, so every PDF opened in a session stayed resident
    // until a reload. This is the "it gets slower the longer I use it" path.
    expect(APP).toContain("function revokeBlobUrl(");
    expect(APP).toContain('fileData.startsWith("blob:")');
    expect(APP).toContain("URL.revokeObjectURL(fileData)");
  });
});

describe("the Vault stopped flashing", () => {
  it("has no per-card entry animation", () => {
    // animate-slide-up with a per-card animationDelay and no
    // animation-fill-mode: backwards left each card fully visible during its
    // delay, then snapped it to opacity 0 and faded it back in. Every card
    // flashed, on every keystroke.
    expect(LIBRARY).not.toContain("animate-slide-up");
    expect(LIBRARY).not.toContain("animationDelay");
  });

  it("gives a book the same cover whatever order it is sorted in", () => {
    expect(LIBRARY).toContain("hues[seedOf(book.id) % hues.length]");
    expect(LIBRARY).not.toContain("hues[index % hues.length]");
  });
});

describe("the Vault is reachable from a keyboard", () => {
  it("reveals the shelf card actions on focus, not only on hover", () => {
    // They are tab-focusable buttons at opacity-0: focus moved onto controls
    // the user could not see (WCAG 2.4.7).
    expect(SHELVES).toContain("group-hover:opacity-100 focus-within:opacity-100");
  });

  it("does not nest a button inside a row that is itself a button", () => {
    // The row wrapped the delete button, so the whole row — cover, title,
    // summary, tags, counts, date — was announced as one button name.
    expect(LIST).not.toMatch(/role="button"\s*\n\s*tabIndex=\{0\}/);
    expect(LIST).toContain("onClick={(e) => { e.stopPropagation(); onOpenBook(book.id); }}");
  });

  it("declares the sort direction each column actually uses", () => {
    // Name sorts A to Z, date sorts newest first; both claimed "descending".
    expect(LIST).toContain('aria-sort={active ? (sortKey === "name" ? "ascending" : "descending") : undefined}');
  });

  it("declares the column header at module scope so sorting keeps focus", () => {
    // Defined in the render body it was a new component type every render, so
    // React remounted every header on each sort click and dropped focus.
    const headerAt = LIST.indexOf("const Header: React.FC<{");
    const listAt = LIST.indexOf("const LibraryList: React.FC<{");
    expect(headerAt).toBeGreaterThan(-1);
    expect(headerAt).toBeLessThan(listAt);
  });
});
