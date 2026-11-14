import { describe, it, expect } from "vitest";
import {
  MAX_NOTEBOOK_DEPTH,
  allRows,
  ancestorsOf,
  buildNotebookTree,
  matchNotebooks,
  parentIdOf,
  pathLabel,
  visibleRows,
  whyCannotNest,
  withParent,
} from "@/lib/notebookTree";

/**
 * Notebooks inside notebooks.
 *
 * WHAT THIS PROTECTS. The parent lives in a tag, so the data can be wrong in
 * ways a foreign key would have refused: a parent that was deleted, a notebook
 * inside itself, two notebooks inside each other. In every one of those the
 * notebook must still be on screen — a tree that hides a notebook hides its
 * notes with it.
 */

const nb = (id: string, parent?: string, name = id, tags: string[] = []) => ({
  id,
  name,
  tags: parent ? [...tags, `in:${parent}`] : tags,
});
const ids = (nodes: { wiki: { id: string } }[]) => nodes.map((n) => n.wiki.id);

describe("the parent tag", () => {
  it("reads and writes the parent without touching other tags", () => {
    expect(parentIdOf({ tags: ["classic", "in:abc"] })).toBe("abc");
    expect(parentIdOf({ tags: ["classic"] })).toBeNull();
    expect(withParent(["classic", "in:abc"], "xyz")).toEqual(["classic", "in:xyz"]);
    expect(withParent(["classic", "in:abc"], null)).toEqual(["classic"]);
    expect(withParent(null, "xyz")).toEqual(["in:xyz"]);
  });

  it("treats an empty parent tag as top level", () => {
    expect(parentIdOf({ tags: ["in:"] })).toBeNull();
  });
});

describe("buildNotebookTree", () => {
  it("nests, sorts by name at every level and sets depths", () => {
    const tree = buildNotebookTree([
      nb("z", undefined, "Zen"),
      nb("a", undefined, "art"),
      nb("a2", "a", "Chapter 10"),
      nb("a1", "a", "Chapter 2"),
      nb("a1x", "a1", "Deep"),
    ]);
    expect(ids(tree.roots)).toEqual(["a", "z"]);
    // Numeric order: "Chapter 2" before "Chapter 10".
    expect(ids(tree.byId.get("a")!.children)).toEqual(["a1", "a2"]);
    expect(tree.byId.get("a1x")!.depth).toBe(3);
    expect(ids(ancestorsOf(tree, "a1x"))).toEqual(["a", "a1"]);
    expect(pathLabel(tree, "a1x")).toBe("art › Chapter 2 › Deep");
  });

  it("keeps a notebook on screen when its parent is gone", () => {
    const tree = buildNotebookTree([nb("orphan", "deleted-long-ago"), nb("a")]);
    expect(ids(tree.roots)).toEqual(["a", "orphan"]);
  });

  it("keeps every notebook on screen when the tags form a loop", () => {
    const tree = buildNotebookTree([nb("a", "b"), nb("b", "a"), nb("self", "self"), nb("c", "a")]);
    expect(ids(allRows(tree)).sort()).toEqual(["a", "b", "c", "self"]);
    expect(ids(tree.roots)).toContain("self");
  });

  it("folds away the children of a collapsed notebook, at any depth", () => {
    const tree = buildNotebookTree([nb("a"), nb("b", "a"), nb("c", "b"), nb("d")]);
    expect(ids(visibleRows(tree, new Set()))).toEqual(["a", "b", "c", "d"]);
    expect(ids(visibleRows(tree, new Set(["b"])))).toEqual(["a", "b", "d"]);
    expect(ids(visibleRows(tree, new Set(["a"])))).toEqual(["a", "d"]);
  });
});

describe("whyCannotNest", () => {
  const tree = buildNotebookTree([nb("a"), nb("b", "a"), nb("c", "b"), nb("d"), nb("e", "d")]);

  it("allows the top level and an ordinary move", () => {
    expect(whyCannotNest(tree, "c", null)).toBeNull();
    expect(whyCannotNest(tree, "e", "a")).toBeNull();
    expect(whyCannotNest(tree, null, "b")).toBeNull();
  });

  it("refuses a notebook inside itself or inside its own contents", () => {
    expect(whyCannotNest(tree, "a", "a")).toMatch(/itself/);
    expect(whyCannotNest(tree, "a", "c")).toMatch(/already inside/);
  });

  it(`stops at ${MAX_NOTEBOOK_DEPTH} levels, counting what the notebook carries with it`, () => {
    // A new notebook under the deepest one would be level 4.
    expect(whyCannotNest(tree, null, "c")).toMatch(/levels/);
    // d carries e: under b that is b(2) + d(3) + e(4).
    expect(whyCannotNest(tree, "d", "b")).toMatch(/levels/);
    // ...but under a it fits exactly.
    expect(whyCannotNest(tree, "d", "a")).toBeNull();
  });

  it("refuses a parent that no longer exists", () => {
    expect(whyCannotNest(tree, "e", "ghost")).toMatch(/no longer exists/);
  });
});

describe("matchNotebooks", () => {
  it("finds notebooks by name at any depth, in tree order", () => {
    const tree = buildNotebookTree([nb("a", undefined, "Stoics"), nb("b", "a", "Meditations notes"), nb("c", undefined, "Dune")]);
    expect(ids(matchNotebooks(tree, "  NOTES "))).toEqual(["b"]);
    expect(ids(matchNotebooks(tree, "o"))).toEqual(["a", "b"]);
    expect(matchNotebooks(tree, "  ")).toEqual([]);
  });
});
