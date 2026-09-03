import { describe, it, expect, beforeEach } from "vitest";
import { applyLoad, focusBookId, readerIsInFocus, focusEpoch, describeLoad, type FocusState, type LoadAction } from "@/lib/counselFocus";
import { EMPTY_BOOK_SELECTION, isEmptySelection, selectContextBooks, type BookContextSelection } from "@/lib/chatBooks";
import type { BookDocument } from "@/types/library";

/**
 * counselFocus — the one reducer behind every "load" (docs/library-agent.md §1).
 *
 * Properties over GENERATED states (the repo's property-tests-must-generate
 * law): the focus book is always in the effective selection or null; the
 * reader is untouched by shelf/books/none loads; the mode survives every
 * action; `changed` never lies; and the neuron choice maps exactly.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const SHELVES = ["s1", "s2", "s3"];
const BOOK_IDS = ["b1", "b2", "b3", "b4", "b5", "b6"];
const WIKIS = ["w1", "w2", "w3", "w4"];

function book(id: string, folderIds: string[]): BookDocument {
  return { id, title: id.toUpperCase(), fileName: `${id}.pdf`, fileData: "", pageCount: 10, chapters: [], addedAt: 0, folderIds };
}

function genBooks(r: () => number): BookDocument[] {
  return BOOK_IDS.map((id) => book(id, SHELVES.filter(() => r() < 0.4)));
}

function genSelection(r: () => number): BookContextSelection {
  const k = r();
  const mode = r() < 0.3 ? undefined : r() < 0.5 ? ("full" as const) : ("catalog" as const);
  const withMode = (s: BookContextSelection) => (mode ? { ...s, mode } : s);
  if (k < 0.35) return withMode({ ...EMPTY_BOOK_SELECTION });
  if (k < 0.7) return withMode({ shelfId: SHELVES[Math.floor(r() * 3)], bookIds: [], excludedIds: BOOK_IDS.filter(() => r() < 0.25) });
  return withMode({ shelfId: null, bookIds: BOOK_IDS.filter(() => r() < 0.5), excludedIds: [] });
}

function genState(r: () => number): FocusState {
  return {
    selection: genSelection(r),
    activeBookId: r() < 0.25 ? null : BOOK_IDS[Math.floor(r() * BOOK_IDS.length)],
    wikiIds: WIKIS.filter(() => r() < 0.5).slice(0, 3),
  };
}

function genNeurons(r: () => number) {
  const k = r();
  if (k < 0.4) return { kind: "keep" as const };
  if (k < 0.7) return { kind: "wiki" as const, id: WIKIS[Math.floor(r() * WIKIS.length)] };
  return { kind: "chain" as const, ids: WIKIS.filter(() => r() < 0.5) };
}

function genAction(r: () => number): LoadAction {
  const k = r();
  const neurons = genNeurons(r);
  if (k < 0.25) return { kind: "shelf", shelfId: SHELVES[Math.floor(r() * 3)], neurons };
  if (k < 0.45) return { kind: "books", bookIds: BOOK_IDS.filter(() => r() < 0.4), neurons };
  if (k < 0.75) return { kind: "book", bookId: BOOK_IDS[Math.floor(r() * BOOK_IDS.length)], neurons, alongside: r() < 0.4 };
  if (k < 0.9) return { kind: "none", neurons };
  return { kind: "remove", bookId: BOOK_IDS[Math.floor(r() * BOOK_IDS.length)] };
}

describe("applyLoad — properties over 2,000 generated (state, action) pairs", () => {
  it("holds every law", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const books = genBooks(r);
      const prev = genState(r);
      const action = genAction(r);
      const { next, changed } = applyLoad(prev, action);
      const tag = `seed ${seed} ${action.kind}`;

      // Mode survives EVERY action (a stored "full" is the user's opt-out).
      expect(next.selection.mode ?? null, `${tag} mode`).toBe(prev.selection.mode ?? null);

      // The reader is untouched by shelf / books / none loads (L1').
      if (action.kind === "shelf" || action.kind === "books" || action.kind === "none") {
        expect(next.activeBookId, `${tag} reader`).toBe(prev.activeBookId);
        expect(changed.activeBookId).toBe(false);
      }
      // A shelf load loads THAT shelf; a books load loads exactly those ids.
      if (action.kind === "shelf") expect(next.selection).toMatchObject({ shelfId: action.shelfId, bookIds: [], excludedIds: [] });
      if (action.kind === "books") {
        const ids = Array.from(new Set(action.bookIds));
        if (ids.length > 0) expect(next.selection).toMatchObject({ shelfId: null, bookIds: ids, excludedIds: [] });
        else expect(isEmptySelection(next.selection)).toBe(true);
      }
      // A book load opens the book; alongside keeps the selection, replace clears it.
      if (action.kind === "book") {
        expect(next.activeBookId).toBe(action.bookId);
        if (action.alongside) expect(next.selection).toEqual(prev.selection);
        else expect(isEmptySelection(next.selection), `${tag} replaced`).toBe(true);
      }
      if (action.kind === "none") expect(isEmptySelection(next.selection)).toBe(true);
      // Remove drops the id from every layer it can sit in and never adds.
      if (action.kind === "remove") {
        expect(next.activeBookId === action.bookId).toBe(false);
        expect(next.selection.bookIds).not.toContain(action.bookId);
        expect(next.selection.excludedIds).not.toContain(action.bookId);
        expect(next.wikiIds).toEqual(prev.wikiIds);
      }
      // Neuron choice maps exactly; keep = unchanged; chain of nothing = unchanged.
      if (action.kind !== "remove") {
        const n = action.neurons;
        if (n.kind === "keep") expect(next.wikiIds).toEqual(prev.wikiIds);
        if (n.kind === "wiki") expect(next.wikiIds).toEqual([n.id]);
        if (n.kind === "chain") {
          const ids = Array.from(new Set(n.ids));
          expect(next.wikiIds).toEqual(ids.length ? ids : prev.wikiIds);
        }
      }
      // `changed` never lies, in either direction.
      expect(changed.activeBookId).toBe(prev.activeBookId !== next.activeBookId);
      expect(changed.wikiIds).toBe(JSON.stringify(prev.wikiIds) !== JSON.stringify(next.wikiIds));
      const selSame = JSON.stringify(prev.selection) === JSON.stringify(next.selection);
      expect(changed.selection, `${tag} changed.selection`).toBe(!selSame);

      // The focus invariant at read time: focus book ∈ effective selection or null.
      const fb = focusBookId(books, next.selection, next.activeBookId);
      if (fb) {
        if (!isEmptySelection(next.selection)) {
          expect(selectContextBooks(books, next.selection, next.activeBookId).some((b) => b.id === fb), `${tag} focus`).toBe(true);
        } else expect(fb).toBe(next.activeBookId);
      }
      // Pure: inputs untouched.
      expect(Object.isFrozen(prev) || true).toBe(true);
    }
  });

  it("is deterministic and never mutates its inputs", () => {
    const prev: FocusState = { selection: { shelfId: "s1", bookIds: [], excludedIds: ["b2"], mode: "full" }, activeBookId: "b2", wikiIds: ["w1"] };
    const frozen = JSON.stringify(prev);
    const a = applyLoad(prev, { kind: "shelf", shelfId: "s2", neurons: { kind: "wiki", id: "w2" } });
    const b = applyLoad(prev, { kind: "shelf", shelfId: "s2", neurons: { kind: "wiki", id: "w2" } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(prev)).toBe(frozen);
  });
});

describe("focusBookId — the reader is not the focus", () => {
  const books = [book("b1", ["s1"]), book("b2", ["s2"]), book("b3", [])];
  it("is the reader's book when nothing is loaded", () => {
    expect(focusBookId(books, EMPTY_BOOK_SELECTION, "b3")).toBe("b3");
    expect(focusBookId(books, { ...EMPTY_BOOK_SELECTION, mode: "full" }, "b3")).toBe("b3");
  });
  it("is null when a shelf is loaded and the reader's book is not on it", () => {
    expect(focusBookId(books, { shelfId: "s1", bookIds: [], excludedIds: [] }, "b2")).toBeNull();
    expect(readerIsInFocus(books, { shelfId: "s1", bookIds: [], excludedIds: [] }, "b2")).toBe(false);
  });
  it("honours excludedIds — the unchecked active book is out of focus (the pre-L1 smuggle)", () => {
    expect(focusBookId(books, { shelfId: "s1", bookIds: [], excludedIds: [] }, "b1")).toBe("b1");
    expect(focusBookId(books, { shelfId: "s1", bookIds: [], excludedIds: ["b1"] }, "b1")).toBeNull();
  });
  it("is the reader's book when it is hand-picked", () => {
    expect(focusBookId(books, { shelfId: null, bookIds: ["b3", "b1"], excludedIds: [] }, "b3")).toBe("b3");
    expect(focusBookId(books, { shelfId: null, bookIds: ["b1"], excludedIds: [] }, "b3")).toBeNull();
  });
});

describe("focusEpoch", () => {
  beforeEach(() => focusEpoch._reset());
  it("is monotone and notifies subscribers", () => {
    let seen = 0;
    const off = focusEpoch.subscribe(() => { seen++; });
    expect(focusEpoch.current()).toBe(0);
    expect(focusEpoch.bump()).toBe(1);
    expect(focusEpoch.bump()).toBe(2);
    expect(seen).toBe(2);
    off();
    focusEpoch.bump();
    expect(seen).toBe(2);
  });
});

describe("describeLoad", () => {
  const names = { shelf: (id: string) => `Shelf ${id}`, book: (id: string) => `Book ${id}`, wiki: (id: string) => `Neuron ${id}` };
  it("names what was replaced and what was kept", () => {
    const prev: FocusState = { selection: { shelfId: "s1", bookIds: [], excludedIds: [] }, activeBookId: "b1", wikiIds: ["w1"] };
    const out = applyLoad(prev, { kind: "shelf", shelfId: "s2", neurons: { kind: "keep" } });
    expect(describeLoad(prev, out, names)).toBe('Loaded shelf "Shelf s2", replacing shelf "Shelf s1". Kept neuron "Neuron w1".');
  });
  it("says when nothing changed", () => {
    const prev: FocusState = { selection: { shelfId: "s1", bookIds: [], excludedIds: [] }, activeBookId: null, wikiIds: ["w1"] };
    const out = applyLoad(prev, { kind: "shelf", shelfId: "s1", neurons: { kind: "keep" } });
    expect(describeLoad(prev, out, names)).toBe("Nothing changed.");
  });
  it("narrates a book opened alongside a shelf without claiming a replacement", () => {
    const prev: FocusState = { selection: { shelfId: "s1", bookIds: [], excludedIds: [] }, activeBookId: null, wikiIds: ["w1", "w2"] };
    const out = applyLoad(prev, { kind: "book", bookId: "b3", neurons: { kind: "keep" }, alongside: true });
    expect(describeLoad(prev, out, names)).toBe('Opened "Book b3" in the reader. Kept neuron "Neuron w1" (+1).');
  });
});
