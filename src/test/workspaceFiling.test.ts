import { describe, it, expect, beforeEach } from "vitest";
import { workspaceStore } from "@/lib/workspaceStore";

/**
 * Filing: every Workspace item belongs to the notebook Counsel had loaded
 * when it was made, and an item made with none loaded raises one question
 * instead of landing in a pile.
 */
const make = (title: string, userId: string | null = "u1") =>
  workspaceStore.add({ userId, kind: "text", title, content: title });

beforeEach(() => {
  workspaceStore.removeMany(workspaceStore.getAll().map((i) => i.id));
  workspaceStore.dismissFiling();
  workspaceStore.setFilingTarget(null);
});

describe("a notebook is loaded", () => {
  it("files new items there, through both creation seams, and asks nothing", () => {
    workspaceStore.setFilingTarget("w1");
    expect(make("a").meta?.wikiId).toBe("w1");
    const { item } = workspaceStore.addFile({ userId: "u1", title: "b.py", language: "py", content: "print(1)" });
    expect(item.meta?.wikiId).toBe("w1");
    expect(workspaceStore.getFilingRequest()).toBeNull();
  });

  it("follows the notebook when it changes", () => {
    workspaceStore.setFilingTarget("w1");
    make("a");
    workspaceStore.setFilingTarget("w2");
    expect(make("b").meta?.wikiId).toBe("w2");
  });
});

describe("no notebook is loaded", () => {
  it("saves the item anyway and asks once for everything made", () => {
    const a = make("a");
    const b = make("b");
    expect(workspaceStore.getAll().map((i) => i.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(a.meta?.wikiId).toBeUndefined();
    expect(workspaceStore.getFilingRequest()).toEqual({ mode: "new", ids: [a.id, b.id] });
  });

  it("does not ask about signed-out items — notebooks belong to an account", () => {
    make("a", null);
    expect(workspaceStore.getFilingRequest()).toBeNull();
  });

  it("answering files every waiting item and closes the question", () => {
    const a = make("a");
    const b = make("b");
    workspaceStore.assignNotebook([a.id, b.id], "w9");
    expect(workspaceStore.getAll().every((i) => i.meta?.wikiId === "w9")).toBe(true);
    expect(workspaceStore.getFilingRequest()).toBeNull();
  });

  it("deciding later keeps the items, unfiled", () => {
    const a = make("a");
    workspaceStore.dismissFiling();
    expect(workspaceStore.getFilingRequest()).toBeNull();
    expect(workspaceStore.getAll().find((i) => i.id === a.id)?.meta?.wikiId).toBeUndefined();
  });

  it("a deleted item leaves the question", () => {
    const a = make("a");
    const b = make("b");
    workspaceStore.remove(a.id);
    expect(workspaceStore.getFilingRequest()?.ids).toEqual([b.id]);
    workspaceStore.remove(b.id);
    expect(workspaceStore.getFilingRequest()).toBeNull();
  });
});

describe("moving", () => {
  it("refiles an item and can take it out of every notebook", () => {
    workspaceStore.setFilingTarget("w1");
    const a = make("a");
    workspaceStore.requestFiling([a.id]);
    expect(workspaceStore.getFilingRequest()).toEqual({ mode: "move", ids: [a.id] });
    workspaceStore.assignNotebook([a.id], "w2");
    expect(workspaceStore.getAll()[0].meta?.wikiId).toBe("w2");
    workspaceStore.assignNotebook([a.id], null);
    expect(workspaceStore.getAll()[0].meta?.wikiId).toBeUndefined();
  });

  it("removeMany deletes only what it is given", () => {
    workspaceStore.setFilingTarget("w1");
    const a = make("a");
    const b = make("b");
    workspaceStore.removeMany([a.id]);
    expect(workspaceStore.getAll().map((i) => i.id)).toEqual([b.id]);
  });
});

describe("opening a file from another tab", () => {
  it("is taken exactly once", () => {
    workspaceStore.requestOpen("x");
    expect(workspaceStore.takeOpenRequest()).toBe("x");
    expect(workspaceStore.takeOpenRequest()).toBeNull();
  });
});
