import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * The book-context picker — the sheet behind Counsel's `+` → Books.
 *
 * It had no coverage at all, which is how it kept a quadratic render path and
 * a nested scroller through every review of the feature. These are source
 * assertions in the style of counselComposer.test.ts: the component needs
 * AppContext, auth, chat settings and an external store to mount, and the
 * invariants worth holding here are structural.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/\\])\/\/[^\n]*/gm, "$1");

const SRC = stripComments(read("src/components/BookContextPicker.tsx"));
const count = (h: string, n: string) => h.split(n).length - 1;

describe("membership is O(1), not a scan per row", () => {
  it("builds a Set instead of calling includes() while rendering", () => {
    // `isChecked` used to run `bookIds.includes(id)` for every book drawn, so
    // the list was O(books x selection) — and the store emits on every toggle,
    // so that redraw ran again on each tap.
    expect(SRC).toContain("const checkedSet = useMemo(");
    expect(SRC).toContain("checkedSet.has(id)");
  });

  it("no longer scans the selection arrays in the render path", () => {
    expect(SRC).not.toContain("selection.bookIds.includes(id)");
    expect(SRC).not.toContain("selection.excludedIds.includes(id)");
  });

  it("keeps the shelf-mode inversion — the set holds exclusions there", () => {
    expect(SRC).toContain("selection.shelfId ? !checkedSet.has(id) : checkedSet.has(id)");
  });
});

describe("search", () => {
  it("filters the listed books by title", () => {
    expect(SRC).toContain("const visible = useMemo(");
    expect(SRC).toContain('(b.title || "").toLowerCase().includes(q)');
  });

  it("appears only once the list is long enough to need it", () => {
    expect(SRC).toContain("const searchable = listed.length >= SEARCHABLE_FROM");
  });

  it("never autofocuses — that pops the soft keyboard over the list", () => {
    expect(SRC).not.toContain("autoFocus");
    expect(SRC).toContain("onOpenAutoFocus={(e) => e.preventDefault()}");
  });

  it("clears the query when the pool changes or the sheet closes", () => {
    // A query left over from the previous shelf silently hides the books the
    // user just switched to.
    expect(count(SRC, "setQuery(\"\")")).toBeGreaterThanOrEqual(3);
  });
});

describe("select all / none", () => {
  it("acts on the VISIBLE rows only, so a search never touches hidden books", () => {
    expect(SRC).toContain("const ids = visible.map((b) => b.id)");
  });

  it("writes through the store, not local state", () => {
    expect(SRC).toContain("bookContextStore.set({ ...selection, excludedIds: [...excluded] })");
    expect(SRC).toContain("bookContextStore.set({ ...selection, bookIds: [...picked] })");
  });
});

describe("one scroll region", () => {
  it("has exactly one scroller — the list", () => {
    // A `max-h-72` scroller nested inside a scrolling dialog is the trap where
    // a flick moves whichever container the browser guesses.
    expect(count(SRC, "overflow-y-auto")).toBe(1);
    expect(SRC).not.toContain("max-h-72");
    expect(SRC).toContain("flex-1 min-h-0 overflow-y-auto");
  });

  it("is a column with a fixed header and footer", () => {
    expect(SRC).toContain("flex flex-col");
    expect(count(SRC, "shrink-0")).toBeGreaterThanOrEqual(3);
  });
});

describe("it is a bottom sheet, like the sheet that opens it", () => {
  it("uses Sheet, not a centred Dialog", () => {
    expect(SRC).toContain('side="bottom"');
    expect(SRC).not.toContain("DialogContent");
    expect(SRC).not.toContain("@/components/ui/dialog");
  });

  it("clears the home indicator", () => {
    expect(SRC).toContain("env(safe-area-inset-bottom)");
  });
});

describe("touch targets", () => {
  it("gives every row and control a 44px+ target", () => {
    expect(SRC).toContain("min-h-[48px]"); // book rows
    expect(count(SRC, "min-h-[44px]")).toBeGreaterThanOrEqual(4);
  });

  it("uses a checkbox big enough to hit", () => {
    expect(SRC).toContain('className="h-5 w-5 shrink-0 accent-primary"');
  });
});

describe("it still reads the mode from the one authority", () => {
  it("resolves through resolveBookContextMode, never a bare comparison", () => {
    // A second, drifting coercion here is the documented review finding.
    expect(SRC).toContain("resolveBookContextMode(selection, true)");
    expect(SRC).not.toMatch(/selection\.mode\s*===/);
  });
});
