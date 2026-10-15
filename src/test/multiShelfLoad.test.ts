import { describe, it, expect } from "vitest";
import { applyLoad, describeLoad, focusChanged } from "@/lib/counselFocus";
import { selectContextBooks, selectionShelfIds, bookContextStore } from "@/lib/chatBooks";
import type { BookDocument } from "@/types/library";

/**
 * Several shelves loaded together (the Vault's "Chat with these N shelves").
 * The load used to flatten into a hand-picked snapshot: Counsel then said
 * "4 hand-picked books", the picker's Shelf box showed none, and picking a
 * shelf there to "fix" it replaced the set with that one shelf.
 */
const mk = (id: string, folderIds: string[]): BookDocument =>
  ({ id, title: id, folderIds, chapters: [{ id: `${id}-c`, title: "c", textContent: "x" }] }) as unknown as BookDocument;
const books = [mk("lawn1", ["L"]), mk("lawn2", ["L"]), mk("cash", ["S"]), mk("both", ["L", "S"]), mk("hbs", ["U"])];
const names = { shelf: (id: string) => ({ L: "Lawn", S: "Sales Copy", U: "Papers" }[id] ?? id), book: (id: string) => id, wiki: (id: string) => id };

describe("multi-shelf load", () => {
  const prev = { selection: { shelfId: "U", bookIds: [], excludedIds: [] }, activeBookId: "hbs", wikiIds: [] };
  const out = applyLoad(prev, { kind: "shelf", shelfId: "L", alsoShelfIds: ["S"], neurons: { kind: "keep" } });

  it("stays a shelf load over the union, each book once", () => {
    expect(selectionShelfIds(out.next.selection)).toEqual(["L", "S"]);
    expect(selectContextBooks(books, out.next.selection, null).map((b) => b.id).sort()).toEqual(["both", "cash", "lawn1", "lawn2"]);
  });

  it("picks up books added to either shelf later", () => {
    const later = [...books, mk("new", ["S"])];
    expect(selectContextBooks(later, out.next.selection, null).map((b) => b.id)).toContain("new");
  });

  it("names both shelves in the toast", () => {
    expect(describeLoad(prev, out, names)).toContain('Loaded shelves "Lawn" + "Sales Copy", replacing shelf "Papers"');
  });

  it("counts adding or dropping a shelf as a change", () => {
    const one = applyLoad(out.next, { kind: "shelf", shelfId: "L", neurons: { kind: "keep" } });
    expect(one.changed.selection).toBe(true);
    expect(focusChanged(out.next, out.next).selection).toBe(false);
  });

  it("survives the store round trip", () => {
    bookContextStore.init("u-multi");
    bookContextStore.set(out.next.selection);
    bookContextStore.init(null);
    bookContextStore.init("u-multi");
    expect(selectionShelfIds(bookContextStore.get())).toEqual(["L", "S"]);
    // A fresh one-shelf write drops the extras.
    bookContextStore.set({ shelfId: "U", bookIds: [], excludedIds: [] });
    expect(selectionShelfIds(bookContextStore.get())).toEqual(["U"]);
  });
});
